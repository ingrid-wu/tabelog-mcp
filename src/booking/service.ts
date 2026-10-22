import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserSession } from "../browser/session.ts";
import { TabelogError } from "../errors.ts";
import { type HistoryStore, type Purpose } from "../history/store.ts";
import type { Logger } from "../logger.ts";
import { parseRestaurantPage, parseSlots, type RestaurantDetail } from "../tabelog/parse.ts";
import { bookingFormUrl, parseRestaurantUrl, toSvd } from "../tabelog/urls.ts";
import { type BookingPage, type BookingSummary, type PlanOption, readBookingPage, summaryMatchesRequest } from "./page.ts";

export interface BookingRequest {
  readonly restaurantUrl: string;
  readonly date: string;
  readonly time: string;
  readonly party: number;
  readonly purpose: Purpose;
  /** "seat_only", or part of a course name from a choose_plan result. */
  readonly plan?: string;
  readonly notes?: string;
}

export type HandoffReason = "card_required" | "form_fields" | "summary_unverified" | "unrecognized_page" | "unexpected_completion";

export type PrepareResult =
  | { readonly status: "needs_login" }
  | { readonly status: "choose_plan"; readonly plans: readonly { label: string; price: string | null }[] }
  | {
      readonly status: "needs_user";
      readonly reason: HandoffReason;
      readonly booking_id: string;
      readonly handoff_url: string;
      readonly missing_fields: readonly string[];
    }
  | {
      readonly status: "ready";
      readonly booking_id: string;
      readonly confirmation_token: string;
      readonly expires_in_seconds: number;
      readonly restaurant: string;
      readonly summary: BookingSummary;
    };

export type ConfirmResult =
  | { readonly status: "confirmed"; readonly booking_id: string; readonly reservation_number: string | null; readonly excerpt: string }
  | { readonly status: "needs_user"; readonly reason: HandoffReason; readonly booking_id: string; readonly handoff_url: string }
  | { readonly status: "unclear"; readonly booking_id: string; readonly page_title: string };

interface PendingBooking {
  readonly bookingId: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

const tokenLifetimeMs = 5 * 60_000;
/** Plan choice, guest form, confirmation: a few steps, with slack. */
const maxSteps = 8;

function todayInTokyo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function choosePlan(plans: readonly PlanOption[], wanted: string): PlanOption | undefined {
  if (wanted === "seat_only") return plans.find((plan) => plan.label === "席のみ予約");
  const needle = wanted.normalize("NFKC").toLowerCase();
  const matches = plans.filter((plan) => plan.label.normalize("NFKC").toLowerCase().includes(needle));
  return matches.length === 1 ? matches[0] : undefined;
}

function sameFields(first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every((key) => first[key] === second[key]);
}

/**
 * Two-step booking. prepare() drives Tabelog's form up to, never through, the
 * final button and returns a single-use token; confirm() clicks the final
 * button only for a live token whose confirmation page is unchanged.
 */
export class BookingService {
  private readonly pending = new Map<string, PendingBooking>();

