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
import { createServer } from "../src/server/create-server.ts";
import type { TabelogClient } from "../src/tabelog/client.ts";

async function connect() {
  const paths = dataPaths(mkdtempSync(join(tmpdir(), "tabelog-server-")));
  const booking = {
    confirm: async () => {
      throw Object.assign(new Error("Unknown, used, or expired confirmation token."), { name: "TabelogError", code: "TOKEN_INVALID" });
    },
  } as unknown as BookingService;
  const server = createServer({
    client: {} as TabelogClient,
    booking,
    history: new HistoryStore(paths.history),
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
    "get_availability",
    "get_booking_history",
    "get_preferences",
    "get_restaurant",
    "prepare_booking",
    "search_restaurants",
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
