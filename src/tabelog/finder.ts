// "A private room for 7 within 15 minutes of A and B, in the next 3 days, for
// dinner." Tabelog searches one area at a time and knows nothing about walking
// time, so this seeds candidates from each location's area, keeps those within
// walking range of every location, and then checks real booking slots.

import type { BrowserSession } from "../browser/session.ts";
import { TabelogError } from "../errors.ts";
import { type Point, parseLatLng, walkingMinutes } from "./geo.ts";
import { parseAreaSuggestions, parseRestaurantPage, parseSearchPage, parseSlots, type AreaSuggestion, type RestaurantSummary } from "./parse.ts";
import type { CachedPlace, PlaceCache } from "./place-cache.ts";
import { parseRestaurantUrl, searchUrl, toSvd } from "./urls.ts";

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
}

export interface FindRequest {
  /** Japanese station or place names (丸の内, 渋谷駅), or "lat,lng". */
  readonly locations: readonly string[];
  readonly maxWalkMinutes: number;
  readonly party: number;
  readonly dates: readonly string[];
  readonly window: TimeWindow;
  readonly privateRoom: boolean;
  readonly keyword?: string;
  readonly budgetMax?: number;
  readonly maxResults: number;
}

export interface ResolvedLocation {
  readonly query: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly area: AreaSuggestion | null;
}

export interface FoundRestaurant {
  readonly rst_id: string;
  readonly name: string;
  readonly url: string;
  readonly score: number | null;
  readonly genre: string | null;
  readonly budget_dinner: string | null;
  /** Tabelog's 個室 row, e.g. "有 （2人可、4人可、6人可、8人可）". */
  readonly private_room: string | null;
  /** Whether a listed room holds the party; null when Tabelog does not say. */
  readonly room_fits_party: boolean | null;
  readonly walk_minutes: readonly { readonly location: string; readonly minutes: number }[];
  readonly open_slots: readonly { readonly date: string; readonly times: readonly string[] }[];
}

export interface FindResult {
  readonly locations: readonly ResolvedLocation[];
  readonly criteria: {
    readonly party: number;
    readonly dates: readonly string[];
    readonly window: TimeWindow;
    readonly private_room: boolean;
    readonly max_walk_minutes: number;
    readonly walking_estimate: string;
  };
  readonly results: readonly FoundRestaurant[];
  readonly checked: { readonly candidates: number; readonly within_walk: number; readonly with_slots: number };
}

/** Candidates whose pages are fetched for location and room info. */
const maxCandidates = 30;

/**
 * Whether Tabelog's 個室 row lists a room for this many people: "6人可" is a
 * room for up to 6, "10～20人可" one for 10 to 20, "30人以上可" 30 or more.
 * Null when the row does not say.
 */
export function roomFitsParty(privateRoom: string | null, party: number): boolean | null {
  if (!privateRoom || !privateRoom.startsWith("有")) return privateRoom?.startsWith("無") ? false : null;
  const sizes = [...privateRoom.normalize("NFKC").matchAll(/(\d+)(?:\s*[~〜～-]\s*(\d+))?\s*人(以上)?可/g)];
  if (sizes.length === 0) return null;
  return sizes.some(([, low, high, orMore]) => {
    const min = high ? Number(low) : orMore ? Number(low) : 1;
    const max = high ? Number(high) : orMore ? Number.POSITIVE_INFINITY : Number(low);
    return party >= min && party <= max;
  });
}

export function inWindow(time: string, window: TimeWindow): boolean {
  const padded = time.padStart(5, "0");
  return padded >= window.start && padded <= window.end;
}

/** The half hour nearest the middle of the window, which Tabelog's list centres its slots on. */
export function windowMidpoint(window: TimeWindow): string {
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const middle = Math.round((minutes(window.start) + minutes(window.end)) / 2 / 30) * 30;
  return `${String(Math.floor(middle / 60)).padStart(2, "0")}:${String(middle % 60).padStart(2, "0")}`;
}

export class RestaurantFinder {
  constructor(
    private readonly browser: BrowserSession,
    private readonly places: PlaceCache,
  ) {}

