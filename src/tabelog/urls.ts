import { TabelogError } from "../errors.ts";

export const origin = "https://tabelog.com";

const restaurantPath = /^https:\/\/tabelog\.com\/([a-z]+)\/(A\d{4})\/(A\d{6})\/(\d{7,9})\/?$/;

export interface RestaurantRef {
  readonly rstId: string;
  /** Canonical restaurant page, always on tabelog.com. */
  readonly url: string;
}

/**
 * Accepts only canonical tabelog.com restaurant pages, so no tool can make the
 * browser open an arbitrary URL.
 */
export function parseRestaurantUrl(input: string): RestaurantRef {
  const trimmed = input.trim().replace(/[?#].*$/, "");
  const match = restaurantPath.exec(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  if (!match?.[4]) {
    throw new TabelogError(
      "INVALID_INPUT",
      "restaurant_url must be a tabelog.com restaurant page, e.g. https://tabelog.com/tokyo/A1301/A130101/13263391/.",
      { argument: "restaurant_url" },
    );
  }
  return { rstId: match[4], url: `${origin}/${match[1]}/${match[2]}/${match[3]}/${match[4]}/` };
}

/** YYYY-MM-DD to Tabelog's svd form (YYYYMMDD). */
export function toSvd(date: string): string {
  return date.replaceAll("-", "");
}

/** HH:MM to Tabelog's svt form (HHMM). */
export function toSvt(time: string): string {
  return time.replace(":", "");
}

export const sortKeys = {
  rating: "rt",
  trend: "trend",
  reviews: "rvcn",
  new: "nod",
} as const;
export type SortKey = keyof typeof sortKeys;

export interface SearchQuery {
  readonly area?: { readonly name: string; readonly datatype: string; readonly id: number };
  readonly keyword?: string;
  readonly date?: string;
  readonly time?: string;
  readonly party?: number;
  readonly onlineBookingOnly?: boolean;
  readonly privateRoom?: boolean;
  readonly budgetMax?: number;
  readonly budgetFor?: "dinner" | "lunch";
  readonly sort?: SortKey;
  readonly page?: number;
}

/** Tabelog's budget select values, upper bound in yen. */
export const budgetSteps: readonly (readonly [number, string])[] = [
  [1_000, "1"],
  [2_000, "2"],
  [3_000, "3"],
  [4_000, "4"],
  [5_000, "5"],
  [6_000, "6"],
  [8_000, "7"],
  [10_000, "8"],
  [15_000, "9"],
  [20_000, "10"],
  [30_000, "11"],
  [40_000, "12"],
  [50_000, "13"],
  [60_000, "14"],
  [80_000, "15"],
  [100_000, "16"],
];

/** The smallest Tabelog budget step at or above the requested maximum. */
export function budgetStep(yen: number): string | undefined {
  return budgetSteps.find(([limit]) => limit >= yen)?.[1];
}

/** The site's own search form endpoint; it redirects to the area's list page. */
export function searchUrl(query: SearchQuery): string {
  const params = new URLSearchParams();
  if (query.area) {
    params.set("sa", query.area.name);
    params.set("area_datatype", query.area.datatype);
    params.set("area_id", String(query.area.id));
  }
  if (query.keyword) params.set("sk", query.keyword);
  if (query.date) params.set("svd", toSvd(query.date));
  if (query.time) params.set("svt", toSvt(query.time));
  if (query.party) params.set("svps", String(query.party));
  if (query.onlineBookingOnly) params.set("vac_net", "1");
  if (query.privateRoom) params.set("ChkRoom", "1");
  if (query.budgetMax) {
    const step = budgetStep(query.budgetMax);
    if (step) {
      params.set("RdoCosTp", query.budgetFor === "lunch" ? "1" : "2");
      params.set("LstCosT", step);
    }
  }
  params.set("SrtT", sortKeys[query.sort ?? "rating"]);
  return `${origin}/rst/rstsearch?${params.toString()}`;
}

/** Page N of a list page Tabelog redirected to. */
export function pagedListUrl(listUrl: string, page: number): string {
  if (page <= 1) return listUrl;
  const url = new URL(listUrl);
  url.pathname = url.pathname.replace(/\/rstLst\/(\d+\/)?$/, `/rstLst/${page}/`);
  return url.toString();
}

export function bookingFormUrl(rstId: string, date: string, time: string, party: number): string {
  const params = new URLSearchParams({
    member: String(party),
    rcd: rstId,
    visit_date: toSvd(date),
    visit_time: toSvt(time),
  });
  return `${origin}/booking/form/new?${params.toString()}`;
}

export const loginUrl = `${origin}/account/login/`;

/** Any restaurant page carries the booking widget's login marker. */
export const loginCheckUrl = `${origin}/tokyo/A1301/A130101/13263391/`;
