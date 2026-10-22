import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BookingService } from "../booking/service.ts";
import { recoveryFor, TabelogError, toTabelogError } from "../errors.ts";
import { type HistoryStore, purposes, summarizePreferences } from "../history/store.ts";
import type { Logger } from "../logger.ts";
import type { DataPaths } from "../paths.ts";
import type { PreferencesStore } from "../preferences/store.ts";
import type { TabelogClient } from "../tabelog/client.ts";
import type { RestaurantFinder } from "../tabelog/finder.ts";
import { readSession } from "../tabelog/login.ts";
import { sortKeys } from "../tabelog/urls.ts";
import { version } from "../version.ts";

export interface ServerDependencies {
  readonly client: TabelogClient;
  readonly booking: BookingService;
  readonly history: HistoryStore;
  readonly preferences: PreferencesStore;
  readonly finder: RestaurantFinder;
  readonly paths: DataPaths;
  readonly logger: Logger;
}

const instructions = `Tabelog (食べログ) search and booking for restaurants in Japan, through a real Chrome on this computer. The main use is business dinners.

- For requests like "a private room for 7 within 15 minutes of 丸の内 and 虎ノ門, in the next 3 days, for dinner", call find_available_restaurants. Leave out what the user did not say: party, time window (dinner 17:00-20:00 unless the user prefers otherwise), private room, walking limit, and budget then come from saved preferences.
- Locations and keywords are Japanese: 丸の内, 渋谷駅, 寿司, 焼肉. Translate English place names before calling; stations work best.
- When the user states a lasting preference ("we eat at 7:30", "clients always need a private room", "no smoking"), save it with set_preferences so later searches use it. Read get_preferences before suggesting places.
- Booking is two steps. prepare_booking returns a summary and a confirmation_token. Show the user the summary (restaurant, date, time, party, plan or room, price, cancellation terms) and get an explicit yes in the conversation before calling confirm_booking. Never call confirm_booking on your own initiative.
- prepare_booking signs in by itself when needed: a Chrome window opens and the user signs in there. If it returns needs_login, tell the user the window is waiting and call prepare_booking again once they say they are done.
- When a result says choose_plan for a private-room request, prefer a plan or seat whose name includes 個室, and confirm with the user. When it says needs_user, tell them why and offer show_booking_window or the handoff_url; card details, verification codes, and unknown form fields are always the user's to enter.
- Pass notes the user gives about a booking (occasion, guests, client name) as notes or with add_booking_note; they become memory for later bookings.`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const clock = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM, 24-hour, Japan time.");
const party = z.number().int().min(1).max(50);
const restaurantUrl = z.string().url().describe("A tabelog.com restaurant page URL, as returned by search_restaurants.");
const purpose = z.enum(purposes).describe("business (default) or personal.");

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

function ok(value: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function failure(error: unknown, logger: Logger, tool: string) {
  const normalized = toTabelogError(error);
  logger.warn("tool failed", { tool, code: normalized.code });
  const body = { error: { code: normalized.code, message: normalized.message, details: normalized.details ?? {}, recovery: recoveryFor(normalized.code) } };
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true };
}

/** Progress notifications keep long calls (sign-in, multi-day searches) alive in clients that reset timeouts on progress. */
type Extra = {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

function progressReporter(extra: Extra): (message: string) => void {
  const token = extra._meta?.progressToken;
  let step = 0;
  return (message) => {
    if (token === undefined) return;
    step += 1;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message } }).catch(() => undefined);
  };
}

/** Today and the following days, in Japan time. */
export function nextDays(count: number, now = new Date()): string[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
  return Array.from({ length: count }, (_, offset) => format.format(new Date(now.getTime() + offset * 86_400_000)));
}

