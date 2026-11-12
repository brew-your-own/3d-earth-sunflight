// Flight model: piecewise great-circle route, plane position over time, sun
// geometry relative to the plane, and the offline recap scan.
// Pure — no scene or DOM state — so it's covered by unit tests.
import * as THREE from 'three';
import { DateTime } from 'luxon';
import { type Airport, nearestAirport } from './airports';
import { EARTH_RADIUS_KM, type Arc, arcHeading, arcPoint, latLonToVec3, makeArc } from './geo';
import type { TrackPoint } from './track';
import { type Phase, altitudeKm, daylightLabel, subsolarPoint } from './astro';

// One great-circle leg between two consecutive route points. tStart..tEnd is
// the segment's slice of overall progress (t ∈ [0,1]) — split proportional to
// arc length so the plane moves at uniform angular speed across the whole path.
export type Segment = {
  arc: Arc;
  distanceKm: number;
  tStart: number; tEnd: number;
};

export type Flight = {
  from: Airport; to: Airport;
  fromCode: string; toCode: string;
  waypoints: Airport[]; waypointCodes: string[];
  depUtcMs: number; arrUtcMs: number; durationMs: number;
  segments: Segment[];
  distanceKm: number; speedKmh: number;
  // Set for a flight built from a real GPS track (buildTrackFlight): one
  // altitude per segment boundary (segments.length + 1 entries, km), or null
  // when the file had no altitudes (then the trapezoid profile is used).
  track?: { name: string; altKm: number[] | null };
};

export type RouteSpec = {
  from: Airport; to: Airport;
  fromCode: string; toCode: string;
  waypoints: Airport[]; waypointCodes: string[];
};

// Departure/arrival are local wall-clock ISO strings ("2026-05-16T11:30"),
// each interpreted in its own airport's IANA timezone.
export function buildFlight(
  route: RouteSpec, depLocalStr: string, arrLocalStr: string
): { ok: true; flight: Flight } | { ok: false; error: string } {
  const dep = DateTime.fromISO(depLocalStr, { zone: route.from.tz });
  const arr = DateTime.fromISO(arrLocalStr, { zone: route.to.tz });
  if (!dep.isValid) return { ok: false, error: `Bad departure: ${dep.invalidReason ?? 'invalid'}` };
  if (!arr.isValid) return { ok: false, error: `Bad arrival: ${arr.invalidReason ?? 'invalid'}` };
  const depMs = dep.toMillis();
  const arrMs = arr.toMillis();
  if (arrMs <= depMs) return { ok: false, error: 'Arrival must be after departure (UTC).' };

  // Zero-length legs (a waypoint repeating its neighbour) are dropped: they
  // contribute no distance and their heading would be meaningless.
  const chain = [route.from, ...route.waypoints, route.to];
  const pts   = chain.map((ap) => latLonToVec3(ap.lat, ap.lon, 1));
  const arcs: Arc[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const arc = makeArc(pts[i], pts[i + 1]);
    if (arc.omega > 1e-9) arcs.push(arc);
  }
  if (arcs.length === 0) return { ok: false, error: 'Route has zero length.' };
  const totalOmega = arcs.reduce((sum, a) => sum + a.omega, 0);

  const segments: Segment[] = [];
  let cumT = 0;
  arcs.forEach((arc, i) => {
    const tStart = cumT;
    const tEnd   = i === arcs.length - 1 ? 1 : cumT + arc.omega / totalOmega;
    cumT = tEnd;
    segments.push({ arc, distanceKm: arc.omega * EARTH_RADIUS_KM, tStart, tEnd });
  });

  const distanceKm = totalOmega * EARTH_RADIUS_KM;
  const durationMs = arrMs - depMs;
  return {
    ok: true,
    flight: {
      ...route,
      waypointCodes: route.waypointCodes.slice(),
      depUtcMs: depMs, arrUtcMs: arrMs, durationMs,
      segments, distanceKm,
      speedKmh: distanceKm / (durationMs / 3_600_000),
    },
  };
}

