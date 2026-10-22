import type { BrowserSession } from "../browser/session.ts";
import { TabelogError } from "../errors.ts";
import {
  type AreaSuggestion,
  type CalendarDay,
  type LoginState,
  type PartyOption,
  parseAreaSuggestions,
  parseCalendar,
  parseLoginState,
  parsePartyOptions,
  parseRestaurantPage,
  parseSearchPage,
  parseSlots,
  type RestaurantDetail,
  type SearchPage,
  type TimeSlot,
} from "./parse.ts";
import { waitForLogin } from "./login.ts";
import { loginCheckUrl, pagedListUrl, parseRestaurantUrl, type SearchQuery, searchUrl, toSvd } from "./urls.ts";

export interface SearchRequest extends Omit<SearchQuery, "area"> {
  /** A Japanese place name, resolved through Tabelog's own area suggestions. */
  readonly area?: string;
}

export interface SearchResult extends SearchPage {
  readonly resolved_area: AreaSuggestion | null;
  /** Other places the area name could mean, so the agent can ask. */
  readonly other_areas: readonly AreaSuggestion[];
  readonly page: number;
  readonly list_url: string;
}

export interface Availability {
  readonly rst_id: string;
  readonly days: readonly CalendarDay[];
  readonly date: string | null;
  readonly party: number | null;
  readonly slots: readonly TimeSlot[];
  readonly party_options: readonly PartyOption[];
}

/** Read-only Tabelog operations. Each runs alone on the shared browser. */
export class TabelogClient {
  constructor(private readonly browser: BrowserSession) {}

  findArea(query: string): Promise<AreaSuggestion[]> {
    return this.browser.exclusive(async (browser) =>
      parseAreaSuggestions(await browser.fetchJson(`/internal_api/suggest_form_words?sa=${encodeURIComponent(query)}`)),
    );
  }

  search(request: SearchRequest): Promise<SearchResult> {
    return this.browser.exclusive(async (browser) => {
      let resolved: AreaSuggestion | null = null;
      let others: AreaSuggestion[] = [];
      if (request.area) {
        const suggestions = parseAreaSuggestions(
          await browser.fetchJson(`/internal_api/suggest_form_words?sa=${encodeURIComponent(request.area)}`),
        );
        if (suggestions.length === 0) {
          throw new TabelogError("AREA_NOT_FOUND", `Tabelog does not recognize the area "${request.area}".`, { area: request.area });
        }
        const exact = suggestions.find((suggestion) => suggestion.name === request.area);
        resolved = exact ?? suggestions[0] ?? null;
        others = suggestions.filter((suggestion) => suggestion !== resolved).slice(0, 5);
      }
      const page = request.page ?? 1;
      const { area: _areaName, ...filters } = request;
      const first = await browser.goto(searchUrl({ ...filters, ...(resolved ? { area: resolved } : {}) }));
      const listed = page > 1 ? await browser.goto(pagedListUrl(first.url, page)) : first;
      return {
        ...parseSearchPage(listed.html),
        resolved_area: resolved,
        other_areas: others,
        page,
        list_url: listed.url,
      };
    });
  }

  restaurant(restaurantUrl: string): Promise<RestaurantDetail> {
    const ref = parseRestaurantUrl(restaurantUrl);
    return this.browser.exclusive(async (browser) => parseRestaurantPage((await browser.goto(ref.url)).html, ref.rstId));
  }

  availability(restaurantUrl: string, date?: string, party?: number): Promise<Availability> {
    const { rstId } = parseRestaurantUrl(restaurantUrl);
    return this.browser.exclusive(async (browser) => {
      const days = parseCalendar(await browser.fetchJson(`/booking/calendar/initial_vacancy?rst_id=${rstId}`));
      if (!date) return { rst_id: rstId, days, date: null, party: party ?? null, slots: [], party_options: [] };
      const svd = toSvd(date);
      const partyOptions = parsePartyOptions(
        await browser.fetchJson(`/booking/calendar/find_vacancy_member_by_date/?rst_id=${rstId}&svd=${svd}`),
      );
      const slots = party
        ? parseSlots(await browser.fetchJson(`/booking/calendar/find_vacancy/?rst_id=${rstId}&svd=${svd}&svps=${party}`))
        : [];
      return { rst_id: rstId, days, date, party: party ?? null, slots, party_options: partyOptions };
    });
  }

  loginState(): Promise<LoginState> {
    return this.browser.exclusive(async (browser) => parseLoginState((await browser.goto(loginCheckUrl)).html));
  }

  login(timeoutMs: number, sessionPath: string, onProgress?: (message: string) => void): Promise<LoginState> {
    return this.browser.exclusive((browser) => waitForLogin(browser, { timeoutMs, sessionPath, ...(onProgress ? { onProgress } : {}) }));
  }
}
