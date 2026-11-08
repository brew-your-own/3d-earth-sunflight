// Sun position and day/twilight/night classification. Pure — no scene state.

const degToRad = (d: number) => d * Math.PI / 180;
const radToDeg = (r: number) => r * 180 / Math.PI;

// Subsolar point at a given UTC instant: where on Earth (lat/lon, in the
// Earth-fixed/ECEF frame) the sun is directly overhead. NOAA-derived formula,
// accurate to ~0.01° — well past anything we'd notice visually.
export function subsolarPoint(utcMs: number): { lat: number; lon: number } {
  const jd = utcMs / 86400000 + 2440587.5;            // Julian date (UT1≈UTC)
  const n  = jd - 2451545.0;                          // days since J2000.0

  const mod360 = (x: number) => ((x % 360) + 360) % 360;
  const mod24  = (x: number) => ((x % 24)  + 24)  % 24;

  const L  = mod360(280.460 + 0.9856474 * n);                    // mean longitude
  const g  = degToRad(mod360(357.528 + 0.9856003 * n));          // mean anomaly
  const lambda  = degToRad(
    L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)            // ecliptic longitude
  );
  const epsilon = degToRad(23.439 - 0.0000004 * n);              // obliquity

  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ra   = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));

  // Greenwich Mean Sidereal Time (Meeus approximation)
  const gmstDeg = mod24(18.697374558 + 24.06570982441908 * n) * 15;

  let lon = radToDeg(ra) - gmstDeg;
  lon = ((lon + 540) % 360) - 180;
  return { lat: radToDeg(decl), lon };
}

// Sunrise/sunset as seen from the cabin at cruise altitude. Elevation is
// measured against the geometric (level) horizon, but from 11 km up the
// visible horizon sits lower:
//   - horizon dip  acos(R / (R + h))      ≈ 3.36°
//   - refraction (0.57°) + solar semidiameter (0.27°) — the same 0.833° used
//     for standard ground-level sunrise (upper limb touching the horizon)
// So the passenger sees the sun at elevation ≳ -4.2°, not 0°. Civil twilight
// keeps its 6° depth below that apparent horizon. On the ground (dip = 0)
// this reduces to the standard -0.833° sunrise and -6.833° civil dusk.
export const CRUISE_ALT_KM = 11;

export function horizonDipDeg(altKm: number): number {
  return radToDeg(Math.acos(6371 / (6371 + Math.max(0, altKm))));
}
export function sunriseElevDeg(altKm: number): number {
  return -(horizonDipDeg(altKm) + 0.833);
}

// Cruise values, for display and the window view's night cutoff.
export const HORIZON_DIP_DEG  = horizonDipDeg(CRUISE_ALT_KM);
export const SUNRISE_ELEV_DEG = sunriseElevDeg(CRUISE_ALT_KM);
export const NIGHT_ELEV_DEG   = SUNRISE_ELEV_DEG - 6;

export type Phase = 'DAY' | 'TWILIGHT' | 'NIGHT';

export function daylightLabel(elevDeg: number, altKm = CRUISE_ALT_KM): Phase {
  const sunrise = sunriseElevDeg(altKm);
  if (elevDeg >= sunrise)     return 'DAY';
  if (elevDeg >= sunrise - 6) return 'TWILIGHT';
  return 'NIGHT';
}

// ─── Altitude profile ────────────────────────────────────────────────────────
// Simple trapezoid: linear climb to cruise over the first CLIMB_MIN minutes,
// level, then linear descent over the last DESCENT_MIN. On a flight too short
// to reach cruise it peaks where the two ramps meet.
export const CLIMB_MIN   = 20;
export const DESCENT_MIN = 30;

export function altitudeKm(elapsedMin: number, remainingMin: number): number {
  const ramp = Math.min(1, Math.max(0, elapsedMin) / CLIMB_MIN, Math.max(0, remainingMin) / DESCENT_MIN);
  return CRUISE_ALT_KM * ramp;
}