  async find(request: FindRequest, onProgress: (message: string) => void = () => undefined): Promise<FindResult> {
    if (request.window.start >= request.window.end) {
      throw new TabelogError("INVALID_INPUT", "The time window must start before it ends, within one day.", { argument: "window" });
    }
    return this.browser.exclusive(async (browser) => {
      const locations: ResolvedLocation[] = [];
      for (const query of request.locations) locations.push(await resolveLocation(browser, query));
      const seeds = locations.filter((location) => location.area);
      if (seeds.length === 0) {
        throw new TabelogError("AREA_NOT_FOUND", "At least one location must be a place Tabelog knows (a station or neighbourhood), not only coordinates.");
      }

      // 1. Candidates: restaurants bookable online near each location on each date.
      const candidates = new Map<string, RestaurantSummary>();
      for (const location of seeds) {
        for (const date of request.dates) {
          onProgress(`Searching near ${location.name} on ${date}`);
          const page = await browser.goto(
            searchUrl({
              ...(location.area ? { area: location.area } : {}),
              ...(request.keyword ? { keyword: request.keyword } : {}),
              date,
              time: windowMidpoint(request.window),
              party: request.party,
              onlineBookingOnly: true,
              privateRoom: request.privateRoom,
              ...(request.budgetMax ? { budgetMax: request.budgetMax } : {}),
              sort: "rating",
            }),
          );
          for (const restaurant of parseSearchPage(page.html).restaurants) {
            if (!candidates.has(restaurant.rst_id)) candidates.set(restaurant.rst_id, restaurant);
          }
        }
      }
      const ranked = [...candidates.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, maxCandidates);

      // 2. Walking range from every location, from each restaurant's map pin.
      const nearby: { summary: RestaurantSummary; place: CachedPlace; walks: { location: string; minutes: number }[] }[] = [];
      for (const [index, summary] of ranked.entries()) {
        let place = this.places.get(summary.rst_id);
        if (!place) {
          onProgress(`Checking location ${index + 1}/${ranked.length}: ${summary.name}`);
          const ref = parseRestaurantUrl(summary.url);
          const detail = parseRestaurantPage((await browser.goto(ref.url)).html, ref.rstId);
          place = {
            name: detail.name,
            location: detail.location,
            private_room: detail.info.個室 ?? null,
            genre: detail.info.ジャンル ?? null,
            address: detail.info.住所 ?? null,
            fetched_at: new Date().toISOString(),
          };
          this.places.set(summary.rst_id, place);
        }
        if (!place.location) continue;
        const pin: Point = place.location;
        const walks = locations.map((location) => ({ location: location.name, minutes: walkingMinutes(location, pin) }));
        if (walks.every((walk) => walk.minutes <= request.maxWalkMinutes)) nearby.push({ summary, place, walks });
      }
      this.places.save();

      // 3. Real slots in the window, best-rated first, until enough are found.
      // A private-room search skips restaurants whose rooms are all too small or too big.
      const results: FoundRestaurant[] = [];
      for (const { summary, place, walks } of nearby) {
        if (request.privateRoom && roomFitsParty(place.private_room, request.party) === false) continue;
        if (results.length >= request.maxResults) break;
        onProgress(`Checking open times: ${summary.name}`);
        const openSlots: { date: string; times: string[] }[] = [];
        for (const date of request.dates) {
          const slots = parseSlots(
            await browser.fetchJson(`/booking/calendar/find_vacancy/?rst_id=${summary.rst_id}&svd=${toSvd(date)}&svps=${request.party}`),
          );
          const times = slots.map((slot) => slot.time).filter((time) => inWindow(time, request.window));
          if (times.length > 0) openSlots.push({ date, times });
        }
        if (openSlots.length === 0) continue;
        results.push({
          rst_id: summary.rst_id,
          name: summary.name,
          url: summary.url,
          score: summary.score,
          genre: place.genre,
          budget_dinner: summary.budget_dinner,
          private_room: place.private_room,
          room_fits_party: roomFitsParty(place.private_room, request.party),
          walk_minutes: walks,
          open_slots: openSlots,
        });
      }

      return {
        locations,
        criteria: {
          party: request.party,
          dates: request.dates,
          window: request.window,
          private_room: request.privateRoom,
          max_walk_minutes: request.maxWalkMinutes,
          walking_estimate: "Straight-line distance × 1.25 at 80 m/min. Not transit; Tabelog has no routing.",
        },
        results,
        checked: { candidates: ranked.length, within_walk: nearby.length, with_slots: results.length },
      };
    });
  }
}

async function resolveLocation(browser: BrowserSession, query: string): Promise<ResolvedLocation> {
  const point = parseLatLng(query);
  if (point) return { query, name: query, ...point, area: null };
  const suggestions = parseAreaSuggestions(await browser.fetchJson(`/internal_api/suggest_form_words?sa=${encodeURIComponent(query)}`));
  // Stations carry coordinates; prefer an exact name, then any station.
  const located = suggestions.filter((suggestion) => suggestion.lat !== undefined && suggestion.lng !== undefined);
  const pick = located.find((suggestion) => suggestion.name === query || suggestion.name === `${query}駅`) ?? located[0];
  if (!pick || pick.lat === undefined || pick.lng === undefined) {
    throw new TabelogError("AREA_NOT_FOUND", `Tabelog has no station or mapped place for "${query}".`, {
      location: query,
      suggestions: suggestions.slice(0, 5).map((suggestion) => suggestion.name),
    });
  }
  return { query, name: pick.name, lat: pick.lat, lng: pick.lng, area: pick };
}
