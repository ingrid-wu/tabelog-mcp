import { appendFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HistoryStore, summarizePreferences, toCsv } from "../src/history/store.ts";

const restaurant = (name: string, genre: string, area = "東京都 中央区 銀座") => ({
  rst_id: name,
  name,
  url: `https://tabelog.com/tokyo/A1301/A130101/${name}/`,
  genre,
  area,
  score: 3.6,
});

function store(now = new Date("2026-10-22T12:00:00Z")) {
  const path = join(mkdtempSync(join(tmpdir(), "tabelog-history-")), "history.jsonl");
  return { path, history: new HistoryStore(path, () => now) };
}

function prepare(history: HistoryStore, id: string, overrides: Partial<Parameters<HistoryStore["append"]>[0]> = {}) {
  history.append({
    type: "prepared",
    id,
    at: "2026-10-22T11:50:00Z",
    purpose: "personal",
    restaurant: restaurant("a", "寿司"),
    date: "2026-10-24",
    time: "19:00",
    party: 2,
    plan: null,
    price: null,
    summary: {},
    notes: null,
    ...overrides,
  } as Parameters<HistoryStore["append"]>[0]);
}

test("a booking's state is the fold of its events", () => {
  const { history } = store();
  prepare(history, "1", { notes: "anniversary" } as never);
  history.append({ type: "confirmed", id: "1", at: "2026-10-22T11:51:00Z", reservation_number: "R1" });
  history.append({ type: "note", id: "1", at: "2026-10-25T00:00:00Z", note: "loved the counter seats" });
  expect(history.bookings()).toEqual([
    expect.objectContaining({ id: "1", status: "confirmed", reservation_number: "R1", notes: ["anniversary", "loved the counter seats"] }),
  ]);
});

test("a prepared booking never confirmed within 30 minutes is abandoned", () => {
  const { history } = store(new Date("2026-10-22T12:30:00Z"));
  prepare(history, "1");
  expect(history.bookings()[0]?.status).toBe("abandoned");
});

test("a line cut short by a crash is skipped, not fatal", () => {
  const { path, history } = store();
  prepare(history, "1");
  appendFileSync(path, '{"type":"confirmed","id":"1","at":"2026');
  expect(history.bookings()).toHaveLength(1);
});

test("the history file is private to the user", () => {
  const { path, history } = store();
  prepare(history, "1");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("preferences come from confirmed bookings of one purpose only", () => {
  const { history } = store();
  const confirm = (id: string) => history.append({ type: "confirmed", id, at: "2026-10-22T11:55:00Z", reservation_number: null });
  prepare(history, "1", { restaurant: restaurant("a", "寿司、海鮮"), party: 2 } as never);
  confirm("1");
  prepare(history, "2", { restaurant: restaurant("a", "寿司、海鮮"), party: 4 } as never);
  confirm("2");
  prepare(history, "3", { purpose: "business", restaurant: restaurant("b", "焼肉"), party: 6, time: "18:30" } as never);
  confirm("3");
  prepare(history, "4", { restaurant: restaurant("c", "イタリアン") } as never);

  expect(summarizePreferences(history.bookings(), "personal")).toMatchObject({
    confirmed_bookings: 2,
    top_genres: ["寿司", "海鮮"],
    usual_party: 2,
    restaurants: [{ name: "a", visits: 2 }],
  });
  expect(summarizePreferences(history.bookings(), "business")).toMatchObject({ confirmed_bookings: 1, usual_time: "18:30" });
});

test("CSV export quotes commas and quotes", () => {
  const { history } = store();
  prepare(history, "1", { restaurant: restaurant('Bar "X", Ginza', "バー") } as never);
  expect(toCsv(history.bookings()).split("\n")[1]).toContain('"Bar ""X"", Ginza"');
});
