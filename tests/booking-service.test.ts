import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { areaOf, BookingService } from "../src/booking/service.ts";
import type { BrowserSession } from "../src/browser/session.ts";
import { HistoryStore } from "../src/history/store.ts";
import { Logger } from "../src/logger.ts";

const restaurantHtml = readFileSync(join(import.meta.dirname, "fixtures", "restaurant.html"), "utf8");
const restaurantUrl = "https://tabelog.com/tokyo/A1301/A130101/13263391/";
const wrap = (body: string) => `<html><body><main>${body}</main></body></html>`;

const planPage = wrap(`<section><h3>席のみ予約</h3><button>席のみ予約</button></section>
  <div><h3 class="t">特選コース</h3><p>13,020円</p><button>選択する</button></div>`);
const formPage = wrap(`<input name="name" value="山田"><button>予約内容を確認する</button>`);
const confirmPage = (party = 2) =>
  wrap(`<table><tr><th>来店日時</th><td>2026年10月24日(土) 16:00</td></tr><tr><th>人数</th><td>${party}名</td></tr></table>
  <button>予約を確定する</button>`);
const completePage = wrap(`<h1>予約が完了しました</h1><p>予約番号：TB-0001</p>`);

/** A scripted browser: each click advances to the next page. Records every click. */
class FakeBrowser {
  readonly clicks: string[] = [];
  pages: string[] = [];
  index = 0;
  slots = [{ time: "11:30" }, { time: "16:00" }];

  exclusive<T>(operation: (session: this) => Promise<T>): Promise<T> {
    return operation(this);
  }
  async goto(url: string) {
    if (url === restaurantUrl) return { status: 200, url, html: restaurantHtml };
    this.index = 0;
    return { status: 200, url: this.url(), html: this.pages[0] ?? "" };
  }
  async fetchJson() {
    return { selection: Object.fromEntries(this.slots.map((slot, i) => [String(i), { time: slot.time, url: "/booking/form/new" }])) };
  }
  async snapshot() {
    return { url: this.url(), html: this.pages[this.index] ?? "", missingRequired: [] };
  }
  async click(button: { text: string }) {
    this.clicks.push(button.text);
    this.index += 1;
  }
  currentUrl() {
    return this.url();
  }
  async show() {}
  private url() {
    return `https://tabelog.com/booking/step/${this.index}`;
  }
}

const request = { restaurantUrl, date: "2026-10-24", time: "16:00", party: 2, purpose: "business" as const, notes: "client dinner" };

let browser: FakeBrowser;
let history: HistoryStore;
let clock: Date;
let service: BookingService;

beforeEach(() => {
  browser = new FakeBrowser();
  history = new HistoryStore(join(mkdtempSync(join(tmpdir(), "tabelog-test-")), "history.jsonl"), () => clock);
  clock = new Date("2026-10-22T12:00:00+09:00");
  service = new BookingService(browser as unknown as BrowserSession, history, new Logger("error"), () => clock);
});

describe("prepare_booking", () => {
  test("asks for a plan when the restaurant offers several and none was given", async () => {
    browser.pages = [planPage];
    expect(await service.prepare(request)).toEqual({
      status: "choose_plan",
      plans: [
        { label: "席のみ予約", price: null },
        { label: "特選コース", price: "13,020円" },
      ],
    });
    expect(browser.clicks).toEqual([]);
  });

  test("walks plan and form steps to the confirmation page and stops there", async () => {
    browser.pages = [planPage, formPage, confirmPage(), completePage];
    const result = await service.prepare({ ...request, plan: "特選" });
    expect(result.status).toBe("ready");
    // It chose the plan and moved past the form. It never pressed the final button.
    expect(browser.clicks).toEqual(["選択する", "予約内容を確認する"]);
    expect(history.bookings()[0]).toMatchObject({ status: "prepared", purpose: "business", plan: "特選コース", notes: ["client dinner"] });
    expect(history.bookings()[0]?.restaurant).toMatchObject({ name: "焼肉うしごろ 銀座店", area: "東京都中央区", genre: "焼肉、ステーキ、ホルモン" });
  });

  test("hands off when the confirmation page does not show the requested party", async () => {
    browser.pages = [confirmPage(4)];
    const result = await service.prepare(request);
    expect(result).toMatchObject({ status: "needs_user", reason: "summary_unverified" });
    expect(history.bookings()[0]?.status).toBe("handed_off");
  });

  test("refuses a time that is not open", async () => {
    await expect(service.prepare({ ...request, time: "19:00" })).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  test("refuses a date in the past", async () => {
    await expect(service.prepare({ ...request, date: "2026-10-21" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("hands card entry to the user", async () => {
    browser.pages = [wrap(`<input name="card_number"><button>予約を確定する</button>`)];
    expect(await service.prepare(request)).toMatchObject({ status: "needs_user", reason: "card_required" });
    expect(browser.clicks).toEqual([]);
  });
});

describe("confirm_booking", () => {
  async function prepared(): Promise<string> {
    browser.pages = [confirmPage(), completePage];
    const result = await service.prepare(request);
    if (result.status !== "ready") throw new Error(`not ready: ${result.status}`);
    return result.confirmation_token;
  }

  test("clicks the final button once and records the reservation number", async () => {
    const token = await prepared();
    expect(await service.confirm(token)).toMatchObject({ status: "confirmed", reservation_number: "TB-0001" });
    expect(browser.clicks).toEqual(["予約を確定する"]);
    expect(history.bookings()[0]).toMatchObject({ status: "confirmed", reservation_number: "TB-0001" });
  });

  test("a token works once", async () => {
    const token = await prepared();
    await service.confirm(token);
    await expect(service.confirm(token)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    expect(browser.clicks).toEqual(["予約を確定する"]);
  });

  test("an unknown token books nothing", async () => {
    await prepared();
    await expect(service.confirm("x".repeat(24))).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    expect(browser.clicks).toEqual([]);
  });

  test("a token expires after 5 minutes", async () => {
    const token = await prepared();
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    await expect(service.confirm(token)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    expect(browser.clicks).toEqual([]);
  });

  test("a confirmation page that changed since prepare books nothing", async () => {
    const token = await prepared();
    browser.pages[0] = confirmPage(3);
    await expect(service.confirm(token)).rejects.toMatchObject({ code: "SUMMARY_CHANGED" });
    expect(browser.clicks).toEqual([]);
    expect(history.bookings()[0]?.status).toBe("failed");
  });

  test("never reports success without seeing the completion page", async () => {
    const token = await prepared();
    browser.pages[1] = wrap(`<p>しばらくお待ちください</p>`);
    expect(await service.confirm(token)).toMatchObject({ status: "unclear" });
    expect(history.bookings()[0]?.status).toBe("failed");
  });
});

test("area is prefecture plus city or ward", () => {
  expect(areaOf("東京都中央区銀座1-8-19 ONE GINZA 7F")).toBe("東京都中央区");
  expect(areaOf("大阪府大阪市北区梅田1-1")).toBe("大阪府大阪市");
  expect(areaOf("")).toBeNull();
});
