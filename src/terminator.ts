// Day/night terminator + twilight bands drawn on the globe (main view only).
//
// A thin transparent shell just above the surface (below clouds at 1.01 R and
// the route at 1.02 R), parented to the Earth mesh so it inherits tilt and
// spin. Per fragment, sin(solar elevation) = dot(surface normal, sun dir) —
// so the lines are exact small circles around the subsolar point, matching
// the directional light that shades the globe.
//
// It lives on its own render layer: the main camera enables it, the window
// camera (layers 0 + 1) does not, so the bands never show from the window seat.
import * as THREE from 'three';

export const TERMINATOR_LAYER = 2;
const SHELL_FACTOR = 1.002;

// Ground-level conventions (not the cruise-altitude ones used for the plane):
// these are the standard definitions people know from almanacs.
export type TwilightLine = { name: string; elevDeg: number; color: string };
export const TWILIGHT_LINES: readonly TwilightLine[] = [
  { name: 'sunrise/sunset', elevDeg: -0.833, color: '#ffcc66' },
  { name: 'civil',          elevDeg: -6,     color: '#ff8a5c' },
  { name: 'nautical',       elevDeg: -12,    color: '#b07cff' },
  { name: 'astronomical',   elevDeg: -18,    color: '#5a6cff' },
];

// The shader compares sin(elevation) directly, so pass thresholds as sines.
export function thresholdSines(lines: readonly TwilightLine[] = TWILIGHT_LINES): number[] {
  return lines.map((l) => Math.sin(THREE.MathUtils.degToRad(l.elevDeg)));
}

// Compact legend for the settings panel: a coloured dash per line.
export function legendHtml(lines: readonly TwilightLine[] = TWILIGHT_LINES): string {
  return lines.map((l) =>
    `<span class="tl-key"><span class="tl-dash" style="background:${l.color}"></span>` +
    `${l.name.split('/')[0]} ${l.elevDeg}°</span>`).join(' ');
}

const VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Lines: ~1.5 px, anti-aliased with fwidth (constant screen width whatever
// the zoom). Fills: very faint tints between consecutive thresholds so the
// civil / nautical / astronomical zones read without dimming the night lights.
const FRAGMENT = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uTh[4];
  uniform vec3 uCol[4];
  varying vec3 vNormalW;

  float lineMask(float s, float th, float w) {
    return 1.0 - smoothstep(0.6 * w, 1.6 * w, abs(s - th));
  }

  void main() {
    float s = dot(normalize(vNormalW), uSunDir);   // sin(solar elevation)
    float w = fwidth(s);

    vec3 col = vec3(0.0);
    float a = 0.0;

    // Zone fills (between line i and line i+1), alpha kept tiny.
    float zoneA[3];
    zoneA[0] = 0.045; zoneA[1] = 0.04; zoneA[2] = 0.035;
    for (int i = 0; i < 3; i++) {
      float inZone = step(uTh[i + 1], s) * step(s, uTh[i]);
      col = mix(col, uCol[i + 1], inZone);
      a = max(a, inZone * zoneA[i]);
    }

    // Lines on top.
    for (int i = 0; i < 4; i++) {
      float m = lineMask(s, uTh[i], w) * 0.6;
      col = mix(col, uCol[i], m / max(m + a, 1e-4));
      a = max(a, m);
    }

    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export type TerminatorDeps = {
  earth: THREE.Object3D;
  earthRadius: number;   // scene units
};

export function createTerminatorOverlay(d: TerminatorDeps) {
  const sines = thresholdSines();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uTh:     { value: sines },
      uCol:    { value: TWILIGHT_LINES.map((l) => new THREE.Color(l.color)) },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.earthRadius * SHELL_FACTOR, 128, 96), mat);
  mesh.layers.set(TERMINATOR_LAYER);
  // Transparent objects sort by renderOrder first: draw this before the cloud
  // shell (renderOrder 0) so clouds blend over the bands, not the reverse.
  mesh.renderOrder = -0.5;
  d.earth.add(mesh);

  return {
    mesh,
    // `sunPos`: the directional light's world position (any length).
    setSunPosition(sunPos: THREE.Vector3) {
      mat.uniforms.uSunDir.value.copy(sunPos).normalize();
    },
    get visible() { return mesh.visible; },
    set visible(v: boolean) { mesh.visible = v; },
  };
}
