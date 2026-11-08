// Aurora chances along a flight. Pure — built on flight.ts samples.
//
// Model (deliberately simple; there is no live Kp feed so the singlefile build
// stays offline — advice is phrased as "if activity is moderate"):
//
// 1. Geomagnetic latitude from a centred dipole. Good to a few degrees, which
//    is well inside the uncertainty of "where is the oval tonight" anyway.
// 2. The night-side auroral oval sits around 65–70° magnetic latitude in quiet
//    conditions (Kp 2–3), its equatorward edge near ~63°; at Kp 4–5 that edge
//    moves down to ~58–60°.
// 3. Aurora glows ~100–300 km up. From 11 km the horizon for an emitter at
//    ~110 km is ~1,500 km away, but it has to be a few degrees above the
//    horizon (and out of the haze) to notice: call it ~400–500 km ≈ 4° of
//    magnetic latitude of extra reach on the poleward horizon.
//
// Tiers on |magLat| (only during NIGHT, which is already altitude-aware):
//   LIKELY   ≥ 62°  — at or poleward of the quiet-time oval edge minus that
//                     reach: on a clear dark night you'd usually see something.
//   POSSIBLE ≥ 55°  — needs the oval pushed to ~59° (Kp ≈ 4–5, a few nights a
//                     month near solar maximum) to show low on the horizon.
// Deep inside the polar cap (|magLat| > 74°) the oval is *equatorward* of
// you, so the glow is on the side facing away from the pole.
//
// Southern hemisphere is symmetric (aurora australis) with the antipodal pole.
import * as THREE from 'three';
import { latLonToVec3 } from './geo';
import { type Flight, type FlightSample, type Side, flightSampleAt } from './flight';

// Geomagnetic north pole (centred-dipole axis), IGRF-14, epoch 2025.0. It
// drifts ~0.1–0.2°/yr, negligible here.
export const GEOMAG_NORTH_POLE = { lat: 80.8, lon: -72.8 };
const POLE = latLonToVec3(GEOMAG_NORTH_POLE.lat, GEOMAG_NORTH_POLE.lon, 1);

export const AURORA_LIKELY_DEG   = 62;
export const AURORA_POSSIBLE_DEG = 55;
export const POLAR_CAP_DEG       = 74;
// Typical night-side oval centre, quiet conditions — the "best moment" in a
// window is where the plane gets closest to it.
export const OVAL_CENTER_DEG     = 67;

export type AuroraTier = 'likely' | 'possible';

export function geomagneticLatitude(latDeg: number, lonDeg: number): number {
  return magLatOfUnit(latLonToVec3(latDeg, lonDeg, 1));
}

function magLatOfUnit(pos: THREE.Vector3): number {
  return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(pos.dot(POLE), -1, 1)));
}

export type AuroraState = {
  magLat: number;
  tier: AuroraTier | null;      // null: not visible (day/twilight or too far from the oval)
  strength: number;             // 0..1 glow intensity for the window view
  side: Side;                   // which window faces the aurora
  toward: 'poleward' | 'equatorward';
  dirLocal: THREE.Vector3;      // unit, Earth-local, horizontal at the plane, toward the aurora
};

export function auroraAt(s: FlightSample): AuroraState {
  const magLat = magLatOfUnit(s.pos);
  const abs = Math.abs(magLat);
  // Pole of the plane's own hemisphere, projected onto the local horizontal.
  const pole = magLat >= 0 ? POLE : POLE.clone().negate();
  const dirLocal = pole.clone().addScaledVector(s.pos, -pole.dot(s.pos));
  if (dirLocal.lengthSq() < 1e-12) dirLocal.copy(s.heading);   // standing on the pole
  dirLocal.normalize();
  const toward = abs > POLAR_CAP_DEG ? 'equatorward' : 'poleward';
  if (toward === 'equatorward') dirLocal.negate();

  const right = new THREE.Vector3().crossVectors(s.heading, s.pos).normalize();
  const side: Side = dirLocal.dot(right) > 0 ? 'RIGHT' : 'LEFT';

  let tier: AuroraTier | null = null;
  if (s.phase === 'NIGHT') {
    if (abs >= AURORA_LIKELY_DEG) tier = 'likely';
    else if (abs >= AURORA_POSSIBLE_DEG) tier = 'possible';
  }
  const strength = tier
    ? 0.35 + 0.65 * THREE.MathUtils.smoothstep(abs, AURORA_POSSIBLE_DEG, AURORA_LIKELY_DEG)
    : 0;
  return { magLat, tier, strength, side, toward, dirLocal };
}

export type AuroraWindow = {
  startUtcMs: number; endUtcMs: number;
  tStart: number; tEnd: number;
  tPeak: number;                // closest approach to the oval centre — the best moment to look
  tier: AuroraTier;             // best tier reached
  side: Side;                   // side facing the aurora for most of the window
  toward: 'poleward' | 'equatorward';
};

// Gaps shorter than this (e.g. a brief twilight graze) are bridged.
const MERGE_GAP_MIN = 10;

export function auroraWindows(f: Flight, N = 600): AuroraWindow[] {
  const windows: AuroraWindow[] = [];
  type Acc = { t0: number; t1: number; peakT: number; peak: number; likely: boolean;
               left: number; right: number; pole: number; eq: number };
  let cur: Acc | null = null;
  const gapT = (MERGE_GAP_MIN * 60_000) / f.durationMs;

  const close = (a: Acc) => {
    windows.push({
      startUtcMs: f.depUtcMs + a.t0 * f.durationMs,
      endUtcMs:   f.depUtcMs + a.t1 * f.durationMs,
      tStart: a.t0, tEnd: a.t1, tPeak: a.peakT,
      tier: a.likely ? 'likely' : 'possible',
      side: a.right > a.left ? 'RIGHT' : 'LEFT',
      toward: a.eq > a.pole ? 'equatorward' : 'poleward',
    });
  };

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = auroraAt(flightSampleAt(f, t));
    if (!a.tier) continue;
    if (cur && t - cur.t1 > gapT + 1 / N) { close(cur); cur = null; }
    if (!cur) cur = { t0: t, t1: t, peakT: t, peak: -Infinity, likely: false, left: 0, right: 0, pole: 0, eq: 0 };
    cur.t1 = t;
    const score = -Math.abs(Math.abs(a.magLat) - OVAL_CENTER_DEG);
    if (score > cur.peak) { cur.peak = score; cur.peakT = t; }
    if (a.tier === 'likely') cur.likely = true;
    if (a.side === 'RIGHT') cur.right++; else cur.left++;
    if (a.toward === 'poleward') cur.pole++; else cur.eq++;
  }
  if (cur) close(cur);
  return windows;
}
