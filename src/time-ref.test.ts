import { describe, expect, it } from 'vitest';
import { airports, nearestAirport } from './airports';
import { type Flight, buildFlight } from './flight';
import { formatAt, formatRange, zoneAt } from './time-ref';

function flight(from: string, to: string, dep: string, arr: string): Flight {
  const r = buildFlight({
    from: airports[from], to: airports[to], fromCode: from, toCode: to, waypoints: [], waypointCodes: [],
  }, dep, arr);
  if (!r.ok) throw new Error(r.error);
  return r.flight;
}

describe('nearestAirport', () => {
  it('finds the big airport next to a point', () => {
    expect(['LHR', 'LCY']).toContain(nearestAirport(51.47, -0.45).code);
    expect(nearestAirport(40.64, -73.78).code).toBe('JFK');
  });
});

describe('time reference', () => {
  // JFK 18:00 EDT (22:00Z) → LHR 06:00 BST next day (05:00Z), 7 h.
  const f = flight('JFK', 'LHR', '2026-06-01T18:00', '2026-06-02T06:00');

  it('formats in dep / arr / UTC zones', () => {
    expect(formatAt(f, 'dep', f.depUtcMs, 'HH:mm')).toBe('18:00');
    expect(formatAt(f, 'arr', f.depUtcMs, 'HH:mm')).toBe('23:00');
    expect(formatAt(f, 'utc', f.depUtcMs, 'HH:mm')).toBe('22:00');
  });

  it('local follows the plane: New York at take-off, London at landing', () => {
    expect(zoneAt(f, 'local', f.depUtcMs)).toBe('America/New_York');
    expect(zoneAt(f, 'local', f.arrUtcMs)).toBe('Europe/London');
  });

  it('adds the weekday when a range crosses midnight', () => {
    const h = 3_600_000;
    expect(formatRange(f, 'utc', f.depUtcMs, f.depUtcMs + h)).toBe('22:00–23:00');
    expect(formatRange(f, 'utc', f.depUtcMs, f.depUtcMs + 3 * h)).toBe('Mon 22:00–Tue 01:00');
  });
});
