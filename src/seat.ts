// Seat recommendation: which window to pick for sunrise/sunset views, and
// which side stays in the shade. Pure — built on flight.ts samples.
import { type Flight, type RecapRow, type Side, flightSampleAt } from './flight';

export type ViewAngle = 'ahead' | 'forward' | 'abeam' | 'aft' | 'behind';

export type SeatEvent = {
  kind: 'sunrise' | 'sunset';
  utcMs: number;
  t: number;            // flight progress ∈ [0,1] at the event
  side: Side;           // window side the sun is on
  relAzDeg: number;     // sun bearing relative to the nose: 0 ahead, +90 right, ±180 behind
  view: ViewAngle;
};

export type SeatAdvice = {
  events: SeatEvent[];
  sunHours: Record<Side, number>;   // hours of direct sun through that side's windows
  shadeSide: Side | null;           // null: little sun either way, or roughly equal
};

// Below this, sunlight through the windows is negligible for "shade" advice.
const MIN_SUN_HOURS = 1 / 6;   // 10 min
// "Direct sun through the window": daylight and at least ~15° off the nose/tail
// axis horizontally (sR is the sun's component along the wing, so it already
// shrinks as the sun climbs and stops coming in sideways).
const WINDOW_SR = 0.25;

export function viewAngle(relAzDeg: number): ViewAngle {
  const a = Math.abs(relAzDeg);
  if (a < 30)  return 'ahead';
  if (a < 60)  return 'forward';
  if (a <= 120) return 'abeam';
  if (a <= 150) return 'aft';
  return 'behind';
}

export function seatAdvice(f: Flight, rows: RecapRow[], N = 600): SeatAdvice {
  // Sunrise = entering DAY from twilight/night; sunset = leaving DAY. The
  // departure row isn't an event (we're already in that phase on the ground).
  const events: SeatEvent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].phase, cur = rows[i];
    if (cur.kind !== 'phase') continue;
    let kind: SeatEvent['kind'] | null = null;
    if (prev !== 'DAY' && cur.phase === 'DAY') kind = 'sunrise';
    else if (prev === 'DAY' && cur.phase !== 'DAY') kind = 'sunset';
    if (!kind) continue;
    const t = (cur.utcMs - f.depUtcMs) / f.durationMs;
    const s = flightSampleAt(f, t);
    const relAzDeg = Math.atan2(s.sR, s.sF) * 180 / Math.PI;
    events.push({
      kind, utcMs: cur.utcMs, t,
      side: s.sR > 0 ? 'RIGHT' : 'LEFT',
      relAzDeg, view: viewAngle(relAzDeg),
    });
  }

  const sunHours: Record<Side, number> = { LEFT: 0, RIGHT: 0 };
  const dtH = f.durationMs / 3_600_000 / N;
  for (let i = 0; i < N; i++) {
    const s = flightSampleAt(f, (i + 0.5) / N);
    if (s.phase !== 'DAY' || Math.abs(s.sR) < WINDOW_SR) continue;
    sunHours[s.sR > 0 ? 'RIGHT' : 'LEFT'] += dtH;
  }

  const { LEFT: l, RIGHT: r } = sunHours;
  let shadeSide: Side | null = null;
  if (Math.max(l, r) >= MIN_SUN_HOURS && Math.abs(l - r) >= 0.2 * Math.max(l, r)) {
    shadeSide = l > r ? 'RIGHT' : 'LEFT';
  }
  return { events, sunHours, shadeSide };
}

// Window seat letters: A is the left window on every layout; the right
// window is F on a 3-3 narrow-body and K on most wide-bodies.
export const SEAT_LETTERS: Record<Side, string> = { LEFT: 'A', RIGHT: 'F/K' };
