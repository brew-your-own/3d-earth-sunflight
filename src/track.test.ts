import { describe, expect, it } from 'vitest';
import { TrackError, type TrackPoint, cleanTrack, parseGpx, parseKml, readTrackFile, simplify } from './track';
import { buildTrackFlight, computeRecap, distanceAt, flightSampleAt, groundSpeedAt, planeAt } from './flight';
import { vec3ToLatLon } from './geo';

import kmlText from './fixtures/ncar-gv-rf16.kml?raw';
import kmzDataUrl from './fixtures/ncar-gv-rf16.kmz?inline';
import faText from './fixtures/flightaware-dlh796-eddf-vhhh.kml?raw';

const FIXTURES: Record<string, () => Uint8Array> = {
  'ncar-gv-rf16.kml': () => new TextEncoder().encode(kmlText),
  'flightaware-dlh796-eddf-vhhh.kml': () => new TextEncoder().encode(faText),
  'ncar-gv-rf16.kmz': () => Uint8Array.from(atob(kmzDataUrl.split(',')[1]), (c) => c.charCodeAt(0)),
};
const fixture = (name: string) => FIXTURES[name]();
const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + 'Z';

// NCAR/EOL GV research flight "INSPYRE rf16", Boeing Field → Jeffco, 2026-09-08.
// Untimed LineString (altitudes in feet) + timed / clock-only placemarks.
describe('NCAR live-feed KML', () => {
  it('times the line from the placemarks and fills the coverage gap', async () => {
    const t = await readTrackFile('real-time.kml', fixture('ncar-gv-rf16.kml'));
    expect(t.name).toBe('INSPYRE rf16');
    expect(t.notes).toContain('altitudes read as feet');
    expect(iso(t.points[0].utcMs)).toBe('2026-09-08T20:36:01Z');            // "Take off" (clock only)
    expect(iso(t.points[t.points.length - 1].utcMs)).toBe('2026-09-09T03:06:22Z');
    for (let i = 1; i < t.points.length; i++) expect(t.points[i].utcMs).toBeGreaterThan(t.points[i - 1].utcMs);
    // The line jumps Wyoming → Jeffco; the 02:30 wind-barb fix is in between.
    const p = t.points.find((q) => iso(q.utcMs) === '2026-09-09T02:30:00Z');
    expect(p).toBeDefined();
    const peakFt = Math.max(...t.points.map((q) => q.altM ?? 0)) / 0.3048;
    expect(peakFt).toBeGreaterThan(45000);   // FL450+, i.e. feet were converted
    expect(peakFt).toBeLessThan(46000);
  });

  it('reads the same flight from the KMZ', async () => {
    const a = await readTrackFile('a.kml', fixture('ncar-gv-rf16.kml'));
    const b = await readTrackFile('b.kmz', fixture('ncar-gv-rf16.kmz'));
    expect(b.points).toEqual(a.points);
  });

  it('builds a flight: trimmed to wheels-up, BFI → BJC, sunset en route', async () => {
    const t = await readTrackFile('x.kmz', fixture('ncar-gv-rf16.kmz'));
    const c = cleanTrack(t.points);
    expect(c.points.length).toBeLessThan(t.points.length / 2);
    expect(c.notes.join()).toMatch(/ground time trimmed \(1h21 before take-off/);
    const r = buildTrackFlight(t.name, c.points);
    if (!r.ok) throw new Error(r.error);
    const f = r.flight;
    expect([f.fromCode, f.toCode]).toEqual(['BFI', 'BJC']);
    expect(iso(f.depUtcMs)).toMatch(/^2026-09-08T21:5/);
    expect(f.track?.altKm).not.toBeNull();
    const rows = computeRecap(f).rows;
    expect(rows.some((r) => r.label === '→ NIGHT')).toBe(true);
  });
});

// FlightAware export: Lufthansa DLH796 Frankfurt → Hong Kong, 2026-11-08.
// One gx:Track (metres), plus untimed airport placemarks that must be ignored.
// Patchy ADS-B east of the Black Sea: 4 holes ≥ 15 min (69, 25, 82 min and
// 4h50 from Kazakhstan to southern China) — 7h47 of the 11h47 flight.
describe('FlightAware KML (gx:Track)', () => {
  const load = () => readTrackFile('FlightAware_DLH796_EDDF_VHHH_20261108.kml', fixture('flightaware-dlh796-eddf-vhhh.kml'));

  it('reads every fix of the gx:Track, in metres', async () => {
    const t = await load();
    expect(t.name).toBe('FlightAware ✈ DLH796 08-Nov-2026 (FRA / EDDF-HKG / VHHH)');
    expect(t.notes).toEqual([]);                       // no feet, no clock-only labels
    expect(t.points.length).toBe(466);
    expect(iso(t.points[0].utcMs)).toBe('2026-11-08T21:24:50Z');
    expect(iso(t.points[t.points.length - 1].utcMs)).toBe('2026-11-09T09:12:19Z');
    expect(t.points[0]).toMatchObject({ lat: expect.closeTo(50.03, 1), lon: expect.closeTo(8.57, 1) });
    expect(Math.max(...t.points.map((p) => p.altM ?? 0))).toBe(11918);
  });

  it('flags the coverage gaps and keeps the long one as a single bridged leg', async () => {
    const c = cleanTrack((await load()).points);
    expect(c.notes).toEqual(['4 coverage gaps bridged by great circle (7h47 in all, longest 4h50)']);
    const gap = c.points.slice(1).findIndex((p, i) => p.utcMs - c.points[i].utcMs > 4 * 3_600_000);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(c.points[gap].lon).toBeCloseTo(75.44, 1);       // last fix over Kazakhstan
    expect(c.points[gap + 1].lon).toBeCloseTo(110.80, 1);  // first fix over southern China
  });

  it('builds FRA → HKG: night departure, sunrise over Asia with the sun on the right', async () => {
    const c = cleanTrack((await load()).points);
    const r = buildTrackFlight('DLH796', c.points);
    if (!r.ok) throw new Error(r.error);
    const f = r.flight;
    expect([f.fromCode, f.toCode]).toEqual(['FRA', 'HKG']);
    expect([f.from.tz, f.to.tz]).toEqual(['Europe/Berlin', 'Asia/Hong_Kong']);
    expect(f.distanceKm).toBeGreaterThan(9500);
    expect(f.distanceKm).toBeLessThan(11000);
    const { rows, stats } = computeRecap(f);
    expect(rows[0].phase).toBe('NIGHT');
    const sunrise = rows.find((x) => x.phase === 'DAY')!;
    expect(iso(sunrise.utcMs)).toMatch(/^2026-11-09T02:/);
    expect(sunrise.side).toBe('RIGHT');
    expect(stats.rightPct).toBeGreaterThan(10 * stats.leftPct);
  });
});

describe('parseKml formats', () => {
  it('reads gx:Track (metres)', () => {
    const kml = `<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>AF1</name><Placemark>
      <gx:Track><when>2026-06-01T10:00:00Z</when><when>2026-06-01T11:00:00Z</when>
      <gx:coord>2.55 49.01 100</gx:coord><gx:coord>0 51.47 10000</gx:coord></gx:Track></Placemark></Document></kml>`;
    const t = parseKml(kml);
    expect(t.name).toBe('AF1');
    expect(t.points).toEqual([
      { utcMs: Date.UTC(2026, 5, 1, 10), lat: 49.01, lon: 2.55, altM: 100 },
      { utcMs: Date.UTC(2026, 5, 1, 11), lat: 51.47, lon: 0, altM: 10000 },
    ]);
  });

  it('reads timed placemarks (Flightradar24 style), sorted by time', () => {
    const pm = (when: string, lon: number, lat: number) =>
      `<Placemark><TimeStamp><when>${when}</when></TimeStamp><Point><coordinates>${lon},${lat},9000</coordinates></Point></Placemark>`;
    const kml = `<kml><Document>${pm('2026-06-01T10:10:00Z', 1, 50)}${pm('2026-06-01T10:00:00Z', 2, 49)}</Document></kml>`;
    const t = parseKml(kml);
    expect(t.points.map((p) => p.lon)).toEqual([2, 1]);
    expect(t.notes).not.toContain('altitudes read as feet');
  });

  it('explains a NetworkLink-only file', () => {
    const kml = `<kml><Document><NetworkLink><name>GV</name><Link><href>http://example.org/real-time.kmz</href></Link></NetworkLink></Document></kml>`;
    expect(() => parseKml(kml)).toThrow(TrackError);
    expect(() => parseKml(kml)).toThrow(/live feed \(http:\/\/example\.org\/real-time\.kmz\)/);
  });

  it('rejects a line with no timestamps', () => {
    const kml = `<kml><Placemark><LineString><coordinates>0,0,0 1,1,0</coordinates></LineString></Placemark></kml>`;
    expect(() => parseKml(kml)).toThrow(/no timestamps/);
  });
});

describe('parseGpx', () => {
  it('reads trkpt with ele and time', () => {
    const gpx = `<gpx><trk><name>Phone log</name><trkseg>
      <trkpt lat="48.0" lon="2.0"><ele>120</ele><time>2026-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="48.5" lon="2.5"><time>2026-06-01T10:05:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const t = parseGpx(gpx);
    expect(t.name).toBe('Phone log');
    expect(t.points[0]).toEqual({ utcMs: Date.UTC(2026, 5, 1, 10), lat: 48, lon: 2, altM: 120 });
    expect(t.points[1].altM).toBeNull();
  });
});

// Straight north along lon 0 at a given speed: easy to reason about.
function northLine(n: number, stepS: number, kmh: number, t0 = Date.UTC(2026, 5, 1, 12)): TrackPoint[] {
  const degPerS = kmh / 3600 / 111.195;
  return Array.from({ length: n }, (_, i) => ({ utcMs: t0 + i * stepS * 1000, lat: 10 + i * stepS * degPerS, lon: 0, altM: 10000 }));
}

describe('cleanTrack', () => {
  it('drops a GPS spike and simplifies a straight constant-speed line to its ends', () => {
    const pts = northLine(50, 10, 800);
    pts[20] = { ...pts[20], lon: 5 };   // 500 km off in 10 s
    const c = cleanTrack(pts);
    expect(c.notes).toContain('1 GPS spikes removed');
    expect(c.points.length).toBe(2);
  });

  it('keeps the point where the speed changes (time-synchronised simplify)', () => {
    const slow = northLine(10, 60, 300);
    const last = slow[slow.length - 1];
    const fast = northLine(10, 60, 900, last.utcMs).map((p) => ({ ...p, lat: p.lat - 10 + last.lat }));
    const s = simplify([...slow, ...fast.slice(1)], 0.25);
    expect(s.map((p) => p.utcMs)).toContain(last.utcMs);
  });
});

describe('buildTrackFlight', () => {
  // A: 0 h, B: +1 h (100 km), C: +3 h (another 100 km) → the plane reaches B
  // at a third of the time, not half way.
  const t0 = Date.UTC(2026, 5, 1, 12);
  const d = 100 / 111.195;
  const pts: TrackPoint[] = [
    { utcMs: t0, lat: 0, lon: 0, altM: 0 },
    { utcMs: t0 + 3_600_000, lat: d, lon: 0, altM: 10000 },
    { utcMs: t0 + 3 * 3_600_000, lat: 2 * d, lon: 0, altM: null },
  ];
  const r = buildTrackFlight('T', pts);
  if (!r.ok) throw new Error(r.error);
  const f = r.flight;

  it('maps progress to time', () => {
    expect(vec3ToLatLon(planeAt(f, 1 / 3).pos).lat).toBeCloseTo(d, 6);
    expect(distanceAt(f, 1 / 3)).toBeCloseTo(100, 1);
    expect(groundSpeedAt(f, 0.1)).toBeCloseTo(100, 0);
    expect(groundSpeedAt(f, 0.9)).toBeCloseTo(50, 0);
  });

  it('interpolates altitude, filling a missing one from its neighbours', () => {
    expect(flightSampleAt(f, 1 / 6).altKm).toBeCloseTo(5, 6);
    expect(flightSampleAt(f, 1).altKm).toBeCloseTo(10, 6);
  });

  it('heading points north (smoothed, finite) everywhere', () => {
    for (const t of [0, 1 / 3, 0.5, 1]) {
      const h = planeAt(f, t).heading;
      expect(h.y).toBeGreaterThan(0.99);
    }
  });

  it('rejects a track with no duration', () => {
    expect(buildTrackFlight('T', [pts[0], { ...pts[1], utcMs: t0 }]).ok).toBe(false);
  });
});
