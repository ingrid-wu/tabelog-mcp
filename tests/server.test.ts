import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import type { BookingService } from "../src/booking/service.ts";
import { HistoryStore } from "../src/history/store.ts";
import { Logger } from "../src/logger.ts";
import { dataPaths } from "../src/paths.ts";
import { PreferencesStore } from "../src/preferences/store.ts";
import { createServer, nextDays } from "../src/server/create-server.ts";
import type { TabelogClient } from "../src/tabelog/client.ts";
import type { FindRequest, RestaurantFinder } from "../src/tabelog/finder.ts";

let lastFind: FindRequest | null = null;

async function connect() {
  const paths = dataPaths(mkdtempSync(join(tmpdir(), "tabelog-server-")));
  lastFind = null;
  const finder = {
    find: async (request: FindRequest) => {
      lastFind = request;
      return { locations: [], criteria: {}, results: [], checked: { candidates: 0, within_walk: 0, with_slots: 0 } };
    },
  } as unknown as RestaurantFinder;
  const booking = {
    confirm: async () => {
      throw Object.assign(new Error("Unknown, used, or expired confirmation token."), { name: "TabelogError", code: "TOKEN_INVALID" });
    },
  } as unknown as BookingService;
  const server = createServer({
    client: {} as TabelogClient,
    booking,
    history: new HistoryStore(paths.history),
    preferences: new PreferencesStore(paths.preferences),
    finder,
    paths,
    logger: new Logger("error"),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("exposes the booking tools, with confirm_booking marked destructive and nothing else", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "add_booking_note",
    "confirm_booking",
    "find_area",
    "find_available_restaurants",
    "get_availability",
    "get_booking_history",
    "get_preferences",
    "get_restaurant",
    "prepare_booking",
    "search_restaurants",
    "set_preferences",
    "show_booking_window",
    "tabelog_login",
    "tabelog_status",
  ]);
  const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
  expect(destructive).toEqual(["confirm_booking"]);
});

test("no tool takes an arbitrary URL, script, or selector", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const argumentNames = tools.flatMap((tool) => Object.keys((tool.inputSchema.properties ?? {}) as object));
  expect(argumentNames).not.toEqual(expect.arrayContaining(["url"]));
  for (const name of argumentNames) expect(name).not.toMatch(/^(script|selector|js|code|eval)$/);
});

test("invalid input is rejected before any work", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "prepare_booking", arguments: { restaurant_url: "x", date: "tomorrow", time: "7pm", party: 0 } });
  expect(result.isError).toBe(true);
});

test("an empty history reads as empty", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "get_booking_history", arguments: {} });
  expect(result.structuredContent).toEqual({ bookings: [] });
});

test("the business dinner request fills unset options from preferences: next 3 days, 17:00-20:00, private room, 15 minutes", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "find_available_restaurants", arguments: { locations: ["丸の内", "虎ノ門"], party: 7 } });
  expect(result.isError).toBeFalsy();
  expect(lastFind).toMatchObject({
    locations: ["丸の内", "虎ノ門"],
    party: 7,
    dates: nextDays(3),
    window: { start: "17:00", end: "20:00" },
    privateRoom: true,
    maxWalkMinutes: 15,
  });
});

test("a preference the user states becomes the next search's default", async () => {
  const client = await connect();
  await client.callTool({ name: "set_preferences", arguments: { dinner_from: "18:30", dinner_to: "20:30", party: 6 } });
  await client.callTool({ name: "find_available_restaurants", arguments: { locations: ["丸の内"] } });
  expect(lastFind).toMatchObject({ party: 6, window: { start: "18:30", end: "20:30" } });
});

test("an explicit time beats the saved window", async () => {
  const client = await connect();
  await client.callTool({ name: "find_available_restaurants", arguments: { locations: ["丸の内"], party: 7, time_from: "19:00" } });
  expect(lastFind?.window).toEqual({ start: "19:00", end: "20:00" });
});

test("without a party size or a saved one, it asks", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "find_available_restaurants", arguments: { locations: ["丸の内"] } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.structuredContent)).toContain("How many people");
});

test("next 3 days are today and the two after, in Japan time", () => {
  // 23:30 UTC on the 22nd is already the 23rd in Tokyo.
  expect(nextDays(3, new Date("2026-10-22T23:30:00Z"))).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
});
