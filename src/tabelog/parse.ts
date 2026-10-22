// Pure parsers for Tabelog's Japanese pages and JSON. Every selector the
// server depends on lives here, so a Tabelog redesign has one place to fix,
// and tests/fixtures holds real pages to check against.

import { type HTMLElement, parse } from "node-html-parser";
import { z } from "zod";
import { TabelogError } from "../errors.ts";

const text = (element: HTMLElement | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const number = (value: string): number | null => {
  const parsed = Number(value.replace(/[,，\s]/g, ""));
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : null;
};

/** Tabelog's block page, served with HTTP 403 when Cloudflare refuses a visitor. */
export function isBlockedPage(html: string): boolean {
  return html.includes("現在アクセスが集中しています");
}

/** Cloudflare's "please wait" check, which a normal browser passes on its own within seconds. */
export function isChallengePage(title: string): boolean {
  return /しばらくお待ちください|Just a moment/.test(title);
}

export type LoginState = "signed_in" | "signed_out" | "unknown";

/** Restaurant and list pages carry the login state for the booking widget. */
export function parseLoginState(html: string): LoginState {
  const root = parse(html);
  const marker = root.getElementById("js-login-request")?.getAttribute("data-user-login");
  if (marker === "false") return "signed_out";
  if (marker === "true") return "signed_in";
  const tel = root.getElementById("js-tel-call")?.getAttribute("data-user-login");
  if (tel === "nologin") return "signed_out";
  if (tel) return "signed_in";
  return "unknown";
}

export type SlotState = "open" | "full";

export interface ListSlot {
  readonly time: string;
  readonly state: SlotState;
}

export interface RestaurantSummary {
  readonly rst_id: string;
  readonly name: string;
  readonly url: string;
  /** Station distance and genres, as Tabelog lists them: "銀座駅 205m / 寿司". */
  readonly area_genre: string;
  readonly score: number | null;
  readonly review_count: number | null;
  readonly budget_dinner: string | null;
  readonly budget_lunch: string | null;
  readonly awards: readonly string[];
  /** Online-booking times shown around the searched time, when a date was searched. */
  readonly slots: readonly ListSlot[];
}

export interface SearchPage {
  readonly total: number | null;
  readonly restaurants: readonly RestaurantSummary[];
  readonly has_next_page: boolean;
}

export function parseSearchPage(html: string): SearchPage {
  const root = parse(html);
  const cards = root.querySelectorAll(".js-rst-cassette-wrap");
  const restaurants = cards.flatMap((card): RestaurantSummary[] => {
    const rstId = card.getAttribute("data-rst-id");
    const nameLink = card.querySelector(".list-rst__rst-name-target");
    const url = nameLink?.getAttribute("href") ?? card.getAttribute("data-detail-url");
    if (!rstId || !url || !nameLink) return [];
    const budget = (label: string): string | null => {
      for (const item of card.querySelectorAll(".list-rst__info-item")) {
        if (item.querySelector(`[aria-label="${label}"]`)) return text(item.querySelector(".c-rating-v3__val")) || null;
      }
      return null;
    };
    const slots = card.querySelectorAll(".flexible-bookable-time__btn").flatMap((button): ListSlot[] => {
      const time = text(button);
      if (!/^\d{1,2}:\d{2}$/.test(time)) return [];
      return [{ time, state: button.tagName === "A" ? "open" : "full" }];
    });
    return [
      {
        rst_id: rstId,
        name: text(nameLink),
        url,
        area_genre: text(card.querySelector(".list-rst__area-genre")),
        score: number(text(card.querySelector(".list-rst__rating-val"))),
        review_count: number(text(card.querySelector(".list-rst__rvw-count-num"))),
        budget_dinner: budget("夜の予算"),
        budget_lunch: budget("昼の予算"),
        awards: [
          ...card.querySelectorAll(".c-badge-award i, .c-badge-hyakumeiten i").map((badge) => text(badge)),
        ].filter(Boolean),
        slots,
      },
    ];
  });
  const counts = root.querySelectorAll(".c-page-count__num strong").map((element) => number(text(element)));
  const total = counts.at(-1) ?? null;
  const shownTo = counts.at(-2) ?? null;
  const hasNext = root.querySelector(".c-pagination__arrow--next") !== null || (total !== null && shownTo !== null && shownTo < total);
  if (restaurants.length === 0 && !html.includes("c-page-count") && !html.includes("該当するお店はありません")) {
    throw new TabelogError("PAGE_CHANGED", "The search page had no recognizable restaurant list.", { stage: "search_list" });
  }
  return { total, restaurants, has_next_page: hasNext };
}

export interface RestaurantDetail {
  readonly rst_id: string;
  readonly name: string;
  readonly score: number | null;
  /** From the page's print link; null if Tabelog has no map pin for the restaurant. */
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** The restaurant information table, label to text: 予約可否, 営業時間, 予算, 個室, 支払い方法, … */
  readonly info: Readonly<Record<string, string>>;
  readonly online_booking: boolean;
}

/** Info-table rows that are noise for an agent. */
const skippedInfoRows = new Set(["関連店舗情報", "初投稿者", "最近の編集者"]);

export function parseRestaurantPage(html: string, rstId: string): RestaurantDetail {
  const root = parse(html);
  const info: Record<string, string> = {};
  for (const row of root.querySelectorAll(".rstinfo-table__table tr, .rstinfo-table tr")) {
    const label = text(row.querySelector("th"));
    const value = text(row.querySelector("td"))
      .replace(/大きな地図を見る.*$/, "")
      .replace(/利用金額分布を見る/, "")
      .trim();
    if (label && value && !skippedInfoRows.has(label) && !(label in info)) info[label] = value;
  }
  const name = info.店名 ?? text(root.querySelector(".display-name")) ?? "";
  if (!name) throw new TabelogError("PAGE_CHANGED", "The restaurant page had no name.", { stage: "restaurant_info" });
  const bookingParams = root.getElementById("js-booking-params");
  const pin = /rstdtl_print\?lat=(-?\d+(?:\.\d+)?)&(?:amp;)?lng=(-?\d+(?:\.\d+)?)/.exec(html);
  return {
    rst_id: rstId,
    name,
    score: number(text(root.querySelector(".rdheader-rating__score-val-dtl"))),
    location: pin ? { lat: Number(pin[1]), lng: Number(pin[2]) } : null,
    info,
    online_booking: bookingParams?.getAttribute("data-booking-enabled") === "1",
  };
}

// Availability JSON from /booking/calendar/*. The site's own calendar treats
// 1 and 2 as bookable; 1 shows as "few left".
const availability = z.union([z.literal(0), z.literal(1), z.literal(2)]).catch(0);
export type DayState = "open" | "few_left" | "full";
const dayState = (value: 0 | 1 | 2): DayState => (value === 2 ? "open" : value === 1 ? "few_left" : "full");

const dateEntry = z.object({
  year: z.number(),
  month: z.number(),
  day: z.number(),
  available: availability,
  holiday: z.boolean().optional(),
});

const isoDate = (entry: { year: number; month: number; day: number }): string =>
  `${entry.year}-${String(entry.month).padStart(2, "0")}-${String(entry.day).padStart(2, "0")}`;

export interface CalendarDay {
  readonly date: string;
  readonly state: DayState;
  readonly holiday: boolean;
}

export function parseCalendar(json: unknown): CalendarDay[] {
  const parsed = z.object({ date_with_status: z.object({ dateList: z.array(dateEntry) }) }).safeParse(json);
  if (!parsed.success) throw new TabelogError("PAGE_CHANGED", "Tabelog's calendar response changed shape.", { stage: "calendar" });
  return parsed.data.date_with_status.dateList.map((entry) => ({
    date: isoDate(entry),
    state: dayState(entry.available),
    holiday: entry.holiday ?? false,
  }));
}

export interface TimeSlot {
  readonly time: string;
}

export function parseSlots(json: unknown): TimeSlot[] {
  const parsed = z
    .object({ selection: z.record(z.string(), z.object({ time: z.string(), url: z.string() })).or(z.array(z.unknown())) })
    .safeParse(json);
  if (!parsed.success) throw new TabelogError("PAGE_CHANGED", "Tabelog's time-slot response changed shape.", { stage: "slots" });
  const selection = parsed.data.selection;
  if (Array.isArray(selection)) return [];
  return Object.values(selection)
    .filter((slot) => /^\d{1,2}:\d{2}$/.test(slot.time))
    .map((slot) => ({ time: slot.time.padStart(5, "0") }));
}

export interface PartyOption {
  readonly party: number;
  readonly state: DayState;
}

export function parsePartyOptions(json: unknown): PartyOption[] {
  const parsed = z.object({ svpsOpts: z.array(z.object({ member_num: z.number(), status: availability })) }).safeParse(json);
  if (!parsed.success) throw new TabelogError("PAGE_CHANGED", "Tabelog's party-size response changed shape.", { stage: "party" });
  return parsed.data.svpsOpts.map((option) => ({ party: option.member_num, state: dayState(option.status) }));
}

export interface AreaSuggestion {
  readonly name: string;
  /** RailroadStation, Town, Area, … as Tabelog labels it. */
  readonly datatype: string;
  readonly id: number;
  /** Stations carry coordinates; towns usually do not. */
  readonly lat?: number;
  readonly lng?: number;
}

export function parseAreaSuggestions(json: unknown): AreaSuggestion[] {
  if (json && typeof json === "object" && "suggest_empty" in json) return [];
  const parsed = z
    .array(
      z.object({
        name: z.string(),
        datatype: z.string(),
        id_in_datatype: z.number(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      }),
    )
    .safeParse(json);
  if (!parsed.success) throw new TabelogError("PAGE_CHANGED", "Tabelog's area suggestions changed shape.", { stage: "area" });
  return parsed.data.map((entry) => ({
    name: entry.name,
    datatype: entry.datatype,
    id: entry.id_in_datatype,
    ...(typeof entry.lat === "number" && typeof entry.lng === "number" ? { lat: entry.lat, lng: entry.lng } : {}),
  }));
}
