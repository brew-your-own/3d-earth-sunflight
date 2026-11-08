// Pure spherical geometry: lat/lon ↔ 3D and great-circle arcs.
// No scene state — safe to import from tests.
import * as THREE from 'three';

export const EARTH_RADIUS_KM = 6371;

// Convention (in Earth's local frame, before tilt/spin):
//   lat= 0, lon=   0  →  +X   (prime meridian on equator)
//   lat= 0, lon= +90  →  -Z   (east of Greenwich → into the screen)
//   lat= 0, lon= -90  →  +Z   (west of Greenwich → out of the screen)
//   lat=+90, lon=any  →  +Y   (north pole)
// Three's SphereGeometry UVs trace -X→+Z→+X→-Z→-X as u goes 0→1, so an
// equirectangular map (u: -180°→+180°) ends up with longitude increasing
// clockwise around +Y — hence the negative sign on Z below.
export function latLonToVec3(latDeg: number, lonDeg: number, radius: number): THREE.Vector3 {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(
    radius * cosLat * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * cosLat * Math.sin(lon)
  );
}

// Inverse of latLonToVec3 for a unit vector.
export function vec3ToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  return {
    lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y, -1, 1))),
    lon: THREE.MathUtils.radToDeg(Math.atan2(-v.z, v.x)),
  };
}

// Great-circle arc from unit vector p1 to p2, expressed as p1 plus a unit
// tangent t1 (⊥ p1, in the arc's plane, pointing toward p2):
//   pos(u)     = p1·cos(uω) + t1·sin(uω)
//   heading(u) = −p1·sin(uω) + t1·cos(uω)
// Unlike the textbook slerp (which divides by sin ω) this never produces NaN:
// coincident points give ω = 0, and antipodal points (where every great
// circle qualifies) get an arbitrary but stable perpendicular.
export type Arc = { p1: THREE.Vector3; t1: THREE.Vector3; omega: number };

export function makeArc(p1: THREE.Vector3, p2: THREE.Vector3): Arc {
  const d = THREE.MathUtils.clamp(p1.dot(p2), -1, 1);
  // atan2(|p1×p2|, p1·p2) rather than acos(p1·p2): acos is ill-conditioned
  // near 1, so identical points would give ω ≈ 2e-8 instead of exactly 0.
  const omega = Math.atan2(new THREE.Vector3().crossVectors(p1, p2).length(), d);
  const t1 = p2.clone().addScaledVector(p1, -d);   // reject p1 component
  if (t1.lengthSq() < 1e-12) {
    // Coincident or antipodal: pick any direction perpendicular to p1.
    const ref = Math.abs(p1.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    t1.crossVectors(ref, p1);
  }
  t1.normalize();
  return { p1: p1.clone(), t1, omega };
}

export function arcPoint(arc: Arc, u: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = u * arc.omega;
  return out.copy(arc.p1).multiplyScalar(Math.cos(a)).addScaledVector(arc.t1, Math.sin(a));
}

export function arcHeading(arc: Arc, u: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = u * arc.omega;
  return out.copy(arc.p1).multiplyScalar(-Math.sin(a)).addScaledVector(arc.t1, Math.cos(a));
}

// Sample N+1 positions along the arc between two surface points.
export function greatCirclePoints(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  radius: number,
  segments = 128
): THREE.Vector3[] {
  const arc = makeArc(latLonToVec3(lat1, lon1, 1), latLonToVec3(lat2, lon2, 1));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    points.push(arcPoint(arc, i / segments).multiplyScalar(radius));
  }
  return points;
}
