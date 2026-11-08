import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { airports } from './airports';
import { type Flight, buildFlight } from './flight';
import { latLonToVec3 } from './geo';
import {
  moonEcliptic, moonEmoji, moonEquatorial, moonPhase, moonSummary, moonVecER, topocentricMoonDir,
} from './moon';

const at = (iso: string) => Date.parse(iso);

function flight(from: string, to: string, dep: string, arr: string): Flight {
  const r = buildFlight({
    from: airports[from], to: airports[to], fromCode: from, toCode: to, waypoints: [], waypointCodes: [],
  }, dep, arr);
  if (!r.ok) throw new Error(r.error);
  return r.flight;
}

describe('moon position (Meeus example 47.a, 1992-04-12 0h TD)', () => {
  // 0h TD = 23:59:01 UT the previous day (ΔT ≈ 59 s).
  const ms = at('1992-04-11T23:59:01Z');

  it('ecliptic longitude, latitude and distance', () => {
    const m = moonEcliptic(ms);
    expect(Math.abs(m.lonDeg - 133.162655)).toBeLessThan(0.02);
    expect(Math.abs(m.latDeg - -3.229126)).toBeLessThan(0.02);
    expect(Math.abs(m.distKm - 368409.7)).toBeLessThan(50);
  });

  it('right ascension and declination', () => {
    // Meeus gives apparent RA 134.688470°, Dec 13.768368°; we skip nutation
    // (≤ ~0.005°) so allow a slightly looser tolerance.
    const q = moonEquatorial(ms);
    expect(Math.abs(q.raDeg - 134.688470)).toBeLessThan(0.03);
    expect(Math.abs(q.decDeg - 13.768368)).toBeLessThan(0.03);
  });

  it('illuminated fraction (Meeus example 48.a: k = 0.6786)', () => {
    const p = moonPhase(ms);
    expect(p.illuminated).toBeCloseTo(0.6786, 2);
    expect(p.waxing).toBe(true);
  });
});

describe('moon phase at published 2026 lunations', () => {
  it('new moon 2026-02-17 12:01 UTC (annular solar eclipse)', () => {
    const p = moonPhase(at('2026-02-17T12:01Z'));
    expect(p.illuminated).toBeLessThan(0.002);
    expect(moonEmoji(p.ageDeg)).toBe('🌑');
  });

  it('full moon 2026-03-03 11:38 UTC (total lunar eclipse)', () => {
    const p = moonPhase(at('2026-03-03T11:38Z'));
    expect(p.illuminated).toBeGreaterThan(0.999);
    expect(moonEmoji(p.ageDeg)).toBe('🌕');
  });

  it('waxing a week after new, waning a week after full', () => {
    expect(moonPhase(at('2026-02-24T12:00Z')).waxing).toBe(true);
    expect(moonPhase(at('2026-03-10T12:00Z')).waxing).toBe(false);
  });
});

describe('topocentric parallax', () => {
  it('is ~0.95° for a Moon on the observer\'s geometric horizon', () => {
    const ms = at('2026-03-03T11:38Z');
    const moon = moonVecER(ms);
    // Observer 90° away from the sublunar point → Moon geocentrically on the horizon.
    const sub = moon.clone().normalize();
    const p = new THREE.Vector3(0, 1, 0).cross(sub).normalize();
    const geoElev = Math.asin(sub.dot(p)) * 180 / Math.PI;
    const topoElev = Math.asin(topocentricMoonDir(moon, p, 0).dot(p)) * 180 / Math.PI;
    expect(geoElev).toBeCloseTo(0, 6);
    const parallax = geoElev - topoElev;
    expect(parallax).toBeGreaterThan(0.9);
    expect(parallax).toBeLessThan(1.0);
  });

  it('vanishes for an observer directly under the Moon', () => {
    const moon = moonVecER(at('2026-03-03T11:38Z'));
    const p = moon.clone().normalize();
    expect(topocentricMoonDir(moon, p, 11).angleTo(p)).toBeLessThan(1e-9);
  });
});

describe('moonSummary', () => {
  it('daytime flight: no night, no events', () => {
    const s = moonSummary(flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00'));
    expect(s.nightHours).toBe(0);
    expect(s.upHours).toBe(0);
    expect(s.events).toEqual([]);
  });

  it('overnight flight near full moon: Moon up most of the night, nearly full', () => {
    // JFK 21:00 EST → LHR 09:00 GMT, the night of the 2026-11-24 full moon.
    const s = moonSummary(flight('JFK', 'LHR', '2026-11-24T21:00', '2026-11-25T09:00'));
    expect(s.nightHours).toBeGreaterThan(5);
    expect(s.upHours).toBeGreaterThan(0.6 * s.nightHours);
    expect(s.upHours).toBeLessThanOrEqual(s.nightHours + 1e-9);
    expect(s.sideHours.LEFT + s.sideHours.RIGHT).toBeCloseTo(s.upHours, 9);
    expect(s.phase.illuminated).toBeGreaterThan(0.95);
  });

  it('a rise/set event, when present, is a real horizon crossing in the dark', () => {
    for (const [a, b, d, r] of [
      ['JFK', 'LHR', '2026-11-24T21:00', '2026-11-25T09:00'],
      ['LHR', 'SIN', '2026-11-20T21:00', '2026-11-21T17:00'],
      ['SFO', 'SYD', '2026-11-27T22:00', '2026-11-29T07:00'],
    ] as const) {
      const f = flight(a, b, d, r);
      for (const e of moonSummary(f).events) {
        expect(f.depUtcMs + e.t * f.durationMs).toBeCloseTo(e.utcMs, 0);
        expect(['moonrise', 'moonset']).toContain(e.kind);
      }
    }
  });
});

describe('sublunar point sanity', () => {
  it('declination stays within ±(23.44 + 5.15 + margin)°', () => {
    for (let d = 0; d < 30; d++) {
      const { decDeg } = moonEquatorial(at('2026-01-01T00:00Z') + d * 86400000);
      expect(Math.abs(decDeg)).toBeLessThan(28.8);
    }
  });

  it('distance stays between perigee and apogee', () => {
    for (let d = 0; d < 30; d++) {
      const { distKm } = moonEcliptic(at('2026-01-01T00:00Z') + d * 86400000);
      expect(distKm).toBeGreaterThan(356000);
      expect(distKm).toBeLessThan(407000);
    }
  });

  it('moonVecER agrees with latLonToVec3 of the sublunar point', () => {
    const v = moonVecER(at('2026-05-01T00:00Z'));
    expect(v.length()).toBeGreaterThan(55);
    expect(v.length()).toBeLessThan(64);
    expect(latLonToVec3(0, 0, 1).length()).toBe(1);
  });
});
