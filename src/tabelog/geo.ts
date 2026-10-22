// Walking-time estimates. Tabelog has no routing, so "within 15 minutes" means
// walking, estimated from straight-line distance: streets add about a quarter
// to the crow-flies distance, and Japanese listings assume 80 m per minute.

export interface Point {
  readonly lat: number;
  readonly lng: number;
}

/** Street distance over straight-line distance, a common urban detour factor. */
export const detourFactor = 1.25;
/** Walking speed Japanese real-estate and station listings assume. */
export const metersPerMinute = 80;

export function distanceMeters(a: Point, b: Point): number {
  const radius = 6_371_000;
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

export function walkingMinutes(a: Point, b: Point): number {
  return Math.ceil((distanceMeters(a, b) * detourFactor) / metersPerMinute);
}

/** "35.6812,139.7671" as a point, or null. */
export function parseLatLng(input: string): Point | null {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(input);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