// A flight from a real GPS track (track.ts → cleanTrack). Progress t maps to
// time, not distance: each point's t is its timestamp's share of the flight,
// so the plane speeds up, slows and holds exactly as recorded. Endpoints are
// named after the nearest airport (any size) — their tz drives the recap's
// dep/arr clocks.
export function buildTrackFlight(
  name: string, points: TrackPoint[],
): { ok: true; flight: Flight } | { ok: false; error: string } {
  if (points.length < 2) return { ok: false, error: 'Track has fewer than two points.' };
  const depUtcMs = points[0].utcMs;
  const arrUtcMs = points[points.length - 1].utcMs;
  const durationMs = arrUtcMs - depUtcMs;
  if (!(durationMs > 0)) return { ok: false, error: 'Track has no duration.' };

  // Points missing an altitude take it from their neighbours (linear in time).
  const known = points.flatMap((p, i) => (p.altM != null ? [i] : []));
  const altAt = (i: number): number => {
    if (known.length === 0) return 0;
    let k = 0;
    while (k < known.length - 1 && known[k + 1] <= i) k++;
    const i0 = known[k], i1 = known[Math.min(k + 1, known.length - 1)];
    const a0 = points[i0].altM!, a1 = points[i1].altM!;
    if (i <= i0 || i1 === i0) return a0;
    const u = (points[i].utcMs - points[i0].utcMs) / (points[i1].utcMs - points[i0].utcMs);
    return a0 + (a1 - a0) * u;
  };

  const pts = points.map((p) => latLonToVec3(p.lat, p.lon, 1));
  const segments: Segment[] = [];
  const altKm: number[] = [Math.max(0, altAt(0) / 1000)];
  for (let i = 0; i < points.length - 1; i++) {
    const arc = makeArc(pts[i], pts[i + 1]);
    segments.push({
      arc, distanceKm: arc.omega * EARTH_RADIUS_KM,
      tStart: (points[i].utcMs - depUtcMs) / durationMs,
      tEnd:   i === points.length - 2 ? 1 : (points[i + 1].utcMs - depUtcMs) / durationMs,
    });
    altKm.push(Math.max(0, altAt(i + 1) / 1000));
  }
  const distanceKm = segments.reduce((d, s) => d + s.distanceKm, 0);
  const a = nearestAirport(points[0].lat, points[0].lon, 0);
  const b = nearestAirport(points[points.length - 1].lat, points[points.length - 1].lon, 0);
  return {
    ok: true,
    flight: {
      from: a.ap, to: b.ap, fromCode: a.code, toCode: b.code,
      waypoints: [], waypointCodes: [],
      depUtcMs, arrUtcMs, durationMs, segments, distanceKm,
      speedKmh: distanceKm / (durationMs / 3_600_000),
      track: { name, altKm: points.some((p) => p.altM != null) ? altKm : null },
    },
  };
}

// Index of the segment active at t (binary search: tracks have hundreds).
function segmentIndexAt(f: Flight, t: number): number {
  const segs = f.segments;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t <= segs[mid].tEnd) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function segU(seg: Segment, t: number): number {
  const span = seg.tEnd - seg.tStart;
  return span > 0 ? THREE.MathUtils.clamp((t - seg.tStart) / span, 0, 1) : 0;
}

function posAt(f: Flight, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const seg = f.segments[segmentIndexAt(f, t)];
  return arcPoint(seg.arc, segU(seg, t), out);
}

// A track's heading jumps at every vertex; the window camera would jerk. Use
// the chord across ±HEADING_WINDOW_MS of flight instead (projected onto the
// local horizontal). Stationary (taxi stop, hold on the runway): keep the
// heading of the nearest leg that moved.
const HEADING_WINDOW_MS = 30_000;

