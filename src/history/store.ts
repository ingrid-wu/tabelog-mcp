// Booking history as an append-only JSON Lines log. Each line is one event;
// a booking's current state is the fold of its events. Appends are single
// small writes, so several server processes can share the file, and a line cut
// short by a crash is skipped on read instead of corrupting the history.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const purposes = ["personal", "business"] as const;
export type Purpose = (typeof purposes)[number];

const restaurant = z.object({
  rst_id: z.string(),
  name: z.string(),
  url: z.string(),
  genre: z.string().nullable(),
  area: z.string().nullable(),
  score: z.number().nullable(),
});

const event = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prepared"),
    id: z.string(),
    at: z.string(),
    purpose: z.enum(purposes),
    restaurant,
    date: z.string(),
    time: z.string(),
    party: z.number(),
    plan: z.string().nullable(),
    price: z.string().nullable(),
    summary: z.record(z.string(), z.string()),
    notes: z.string().nullable(),
  }),
  z.object({ type: z.literal("confirmed"), id: z.string(), at: z.string(), reservation_number: z.string().nullable() }),
  z.object({ type: z.literal("failed"), id: z.string(), at: z.string(), reason: z.string() }),
  z.object({ type: z.literal("handed_off"), id: z.string(), at: z.string(), reason: z.string() }),
  z.object({ type: z.literal("note"), id: z.string(), at: z.string(), note: z.string() }),
]);
export type HistoryEvent = z.infer<typeof event>;
type PreparedEvent = Extract<HistoryEvent, { type: "prepared" }>;

export type BookingStatus = "prepared" | "confirmed" | "failed" | "handed_off" | "abandoned";

export interface BookingRecord {
  readonly id: string;
  readonly status: BookingStatus;
  readonly purpose: Purpose;
  readonly restaurant: PreparedEvent["restaurant"];
  readonly date: string;
  readonly time: string;
  readonly party: number;
  readonly plan: string | null;
  readonly price: string | null;
  readonly reservation_number: string | null;
  readonly failure_reason: string | null;
  readonly notes: readonly string[];
  readonly prepared_at: string;
  readonly updated_at: string;
}

/** A prepared booking never confirmed within this long counts as abandoned. */
const abandonAfterMs = 30 * 60_000;

export class HistoryStore {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(entry: HistoryEvent): void {
    const parsed = event.parse(entry);
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  events(): HistoryEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed = event.safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
  }

  bookings(): BookingRecord[] {
    const records = new Map<string, BookingRecord>();
    for (const entry of this.events()) {
      if (entry.type === "prepared") {
        records.set(entry.id, {
          id: entry.id,
          status: "prepared",
          purpose: entry.purpose,
          restaurant: entry.restaurant,
          date: entry.date,
          time: entry.time,
          party: entry.party,
          plan: entry.plan,
          price: entry.price,
          reservation_number: null,
          failure_reason: null,
          notes: entry.notes ? [entry.notes] : [],
          prepared_at: entry.at,
          updated_at: entry.at,
        });
        continue;
      }
      const record = records.get(entry.id);
      if (!record) continue;
      switch (entry.type) {
        case "confirmed":
          records.set(entry.id, { ...record, status: "confirmed", reservation_number: entry.reservation_number, updated_at: entry.at });
          break;
        case "failed":
          records.set(entry.id, { ...record, status: "failed", failure_reason: entry.reason, updated_at: entry.at });
          break;
        case "handed_off":
          records.set(entry.id, { ...record, status: "handed_off", failure_reason: entry.reason, updated_at: entry.at });
          break;
        case "note":
          records.set(entry.id, { ...record, notes: [...record.notes, entry.note], updated_at: entry.at });
          break;
      }
    }
    const now = this.now().getTime();
    return [...records.values()]
      .map((record) =>
        record.status === "prepared" && now - Date.parse(record.updated_at) > abandonAfterMs
          ? { ...record, status: "abandoned" as const }
          : record,
      )
      .sort((a, b) => b.prepared_at.localeCompare(a.prepared_at));
  }
}

export interface PreferenceSummary {
  readonly purpose: Purpose;
  readonly confirmed_bookings: number;
  readonly top_genres: readonly string[];
  readonly top_areas: readonly string[];
  readonly usual_party: number | null;
  readonly usual_time: string | null;
  readonly restaurants: readonly { readonly name: string; readonly url: string; readonly visits: number }[];
}

function topCounts(values: readonly (string | null)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** What past confirmed bookings say about this person, per purpose. */
export function summarizePreferences(records: readonly BookingRecord[], purpose: Purpose): PreferenceSummary {
  const confirmed = records.filter((record) => record.status === "confirmed" && record.purpose === purpose);
  const genres = confirmed.flatMap((record) => (record.restaurant.genre ?? "").split(/[、,]/).map((genre) => genre.trim()));
  const visits = new Map<string, { name: string; url: string; visits: number }>();
  for (const record of confirmed) {
    const known = visits.get(record.restaurant.url);
    visits.set(record.restaurant.url, { name: record.restaurant.name, url: record.restaurant.url, visits: (known?.visits ?? 0) + 1 });
  }
  return {
    purpose,
    confirmed_bookings: confirmed.length,
    top_genres: topCounts(genres, 5),
    top_areas: topCounts(confirmed.map((record) => record.restaurant.area), 5),
    usual_party: median(confirmed.map((record) => record.party)),
    usual_time: topCounts(confirmed.map((record) => record.time), 1)[0] ?? null,
    restaurants: [...visits.values()].sort((a, b) => b.visits - a.visits).slice(0, 10),
  };
}

const csvCell = (value: string | number | null): string => {
  const raw = value === null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
};

/** Expense-friendly export. */
export function toCsv(records: readonly BookingRecord[]): string {
  const header = ["date", "time", "restaurant", "party", "plan", "price", "status", "purpose", "reservation_number", "url", "notes"];
  const rows = records.map((record) =>
    [
      record.date,
      record.time,
      record.restaurant.name,
      record.party,
      record.plan,
      record.price,
      record.status,
      record.purpose,
      record.reservation_number,
      record.restaurant.url,
      record.notes.join(" | "),
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...rows].join("\n")}\n`;
}
