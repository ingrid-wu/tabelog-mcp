// Restaurant locations and info rows, cached on disk. A restaurant's map pin
// and room info rarely change, and fetching each page costs a paced request,
// so repeat searches in the same neighbourhood get much faster.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Point } from "./geo.ts";

export interface CachedPlace {
  readonly name: string;
  readonly location: Point | null;
  readonly private_room: string | null;
  readonly genre: string | null;
  readonly address: string | null;
  readonly fetched_at: string;
}

const maxAgeMs = 30 * 24 * 60 * 60_000;

export class PlaceCache {
  private entries: Record<string, CachedPlace> | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(rstId: string): CachedPlace | undefined {
    const entry = this.load()[rstId];
    if (!entry || this.now().getTime() - Date.parse(entry.fetched_at) > maxAgeMs) return undefined;
    return entry;
  }

  set(rstId: string, place: Omit<CachedPlace, "fetched_at">): void {
    this.load()[rstId] = { ...place, fetched_at: this.now().toISOString() };
  }

  save(): void {
    if (!this.entries) return;
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  private load(): Record<string, CachedPlace> {
    if (this.entries) return this.entries;
    try {
      this.entries = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, CachedPlace>) : {};
    } catch {
      this.entries = {};
    }
    return this.entries;
  }
}