  constructor(
    private readonly browser: BrowserSession,
    private readonly history: HistoryStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(request: BookingRequest): Promise<PrepareResult> {
    const ref = parseRestaurantUrl(request.restaurantUrl);
    if (request.date < todayInTokyo(this.now())) {
      throw new TabelogError("INVALID_INPUT", "date is in the past (Japan time).", { argument: "date" });
    }
    return this.browser.exclusive(async (browser) => {
      const detail = parseRestaurantPage((await browser.goto(ref.url)).html, ref.rstId);
      const slots = parseSlots(
        await browser.fetchJson(`/booking/calendar/find_vacancy/?rst_id=${ref.rstId}&svd=${toSvd(request.date)}&svps=${request.party}`),
      );
      if (!slots.some((slot) => slot.time === request.time)) {
        throw new TabelogError("SLOT_UNAVAILABLE", `${request.time} is not open for ${request.party} on ${request.date}.`, {
          open_times: slots.map((slot) => slot.time),
        });
      }

      const bookingId = randomUUID();
      let chosenPlan: PlanOption | undefined;
      let prepared = false;
      const record = (page: { plan: string | null; price: string | null; summary: Record<string, string> }): void => {
        if (prepared) return;
        prepared = true;
        this.history.append({
          type: "prepared",
          id: bookingId,
          at: this.now().toISOString(),
          purpose: request.purpose,
          restaurant: restaurantForHistory(detail, ref.url),
          date: request.date,
          time: request.time,
          party: request.party,
          plan: page.plan,
          price: page.price,
          summary: page.summary,
          notes: request.notes ?? null,
        });
      };
      const handOff = (reason: HandoffReason, missing: readonly string[] = []): PrepareResult => {
        record({ plan: chosenPlan?.label ?? null, price: chosenPlan?.price ?? null, summary: {} });
        this.history.append({ type: "handed_off", id: bookingId, at: this.now().toISOString(), reason });
        return {
          status: "needs_user",
          reason,
          booking_id: bookingId,
          handoff_url: browser.currentUrl("booking") ?? bookingFormUrl(ref.rstId, request.date, request.time, request.party),
          missing_fields: missing,
        };
      };

      await browser.goto(bookingFormUrl(ref.rstId, request.date, request.time, request.party), { tab: "booking" });
      for (let step = 0; step < maxSteps; step += 1) {
        const page: BookingPage = readBookingPage(await browser.snapshot("booking"));
        this.logger.info("booking step", { step, kind: page.kind });
        switch (page.kind) {
          case "login_required":
            return { status: "needs_login" };
          case "choose_plan": {
            const plan = request.plan ? choosePlan(page.plans, request.plan) : undefined;
            if (!plan) return { status: "choose_plan", plans: page.plans.map(({ label, price }) => ({ label, price })) };
            chosenPlan = plan;
            await browser.click(plan.button);
            continue;
          }
          case "form":
            if (page.missing.length > 0 || !page.next) return handOff("form_fields", page.missing);
            await browser.click(page.next);
            continue;
          case "card_required":
            return handOff("card_required");
          case "complete":
            // Preparing never clicks a final button, so this means the flow changed.
            this.logger.error("booking completed during prepare", { bookingId });
            return handOff("unexpected_completion");
          case "unknown":
            return handOff("unrecognized_page");
          case "confirm": {
            if (!summaryMatchesRequest(page.summary, request)) return handOff("summary_unverified");
            record({ plan: chosenPlan?.label ?? null, price: chosenPlan?.price ?? null, summary: { ...page.summary.fields } });
            const token = randomBytes(18).toString("base64url");
            this.pending.set(token, {
              bookingId,
              url: browser.currentUrl("booking") ?? "",
              fields: page.summary.fields,
              expiresAt: this.now().getTime() + tokenLifetimeMs,
            });
            return {
              status: "ready",
              booking_id: bookingId,
              confirmation_token: token,
              expires_in_seconds: tokenLifetimeMs / 1_000,
              restaurant: detail.name,
              summary: page.summary,
            };
          }
        }
      }
      return handOff("unrecognized_page");
    });
  }

  async confirm(token: string): Promise<ConfirmResult> {
    const pending = this.pending.get(token);
    // Single use: the token is gone whatever happens next.
    this.pending.delete(token);
    if (!pending || pending.expiresAt < this.now().getTime()) {
      throw new TabelogError("TOKEN_INVALID", "Unknown, used, or expired confirmation token.");
    }
    return this.browser.exclusive(async (browser) => {
      const before = await browser.snapshot("booking");
      const page = readBookingPage(before);
      if (before.url !== pending.url || page.kind !== "confirm" || !sameFields(page.summary.fields, pending.fields)) {
        this.history.append({ type: "failed", id: pending.bookingId, at: this.now().toISOString(), reason: "summary_changed" });
        throw new TabelogError("SUMMARY_CHANGED", "The confirmation page changed after prepare_booking.");
      }
      await browser.click(page.confirm);
      const after = readBookingPage(await browser.snapshot("booking"));
      const at = this.now().toISOString();
      if (after.kind === "complete") {
        this.history.append({ type: "confirmed", id: pending.bookingId, at, reservation_number: after.reservationNumber });
        return { status: "confirmed", booking_id: pending.bookingId, reservation_number: after.reservationNumber, excerpt: after.excerpt };
      }
      if (after.kind === "card_required") {
        this.history.append({ type: "handed_off", id: pending.bookingId, at, reason: "card_required" });
        return { status: "needs_user", reason: "card_required", booking_id: pending.bookingId, handoff_url: browser.currentUrl("booking") ?? pending.url };
      }
      // The final click happened, but the result page is not one this parser knows.
      // Never report success without seeing it.
      this.history.append({ type: "failed", id: pending.bookingId, at, reason: "unclear_after_confirm" });
      return { status: "unclear", booking_id: pending.bookingId, page_title: after.kind === "unknown" ? after.title : after.kind };
    });
  }

  /** Shows the booking tab so the user can finish a handed-off booking by hand. */
  showBookingWindow(): Promise<string | null> {
    return this.browser.exclusive(async (browser) => {
      await browser.show(undefined, "booking");
      return browser.currentUrl("booking");
    });
  }
}

/** Prefecture and city or ward, e.g. 東京都中央区, from a Japanese address. */
export function areaOf(address: string): string | null {
  return /^(.+?[都道府県])(.+?[市区町村])/.exec(address.replace(/\s+/g, ""))?.slice(1, 3).join("") ?? null;
}

function restaurantForHistory(detail: RestaurantDetail, url: string) {
  return {
    rst_id: detail.rst_id,
    name: detail.name,
    url,
    genre: detail.info.ジャンル ?? null,
    area: areaOf(detail.info.住所 ?? ""),
    score: detail.score,
  };
}
