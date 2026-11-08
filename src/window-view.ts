// Window-seat view: a second camera at cruise altitude looking out the left
// or right window, drawn into a screen rect (scissor) after the main render.
//
// What makes it read as "from a plane" rather than "from space":
//   - a sky dome shader (layer 1, so the main camera never sees it): blue sky
//     by day, a warm horizon band toward the sun at twilight, a sun disc +
//     glow, and transparency at night so the starfield shows through. Earth
//     is depth-tested in front of it, so the horizon dip (~3.4° at 11 km)
//     and the sun setting behind the curve come out of the real geometry.
//   - scene fog, enabled only for this render, as aerial-perspective haze.
//   - the cloud shell, temporarily shrunk to ~6 km so it sits *below* the
//     plane (normally it floats at 1.01 R ≈ 64 km, above cruise altitude);
//     below 6 km (climb/descent) it's overhead and back-face culled.
//   - the camera height follows the sample's climb/cruise/descent altitude.
//   - the route line, labels and plane cone hidden (they live at 1.02 R).
import * as THREE from 'three';

import { EARTH_RADIUS_KM } from './geo';
import type { FlightSample, Side } from './flight';
import { auroraAt } from './aurora';

const SKY_LAYER = 1;
const LOOK_DOWN_DEG = 10;         // passengers look a little below level
const MAX_LEAN_DEG  = 55;         // how far fore/aft of straight-out you can see by leaning
const LEAN_RATE     = 2.5;        // 1/s — easing toward the sun (≈1 s to settle)
const CLOUD_ALT_KM  = 6;
const NO_FOG = { near: 1e6, far: 2e6 };
const HAZE   = { near: 0.01, far: 0.3 };   // scene units (Earth radius = 2)

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uSunDir;   // world, unit
  uniform vec3 uUp;       // local vertical at the plane, world, unit
  // Aurora block uniforms (see aurora.ts)
  uniform vec3  uAuroraDir;        // world, unit, horizontal toward the aurora
  uniform float uAuroraStrength;   // 0 = none … 1 = "likely" tier
  uniform float uTime;             // seconds, drives the slow ray drift
  varying vec3 vWorldPos;

  void main() {
    vec3 dir    = normalize(vWorldPos - cameraPosition);
    float h     = dot(dir, uUp);        // sine of view elevation
    float sunE  = dot(uSunDir, uUp);    // sine of sun elevation
    float cosSun = dot(dir, uSunDir);

    float day = smoothstep(-0.17, 0.04, sunE);       // ~-10° → +2°
    float hz  = 1.0 - clamp(h, 0.0, 1.0);             // 1 at horizon, 0 at zenith

    // Thin air at 11 km: deep blue overhead, paler toward the horizon.
    vec3 col = mix(vec3(0.05, 0.16, 0.48), vec3(0.50, 0.66, 0.88), pow(hz, 5.0)) * day;

    // Twilight: warm band along the horizon, brightest toward the sun.
    float tw = exp(-pow((sunE + 0.03) / 0.09, 2.0));
    vec3 dirH = normalize(dir - uUp * h + 1e-5);
    vec3 sunH = normalize(uSunDir - uUp * sunE + 1e-5);
    float towardSun = pow(max(dot(dirH, sunH), 0.0), 2.0);
    float band = pow(hz, 8.0);
    col += vec3(1.0, 0.42, 0.12) * tw * band * (0.2 + 0.9 * towardSun);

    // Sun glow + disc (disc drawn ~1.2° radius — over 4× the real 0.27° so
    // it reads as a sun in a ~250 px inset). When the sun is below the horizon the Earth,
    // drawn with depth, covers it.
    float c = max(cosSun, 0.0);
    float glow = pow(c, 24.0) * 0.35 + pow(c, 400.0) * 0.8;
    vec3 sunCol = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.95, 0.85), smoothstep(-0.02, 0.15, sunE));
    float disc = smoothstep(0.99974, 0.99985, cosSun);   // cos 1.3° → cos 1.0°
    col += sunCol * (glow * max(day, tw) + disc * 2.0);

    // ── Aurora block ────────────────────────────────────────────────────────
    // A wide arc low over the horizon toward uAuroraDir: green (557.7 nm
    // oxygen) from the horizon up to ~15°, a fainter purple/red fringe above,
    // broken into slowly drifting vertical rays. Additive, and it adds its own
    // alpha so it shows over the transparent night sky (stars behind).
    float auroraA = 0.0;
    if (uAuroraStrength > 0.0) {
      vec3 dirHa = normalize(dir - uUp * h + 1e-5);
      float facing = pow(max(dot(dirHa, uAuroraDir), 0.0), 3.0);      // ~±60° wide
      float elev = asin(clamp(h, -1.0, 1.0));                          // radians
      float green  = smoothstep(-0.02, 0.05, elev) * (1.0 - smoothstep(0.08, 0.28, elev));
      float fringe = smoothstep(0.12, 0.24, elev) * (1.0 - smoothstep(0.24, 0.42, elev));
      vec3 sideAx = cross(uUp, uAuroraDir);
      float az = atan(dot(dirHa, sideAx), dot(dirHa, uAuroraDir));
      float rays = 0.6 + 0.4 * sin(az * 41.0 + uTime * 0.5) * sin(az * 17.0 - uTime * 0.3);
      float k = facing * rays * uAuroraStrength * 0.55;
      col += (vec3(0.15, 1.0, 0.45) * green + vec3(0.65, 0.25, 0.9) * fringe * 0.6) * k;
      auroraA = max(green, fringe * 0.6) * k;
    }

    float alpha = clamp(max(max(day, tw * band * 1.2), disc + glow * max(day, tw)), 0.0, 1.0);
    alpha = max(alpha, auroraA);   // aurora block
    gl_FragColor = vec4(col, alpha);
  }
