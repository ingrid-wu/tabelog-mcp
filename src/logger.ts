type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON lines on stderr. stdout belongs to the MCP protocol. Never log names, phone numbers, or page text. */
export class Logger {
  constructor(
    private readonly minimum: Level = "info",
    private readonly scope = "tabelog-mcp",
  ) {}

  child(scope: string): Logger {
    return new Logger(this.minimum, `${this.scope}:${scope}`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (order[level] < order[this.minimum]) return;
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, scope: this.scope, message, ...fields })}\n`);
  }
}
