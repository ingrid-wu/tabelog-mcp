// Sign-in, run inside whatever operation needs it. The user signs in
// themselves in the Chrome window; this code only waits and then notes when
// Tabelog's new session cookies expire, since Tabelog does not publish how
// long a sign-in lasts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserSession } from "../browser/session.ts";
import { type LoginState, parseLoginState } from "./parse.ts";
import { loginCheckUrl, loginUrl, origin } from "./urls.ts";

export interface SessionRecord {
  readonly signed_in_at: string;
  /** Latest expiry among cookies Tabelog set at sign-in: when the sign-in should lapse. */
  readonly expires_at: string | null;
}

export function readSession(path: string): SessionRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

export interface WaitForLoginOptions {
  readonly timeoutMs: number;
  readonly sessionPath: string;
  readonly onProgress?: (message: string) => void;
}

/**
 * Shows the window on Tabelog's login page and waits for the user to finish.
 * Returns signed_in, or signed_out on timeout with the window left open so
 * the user can still finish and retry.
 */
export async function waitForLogin(browser: BrowserSession, options: WaitForLoginOptions): Promise<LoginState> {
  const before = new Map((await browser.cookieExpiries()).map((cookie) => [cookie.name, cookie.expires]));
  await browser.show(loginUrl);
  options.onProgress?.("A Chrome window is open on Tabelog's login page. Sign in there.");
  const deadline = Date.now() + options.timeoutMs;
  let checkedAt: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const url = browser.currentUrl() ?? "";
    // Tabelog sends the user back to tabelog.com after the provider's sign-in.
    if (!url.startsWith(origin) || url.includes("/account/") || url === checkedAt) continue;
    let state = parseLoginState((await browser.snapshot()).html);
    if (state === "unknown") state = parseLoginState((await browser.goto(loginCheckUrl)).html);
    if (state === "signed_in") {
      recordSession(options.sessionPath, before, await browser.cookieExpiries());
      await browser.hide();
      return state;
    }
    checkedAt = browser.currentUrl();
  }
  return "signed_out";
}

function recordSession(path: string, before: Map<string, number>, after: { name: string; expires: number }[]): void {
  const fresh = after.filter((cookie) => cookie.expires > 0 && before.get(cookie.name) !== cookie.expires);
  const latest = fresh.reduce((max, cookie) => Math.max(max, cookie.expires), 0);
  const record: SessionRecord = {
    signed_in_at: new Date().toISOString(),
    expires_at: latest > 0 ? new Date(latest * 1_000).toISOString() : null,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
