export const errorCodes = [
  "AREA_NOT_FOUND",
  "BLOCKED",
  "BROWSER_BUSY",
  "CHROME_NOT_FOUND",
  "INVALID_INPUT",
  "PAGE_CHANGED",
  "SLOT_UNAVAILABLE",
  "SUMMARY_CHANGED",
  "TIMEOUT",
  "TOKEN_INVALID",
  "UNEXPECTED",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class TabelogError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "TabelogError";
  }
}

export function recoveryFor(code: ErrorCode): string {
  switch (code) {
    case "AREA_NOT_FOUND":
      return "Use a Japanese place name (銀座, 渋谷駅, 恵比寿), or call find_area and pass one of its results.";
    case "BLOCKED":
      return "Tabelog refused the request (Cloudflare). Wait a few minutes. If it persists, run `tabelog-mcp login` once so the browser profile looks like a normal visitor.";
    case "BROWSER_BUSY":
      return "Another tabelog-mcp process holds the browser profile. Close the other session, or run one shared server with `tabelog-mcp serve --http` (see README).";
    case "CHROME_NOT_FOUND":
      return "Install Google Chrome, or set TABELOG_MCP_CHROME to the path of a Chrome or Chromium binary.";
    case "INVALID_INPUT":
      return "Fix the argument named in details and retry.";
    case "PAGE_CHANGED":
      return "Tabelog's page did not look as expected. Retry once; if it keeps failing, Tabelog changed its layout and the parser needs an update.";
    case "SLOT_UNAVAILABLE":
      return "That time is no longer open. Call get_availability again and pick another slot.";
    case "SUMMARY_CHANGED":
      return "The booking details changed between prepare and confirm. Call prepare_booking again and show the user the new summary.";
    case "TIMEOUT":
      return "Tabelog was slow to respond. Retry once.";
    case "TOKEN_INVALID":
      return "The token is unknown, used, or expired (5 minutes). Call prepare_booking again.";
    case "UNEXPECTED":
      return "Check `tabelog-mcp status` and the server's stderr log.";
  }
}

export function toTabelogError(error: unknown): TabelogError {
  if (error instanceof TabelogError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new TabelogError("TIMEOUT", error.message.split("\n")[0] ?? "Timed out.");
  }
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
  return new TabelogError("UNEXPECTED", message);
}
