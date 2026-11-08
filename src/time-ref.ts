// Which clock the recap shows times in: departure tz, arrival tz, UTC, or
// "plane-local" (the tz under the plane at that moment). Pure — no DOM.
import { DateTime } from 'luxon';
import { nearestAirport } from './airports';
import { type Flight, planeAt } from './flight';
import { vec3ToLatLon } from './geo';

export type TimeRef = 'dep' | 'arr' | 'utc' | 'local';
export const TIME_REFS: TimeRef[] = ['dep', 'arr', 'utc', 'local'];

// IANA zone for a moment of the flight under the given reference.
export function zoneAt(f: Flight, ref: TimeRef, utcMs: number): string {
  switch (ref) {
    case 'dep': return f.from.tz;
    case 'arr': return f.to.tz;
    case 'utc': return 'UTC';
    case 'local': {
      const t = Math.min(1, Math.max(0, (utcMs - f.depUtcMs) / f.durationMs || 0));
      const { lat, lon } = vec3ToLatLon(planeAt(f, t).pos);
      return nearestAirport(lat, lon).ap.tz;
    }
  }
}

export function formatAt(f: Flight, ref: TimeRef, utcMs: number, fmt: string): string {
  return DateTime.fromMillis(utcMs).setZone(zoneAt(f, ref, utcMs)).toFormat(fmt);
}

// "21:40–23:15", or "Tue 23:40–Wed 01:15" when the range crosses midnight
// in the chosen zone(s).
export function formatRange(f: Flight, ref: TimeRef, a: number, b: number): string {
  const da = DateTime.fromMillis(a).setZone(zoneAt(f, ref, a));
  const db = DateTime.fromMillis(b).setZone(zoneAt(f, ref, b));
  return da.toISODate() === db.toISODate()
    ? `${da.toFormat('HH:mm')}–${db.toFormat('HH:mm')}`
    : `${da.toFormat('ccc HH:mm')}–${db.toFormat('ccc HH:mm')}`;
}

// Short button label and a longer description for the recap title.
export function refLabel(f: Flight, ref: TimeRef): string {
  return ref === 'dep' ? f.fromCode : ref === 'arr' ? f.toCode : ref === 'utc' ? 'UTC' : 'Local';
}
export function refDescription(f: Flight, ref: TimeRef): string {
  switch (ref) {
    case 'dep':   return `${f.fromCode} time (${f.from.tz})`;
    case 'arr':   return `${f.toCode} time (${f.to.tz})`;
    case 'utc':   return 'UTC';
    case 'local': return 'local time under the plane';
  }
}
