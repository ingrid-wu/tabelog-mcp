// One real Chrome, owned by this process, with its own profile. Tabelog's
// Japanese site (behind Cloudflare) refuses plain HTTP clients and headless
// browsers, so the window is visible but placed off-screen; it comes on-screen
// only when the user must act (sign in, solve a check, enter a card).

import { mkdirSync } from "node:fs";
import { type BrowserContext, chromium, type Page, type Route } from "playwright-core";
import { TabelogError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { isBlockedPage } from "../tabelog/parse.ts";
import { origin } from "../tabelog/urls.ts";

/** Hosts the browser may load while the server drives it. Everything else (ads, trackers) is blocked. */
const automatedHosts = [/(^|\.)tabelog\.com$/, /(^|\.)k-img\.com$/, /^www\.gstatic\.com$/, /^www\.google\.com$/, /^www\.recaptcha\.net$/];
const blockedResourceTypes = new Set(["image", "media", "font"]);

const offScreen = { left: -2400, top: -2400 } as const;
const windowSize = { width: 1280, height: 900 } as const;

/** "browse" serves searches and lookups; "booking" holds one booking flow, so a search cannot navigate away from it. */
export type Tab = "browse" | "booking";

export interface PageResult {
  readonly status: number | null;
  readonly url: string;
  readonly html: string;
}

export interface BrowserSessionOptions {
  readonly profileDirectory: string;
  readonly logger: Logger;
  /** Minimum gap between requests to Tabelog. */
  readonly minIntervalMs?: number;
  /** Close the browser after this long without use, releasing the profile for other processes. */
  readonly idleCloseMs?: number;
  readonly executablePath?: string;
}

export class BrowserSession {
  private context: BrowserContext | null = null;
  private readonly pages = new Map<Tab, Page>();
  private visible = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: BrowserSessionOptions) {}

  /** Runs one operation at a time: the browser has one page and Tabelog gets one request at a time. */
  exclusive<T>(operation: (session: this) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => operation(this));
    this.queue = run.catch(() => undefined);
    return run.finally(() => this.scheduleIdleClose());
  }

  async goto(url: string, { timeoutMs = 30_000, tab = "browse" as Tab } = {}): Promise<PageResult> {
    const page = await this.ensurePage(tab);
    await this.pace();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const html = await page.content();
    if (response?.status() === 403 || isBlockedPage(html)) {
      throw new TabelogError("BLOCKED", "Tabelog's bot protection refused the page.", { url: page.url() });
    }
    return { status: response?.status() ?? null, url: page.url(), html };
  }

  /** Same-origin JSON request from inside the page, so it carries the browser's cookies. */
  async fetchJson(path: string): Promise<unknown> {
    const page = await this.ensurePage("browse");
    if (!page.url().startsWith(origin)) await this.goto(`${origin}/robots.txt`);
    await this.pace();
    const result = await page.evaluate(async (target) => {
      const response = await fetch(target, { headers: { "X-Requested-With": "XMLHttpRequest" } });
      return { status: response.status, body: await response.text() };
    }, path);
    if (result.status === 403 || isBlockedPage(result.body)) {
      throw new TabelogError("BLOCKED", "Tabelog's bot protection refused the request.", { path });
    }
    try {
      return JSON.parse(result.body);
    } catch {
      throw new TabelogError("PAGE_CHANGED", "Tabelog returned something other than JSON.", { path, status: result.status });
    }
  }

  async snapshot(tab: Tab = "browse"): Promise<{ url: string; html: string; missingRequired: string[] }> {
    const page = await this.ensurePage(tab);
    const missingRequired = await page.evaluate(() => {
      const labels: string[] = [];
      for (const field of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input[required], select[required], textarea[required], [aria-required=true]",
      )) {
        if (field instanceof HTMLInputElement && (field.type === "hidden" || field.type === "submit")) continue;
        const style = window.getComputedStyle(field);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const empty =
          field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")
            ? !document.querySelector(`input[name="${CSS.escape(field.name)}"]:checked`)
            : !("value" in field) || String(field.value).trim() === "";
        if (!empty) continue;
        const label = (field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent) || field.getAttribute("placeholder") || field.getAttribute("name") || "field";
        labels.push(label.replace(/\s+/g, " ").trim().slice(0, 40));
      }
      return [...new Set(labels)];
    });
    return { url: page.url(), html: await page.content(), missingRequired };
  }

  /** Clicks the control with exactly this text (the Nth such control) and waits for the next page. */
  async click(button: { readonly text: string; readonly occurrence: number }, tab: Tab = "booking"): Promise<void> {
    const page = await this.ensurePage(tab);
    const exact = new RegExp(`^\\s*${button.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    const byText = page.locator("button, a").filter({ hasText: exact });
    const byValue = page.locator(`input[type=submit][value="${button.text}"], input[type=button][value="${button.text}"]`);
    const candidates = (await byText.count()) > 0 ? byText : byValue;
    if ((await candidates.count()) <= button.occurrence) {
      throw new TabelogError("PAGE_CHANGED", `The "${button.text}" control moved or disappeared.`, { stage: "click" });
    }
    await this.pace();
    await candidates.nth(button.occurrence).click({ timeout: 15_000 });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  }

  currentUrl(tab: Tab = "browse"): string | null {
    return this.pages.get(tab)?.url() ?? null;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Brings the window on-screen for the user and stops blocking third-party hosts (sign-in providers). */
  async show(url?: string, tab: Tab = "browse"): Promise<void> {
    const page = await this.ensurePage(tab);
    this.visible = true;
    await this.setWindow(page, { left: 80, top: 60 });
    await page.bringToFront();
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async hide(): Promise<void> {
    const page = this.pages.get("browse") ?? this.pages.get("booking");
    this.visible = false;
    if (page) await this.setWindow(page, offScreen);
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const context = this.context;
    this.context = null;
    this.pages.clear();
    await context?.close().catch(() => undefined);
  }

  private async ensurePage(tab: Tab): Promise<Page> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const existing = this.pages.get(tab);
    if (existing && !existing.isClosed()) return existing;
    if (!this.context) this.context = await this.launch();
    const unused = this.context.pages().find((page) => ![...this.pages.values()].includes(page));
    const page = unused ?? (await this.context.newPage());
    this.pages.set(tab, page);
    return page;
  }

  private async launch(): Promise<BrowserContext> {
    mkdirSync(this.options.profileDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.options.profileDirectory, {
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : { channel: "chrome" }),
        headless: false,
        args: [`--window-position=${offScreen.left},${offScreen.top}`, `--window-size=${windowSize.width},${windowSize.height}`],
        viewport: windowSize,
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/is not found|Executable doesn't exist|ENOENT/i.test(message)) {
        throw new TabelogError("CHROME_NOT_FOUND", "Google Chrome is not installed where Playwright looks for it.");
      }
      if (/ProcessSingleton|profile.*in use|SingletonLock|already running/i.test(message)) {
        throw new TabelogError("BROWSER_BUSY", "Another tabelog-mcp process is using the browser profile.");
      }
      throw error;
    }
    await context.route("**/*", (route) => this.filter(route));
    context.on("close", () => {
      this.context = null;
      this.pages.clear();
    });
    this.options.logger.info("browser started");
    return context;
  }

  private filter(route: Route): Promise<void> {
    if (this.visible) return route.continue();
    const request = route.request();
    const host = new URL(request.url()).hostname;
    if (blockedResourceTypes.has(request.resourceType()) || !automatedHosts.some((pattern) => pattern.test(host))) {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  }

  private async setWindow(page: Page, position: { left: number; top: number }): Promise<void> {
    if (!this.context) return;
    const cdp = await this.context.newCDPSession(page);
    try {
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { ...position, ...windowSize } });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private async pace(): Promise<void> {
    const gap = this.options.minIntervalMs ?? 1_500;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.visible) return;
    this.idleTimer = setTimeout(() => {
      this.options.logger.info("browser closed after idle");
      void this.close();
    }, this.options.idleCloseMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }
}
