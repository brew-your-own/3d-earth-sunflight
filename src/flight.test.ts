import { describe, expect, it } from 'vitest';
import { airports } from './airports';
import { vec3ToLatLon } from './geo';
import { type Flight, buildFlight, computeRecap, flightSampleAt, planeAt } from './flight';

function flight(from: string, to: string, dep: string, arr: string, via: string[] = []): Flight {
  const r = buildFlight({
    from: airports[from], to: airports[to], fromCode: from, toCode: to,
    waypoints: via.map((c) => airports[c]), waypointCodes: via,
  }, dep, arr);
  if (!r.ok) throw new Error(r.error);
  return r.flight;
}

describe('buildFlight', () => {
  it('reads each time in its own airport timezone', () => {
    // 11:00 EDT = 15:00Z; 23:00 BST = 22:00Z → 7 h.
    const f = flight('JFK', 'LHR', '2026-06-01T11:00', '2026-06-01T23:00');
    expect(new Date(f.depUtcMs).toISOString()).toBe('2026-06-01T15:00:00.000Z');
    expect(f.durationMs).toBe(7 * 3_600_000);
    expect(f.speedKmh).toBeCloseTo(f.distanceKm / 7, 6);
  });

  it('rejects arrival before departure and invalid times', () => {
    const route = {
      from: airports.LHR, to: airports.JFK, fromCode: 'LHR', toCode: 'JFK',
      waypoints: [], waypointCodes: [],
    };
    expect(buildFlight(route, '2026-06-01T12:00', '2026-06-01T06:00').ok).toBe(false); // 11:00Z → 10:00Z
    expect(buildFlight(route, 'garbage', '2026-06-01T06:00').ok).toBe(false);
  });

  it('rejects a zero-length route', () => {
    const r = buildFlight({
      from: airports.LHR, to: airports.LHR, fromCode: 'LHR', toCode: 'LHR',
      waypoints: [], waypointCodes: [],
    }, '2026-06-01T10:00', '2026-06-01T12:00');
    expect(r).toEqual({ ok: false, error: 'Route has zero length.' });
  });

  it('drops zero-length legs from repeated waypoints', () => {
    const f = flight('LHR', 'SYD', '2026-11-08T21:00', '2026-11-10T06:00', ['LHR', 'DXB', 'DXB', 'SIN']);
    expect(f.segments).toHaveLength(3);
    expect(f.segments[0].tStart).toBe(0);
    expect(f.segments.at(-1)!.tEnd).toBe(1);
  });

  it('splits progress proportionally to leg length', () => {
    const f = flight('LHR', 'SYD', '2026-11-08T21:00', '2026-11-10T06:00', ['DXB', 'SIN']);
    const total = f.segments.reduce((s, x) => s + x.distanceKm, 0);
    expect(total).toBeCloseTo(f.distanceKm, 6);
    for (const s of f.segments) {
      expect(s.tEnd - s.tStart).toBeCloseTo(s.distanceKm / total, 9);
    }
  });
});

describe('planeAt', () => {
  const f = flight('LHR', 'SYD', '2026-11-08T21:00', '2026-11-10T06:00', ['DXB', 'SIN']);

  it('starts at the origin, passes through waypoints, ends at the destination', () => {
    const at = (t: number) => vec3ToLatLon(planeAt(f, t).pos);
    const near = (p: { lat: number; lon: number }, code: string) => {
      expect(p.lat).toBeCloseTo(airports[code].lat, 6);
      expect(p.lon).toBeCloseTo(airports[code].lon, 6);
    };
    near(at(0), 'LHR');
    near(at(f.segments[0].tEnd), 'DXB');
    near(at(f.segments[1].tEnd), 'SIN');
    near(at(1), 'SYD');
  });

  it('never returns NaN', () => {
    for (let i = 0; i <= 100; i++) {
      const { pos, heading } = planeAt(f, i / 100);
      expect(Number.isFinite(pos.x + pos.y + pos.z + heading.x + heading.y + heading.z)).toBe(true);
    }
  });
});

describe('flightSampleAt', () => {
  it('puts the sun on the left of a westbound plane at local noon in northern summer', () => {
    // LHR→JFK heads roughly west-northwest; at mid-day in June the sun is to
    // the south, i.e. on the left side of the aircraft.
    const f = flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00');
    const s = flightSampleAt(f, 0.05);
    expect(s.phase).toBe('DAY');
    expect(s.side).toBe('LEFT');
    expect(s.elevDeg).toBeGreaterThan(40);
  });
});

describe('computeRecap', () => {
  it('produces ordered rows bracketed by departure and arrival', () => {
    const f = flight('LHR', 'SYD', '2026-11-08T21:00', '2026-11-10T06:00', ['DXB', 'SIN']);
    const { rows } = computeRecap(f);
    expect(rows[0].kind).toBe('endpoint');
    expect(rows[0].label).toMatch(/^Depart LHR/);
    expect(rows.at(-1)!.kind).toBe('endpoint');
    expect(rows.at(-1)!.label).toBe('Arrive SYD');
    for (let i = 1; i < rows.length; i++) expect(rows[i].utcMs).toBeGreaterThanOrEqual(rows[i - 1].utcMs);
  });

  it('time breakdown sums to 100%', () => {
    const f = flight('JFK', 'HND', '2026-11-08T11:00', '2026-11-09T15:00');
    const { stats } = computeRecap(f);
    expect(stats.leftPct + stats.rightPct + stats.twilightPct + stats.nightPct).toBeCloseTo(100, 9);
  });

  it('an overnight eastbound transatlantic starts in NIGHT and lands in DAY', () => {
    // JFK 21:00 EST → LHR 09:00 GMT in mid-December (London sunrise ≈ 08:00).
    const f = flight('JFK', 'LHR', '2026-12-15T21:00', '2026-12-16T09:00');
    const { rows, stats } = computeRecap(f);
    expect(rows[0].phase).toBe('NIGHT');
    expect(rows.at(-1)!.phase).toBe('DAY');
    expect(stats.nightPct).toBeGreaterThan(50);
  });

  it('a summer midday westbound hop is all daylight', () => {
    const f = flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00');
    const { stats } = computeRecap(f);
    expect(stats.twilightPct + stats.nightPct).toBe(0);
  });
});
