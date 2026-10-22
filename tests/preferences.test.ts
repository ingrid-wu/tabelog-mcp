import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PreferencesStore } from "../src/preferences/store.ts";

const store = () => {
  const path = join(mkdtempSync(join(tmpdir(), "tabelog-prefs-")), "preferences.json");
  return { path, preferences: new PreferencesStore(path) };
};

test("defaults: business first, dinner 17:00-20:00, private room for business, 15-minute walk", () => {
  const saved = store().preferences.read();
  expect(saved.default_purpose).toBe("business");
  expect(saved.business).toMatchObject({ dinner_window: { start: "17:00", end: "20:00" }, private_room: true, max_walk_minutes: 15 });
  expect(saved.personal.private_room).toBe(false);
});

test("a stated preference persists and only changes what was said", () => {
  const { path, preferences } = store();
  preferences.update("business", { dinner_window: { start: "18:30", end: "20:30" }, party: 7, add_note: "client avoids raw fish" });
  const reread = new PreferencesStore(path).read();
  expect(reread.business).toMatchObject({ dinner_window: { start: "18:30", end: "20:30" }, party: 7, private_room: true, notes: ["client avoids raw fish"] });
  expect(reread.personal.dinner_window).toEqual({ start: "17:00", end: "20:00" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("notes accumulate", () => {
  const { preferences } = store();
  preferences.update("business", { add_note: "no smoking" });
  expect(preferences.update("business", { add_note: "near the office" }).business.notes).toEqual(["no smoking", "near the office"]);
});

test("a damaged file falls back to the defaults", () => {
  const { path, preferences } = store();
  writeFileSync(path, "{not json");
  expect(preferences.read().default_purpose).toBe("business");
});
