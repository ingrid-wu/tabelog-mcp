import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readBookingPage, summaryMatchesRequest } from "../src/booking/page.ts";

const page = (body: string, url = "https://tabelog.com/booking/form/new?rcd=1", missingRequired: string[] = []) =>
  readBookingPage({ url, html: `<html><head><title>t</title></head><body><main>${body}</main></body></html>`, missingRequired });

describe("readBookingPage", () => {
  test("Tabelog's real logged-out page is login_required", () => {
    const html = readFileSync(join(import.meta.dirname, "fixtures", "booking-no-login.html"), "utf8");
    expect(readBookingPage({ url: "https://tabelog.com/booking/no_login/show?rcd=1", html, missingRequired: [] }).kind).toBe(
      "login_required",
    );
  });

  test("plan list: each plan's name, price, and which identical button selects it", () => {
    const result = page(`
      <section><h3>席のみ予約</h3><button>席のみ予約</button></section>
      <div class="plan"><h3 class="plan-title">特選コース</h3><p>13,020円（税込）</p><button>選択する</button></div>
      <div class="plan"><h3 class="plan-title">季節のコース</h3><p>16,590円（税込）</p><button>選択する</button></div>`);
    expect(result).toEqual({
      kind: "choose_plan",
      plans: [
        { label: "席のみ予約", price: null, button: { text: "席のみ予約", occurrence: 0 } },
        { label: "特選コース", price: "13,020円", button: { text: "選択する", occurrence: 0 } },
        { label: "季節のコース", price: "16,590円", button: { text: "選択する", occurrence: 1 } },
      ],
    });
  });

  test("a form step moves on with its next button, never a final one", () => {
    const result = page(`<form><input name="tel" value="0312345678"><button>予約内容を確認する</button><button>予約する</button></form>`);
    expect(result).toEqual({ kind: "form", missing: [], next: { text: "予約内容を確認する", occurrence: 0 } });
  });

  test("empty required fields stop the flow", () => {
    expect(page(`<button>次へ</button>`, undefined, ["電話番号"])).toEqual({
      kind: "form",
      missing: ["電話番号"],
      next: { text: "次へ", occurrence: 0 },
    });
  });

  test("a confirmation page with exactly one final button, and its summary", () => {
    const result = page(`
      <table><tr><th>来店日時</th><td>2026年10月24日(土) 16:00</td></tr><tr><th>人数</th><td>2名</td></tr></table>
      <dl><dt>キャンセル規定</dt><dd>前日 50%</dd></dl>
      <button>予約を確定する</button>`);
    expect(result.kind).toBe("confirm");
    if (result.kind !== "confirm") return;
    expect(result.confirm).toEqual({ text: "予約を確定する", occurrence: 0 });
    expect(result.summary.fields).toEqual({ 来店日時: "2026年10月24日(土) 16:00", 人数: "2名", キャンセル規定: "前日 50%" });
  });

  test("two final buttons is not a page it understands", () => {
    expect(page(`<button>予約を確定する</button><a>この内容で予約する</a>`).kind).toBe("unknown");
  });

  test("card entry, by field or payment frame, is card_required", () => {
    expect(page(`<input name="card_number"><button>予約を確定する</button>`).kind).toBe("card_required");
    expect(page(`<iframe src="https://pay.veritrans.co.jp/x"></iframe><button>次へ</button>`).kind).toBe("card_required");
  });

  test("a completion page, with the reservation number", () => {
    expect(page(`<h1>予約が完了しました</h1><p>予約番号：TB-12345678</p>`)).toMatchObject({
      kind: "complete",
      reservationNumber: "TB-12345678",
    });
  });

  test("anything else is unknown", () => {
    expect(page(`<p>メンテナンス中です</p>`).kind).toBe("unknown");
  });
});

describe("summaryMatchesRequest", () => {
  const summary = { fields: { 来店日時: "2026年10月24日(土) 16:00", 人数: "2名" }, excerpt: "" };

  test("the summary names the requested date, time, and party", () => {
    expect(summaryMatchesRequest(summary, { date: "2026-10-24", time: "16:00", party: 2 })).toBe(true);
  });

  test("a different party, time, or date does not match", () => {
    expect(summaryMatchesRequest(summary, { date: "2026-10-24", time: "16:00", party: 12 })).toBe(false);
    expect(summaryMatchesRequest(summary, { date: "2026-10-24", time: "16:30", party: 2 })).toBe(false);
    expect(summaryMatchesRequest(summary, { date: "2026-10-25", time: "16:00", party: 2 })).toBe(false);
  });
});
