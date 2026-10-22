// One long-running local server that several MCP clients share, so they share
// one browser profile instead of fighting over it. Streamable HTTP on loopback,
// with a bearer token every client must send.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.ts";
import { createServer, type ServerDependencies } from "./create-server.ts";

const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
const maxBodyBytes = 1_048_576;

/** Reads the saved token, creating one on first run. */
export function httpToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export function startHttpServer(
  dependencies: ServerDependencies,
  options: { host: string; port: number; token: string; logger: Logger },
): Promise<{ url: string; close(): Promise<void> }> {
  if (!loopback.has(options.host)) {
    // A public bind would put booking tools on the network. Tunnels connect to loopback.
    throw new Error("Refusing to listen on a non-loopback host. Use a tunnel to reach this server remotely.");
  }
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (url.pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    // Tunnels rewrite Host, so the token is the gate; Host and Origin checks stop browser pages on this machine.
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      response.writeHead(403).end("Forbidden origin");
      return;
    }
    if (!authorized(request, options.token)) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    if (!request.headers["x-forwarded-host"] && !allowedHosts.has(request.headers.host ?? "")) {
      response.writeHead(403).end("Forbidden host");
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (request.method === "POST") {
      const body = await readJson(request);
      if (existing) {
        await existing.handleRequest(request, response, body);
        return;
      }
      if (!isInitializeRequest(body)) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Initialize first." }, id: null }),
        );
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await createServer(dependencies).connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    if (!existing) {
      response.writeHead(400).end("Unknown session");
      return;
    }
    await existing.handleRequest(request, response);
  };

  const server = createHttpServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.logger.error("http request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) response.writeHead(500).end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      resolve({
        url: `http://${options.host === "::1" ? "[::1]" : options.host}:${options.port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            for (const transport of transports.values()) void transport.close();
            server.close(() => done());
          }),
      });
    });
  });
}
