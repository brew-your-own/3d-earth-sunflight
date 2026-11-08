// Moon position, phase and per-flight visibility. Pure — no scene/DOM state.
//
// Position: Meeus, "Astronomical Algorithms" ch. 47, truncated to the largest
// periodic terms (27 in longitude/distance, 20 in latitude, plus the A1–A3
// additive terms). Error vs the full series is ≲ 0.01° in λ/β and a few tens
// of km in distance — far below the ~1° disc we draw. No nutation (≤ 0.005°).
import * as THREE from 'three';
import {
  daysSinceJ2000, gmstDeg, obliquityDeg, sunEclipticLongitudeDeg, sunriseElevDeg,
} from './astro';
import { EARTH_RADIUS_KM, latLonToVec3 } from './geo';
import { type Flight, type Side, flightSampleAt } from './flight';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const mod360 = (x: number) => ((x % 360) + 360) % 360;

// [D, M, M', F, Σl (1e-6 °), Σr (1e-3 km)] — Meeus table 47.A (largest terms)
const LR_TERMS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
];

// [D, M, M', F, Σb (1e-6 °)] — Meeus table 47.B (largest terms)
const B_TERMS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
];

export type MoonEcliptic = { lonDeg: number; latDeg: number; distKm: number };

// Geocentric ecliptic coordinates (mean equinox of date).
export function moonEcliptic(utcMs: number): MoonEcliptic {
  const T = daysSinceJ2000(utcMs) / 36525;
  const Lp = mod360(218.3164477 + 481267.88123421 * T);
  const D  = mod360(297.8501921 + 445267.1114034 * T);
  const M  = mod360(357.5291092 + 35999.0502909 * T);
  const Mp = mod360(134.9633964 + 477198.8675055 * T);
  const F  = mod360(93.2720950 + 483202.0175233 * T);
  const E  = 1 - 0.002516 * T - 0.0000074 * T * T;
  const A1 = mod360(119.75 + 131.849 * T);
  const A2 = mod360(53.09 + 479264.290 * T);
  const A3 = mod360(313.45 + 481266.484 * T);
  const eFac = (m: number) => (m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E);

  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR_TERMS) {
    const arg = (d * D + m * M + mp * Mp + f * F) * D2R;
    const e = eFac(m);
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of B_TERMS) {
    sb += b * eFac(m) * Math.sin((d * D + m * M + mp * Mp + f * F) * D2R);
  }
  sl += 3958 * Math.sin(A1 * D2R) + 1962 * Math.sin((Lp - F) * D2R) + 318 * Math.sin(A2 * D2R);
  sb += -2235 * Math.sin(Lp * D2R) + 382 * Math.sin(A3 * D2R)
      + 175 * Math.sin((A1 - F) * D2R) + 175 * Math.sin((A1 + F) * D2R)
      + 127 * Math.sin((Lp - Mp) * D2R) - 115 * Math.sin((Lp + Mp) * D2R);

  return { lonDeg: mod360(Lp + sl / 1e6), latDeg: sb / 1e6, distKm: 385000.56 + sr / 1000 };
}

export function moonEquatorial(utcMs: number): { raDeg: number; decDeg: number; distKm: number } {
  const { lonDeg, latDeg, distKm } = moonEcliptic(utcMs);
  const l = lonDeg * D2R, b = latDeg * D2R, e = obliquityDeg(utcMs) * D2R;
  const ra  = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return { raDeg: mod360(ra * R2D), decDeg: dec * R2D, distKm };
}

// Sublunar point (Earth-fixed lat/lon, same convention as subsolarPoint) and
// distance in Earth radii.
export function sublunarPoint(utcMs: number): { lat: number; lon: number; distER: number } {
  const { raDeg, decDeg, distKm } = moonEquatorial(utcMs);
  const lon = ((raDeg - gmstDeg(utcMs) + 540) % 360) - 180;
  return { lat: decDeg, lon, distER: distKm / EARTH_RADIUS_KM };
}

// Geocentric Moon position in the Earth-local scene frame, in Earth radii.
export function moonVecER(utcMs: number): THREE.Vector3 {
  const { lat, lon, distER } = sublunarPoint(utcMs);
  return latLonToVec3(lat, lon, distER);
}

// Topocentric direction (unit, Earth-local) from an observer at unit position
// p, altKm above the surface. The Moon is only ~60 R away, so this differs
// from the geocentric direction by up to ~0.95° (horizontal parallax).
export function topocentricMoonDir(moonER: THREE.Vector3, p: THREE.Vector3, altKm: number): THREE.Vector3 {
  return moonER.clone().addScaledVector(p, -(1 + altKm / EARTH_RADIUS_KM)).normalize();
}

// ─── Phase ───────────────────────────────────────────────────────────────────

