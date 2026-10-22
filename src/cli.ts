#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BookingService } from "./booking/service.ts";
import { BrowserSession } from "./browser/session.ts";
import { recoveryFor, toTabelogError } from "./errors.ts";
import { HistoryStore, purposes, toCsv } from "./history/store.ts";
import { PreferencesStore } from "./preferences/store.ts";
import { RestaurantFinder } from "./tabelog/finder.ts";
import { readSession } from "./tabelog/login.ts";
import { PlaceCache } from "./tabelog/place-cache.ts";
import { Logger } from "./logger.ts";
import { dataPaths } from "./paths.ts";
import { createServer } from "./server/create-server.ts";
import { httpToken, startHttpServer } from "./server/http.ts";
import { TabelogClient } from "./tabelog/client.ts";
import { version } from "./version.ts";

const usage = `tabelog-mcp ${version}: Tabelog search and two-step booking for MCP clients

Usage:
  tabelog-mcp                       Run the MCP server over stdio (what MCP clients start)
  tabelog-mcp serve --http [--port 3217]
                                    Run one shared local server over HTTP on 127.0.0.1
  tabelog-mcp login                 Open Chrome and sign in to Tabelog (once; the session is saved)
  tabelog-mcp status                Show the data folder and whether you are signed in
  tabelog-mcp history [--purpose personal|business] [--csv]
                                    Print booking history (CSV for expenses)
  tabelog-mcp token                 Print the HTTP bearer token

Environment:
  TABELOG_MCP_HOME     Data folder (default: per-OS app data folder)
  TABELOG_MCP_CHROME   Path to a Chrome or Chromium binary (default: installed Google Chrome)
  TABELOG_MCP_LOG      debug | info | warn | error (default: info)
`;

function dependencies() {
  const logLevel = (process.env.TABELOG_MCP_LOG ?? "info") as "debug" | "info" | "warn" | "error";
  const logger = new Logger(logLevel);
  const paths = dataPaths();
  const browser = new BrowserSession({
    profileDirectory: paths.profile,
    logger: logger.child("browser"),
    ...(process.env.TABELOG_MCP_CHROME ? { executablePath: process.env.TABELOG_MCP_CHROME } : {}),
  });
  const history = new HistoryStore(paths.history);
  const client = new TabelogClient(browser);
  // Long enough to scan LINE's QR code or approve on a phone; the window stays open after.
  const booking = new BookingService(browser, history, logger.child("booking"), undefined, { sessionPath: paths.session, waitMs: 3 * 60_000 });
  const preferences = new PreferencesStore(paths.preferences);
  const finder = new RestaurantFinder(browser, new PlaceCache(paths.places));
  return { logger, paths, browser, history, client, booking, preferences, finder };
}

function onShutdown(close: () => Promise<void>, { stdio = false } = {}): void {
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // An MCP client ends a stdio server by closing its stdin.
  if (stdio) process.stdin.once("close", stop);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: "boolean" },
      port: { type: "string", default: "3217" },
      purpose: { type: "string" },
      csv: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return void process.stdout.write(usage);
  if (values.version) return void process.stdout.write(`${version}\n`);
  const command = positionals[0] ?? "serve";
  const deps = dependencies();

  switch (command) {
    case "serve": {
      if (values.http) {
        const port = Number(values.port);
        const token = httpToken(deps.paths.httpToken);
        const http = await startHttpServer(deps, { host: "127.0.0.1", port, token, logger: deps.logger.child("http") });
        process.stderr.write(`tabelog-mcp listening on ${http.url}\nBearer token: tabelog-mcp token\n`);
        onShutdown(async () => {
          await http.close();
          await deps.browser.close();
        });
        return;
      }
      const server = createServer(deps);
      await server.connect(new StdioServerTransport());
      deps.logger.info("stdio server started", { version });
      onShutdown(
        async () => {
          await server.close();
          await deps.browser.close();
        },
        { stdio: true },
      );
      return;
    }
    case "login": {
      process.stdout.write("A Chrome window opens on Tabelog's login page. Sign in there (LINE QR or Apple are quickest). Waiting up to 10 minutes…\n");
      const state = await deps.client.login(10 * 60_000, deps.paths.session);
      await deps.browser.close();
      const expires = readSession(deps.paths.session)?.expires_at;
      process.stdout.write(
        state === "signed_in"
          ? `Signed in. The session is saved for the MCP server${expires ? ` and lasts until ${expires}` : ""}.\n`
          : "Not signed in. Run `tabelog-mcp login` again.\n",
      );
      process.exitCode = state === "signed_in" ? 0 : 1;
      return;
    }
    case "status": {
      const login = await deps.client.loginState();
      await deps.browser.close();
      process.stdout.write(
        `${JSON.stringify(
          {
            version,
            data_directory: deps.paths.root,
            login,
            session_expires_at: readSession(deps.paths.session)?.expires_at ?? null,
            bookings_in_history: deps.history.bookings().length,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    case "history": {
      const purpose = values.purpose;
      if (purpose && !(purposes as readonly string[]).includes(purpose)) throw new Error("--purpose must be personal or business.");
      const records = deps.history.bookings().filter((record) => !purpose || record.purpose === purpose);
      process.stdout.write(values.csv ? toCsv(records) : `${JSON.stringify(records, null, 2)}\n`);
      return;
    }
    case "token":
      process.stdout.write(`${httpToken(deps.paths.httpToken)}\n`);
      return;
    default:
      process.stderr.write(usage);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const normalized = toTabelogError(error);
  process.stderr.write(`${normalized.code}: ${normalized.message}\n${recoveryFor(normalized.code)}\n`);
  process.exit(1);
});
