// Duration parsing and local-time ↔ timezone helpers. Pure — no DOM.
import { DateTime } from 'luxon';

// Accepts "11h 30m", "11:30", "11.5", "11h", "30m". Returns minutes or null.
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})$/)))
    return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/)) && (m[1] || m[2]))
    return Math.round((m[1] ? parseFloat(m[1]) : 0) * 60 + (m[2] ? parseInt(m[2]) : 0));
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/)))
    return Math.round(parseFloat(m[1]) * 60);
  return null;
}

export function formatDuration(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '';
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// arr_local (in toTz) = dep_local (in fromTz) + duration
export function durationToArrIso(depIso: string, fromTz: string, durMin: number, toTz: string): string {
  const dep = DateTime.fromISO(depIso, { zone: fromTz });
  if (!dep.isValid) return '';
  return dep.plus({ minutes: durMin }).setZone(toTz).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function arrIsoToDurationMin(depIso: string, fromTz: string, arrIso: string, toTz: string): number | null {
  const dep = DateTime.fromISO(depIso, { zone: fromTz });
  const arr = DateTime.fromISO(arrIso, { zone: toTz });
  if (!dep.isValid || !arr.isValid) return null;
  return Math.round(arr.diff(dep, 'minutes').minutes);
}

// "America/New_York (UTC−4)" for the given local datetime in that zone.
// Offset is evaluated *at the given datetime* so DST switches are reflected.
export function formatTzInfo(tz: string, localIso: string): string {
  if (!tz) return '';
  const dt = localIso
    ? DateTime.fromISO(localIso, { zone: tz })
    : DateTime.now().setZone(tz);
  if (!dt.isValid) return tz;
  const offMin = dt.offset;                              // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(offMin) / 60);
  const m = Math.abs(offMin) % 60;
  const offStr = m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, '0')}`;
  return `${tz} (UTC${offStr})`;
}
