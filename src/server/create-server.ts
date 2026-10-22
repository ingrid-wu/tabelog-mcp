import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BookingService } from "../booking/service.ts";
import { recoveryFor, TabelogError, toTabelogError } from "../errors.ts";
import { type HistoryStore, purposes, summarizePreferences } from "../history/store.ts";
import type { Logger } from "../logger.ts";
import type { DataPaths } from "../paths.ts";
import type { TabelogClient } from "../tabelog/client.ts";
import { sortKeys } from "../tabelog/urls.ts";
import { version } from "../version.ts";

export interface ServerDependencies {
  readonly client: TabelogClient;
  readonly booking: BookingService;
  readonly history: HistoryStore;
  readonly paths: DataPaths;
  readonly logger: Logger;
}

const instructions = `Tabelog (食べログ) search and booking for restaurants in Japan, through a real Chrome on this computer.

- Area and keyword are Japanese: 銀座, 渋谷駅, 寿司, 焼肉. Translate English place names before searching.
- Before suggesting restaurants, call get_preferences for the booking's purpose (personal or business) and use what it says.
- Booking is two steps. prepare_booking returns a summary and a confirmation_token. Show the user the summary (restaurant, date, time, party, plan, price, cancellation terms) and get an explicit yes in the conversation before calling confirm_booking. Never call confirm_booking on your own initiative.
- When a result says needs_login, ask the user to sign in: call tabelog_login (a Chrome window opens; they sign in themselves). When it says needs_user, tell them why and offer show_booking_window or the handoff_url; card details, verification codes, and unknown form fields are always the user's to enter.
- Pass notes the user gives about a booking (occasion, guests, preferences) as notes or with add_booking_note; they become memory for later bookings.`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const clock = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM, 24-hour, Japan time.");
const party = z.number().int().min(1).max(50);
const restaurantUrl = z.string().url().describe("A tabelog.com restaurant page URL, as returned by search_restaurants.");
const purpose = z.enum(purposes).describe("personal or business. Ask the user when unclear.");

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

export function createServer({ client, booking, history, paths, logger }: ServerDependencies): McpServer {
  const server = new McpServer({ name: "tabelog-mcp", version }, { instructions });
  const run =
    <A>(tool: string, body: (args: A) => Promise<object>) =>
    async (args: A) => {
      try {
        return ok(await body(args));
      } catch (error) {
        return failure(error, logger, tool);
      }
    };

  server.registerTool(
    "tabelog_status",
    {
      title: "Tabelog status",
      description: "Where data is stored, and whether this browser profile is signed in to Tabelog. Starts Chrome if needed.",
      inputSchema: {},
      annotations: readOnly,
    },
    run("tabelog_status", async () => ({
      version,
      data_directory: paths.root,
      login: await client.loginState(),
      bookings_in_history: history.bookings().length,
    })),
  );

  server.registerTool(
    "tabelog_login",
    {
      title: "Sign in to Tabelog",
      description:
        "Opens the Chrome window on Tabelog's login page and waits while the user signs in (LINE, Apple, Google, …). " +
        "The user types credentials and codes themselves; this tool never sees them. The session is saved in the local browser profile for later calls.",
      inputSchema: { timeout_minutes: z.number().int().min(1).max(15).default(5) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    run("tabelog_login", async ({ timeout_minutes }: { timeout_minutes: number }) => ({
      login: await client.login(timeout_minutes * 60_000),
    })),
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
        "Fills Tabelog's booking form up to, never through, the final button. Returns status ready with a summary and a single-use " +
        "confirmation_token (5 minutes), or choose_plan (call again with plan), needs_login, or needs_user (card, code, or unknown field: the user finishes). Books nothing.",
      inputSchema: {
        restaurant_url: restaurantUrl,
        date: isoDate,
        time: clock,
        party,
        purpose,
        plan: z.string().trim().min(1).max(80).optional().describe('"seat_only", or part of a course name from a choose_plan result.'),
        notes: z.string().trim().max(500).optional().describe("Occasion, guests, preferences. Saved with the booking history."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run("prepare_booking", async (args: {
      restaurant_url: string; date: string; time: string; party: number; purpose: (typeof purposes)[number]; plan?: string; notes?: string;
    }) =>
      booking.prepare({
        restaurantUrl: args.restaurant_url,
        date: args.date,
        time: args.time,
        party: args.party,
        purpose: args.purpose,
        ...(args.plan ? { plan: args.plan } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
      }),
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
      description: "What confirmed past bookings say about the user for one purpose: usual genres, areas, party size, time, and repeat restaurants.",
      inputSchema: { purpose },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    run("get_preferences", async ({ purpose: wanted }: { purpose: (typeof purposes)[number] }) =>
      summarizePreferences(history.bookings(), wanted),
    ),
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
