import { describe, expect, it } from 'vitest';
import { airports } from './airports';
import { type Flight, buildFlight, computeRecap, flightSampleAt } from './flight';
import { seatAdvice, viewAngle } from './seat';

function flight(from: string, to: string, dep: string, arr: string, via: string[] = []): Flight {
  const r = buildFlight({
    from: airports[from], to: airports[to], fromCode: from, toCode: to,
    waypoints: via.map((c) => airports[c]), waypointCodes: via,
  }, dep, arr);
  if (!r.ok) throw new Error(r.error);
  return r.flight;
}
const advise = (f: Flight) => seatAdvice(f, computeRecap(f).rows);

describe('viewAngle', () => {
  it('buckets relative bearings symmetrically', () => {
    expect(viewAngle(0)).toBe('ahead');
    expect(viewAngle(-45)).toBe('forward');
    expect(viewAngle(90)).toBe('abeam');
    expect(viewAngle(-135)).toBe('aft');
    expect(viewAngle(179)).toBe('behind');
  });
});

describe('seatAdvice', () => {
  it('westbound evening in autumn: sunset ahead on the left', () => {
    const a = advise(flight('JFK', 'LAX', '2026-11-08T16:00', '2026-11-08T19:00'));
    expect(a.events).toHaveLength(1);
    expect(a.events[0]).toMatchObject({ kind: 'sunset', side: 'LEFT' });
    expect(a.events[0].relAzDeg).toBeLessThan(0);
  });

  it('eastbound overnight in winter: one sunrise, on the right', () => {
    const a = advise(flight('JFK', 'LHR', '2026-12-15T21:00', '2026-12-16T09:00'));
    expect(a.events.map((e) => [e.kind, e.side])).toEqual([['sunrise', 'RIGHT']]);
  });

  it('midday westbound in June: sun through the left windows, shade on the right', () => {
    const a = advise(flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00'));
    expect(a.events).toEqual([]);
    expect(a.sunHours.LEFT).toBeGreaterThan(5);
    expect(a.sunHours.RIGHT).toBe(0);
    expect(a.shadeSide).toBe('RIGHT');
  });

  it('no shade advice when there is barely any direct sun', () => {
    // Sun already set at JFK (-3.7°) when the wheels leave the ground.
    const a = advise(flight('JFK', 'LAX', '2026-11-08T17:00', '2026-11-08T20:00'));
    expect(a.sunHours.LEFT + a.sunHours.RIGHT).toBeLessThan(1 / 6);
    expect(a.shadeSide).toBeNull();
  });

  it('events carry a progress value consistent with their time', () => {
    const f = flight('LHR', 'SYD', '2026-11-08T21:00', '2026-11-10T06:00', ['DXB', 'SIN']);
    const a = advise(f);
    expect(a.events.length).toBeGreaterThan(0);
    for (const e of a.events) {
      expect(f.depUtcMs + e.t * f.durationMs).toBeCloseTo(e.utcMs, 0);
    }
  });
});

describe('recap transition refinement', () => {
  it('pins phase changes to within a second', () => {
    const f = flight('JFK', 'LHR', '2026-12-15T21:00', '2026-12-16T09:00');
    const { rows } = computeRecap(f);
    const tOf = (ms: number) => (ms - f.depUtcMs) / f.durationMs;
    for (let i = 1; i < rows.length - 1; i++) {
      if (rows[i].kind !== 'phase') continue;
      const before = flightSampleAt(f, tOf(rows[i].utcMs - 1000)).phase;
      const after  = flightSampleAt(f, tOf(rows[i].utcMs + 1000)).phase;
      expect(before).toBe(rows[i - 1].phase);
      expect(after).toBe(rows[i].phase);
    }
  });
});
