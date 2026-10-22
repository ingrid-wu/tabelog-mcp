import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  isBlockedPage,
  isChallengePage,
  parseAreaSuggestions,
  parseCalendar,
  parseLoginState,
  parsePartyOptions,
  parseRestaurantPage,
  parseSearchPage,
  parseSlots,
} from "../src/tabelog/parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

describe("search page (銀座駅, 寿司, 2026-10-24 19:00, 2 people)", () => {
  const page = parseSearchPage(fixture("search.html"));

  test("reads every result card and Tabelog's total", () => {
    expect(page.restaurants).toHaveLength(20);
    expect(page.total).toBe(126);
    expect(page.has_next_page).toBe(true);
  });

  test("each card has an id, a canonical restaurant URL, and a score", () => {
    for (const restaurant of page.restaurants) {
      expect(restaurant.url).toMatch(new RegExp(`^https://tabelog\\.com/tokyo/A\\d{4}/A\\d{6}/${restaurant.rst_id}/$`));
      expect(restaurant.name.length).toBeGreaterThan(0);
      expect(restaurant.score).toBeGreaterThan(3);
      expect(restaurant.area_genre).toContain("寿司");
    }
  });

  test("bookable times are links; taken times are not", () => {
    const slots = page.restaurants.flatMap((restaurant) => restaurant.slots);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.time).toMatch(/^\d{1,2}:\d{2}$/);
    expect(new Set(slots.map((slot) => slot.state))).toContain("open");
  });
});

describe("restaurant page (焼肉うしごろ 銀座店)", () => {
  const detail = parseRestaurantPage(fixture("restaurant.html"), "13263391");

  test("reads the name, score, and info table", () => {
    expect(detail.name).toBe("焼肉うしごろ 銀座店");
    expect(detail.score).toBe(3.69);
    expect(detail.info.ジャンル).toBe("焼肉、ステーキ、ホルモン");
    expect(detail.info.予約可否).toBe("予約可");
    expect(detail.info.住所).toMatch(/^東京都中央区銀座1-8-19/);
    expect(detail.info.住所).not.toContain("大きな地図を見る");
    expect(detail.online_booking).toBe(true);
    expect(detail.location).toEqual({ lat: 35.67436693791574, lng: 139.7687324831517 });
  });

  test("leaves out noise rows", () => {
    expect(detail.info).not.toHaveProperty("初投稿者");
  });

  test("a logged-out page says signed_out", () => {
    expect(parseLoginState(fixture("restaurant.html"))).toBe("signed_out");
  });
});

describe("availability JSON", () => {
  test("calendar days map Tabelog's 0/1/2 to full/few_left/open", () => {
    const days = parseCalendar(json("initial-vacancy.json"));
    expect(days[0]).toEqual({ date: "2026-10-23", state: "few_left", holiday: false });
    expect(days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date))).toBe(true);
  });

  test("time slots for one date and party", () => {
    expect(parseSlots(json("vacancy.json"))).toEqual([{ time: "11:30" }, { time: "16:00" }, { time: "16:30" }]);
  });

  test("an empty selection means no times", () => {
    expect(parseSlots({ selection: [] })).toEqual([]);
  });

  test("party sizes open on a date", () => {
    const options = parsePartyOptions(json("members.json"));
    expect(options.find((option) => option.party === 2)?.state).toBe("open");
    expect(options.find((option) => option.party === 7)?.state).toBe("full");
  });

  test("a changed response shape fails loudly instead of returning nothing", () => {
    expect(() => parseCalendar({ dates: [] })).toThrow(/changed shape/);
  });
});

describe("area suggestions", () => {
  test("銀座 resolves to the station first, then towns", () => {
    const areas = parseAreaSuggestions(json("suggest-ginza.json"));
    expect(areas[0]).toEqual({ name: "銀座駅", datatype: "RailroadStation", id: 3368, lat: 35.66865555555555, lng: 139.7673638888889 });
    expect(areas.some((area) => area.datatype === "Town")).toBe(true);
  });

  test("no match is an empty list", () => {
    expect(parseAreaSuggestions({ suggest_empty: true })).toEqual([]);
  });
});

test("recognizes Cloudflare's check and Tabelog's block page", () => {
  expect(isChallengePage("しばらくお待ちください...")).toBe(true);
  expect(isChallengePage("焼肉うしごろ 銀座店のご予約 | 食べログ")).toBe(false);
  expect(isBlockedPage("<title>現在アクセスが集中しています [食べログ]</title>")).toBe(true);
  expect(isBlockedPage(fixture("restaurant.html"))).toBe(false);
});
