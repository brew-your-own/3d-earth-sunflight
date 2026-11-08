import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EARTH_RADIUS_KM, arcHeading, arcPoint, greatCirclePoints, latLonToVec3, makeArc, vec3ToLatLon } from './geo';

const close = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-9) => a.distanceTo(b) < eps;

describe('latLonToVec3', () => {
  it('follows the scene convention (+X prime meridian, +Y north, lon +90 → -Z)', () => {
    expect(close(latLonToVec3(0, 0, 1),  new THREE.Vector3(1, 0, 0))).toBe(true);
    expect(close(latLonToVec3(90, 0, 1), new THREE.Vector3(0, 1, 0))).toBe(true);
    expect(close(latLonToVec3(0, 90, 1), new THREE.Vector3(0, 0, -1))).toBe(true);
    expect(close(latLonToVec3(0, -90, 1), new THREE.Vector3(0, 0, 1))).toBe(true);
  });

  it('round-trips through vec3ToLatLon', () => {
    for (const [lat, lon] of [[51.47, -0.45], [-33.95, 151.18], [35.55, 139.78], [0, 180 - 1e-9]]) {
      const back = vec3ToLatLon(latLonToVec3(lat, lon, 1));
      expect(back.lat).toBeCloseTo(lat, 9);
      expect(back.lon).toBeCloseTo(lon, 6);
    }
  });
});

describe('makeArc / arcPoint / arcHeading', () => {
  const lhr = latLonToVec3(51.47, -0.4543, 1);
  const jfk = latLonToVec3(40.6398, -73.7789, 1);

  it('starts at p1 and ends at p2', () => {
    const arc = makeArc(lhr, jfk);
    expect(close(arcPoint(arc, 0), lhr)).toBe(true);
    expect(close(arcPoint(arc, 1), jfk, 1e-9)).toBe(true);
  });

  it('keeps points on the unit sphere and heading tangent to it', () => {
    const arc = makeArc(lhr, jfk);
    for (let u = 0; u <= 1; u += 0.125) {
      const p = arcPoint(arc, u), h = arcHeading(arc, u);
      expect(p.length()).toBeCloseTo(1, 12);
      expect(h.length()).toBeCloseTo(1, 12);
      expect(p.dot(h)).toBeCloseTo(0, 12);
    }
  });

  it('gives the right LHR–JFK great-circle distance (~5,550 km)', () => {
    const km = makeArc(lhr, jfk).omega * EARTH_RADIUS_KM;
    expect(km).toBeGreaterThan(5500);
    expect(km).toBeLessThan(5600);
  });

  it('handles coincident points without NaN', () => {
    const arc = makeArc(lhr, lhr.clone());
    expect(arc.omega).toBe(0);
    const p = arcPoint(arc, 0.5), h = arcHeading(arc, 0.5);
    expect(close(p, lhr)).toBe(true);
    expect(Number.isFinite(h.x + h.y + h.z)).toBe(true);
  });

  it('handles exactly antipodal points (including the poles) without NaN', () => {
    for (const [a, b] of [
      [latLonToVec3(10, 20, 1), latLonToVec3(-10, -160, 1)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)],
    ]) {
      const arc = makeArc(a, b);
      expect(arc.omega).toBeCloseTo(Math.PI, 6);
      const mid = arcPoint(arc, 0.5);
      expect(mid.length()).toBeCloseTo(1, 9);
      expect(close(arcPoint(arc, 1), b, 1e-6)).toBe(true);
    }
  });
});

describe('greatCirclePoints', () => {
  it('returns segments+1 points at the requested radius', () => {
    const pts = greatCirclePoints(51.47, -0.45, -33.95, 151.18, 2, 64);
    expect(pts).toHaveLength(65);
    for (const p of pts) expect(p.length()).toBeCloseTo(2, 9);
  });
});
