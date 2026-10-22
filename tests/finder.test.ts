import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BrowserSession } from "../src/browser/session.ts";
import { parseLatLng, walkingMinutes } from "../src/tabelog/geo.ts";
import { inWindow, RestaurantFinder, roomFitsParty, windowMidpoint } from "../src/tabelog/finder.ts";
import { parseSearchPage } from "../src/tabelog/parse.ts";
import { PlaceCache } from "../src/tabelog/place-cache.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("walking time", () => {
  test("800 m on the map is about 1 km of street at 80 m/min: 13 minutes", () => {
    // 0.0072° of latitude is ~800 m.
    expect(walkingMinutes({ lat: 35.68, lng: 139.76 }, { lat: 35.6872, lng: 139.76 })).toBe(13);
  });

  test("the same place is 0 minutes", () => {
    expect(walkingMinutes({ lat: 35.68, lng: 139.76 }, { lat: 35.68, lng: 139.76 })).toBe(0);
  });

  test("coordinates can be typed as lat,lng", () => {
    expect(parseLatLng("35.6812, 139.7671")).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(parseLatLng("丸の内")).toBeNull();
    expect(parseLatLng("135,500")).toBeNull();
  });
});

describe("roomFitsParty (Tabelog's 個室 row)", () => {
  test("a room for up to 8 fits 7; rooms for 2 and 10-20 do not", () => {
    expect(roomFitsParty("有 （6人可、8人可）", 7)).toBe(true);
    expect(roomFitsParty("有 （2人可、10～20人可） 完全個室が3室ございます。", 7)).toBe(false);
  });
  test("ranges and 'or more'", () => {
    expect(roomFitsParty("有 （10～20人可、30人以上可）", 12)).toBe(true);
    expect(roomFitsParty("有 （10～20人可、30人以上可）", 40)).toBe(true);
    expect(roomFitsParty("有 （10～20人可、30人以上可）", 25)).toBe(false);
  });
  test("no rooms, or no sizes listed", () => {
    expect(roomFitsParty("無", 4)).toBe(false);
    expect(roomFitsParty("有", 4)).toBeNull();
    expect(roomFitsParty(null, 4)).toBeNull();
  });
});

describe("time window", () => {
  const dinner = { start: "17:00", end: "20:00" };
  test("includes both ends, excludes outside", () => {
    expect(["17:00", "18:30", "20:00"].every((time) => inWindow(time, dinner))).toBe(true);
    expect(["16:30", "20:30", "11:30"].some((time) => inWindow(time, dinner))).toBe(false);
  });
  test("searches centre on the window's middle half hour", () => {
    expect(windowMidpoint(dinner)).toBe("18:30");
    expect(windowMidpoint({ start: "19:00", end: "21:00" })).toBe("20:00");
  });
});

describe("RestaurantFinder", () => {
  const ginza = { lat: 35.6717, lng: 139.765 }; // 銀座駅
  const restaurants = parseSearchPage(fixture("search.html")).restaurants;

  /** Seeds the cache so no restaurant page is fetched: the first five sit at the station, the rest 2 km away. */
  function cacheWithPins(): PlaceCache {
    const cache = new PlaceCache(join(mkdtempSync(join(tmpdir(), "tabelog-places-")), "places.json"));
    restaurants.forEach((restaurant, index) => {
      const location = index < 5 ? ginza : { lat: ginza.lat + 0.018, lng: ginza.lng };
      cache.set(restaurant.rst_id, { name: restaurant.name, location, private_room: "有 （8人可）", genre: "寿司", address: null });
    });
    return cache;
  }

  function browser(slotsByRestaurant: (rstId: string) => string[]) {
    const fetched: string[] = [];
    const fake = {
      exclusive: <T>(operation: (session: unknown) => Promise<T>) => operation(fake),
      goto: async (url: string) => ({ status: 200, url, html: fixture("search.html") }),
      fetchJson: async (path: string) => {
        fetched.push(path);
        if (path.startsWith("/internal_api/suggest_form_words")) return JSON.parse(fixture("suggest-ginza.json"));
        const rstId = /rst_id=(\d+)/.exec(path)?.[1] ?? "";
        return { selection: Object.fromEntries(slotsByRestaurant(rstId).map((time, i) => [String(i), { time, url: "/x" }])) };
      },
    };
    return { fake: fake as unknown as BrowserSession, fetched };
  }

  const request = {
    locations: ["銀座", "35.6717,139.7650"],
    maxWalkMinutes: 15,
    party: 7,
    dates: ["2026-10-23", "2026-10-24"],
    window: { start: "17:00", end: "20:00" },
    privateRoom: true,
    maxResults: 3,
  };

  test("keeps restaurants within walking range of every location that have times in the window", async () => {
    const { fake } = browser(() => ["11:30", "17:30", "21:00"]);
    const result = await new RestaurantFinder(fake, cacheWithPins()).find(request);
    expect(result.locations.map((location) => location.name)).toEqual(["銀座駅", "35.6717,139.7650"]);
    expect(result.checked.within_walk).toBe(5);
    expect(result.results).toHaveLength(3);
    for (const found of result.results) {
      expect(found.walk_minutes.every((walk) => walk.minutes <= 15)).toBe(true);
      expect(found.open_slots).toEqual([
        { date: "2026-10-23", times: ["17:30"] },
        { date: "2026-10-24", times: ["17:30"] },
      ]);
      expect(found.private_room).toBe("有 （8人可）");
    }
    const scores = result.results.map((found) => found.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("drops restaurants with no time in the window", async () => {
    const { fake } = browser(() => ["11:30", "21:00"]);
    const result = await new RestaurantFinder(fake, cacheWithPins()).find(request);
    expect(result.results).toEqual([]);
    expect(result.checked.within_walk).toBe(5);
  });

  test("asks Tabelog for slots at the requested party size", async () => {
    const { fake, fetched } = browser(() => ["18:00"]);
    await new RestaurantFinder(fake, cacheWithPins()).find(request);
    expect(fetched.filter((path) => path.startsWith("/booking/calendar/find_vacancy/")).every((path) => path.includes("svps=7"))).toBe(true);
  });

  test("rejects a window that ends before it starts", async () => {
    const { fake } = browser(() => []);
    await expect(new RestaurantFinder(fake, cacheWithPins()).find({ ...request, window: { start: "20:00", end: "17:00" } })).rejects.toThrow(
      /window/,
    );
  });
});