function trackHeading(f: Flight, t: number, pos: THREE.Vector3, i: number): THREE.Vector3 {
  const dt = HEADING_WINDOW_MS / f.durationMs;
  const d = posAt(f, Math.min(1, t + dt)).sub(posAt(f, Math.max(0, t - dt)));
  d.addScaledVector(pos, -d.dot(pos));
  if (d.lengthSq() > 1e-16) return d.normalize();
  const segs = f.segments;
  for (let k = 0; k < segs.length; k++) {
    for (const j of [i - k, i + k]) {
      if (j < 0 || j >= segs.length || segs[j].arc.omega < 1e-9) continue;
      const h = arcHeading(segs[j].arc, j < i ? 1 : 0);
      h.addScaledVector(pos, -h.dot(pos));
      if (h.lengthSq() > 1e-16) return h.normalize();
    }
  }
  return arcHeading(segs[i].arc, 0);
}

// Position + heading (unit vectors, Earth-local frame) at overall t ∈ [0,1].
export function planeAt(f: Flight, t: number): { pos: THREE.Vector3; heading: THREE.Vector3 } {
  const i = segmentIndexAt(f, t);
  const seg = f.segments[i];
  const u = segU(seg, t);
  const pos = arcPoint(seg.arc, u);
  return { pos, heading: f.track ? trackHeading(f, t, pos, i) : arcHeading(seg.arc, u) };
}

// Altitude (km): the track's when there is one, else the trapezoid profile.
function altitudeAt(f: Flight, t: number): number {
  if (f.track?.altKm) {
    const i = segmentIndexAt(f, t);
    const a = f.track.altKm;
    return a[i] + (a[i + 1] - a[i]) * segU(f.segments[i], t);
  }
  const durMin = f.durationMs / 60_000;
  return altitudeKm(t * durMin, (1 - t) * durMin);
}

// Distance flown by t (km) and the ground speed at t (km/h). Uniform for a
// planned flight; a track speeds up and slows down.
export function distanceAt(f: Flight, t: number): number {
  const i = segmentIndexAt(f, t);
  let d = 0;
  for (let k = 0; k < i; k++) d += f.segments[k].distanceKm;
  return d + f.segments[i].distanceKm * segU(f.segments[i], t);
}
export function groundSpeedAt(f: Flight, t: number): number {
  const seg = f.segments[segmentIndexAt(f, t)];
  const h = (seg.tEnd - seg.tStart) * f.durationMs / 3_600_000;
  return h > 0 ? seg.distanceKm / h : 0;
}

export type Side = 'LEFT' | 'RIGHT';

export type FlightSample = {
  utcMs: number;
  pos: THREE.Vector3; heading: THREE.Vector3; sunLocal: THREE.Vector3;
  sR: number; sF: number; sU: number;   // sun · (right, forward, up)
  altKm: number;                         // from the climb/cruise/descent profile
  elevDeg: number; phase: Phase; side: Side;   // side: raw sign of sR (no dead band)
};

// Everything derived from one moment of the flight. Shared by the per-frame
// HUD and the offline recap scan, so both always agree.
export function flightSampleAt(f: Flight, t: number): FlightSample {
  const utcMs = f.depUtcMs + t * f.durationMs;
  const { pos, heading } = planeAt(f, t);
  const sub = subsolarPoint(utcMs);
  const sunLocal = latLonToVec3(sub.lat, sub.lon, 1);
  const up    = pos;
  const right = new THREE.Vector3().crossVectors(heading, up).normalize();
  const sR = sunLocal.dot(right);
  const sF = sunLocal.dot(heading);
  const sU = sunLocal.dot(up);
  const elevDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sU, -1, 1)));
  const altKm = altitudeAt(f, t);
  return {
    utcMs, pos, heading, sunLocal, sR, sF, sU, altKm, elevDeg,
    phase: daylightLabel(elevDeg, altKm),
    side: sR > 0 ? 'RIGHT' : 'LEFT',
  };
}

// ─── Recap scan ──────────────────────────────────────────────────────────────

