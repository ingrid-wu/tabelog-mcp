// Stated preferences: what the user has told the agent ("we eat at 7:30",
// "always a private room for clients"). They set the defaults that searches
// and bookings use when a request leaves something out. Learned preferences
// (from booking history) are computed separately and never overwrite these.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { purposes } from "../history/store.ts";

const clock = z.string().regex(/^\d{2}:\d{2}$/);
const window = z.object({ start: clock, end: clock });

const purposePreferences = z.object({
  /** Seating window searched when a request names no time. */
  dinner_window: window,
  lunch_window: window,
  party: z.number().int().min(1).max(50).nullable(),
  private_room: z.boolean(),
  max_walk_minutes: z.number().int().min(1).max(60),
  budget_max_yen: z.number().int().min(1_000).max(100_000).nullable(),
  /** Free-text things the user said: cuisines to avoid, guests' needs, … */
  notes: z.array(z.string().max(300)).max(50),
});
export type PurposePreferences = z.infer<typeof purposePreferences>;

const file = z.object({
  default_purpose: z.enum(purposes),
  personal: purposePreferences,
  business: purposePreferences,
});
export type Preferences = z.infer<typeof file>;

const base: PurposePreferences = {
  dinner_window: { start: "17:00", end: "20:00" },
  lunch_window: { start: "11:30", end: "13:30" },
  party: null,
  private_room: false,
  max_walk_minutes: 15,
  budget_max_yen: null,
  notes: [],
};

/** Business is the primary use: client and team dinners, private rooms by default. */
export const defaultPreferences: Preferences = {
  default_purpose: "business",
  personal: base,
  business: { ...base, private_room: true },
};

export type PreferenceUpdate = Partial<Omit<PurposePreferences, "notes">> & { readonly add_note?: string };

export class PreferencesStore {
  constructor(private readonly path: string) {}

  read(): Preferences {
    if (!existsSync(this.path)) return defaultPreferences;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Preferences>;
      // Fill fields added in later versions from the defaults.
      return file.parse({
        default_purpose: raw.default_purpose ?? defaultPreferences.default_purpose,
        personal: { ...defaultPreferences.personal, ...raw.personal },
        business: { ...defaultPreferences.business, ...raw.business },
      });
    } catch {
      return defaultPreferences;
    }
  }

  update(purpose: (typeof purposes)[number], change: PreferenceUpdate, defaultPurpose?: (typeof purposes)[number]): Preferences {
    const current = this.read();
    const { add_note, ...fields } = change;
    const updated = file.parse({
      ...current,
      ...(defaultPurpose ? { default_purpose: defaultPurpose } : {}),
      [purpose]: {
        ...current[purpose],
        ...fields,
        notes: add_note ? [...current[purpose].notes, add_note].slice(-50) : current[purpose].notes,
      },
    });
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Write then rename, so a crash never leaves half a file.
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
    return updated;
  }
}