`;

export type WindowViewDeps = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  earth: THREE.Object3D;
  clouds: THREE.Object3D;
  earthRadius: number;        // scene units
  cloudRadiusFactor: number;  // clouds mesh radius / earthRadius
};

export function createWindowView(d: WindowViewDeps) {
  const camera = new THREE.PerspectiveCamera(60, 4 / 5, 0.0005, 1000);
  camera.layers.enable(SKY_LAYER);

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    uniforms: {
      uSunDir: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
      // aurora block
      uAuroraDir: { value: new THREE.Vector3(1, 0, 0) }, uAuroraStrength: { value: 0 }, uTime: { value: 0 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), skyMat);
  sky.layers.set(SKY_LAYER);
  sky.renderOrder = -1;          // before the (transparent) clouds, after opaque Earth/stars
  sky.frustumCulled = false;
  d.scene.add(sky);

  const fog = new THREE.Fog(0x000000, NO_FOG.near, NO_FOG.far);
  d.scene.fog = fog;             // always present (no shader switches), effectively off

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
  const look = new THREE.Vector3(), sunWorld = new THREE.Vector3(), camPos = new THREE.Vector3();
  const cloudScale  = (1 + CLOUD_ALT_KM / EARTH_RADIUS_KM) / d.cloudRadiusFactor;
  const dip = THREE.MathUtils.degToRad(LOOK_DOWN_DEG);

  // Like a passenger leaning toward the glass: when the sun is up and on this
  // side, turn toward it (within ±MAX_LEAN_DEG of straight out); otherwise
  // look straight out. Eased so jumps and side switches don't snap.
  let leanDeg = 0;
  let leanSettled = true;
  let lastMs = performance.now();
  function updateLean(s: FlightSample, side: Side): number {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastMs) / 1000);
    lastMs = now;
    const abeam = side === 'LEFT' ? -90 : 90;
    const relAz = THREE.MathUtils.radToDeg(Math.atan2(s.sR, s.sF));   // 0 ahead, +90 right
    const off = ((relAz - abeam + 540) % 360) - 180;                  // sun bearing vs straight-out
    const target = s.phase !== 'NIGHT' && Math.abs(off) < 120
      ? THREE.MathUtils.clamp(off, -MAX_LEAN_DEG, MAX_LEAN_DEG)
      : 0;
    leanDeg += (target - leanDeg) * (1 - Math.exp(-LEAN_RATE * dt));
    leanSettled = Math.abs(target - leanDeg) < 0.05;
    return abeam + leanDeg;
  }

  // `hidden`: objects that would float in the sky from this altitude.
  // Returns true while the view is still easing (caller should keep drawing).
  function render(s: FlightSample, side: Side, rect: DOMRect, hidden: Array<THREE.Object3D | null>): boolean {
    const { renderer, scene, earth, clouds, earthRadius } = d;
    earth.getWorldQuaternion(q);
    up.copy(s.pos).applyQuaternion(q);
    fwd.copy(s.heading).applyQuaternion(q);
    right.crossVectors(fwd, up).normalize();
    sunWorld.copy(s.sunLocal).applyQuaternion(q).normalize();

    // Keep at least ~100 m up so the camera never sits inside the sphere.
    const altKm = Math.max(0.1, s.altKm);
    camPos.copy(s.pos).multiplyScalar(earthRadius * (1 + altKm / EARTH_RADIUS_KM));
    earth.localToWorld(camPos);
    camera.position.copy(camPos);
    camera.up.copy(up);
    // Horizontal bearing θ (0 = nose, +90 = right wing), then tilt down.
    const theta = THREE.MathUtils.degToRad(updateLean(s, side));
    look.copy(fwd).multiplyScalar(Math.cos(theta)).addScaledVector(right, Math.sin(theta))
      .multiplyScalar(Math.cos(dip)).addScaledVector(up, -Math.sin(dip)).add(camPos);
    camera.lookAt(look);
    camera.aspect = rect.width / rect.height;
    // Near plane scales with height above ground: at 100 m the ground is
    // ~0.6 km away along the view; at cruise ~60 km. Far stays at 1000 for
    // the stars (nothing out there to z-fight).
    camera.near = THREE.MathUtils.clamp(altKm / EARTH_RADIUS_KM * earthRadius * 0.2, 2e-6, 5e-4);
    camera.updateProjectionMatrix();

    sky.position.copy(camPos);
    skyMat.uniforms.uSunDir.value.copy(sunWorld);
    skyMat.uniforms.uUp.value.copy(up);

    // Aurora: direction + strength from the current sample. While it's on
    // screen the rays drift, so report "still animating" to keep frames coming.
    const aurora = auroraAt(s);
    skyMat.uniforms.uAuroraStrength.value = aurora.strength;
    if (aurora.strength > 0) {
      skyMat.uniforms.uAuroraDir.value.copy(aurora.dirLocal).applyQuaternion(q).normalize();
      skyMat.uniforms.uTime.value = performance.now() / 1000;
    }

    // Haze colour follows the sky near the horizon: pale blue by day, dark at night.
    const day = THREE.MathUtils.smoothstep(sunWorld.dot(up), -0.17, 0.04);
    fog.color.setRGB(0.50 * day + 0.01, 0.66 * day + 0.012, 0.88 * day + 0.02);
    fog.near = HAZE.near; fog.far = HAZE.far;

    const wasVisible = hidden.map((o) => o?.visible ?? false);
    hidden.forEach((o) => { if (o) o.visible = false; });
    const cloudScaleBefore = clouds.scale.x;
    clouds.scale.setScalar(cloudScale);

    const x = rect.left, y = window.innerHeight - rect.bottom;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);

    clouds.scale.setScalar(cloudScaleBefore);
    hidden.forEach((o, i) => { if (o) o.visible = wasVisible[i]; });
    fog.near = NO_FOG.near; fog.far = NO_FOG.far;
    return !leanSettled || aurora.strength > 0;
  }

  return { render };
}
