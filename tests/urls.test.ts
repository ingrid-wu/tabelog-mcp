import { describe, expect, test } from "vitest";
import { bookingFormUrl, budgetStep, pagedListUrl, parseRestaurantUrl, searchUrl } from "../src/tabelog/urls.ts";

describe("parseRestaurantUrl", () => {
  test("accepts canonical restaurant pages, with or without trailing slash or query", () => {
    for (const input of [
      "https://tabelog.com/tokyo/A1301/A130101/13263391/",
      "https://tabelog.com/tokyo/A1301/A130101/13263391",
      "https://tabelog.com/tokyo/A1301/A130101/13263391/?lid=x",
    ]) {
      expect(parseRestaurantUrl(input)).toEqual({ rstId: "13263391", url: "https://tabelog.com/tokyo/A1301/A130101/13263391/" });
    }
  });

  test("rejects anything else, so no tool can send the browser to an arbitrary page", () => {
    for (const input of [
      "https://evil.example/tokyo/A1301/A130101/13263391/",
      "https://tabelog.com.evil.example/tokyo/A1301/A130101/13263391/",
      "http://tabelog.com/tokyo/A1301/A130101/13263391/",
      "https://tabelog.com/booking/form/new?rcd=13263391",
      "https://tabelog.com/tokyo/A1301/A130101/13263391/dtlrvwlst/",
      "javascript:alert(1)",
    ]) {
      expect(() => parseRestaurantUrl(input)).toThrow(/restaurant_url/);
    }
  });
});

test("search URL carries the area id and every filter in Tabelog's parameter names", () => {
  const url = new URL(
    searchUrl({
      area: { name: "銀座駅", datatype: "RailroadStation", id: 3368 },
      keyword: "寿司",
      date: "2026-10-24",
      time: "19:00",
      party: 2,
      onlineBookingOnly: true,
      privateRoom: true,
      budgetMax: 12_000,
      sort: "rating",
    }),
  );
  expect(url.origin + url.pathname).toBe("https://tabelog.com/rst/rstsearch");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    sa: "銀座駅",
    area_datatype: "RailroadStation",
    area_id: "3368",
    sk: "寿司",
    svd: "20261024",
    svt: "1900",
    svps: "2",
    vac_net: "1",
    ChkRoom: "1",
    RdoCosTp: "2",
    LstCosT: "9",
    SrtT: "rt",
  });
});

test("budget rounds up to Tabelog's next step", () => {
  expect(budgetStep(10_000)).toBe("8");
  expect(budgetStep(12_000)).toBe("9");
  expect(budgetStep(1_000)).toBe("1");
});

test("page 2 of a list page", () => {
  expect(pagedListUrl("https://tabelog.com/tokyo/A1301/A130101/R3368/rstLst/?sk=x", 2)).toBe(
    "https://tabelog.com/tokyo/A1301/A130101/R3368/rstLst/2/?sk=x",
  );
  expect(pagedListUrl("https://tabelog.com/tokyo/A1301/A130101/R3368/rstLst/3/?sk=x", 4)).toBe(
    "https://tabelog.com/tokyo/A1301/A130101/R3368/rstLst/4/?sk=x",
  );
});

test("booking form URL", () => {
  expect(bookingFormUrl("13263391", "2026-10-24", "16:00", 2)).toBe(
    "https://tabelog.com/booking/form/new?member=2&rcd=13263391&visit_date=20261024&visit_time=1600",
  );
});
