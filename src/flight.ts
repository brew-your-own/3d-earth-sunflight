// Flight model: piecewise great-circle route, plane position over time, sun
// geometry relative to the plane, and the offline recap scan.
// Pure — no scene or DOM state — so it's covered by unit tests.
import * as THREE from 'three';
import { DateTime } from 'luxon';
import type { Airport } from './airports';
import { EARTH_RADIUS_KM, type Arc, arcHeading, arcPoint, latLonToVec3, makeArc } from './geo';
import { type Phase, daylightLabel, subsolarPoint } from './astro';

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

// Position + heading (unit vectors, Earth-local frame) at overall t ∈ [0,1].
// Walks segments to find the active one, then moves along its arc.
export function planeAt(f: Flight, t: number): { pos: THREE.Vector3; heading: THREE.Vector3 } {
  let seg = f.segments[f.segments.length - 1];
  for (const s of f.segments) {
    if (t <= s.tEnd) { seg = s; break; }
  }
  const span = seg.tEnd - seg.tStart;
  const u    = span > 0 ? THREE.MathUtils.clamp((t - seg.tStart) / span, 0, 1) : 0;
  return { pos: arcPoint(seg.arc, u), heading: arcHeading(seg.arc, u) };
}

export type Side = 'LEFT' | 'RIGHT';

export type FlightSample = {
  utcMs: number;
  pos: THREE.Vector3; heading: THREE.Vector3; sunLocal: THREE.Vector3;
  sR: number; sF: number; sU: number;   // sun · (right, forward, up)
  elevDeg: number; phase: Phase; side: Side;
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
  return {
    utcMs, pos, heading, sunLocal, sR, sF, sU, elevDeg,
    phase: daylightLabel(elevDeg),
    side: sR > 0 ? 'RIGHT' : 'LEFT',
  };
}

// ─── Recap scan ──────────────────────────────────────────────────────────────

export type RecapRow = {
  utcMs: number; phase: Phase; label: string;
  kind: 'endpoint' | 'phase' | 'side';
  side: Side;   // sun side at this row (only meaningful during DAY)
};
export type RecapStats = { rightPct: number; leftPct: number; twilightPct: number; nightPct: number };

// Scan the flight at fine resolution and collect phase / side transitions.
// N = 2000 → ~25 s resolution for a 14 h flight, fine for visualization.
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
    const s = flightSampleAt(f, i / N);
    tally(s);
    if (s.phase !== prevPhase) {
      const extra = s.phase === 'DAY' ? `, sun on the ${s.side}` : '';
      rows.push({ utcMs: s.utcMs, phase: s.phase, kind: 'phase', side: s.side, label: `→ ${s.phase}${extra}` });
    } else if (s.phase === 'DAY' && s.side !== prevSide) {
      rows.push({ utcMs: s.utcMs, phase: 'DAY', kind: 'side', side: s.side, label: `Sun → ${s.side}` });
    }
    prevPhase = s.phase;
    prevSide  = s.side;
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