// Sun-side hysteresis. When the sun is nearly dead ahead/behind, or nearly
// overhead, sR hovers around 0 and its sign flickers; a raw sign test would
// spam "Sun → LEFT / Sun → RIGHT" rows. The side only switches once the sun is
// clearly across: |sR| > 0.05 (≈ 3° off the nose/tail axis at the horizon).
export const SIDE_DEADBAND = 0.05;

export function sideAfter(current: Side, sR: number, deadband = SIDE_DEADBAND): Side {
  if (current === 'RIGHT') return sR < -deadband ? 'LEFT' : 'RIGHT';
  return sR > deadband ? 'RIGHT' : 'LEFT';
}

export type RecapRow = {
  utcMs: number; phase: Phase; label: string;
  kind: 'endpoint' | 'phase' | 'side';
  side: Side;   // sun side at this row (only meaningful during DAY)
};
export type RecapStats = { rightPct: number; leftPct: number; twilightPct: number; nightPct: number };

// Bisect between tA (where `same` holds) and tB (where it doesn't) and return
// the sample just after the change. 16 halvings of one scan step (~25 s on a
// 14 h flight) pin transitions to well under a second.
function refineTransition(f: Flight, tA: number, tB: number, same: (s: FlightSample) => boolean): FlightSample {
  for (let i = 0; i < 16; i++) {
    const mid = (tA + tB) / 2;
    if (same(flightSampleAt(f, mid))) tA = mid; else tB = mid;
  }
  return flightSampleAt(f, tB);
}

// Scan the flight at fine resolution and collect phase / side transitions;
// each detected change is then refined by bisection for an exact timestamp.
export function computeRecap(f: Flight, N = 2000): { rows: RecapRow[]; stats: RecapStats } {
  const rows: RecapRow[] = [];
  let right = 0, left = 0, twilight = 0, night = 0;
  const tally = (s: FlightSample) => {
    if (s.phase === 'DAY') { if (s.side === 'RIGHT') right++; else left++; }
    else if (s.phase === 'TWILIGHT') twilight++;
    else night++;
  };

  const first = flightSampleAt(f, 0);
  tally(first);
  const depExtra = first.phase === 'DAY' ? `, sun on the ${first.side}` : '';
  rows.push({
    utcMs: f.depUtcMs, phase: first.phase, kind: 'endpoint', side: first.side,
    label: `Depart ${f.fromCode} — ${first.phase}${depExtra}`,
  });

  let prevPhase = first.phase;
  let prevSide  = first.side;
  for (let i = 1; i <= N; i++) {
    const raw  = flightSampleAt(f, i / N);
    const side = sideAfter(prevSide, raw.sR);
    const s    = { ...raw, side };
    tally(s);
    const tA = (i - 1) / N, tB = i / N;
    if (s.phase !== prevPhase) {
      const pp = prevPhase;
      const r = refineTransition(f, tA, tB, (x) => x.phase === pp);
      const rSide = sideAfter(prevSide, r.sR);
      const extra = s.phase === 'DAY' ? `, sun on the ${rSide}` : '';
      rows.push({ utcMs: r.utcMs, phase: s.phase, kind: 'phase', side: rSide, label: `→ ${s.phase}${extra}` });
    } else if (s.phase === 'DAY' && side !== prevSide) {
      const ps = prevSide;
      const r = refineTransition(f, tA, tB, (x) => sideAfter(ps, x.sR) === ps);
      rows.push({ utcMs: r.utcMs, phase: 'DAY', kind: 'side', side, label: `Sun → ${side}` });
    }
    prevPhase = s.phase;
    prevSide  = side;
  }

  rows.push({
    utcMs: f.arrUtcMs, phase: prevPhase, kind: 'endpoint', side: prevSide,
    label: `Arrive ${f.toCode}`,
  });

  const total = N + 1;
  return {
    rows,
    stats: {
      rightPct:    (right    / total) * 100,
      leftPct:     (left     / total) * 100,
      twilightPct: (twilight / total) * 100,
      nightPct:    (night    / total) * 100,
    },
  };
}