export function createServer({ client, booking, history, preferences, finder, paths, logger }: ServerDependencies): McpServer {
  const server = new McpServer({ name: "tabelog-mcp", version }, { instructions });
  const run =
    <A>(tool: string, body: (args: A, progress: (message: string) => void) => Promise<object>) =>
    async (args: A, extra: Extra) => {
      try {
        return ok(await body(args, progressReporter(extra)));
      } catch (error) {
        return failure(error, logger, tool);
      }
    };

  server.registerTool(
    "tabelog_status",
    {
      title: "Tabelog status",
      description:
        "Where data is stored, whether this browser profile is signed in to Tabelog, and when the sign-in expires (read from Tabelog's session cookie at sign-in). Starts Chrome in the background if needed.",
      inputSchema: {},
      annotations: readOnly,
    },
    run("tabelog_status", async () => {
      const session = readSession(paths.session);
      return {
        version,
        data_directory: paths.root,
        login: await client.loginState(),
        signed_in_at: session?.signed_in_at ?? null,
        session_expires_at: session?.expires_at ?? null,
        bookings_in_history: history.bookings().length,
      };
    }),
  );

  server.registerTool(
    "tabelog_login",
    {
      title: "Sign in to Tabelog",
      description:
        "Optional: sign in ahead of time. prepare_booking already signs in by itself when needed. Opens the Chrome window on Tabelog's login page and waits while the user signs in (LINE, Apple, Google, …). " +
        "The user types credentials and codes themselves; this tool never sees them. The session is saved in the local browser profile.",
      inputSchema: { timeout_minutes: z.number().int().min(1).max(15).default(5) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    run("tabelog_login", async ({ timeout_minutes }: { timeout_minutes: number }, progress) => {
      const login = await client.login(timeout_minutes * 60_000, paths.session, progress);
      return { login, session_expires_at: readSession(paths.session)?.expires_at ?? null };
    }),
  );

  server.registerTool(
    "find_area",
    {
      title: "Find a Tabelog area",
      description: "Tabelog's own suggestions for a Japanese place name: stations, towns, and areas. Use when a search's resolved_area looks wrong.",
      inputSchema: { query: z.string().trim().min(1).max(40).describe("Japanese place name, e.g. 銀座 or 恵比寿駅.") },
      annotations: readOnly,
    },
    run("find_area", async ({ query }: { query: string }) => ({ areas: await client.findArea(query) })),
  );

  server.registerTool(
    "search_restaurants",
    {
      title: "Search Tabelog",
      description:
        "Search restaurants with Tabelog's filters. With date, time, and party, each result lists the online-booking times Tabelog shows around that time. " +
        "20 results per page; total is Tabelog's count.",
      inputSchema: {
        area: z.string().trim().min(1).max(40).optional().describe("Japanese place name: 銀座, 渋谷駅, 恵比寿."),
        keyword: z.string().trim().min(1).max(60).optional().describe("Japanese cuisine or keyword: 寿司, 焼肉, イタリアン, or a restaurant name."),
        date: isoDate.optional(),
        time: clock.optional(),
        party: party.optional(),
        online_booking_only: z.boolean().default(true).describe("Only restaurants bookable online for the date and time."),
        private_room: z.boolean().optional(),
        budget_max_yen: z.number().int().min(1_000).max(100_000).optional(),
        budget_for: z.enum(["dinner", "lunch"]).default("dinner"),
        sort: z.enum(Object.keys(sortKeys) as [keyof typeof sortKeys]).default("rating"),
        page: z.number().int().min(1).max(60).default(1),
      },
      annotations: readOnly,
    },
    run("search_restaurants", async (args: {
      area?: string; keyword?: string; date?: string; time?: string; party?: number; online_booking_only: boolean;
      private_room?: boolean; budget_max_yen?: number; budget_for: "dinner" | "lunch"; sort: keyof typeof sortKeys; page: number;
    }) =>
      client.search({
        ...(args.area ? { area: args.area } : {}),
        ...(args.keyword ? { keyword: args.keyword } : {}),
        ...(args.date ? { date: args.date } : {}),
        ...(args.time ? { time: args.time } : {}),
        ...(args.party ? { party: args.party } : {}),
        onlineBookingOnly: args.online_booking_only,
        ...(args.private_room ? { privateRoom: true } : {}),
        ...(args.budget_max_yen ? { budgetMax: args.budget_max_yen, budgetFor: args.budget_for } : {}),
        sort: args.sort,
        page: args.page,
      }),
    ),
  );

  server.registerTool(
    "find_available_restaurants",
    {
      title: "Find restaurants near several places, with open slots",
      description:
        "The main search for business dinners. Finds restaurants within walking range of every location, bookable online for the party on the next days within a time window, " +
        "optionally with a private room, and returns each one's walking minutes and open times. Unset options come from saved preferences " +
        "(dinner 17:00-20:00, business: private room, 15 minutes). Walking time is estimated from map distance, not transit. Takes 30 s to 2 min.",
      inputSchema: {
        locations: z.array(z.string().trim().min(1).max(40)).min(1).max(4).describe('Japanese station or place names (丸の内, 虎ノ門駅), or "lat,lng".'),
        party: party.optional(),
        days_ahead: z.number().int().min(1).max(14).default(3).describe("Today and the following days, Japan time."),
        dates: z.array(isoDate).min(1).max(14).optional().describe("Exact dates instead of days_ahead."),
        meal: z.enum(["dinner", "lunch"]).default("dinner"),
        time_from: clock.optional().describe("Earliest seating time; overrides the saved window."),
        time_to: clock.optional().describe("Latest seating time; overrides the saved window."),
        private_room: z.boolean().optional(),
        max_walk_minutes: z.number().int().min(1).max(60).optional(),
        keyword: z.string().trim().min(1).max(60).optional().describe("Japanese cuisine or keyword: 寿司, 和食, 焼肉."),
        budget_max_yen: z.number().int().min(1_000).max(100_000).optional(),
        purpose: purpose.optional(),
        max_results: z.number().int().min(1).max(15).default(5),
      },
      annotations: readOnly,
    },
    run(
      "find_available_restaurants",
      async (
        args: {
          locations: string[]; party?: number; days_ahead: number; dates?: string[]; meal: "dinner" | "lunch"; time_from?: string; time_to?: string;
          private_room?: boolean; max_walk_minutes?: number; keyword?: string; budget_max_yen?: number; purpose?: (typeof purposes)[number]; max_results: number;
        },
        progress,
      ) => {
        const saved = preferences.read();
        const forPurpose = saved[args.purpose ?? saved.default_purpose];
        const window = args.meal === "lunch" ? forPurpose.lunch_window : forPurpose.dinner_window;
        const partySize = args.party ?? forPurpose.party;
        if (!partySize) throw new TabelogError("INVALID_INPUT", "How many people? Pass party, or save a usual party size with set_preferences.", { argument: "party" });
        const budget = args.budget_max_yen ?? forPurpose.budget_max_yen ?? undefined;
        return finder.find(
          {
            locations: args.locations,
            maxWalkMinutes: args.max_walk_minutes ?? forPurpose.max_walk_minutes,
            party: partySize,
            dates: args.dates ?? nextDays(args.days_ahead),
            window: { start: args.time_from ?? window.start, end: args.time_to ?? window.end },
            privateRoom: args.private_room ?? forPurpose.private_room,
            ...(args.keyword ? { keyword: args.keyword } : {}),
            ...(budget ? { budgetMax: budget } : {}),
            maxResults: args.max_results,
          },
          progress,
        );
      },
    ),
  );

  server.registerTool(
    "set_preferences",
    {
      title: "Save a preference",
      description:
        "Saves a lasting preference the user stated, used as the default for later searches and bookings: seating windows, party size, private room, walking limit, budget, or a free-text note.",
      inputSchema: {
        purpose: purpose.default("business"),
        dinner_from: clock.optional(),
        dinner_to: clock.optional(),
        lunch_from: clock.optional(),
        lunch_to: clock.optional(),
        party: party.optional(),
        private_room: z.boolean().optional(),
        max_walk_minutes: z.number().int().min(1).max(60).optional(),
        budget_max_yen: z.number().int().min(1_000).max(100_000).optional(),
        note: z.string().trim().min(1).max(300).optional().describe('Anything else to remember, e.g. "client is vegetarian", "avoid 焼肉".'),
        make_default_purpose: z.boolean().optional().describe("Use this purpose when a request does not say."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    run(
      "set_preferences",
      async (args: {
        purpose: (typeof purposes)[number]; dinner_from?: string; dinner_to?: string; lunch_from?: string; lunch_to?: string; party?: number;
        private_room?: boolean; max_walk_minutes?: number; budget_max_yen?: number; note?: string; make_default_purpose?: boolean;
      }) => {
        const current = preferences.read()[args.purpose];
        const dinner = { start: args.dinner_from ?? current.dinner_window.start, end: args.dinner_to ?? current.dinner_window.end };
        const lunch = { start: args.lunch_from ?? current.lunch_window.start, end: args.lunch_to ?? current.lunch_window.end };
        for (const [name, span] of [["dinner", dinner], ["lunch", lunch]] as const) {
          if (span.start >= span.end) throw new TabelogError("INVALID_INPUT", `The ${name} window must start before it ends.`, { argument: `${name}_from` });
        }
        const updated = preferences.update(
          args.purpose,
          {
            dinner_window: dinner,
            lunch_window: lunch,
            ...(args.party !== undefined ? { party: args.party } : {}),
            ...(args.private_room !== undefined ? { private_room: args.private_room } : {}),
            ...(args.max_walk_minutes !== undefined ? { max_walk_minutes: args.max_walk_minutes } : {}),
            ...(args.budget_max_yen !== undefined ? { budget_max_yen: args.budget_max_yen } : {}),
            ...(args.note ? { add_note: args.note } : {}),
          },
          args.make_default_purpose ? args.purpose : undefined,
        );
        return { saved: updated[args.purpose], default_purpose: updated.default_purpose };
      },
    ),
  );

  server.registerTool(
    "get_restaurant",
    {
      title: "Restaurant details",
      description: "Tabelog's information table for one restaurant: genre, address, hours, closed days, budget, payment, seats, private rooms, smoking.",
      inputSchema: { restaurant_url: restaurantUrl },
      annotations: readOnly,
    },
    run("get_restaurant", async ({ restaurant_url }: { restaurant_url: string }) => client.restaurant(restaurant_url)),
  );

  server.registerTool(
    "get_availability",
    {
      title: "Online-booking availability",
      description:
        "The booking calendar (each day open, few_left, or full). With date: which party sizes are open that day. With date and party: the bookable times.",
      inputSchema: { restaurant_url: restaurantUrl, date: isoDate.optional(), party: party.optional() },
      annotations: readOnly,
    },
    run("get_availability", async (args: { restaurant_url: string; date?: string; party?: number }) =>
      client.availability(args.restaurant_url, args.date, args.party),
    ),
  );

  server.registerTool(
    "prepare_booking",
    {
      title: "Prepare a booking (step 1 of 2)",
      description:
        "Fills Tabelog's booking form up to, never through, the final button. Signs in first if needed (a Chrome window opens for the user). Returns status ready with a summary and a single-use " +
        "confirmation_token (5 minutes), or choose_plan (call again with plan), needs_login (sign-in still open), or needs_user (card, code, or unknown field: the user finishes). Books nothing.",
      inputSchema: {
        restaurant_url: restaurantUrl,
        date: isoDate,
        time: clock,
        party,
        purpose: purpose.optional(),
        plan: z.string().trim().min(1).max(80).optional().describe('"seat_only", or part of a plan or seat name from a choose_plan result (e.g. 個室).'),
        notes: z.string().trim().max(500).optional().describe("Occasion, guests, preferences. Saved with the booking history."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(
      "prepare_booking",
      async (
        args: { restaurant_url: string; date: string; time: string; party: number; purpose?: (typeof purposes)[number]; plan?: string; notes?: string },
        progress,
      ) =>
        booking.prepare(
          {
            restaurantUrl: args.restaurant_url,
            date: args.date,
            time: args.time,
            party: args.party,
            purpose: args.purpose ?? preferences.read().default_purpose,
            ...(args.plan ? { plan: args.plan } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
          },
          progress,
        ),
    ),
  );

  server.registerTool(
    "confirm_booking",
    {
      title: "Confirm a booking (step 2 of 2)",
      description:
        "Places the booking prepared by prepare_booking. Only call after the user has seen that summary and said yes. Fails without a live token, " +
        "or when the confirmation page changed since prepare. Reports confirmed only when Tabelog's completion page is seen.",
      inputSchema: { confirmation_token: z.string().min(16).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run("confirm_booking", async ({ confirmation_token }: { confirmation_token: string }) => booking.confirm(confirmation_token)),
  );

  server.registerTool(
    "show_booking_window",
    {
      title: "Show the booking window",
      description: "Brings the Chrome window with the current booking on-screen, so the user can finish a needs_user booking by hand.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    run("show_booking_window", async () => ({ url: await booking.showBookingWindow() })),
  );

  server.registerTool(
    "get_booking_history",
    {
      title: "Booking history",
      description: "Past bookings made through this server, newest first: status, restaurant, date, party, plan, price, notes, failure reason.",
      inputSchema: {
        purpose: z.enum(purposes).optional(),
        status: z.enum(["prepared", "confirmed", "failed", "handed_off", "abandoned"]).optional(),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    run("get_booking_history", async (args: { purpose?: (typeof purposes)[number]; status?: string; limit: number }) => ({
      bookings: history
        .bookings()
        .filter((record) => (!args.purpose || record.purpose === args.purpose) && (!args.status || record.status === args.status))
        .slice(0, args.limit),
    })),
  );

  server.registerTool(
    "get_preferences",
    {
      title: "Booking preferences",
      description:
        "Saved preferences (what the user said: seating windows, party, private room, walking limit, budget, notes) and learned ones (from confirmed bookings: usual genres, areas, party, time, repeat restaurants).",
      inputSchema: { purpose: purpose.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    run("get_preferences", async ({ purpose: wanted }: { purpose?: (typeof purposes)[number] }) => {
      const saved = preferences.read();
      const chosen = wanted ?? saved.default_purpose;
      return { purpose: chosen, default_purpose: saved.default_purpose, saved: saved[chosen], learned: summarizePreferences(history.bookings(), chosen) };
    }),
  );

  server.registerTool(
    "add_booking_note",
    {
      title: "Add a note to a booking",
      description: "Saves something the user said about a booking (how it went, who came, what to change next time) to the local history.",
      inputSchema: { booking_id: z.string().uuid(), note: z.string().trim().min(1).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    run("add_booking_note", async ({ booking_id, note }: { booking_id: string; note: string }) => {
      if (!history.bookings().some((record) => record.id === booking_id)) {
        throw new TabelogError("INVALID_INPUT", `No booking ${booking_id} in the history.`, { argument: "booking_id" });
      }
      history.append({ type: "note", id: booking_id, at: new Date().toISOString(), note });
      return { saved: true };
    }),
  );

  return server;
}