export type MoonPhase = {
  illuminated: number;   // fraction of the disc lit, 0..1
  waxing: boolean;
  ageDeg: number;        // Moon − Sun ecliptic longitude, [0, 360): 0 new, 180 full
};

export function moonPhase(utcMs: number): MoonPhase {
  const { lonDeg, latDeg, distKm } = moonEcliptic(utcMs);
  const sunLon = sunEclipticLongitudeDeg(utcMs);
  const ageDeg = mod360(lonDeg - sunLon);
  // Geocentric elongation ψ, then phase angle i (Meeus 48.2/48.3).
  const cosPsi = Math.cos(latDeg * D2R) * Math.cos((lonDeg - sunLon) * D2R);
  const psi = Math.acos(THREE.MathUtils.clamp(cosPsi, -1, 1));
  const SUN_KM = 149_597_870;
  const i = Math.atan2(SUN_KM * Math.sin(psi), distKm - SUN_KM * Math.cos(psi));
  return { illuminated: (1 + Math.cos(i)) / 2, waxing: ageDeg < 180, ageDeg };
}

const PHASE_EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
export function moonEmoji(ageDeg: number): string {
  return PHASE_EMOJI[Math.round(mod360(ageDeg) / 45) % 8];
}

// ─── Per-flight summary ──────────────────────────────────────────────────────

export type MoonEvent = {
  kind: 'moonrise' | 'moonset';
  utcMs: number;
  t: number;
  side: Side;
  relAzDeg: number;   // 0 ahead, +90 right, ±180 behind
};

export type MoonSummary = {
  nightHours: number;               // hours outside DAY (altitude-aware)
  upHours: number;                  // of those, Moon above the visible horizon
  sideHours: Record<Side, number>;  // split of upHours by window side
  mainSide: Side | null;            // null when roughly even
  phase: MoonPhase;                 // at the middle of the dark part (or of the flight)
  events: MoonEvent[];              // rise/set while it's dark, en route
};

type MoonSample = { up: boolean; dark: boolean; side: Side; relAzDeg: number; utcMs: number };

function moonSampleAt(f: Flight, t: number): MoonSample {
  const s = flightSampleAt(f, t);
  const dir = topocentricMoonDir(moonVecER(s.utcMs), s.pos, s.altKm);
  const elevDeg = Math.asin(THREE.MathUtils.clamp(dir.dot(s.pos), -1, 1)) * R2D;
  const right = new THREE.Vector3().crossVectors(s.heading, s.pos).normalize();
  const mR = dir.dot(right), mF = dir.dot(s.heading);
  return {
    // Same visible-horizon rule as sunrise (dip + refraction + ~semidiameter).
    up: elevDeg >= sunriseElevDeg(s.altKm),
    dark: s.phase !== 'DAY',
    side: mR > 0 ? 'RIGHT' : 'LEFT',
    relAzDeg: Math.atan2(mR, mF) * R2D,
    utcMs: s.utcMs,
  };
}

export function moonSummary(f: Flight, N = 600): MoonSummary {
  const dtH = f.durationMs / 3_600_000 / N;
  let nightHours = 0, upHours = 0;
  const sideHours: Record<Side, number> = { LEFT: 0, RIGHT: 0 };
  let darkTSum = 0, darkCount = 0;
  const events: MoonEvent[] = [];

  let prev = moonSampleAt(f, 0);
  let prevT = 0;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const s = moonSampleAt(f, t);
    const mid = moonSampleAt(f, (prevT + t) / 2);
    if (mid.dark) {
      nightHours += dtH;
      darkTSum += (prevT + t) / 2; darkCount++;
      if (mid.up) { upHours += dtH; sideHours[mid.side] += dtH; }
    }
    if (s.up !== prev.up) {
      // Bisect for the crossing, then keep it only if it happens in the dark.
      let a = prevT, b = t;
      for (let k = 0; k < 16; k++) {
        const m = (a + b) / 2;
        if (moonSampleAt(f, m).up === prev.up) a = m; else b = m;
      }
      const e = moonSampleAt(f, b);
      if (e.dark) {
        events.push({ kind: e.up ? 'moonrise' : 'moonset', utcMs: e.utcMs, t: b, side: e.side, relAzDeg: e.relAzDeg });
      }
    }
    prev = s; prevT = t;
  }

  const { LEFT: l, RIGHT: r } = sideHours;
  const mainSide: Side | null = upHours > 0 && Math.abs(l - r) >= 0.2 * upHours ? (l > r ? 'LEFT' : 'RIGHT') : null;
  const refT = darkCount > 0 ? darkTSum / darkCount : 0.5;
  return {
    nightHours, upHours, sideHours, mainSide,
    phase: moonPhase(f.depUtcMs + refT * f.durationMs),
    events,
  };
}
