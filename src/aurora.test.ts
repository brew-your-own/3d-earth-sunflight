import { describe, expect, it } from 'vitest';
import { airports } from './airports';
import { type Flight, buildFlight, flightSampleAt } from './flight';
import {
  AURORA_LIKELY_DEG, AURORA_POSSIBLE_DEG, GEOMAG_NORTH_POLE, OVAL_CENTER_DEG,
  auroraAt, auroraWindows, geomagneticLatitude,
} from './aurora';

function flight(from: string, to: string, dep: string, arr: string): Flight {
  const r = buildFlight({
    from: airports[from], to: airports[to], fromCode: from, toCode: to,
    waypoints: [], waypointCodes: [],
  }, dep, arr);
  if (!r.ok) throw new Error(r.error);
  return r.flight;
}

describe('geomagneticLatitude (centred dipole)', () => {
  it('is 90° at the geomagnetic pole and -90° at its antipode', () => {
    expect(geomagneticLatitude(GEOMAG_NORTH_POLE.lat, GEOMAG_NORTH_POLE.lon)).toBeCloseTo(90, 6);
    expect(geomagneticLatitude(-GEOMAG_NORTH_POLE.lat, GEOMAG_NORTH_POLE.lon + 180)).toBeCloseTo(-90, 6);
  });

  it('matches known stations to a couple of degrees', () => {
    expect(geomagneticLatitude(69.65, 18.96)).toBeCloseTo(67.5, 0);    // Tromsø — under the oval
    expect(geomagneticLatitude(51.5, -0.1)).toBeCloseTo(53.5, 0);      // London
    expect(Math.abs(geomagneticLatitude(1.35, 103.8))).toBeLessThan(10); // Singapore
    expect(geomagneticLatitude(-42.9, 147.3)).toBeLessThan(-45);         // Hobart (aurora australis)
  });

  it('is tilted toward North America (NYC is magnetically further north than Rome)', () => {
    expect(geomagneticLatitude(40.7, -74)).toBeGreaterThan(geomagneticLatitude(41.9, 12.5) + 5);
  });
});

describe('auroraAt', () => {
  it('is never visible in daylight, however far north', () => {
    const f = flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00');
    for (let i = 0; i <= 50; i++) expect(auroraAt(flightSampleAt(f, i / 50)).tier).toBeNull();
  });

  it('ramps strength from POSSIBLE to LIKELY', () => {
    expect(AURORA_POSSIBLE_DEG).toBeLessThan(AURORA_LIKELY_DEG);
    expect(AURORA_LIKELY_DEG).toBeLessThan(OVAL_CENTER_DEG);
  });
});

describe('auroraWindows', () => {
  it('winter night LHR→ORD (westbound over Iceland/Greenland): likely, north on the RIGHT', () => {
    // Heading west, north is on the right-hand side of the aircraft.
    const w = auroraWindows(flight('LHR', 'ORD', '2026-12-15T18:00', '2026-12-15T21:00'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ tier: 'likely', side: 'RIGHT', toward: 'poleward' });
    expect(w[0].tStart).toBeLessThan(w[0].tPeak);
    expect(w[0].tPeak).toBeLessThan(w[0].tEnd);
  });

  it('winter night JFK→HEL (eastbound): north is on the LEFT', () => {
    const w = auroraWindows(flight('JFK', 'HEL', '2026-12-15T22:00', '2026-12-16T13:00'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ tier: 'likely', side: 'LEFT' });
  });

  it('southern winter SYD→SCL (eastbound): aurora australis, south pole on the RIGHT', () => {
    const w = auroraWindows(flight('SYD', 'SCL', '2026-06-15T19:00', '2026-06-15T15:00'));
    expect(w.length).toBeGreaterThan(0);
    expect(w[0].side).toBe('RIGHT');
  });

  it('equatorial night route has none', () => {
    expect(auroraWindows(flight('SIN', 'NBO', '2026-12-15T22:00', '2026-12-16T05:00'))).toEqual([]);
  });

  it('daytime high-latitude route has none', () => {
    expect(auroraWindows(flight('LHR', 'JFK', '2026-06-21T11:00', '2026-06-21T14:00'))).toEqual([]);
  });

  it('window times are consistent with progress', () => {
    const f = flight('LHR', 'ORD', '2026-12-15T18:00', '2026-12-15T21:00');
    for (const w of auroraWindows(f)) {
      expect(w.startUtcMs).toBeCloseTo(f.depUtcMs + w.tStart * f.durationMs, 0);
      expect(w.endUtcMs).toBeCloseTo(f.depUtcMs + w.tEnd * f.durationMs, 0);
    }
  });
});
