import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Where the browser profile (login session) and booking history live. Never inside the package. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TABELOG_MCP_HOME) return env.TABELOG_MCP_HOME;
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "tabelog-mcp");
    case "win32":
      return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "tabelog-mcp");
    default:
      return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "tabelog-mcp");
  }
}

export interface DataPaths {
  readonly root: string;
  readonly profile: string;
  readonly history: string;
  readonly httpToken: string;
  readonly session: string;
  readonly preferences: string;
  readonly places: string;
}

export function dataPaths(root = dataDirectory()): DataPaths {
  return {
    root,
    profile: join(root, "profile"),
    history: join(root, "history.jsonl"),
    httpToken: join(root, "http-token"),
    session: join(root, "session.json"),
    preferences: join(root, "preferences.json"),
    places: join(root, "places.json"),
  };
}
