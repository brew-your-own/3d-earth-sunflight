// Globe visual polish: atmosphere rim, ocean sun glint, night lights only on
// the night side, and screen-space-width route lines.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

// ─── Ocean mask → roughness map ─────────────────────────────────────────────
// No specular map ships with the textures, so derive one from the day map:
// water in the Solar System Scope map is dark navy to teal (blue clearly above
// red, not below green), land is green/brown, ice is near-grey. Oceans get a
// low roughness (sun glint), land stays matte. Written to the green channel,
// which is what MeshStandardMaterial reads for roughnessMap.
export const OCEAN_ROUGHNESS = 0.45;
export const LAND_ROUGHNESS  = 0.95;

// Exposed for tests: classify one sRGB pixel (0–255 channels).
export function isOceanPixel(r: number, g: number, b: number): boolean {
  return b > r * 1.25 + 4 && b >= g * 0.95 && r + g + b < 520;
}

export function buildOceanRoughness(image: CanvasImageSource & { width: number; height: number }): THREE.CanvasTexture {
  // Half resolution is plenty for a roughness mask and 4× cheaper to scan.
  const w = Math.max(1, Math.floor(image.width / 2));
  const h = Math.max(1, Math.floor(image.height / 2));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const ocean = Math.round(OCEAN_ROUGHNESS * 255), land = Math.round(LAND_ROUGHNESS * 255);
  for (let i = 0; i < d.length; i += 4) {
    const v = isOceanPixel(d[i], d[i + 1], d[i + 2]) ? ocean : land;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;   // data, not colour
  return tex;
}

// ─── Night lights only where it's dark ───────────────────────────────────────
// The emissive night map used to glow on the sunlit side too (visible with
// low exposure). Fade it by the geometric (not normal-mapped) N·L of the
// directional sun: full at night, gone by the time the sun is ~6° up, fading
// through twilight. Applies wherever the Earth is drawn, window view included.
export function patchNightLights(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #if NUM_DIR_LIGHTS > 0
        float nightLightsNdotL = dot(normalize(vNormal), directionalLights[0].direction);
        totalEmissiveRadiance *= smoothstep(0.1, -0.12, nightLightsNdotL);
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'earth-night-lights-v1';
  mat.needsUpdate = true;
}

// ─── Atmosphere rim ──────────────────────────────────────────────────────────
// A thin additive shell just outside the Earth. Brightness rises toward the
// limb (grazing view through more air) and follows the sun, so the day-side
// limb glows blue and the night side stays dark, with a warmer tint near the
// terminator. Main view only: from the window seat the camera is *inside*
// this shell, so it lives on its own layer that only the main camera enables.
export const ATMOSPHERE_LAYER = 3;

export function createAtmosphere(earthRadius: number) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 n = normalize(vNormalW);
        vec3 v = normalize(cameraPosition - vPosW);
        float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.5);
        float sunN = dot(n, uSunDir);
        float lit = smoothstep(-0.25, 0.35, sunN);
        float dusk = exp(-pow(sunN / 0.18, 2.0));            // near the terminator
        vec3 col = vec3(0.30, 0.58, 1.0) * lit + vec3(1.0, 0.45, 0.2) * dusk * 0.35;
        gl_FragColor = vec4(col * rim * 1.3, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(earthRadius * 1.035, 96, 96), mat);
  mesh.layers.set(ATMOSPHERE_LAYER);
  mesh.renderOrder = 1;   // after clouds (0) and the twilight overlay (-0.5)
  const tmp = new THREE.Vector3();
  return {
    mesh,
    setSunPosition(p: THREE.Vector3) { mat.uniforms.uSunDir.value.copy(tmp.copy(p).normalize()); },
  };
}

// ─── Route lines with real thickness ─────────────────────────────────────────
// WebGL ignores LineBasicMaterial.linewidth (always 1 px). Line2 draws
// screen-space quads instead; its material needs the viewport size in pixels,
// so call setResolution on resize. One shared material for every route line.
export function createRouteLineMaterial(color = 0xffaa33, widthPx = 2.5): LineMaterial {
  const m = new LineMaterial({ color, linewidth: widthPx, worldUnits: false });
  m.toneMapped = false;
  m.transparent = true;   // drawn in the transparent pass, after the atmosphere
  m.resolution.set(window.innerWidth, window.innerHeight);
  return m;
}

export function makeRouteLine(points: THREE.Vector3[], material: LineMaterial): Line2 {
  const geo = new LineGeometry();
  geo.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const line = new Line2(geo, material);
  line.renderOrder = 2;   // atmosphere is 1: keep its additive rim off the route
  return line;
}
