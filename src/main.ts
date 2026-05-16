import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DateTime } from 'luxon';

// Assets are imported (not fetched) so the bundler can decide per build
// whether to ship them as separate hashed files (normal build) or inline as
// base64 data URLs (singlefile build).
import dayMapUrl    from './textures/2k_earth_daymap.jpg';
import nightMapUrl  from './textures/2k_earth_nightmap.jpg';
import normalMapUrl from './textures/2k_earth_normal_map.png';
import cloudsMapUrl from './textures/2k_earth_clouds.jpg';
import starsMapUrl  from './textures/2k_stars_milky_way.jpg';
import airportsData from './airports.json';

// ─── Renderer ────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.appendChild(renderer.domElement);

// ─── Scene & Camera ──────────────────────────────────────────────────────────

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 0.6, 6);

// ─── Controls ────────────────────────────────────────────────────────────────

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;     // keep Earth pinned to the viewport center
controls.minDistance = 2.6;
controls.maxDistance = 30;
controls.target.set(0, 0, 0);

// ─── Lights ──────────────────────────────────────────────────────────────────

// Very dim ambient so the unlit side isn't pitch black before city lights show.
const ambient = new THREE.AmbientLight(0xffffff, 0.04);
scene.add(ambient);

// Directional "Sun". Phase 4 will animate this from the real subsolar point.
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(10, 2, 5);
scene.add(sun);

// ─── Texture loading ─────────────────────────────────────────────────────────

const loader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// Color textures need sRGB; data textures (normal, alpha) stay linear.
function loadColor(path: string) {
  const t = loader.load(path);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}
function loadData(path: string) {
  const t = loader.load(path);
  t.anisotropy = maxAniso;
  return t;
}

const dayMap     = loadColor(dayMapUrl);
const nightMap   = loadColor(nightMapUrl);
const normalMap  = loadData(normalMapUrl);
const cloudsMap  = loadData(cloudsMapUrl);   // used as alpha
const starsMap   = loadColor(starsMapUrl);

// ─── Starfield (large inverted sphere) ───────────────────────────────────────

const stars = new THREE.Mesh(
  new THREE.SphereGeometry(500, 64, 64),
  new THREE.MeshBasicMaterial({ map: starsMap, side: THREE.BackSide })
);
scene.add(stars);

// ─── Earth ───────────────────────────────────────────────────────────────────

export const EARTH_RADIUS = 2;

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 96, 96),
  new THREE.MeshStandardMaterial({
    map: dayMap,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.7, 0.7),
    // emissiveMap adds light on top regardless of shading — on the lit side it's
    // washed out by daylight, on the dark side it shows as city glow.
    emissiveMap: nightMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1.0,
    roughness: 0.95,
    metalness: 0.0,
  })
);
// Real axial tilt (~23.4°) so the north pole leans toward +Y.
earth.rotation.z = THREE.MathUtils.degToRad(23.4);
scene.add(earth);

// ─── Clouds (slightly larger transparent sphere) ─────────────────────────────

// The cloud texture is grayscale (bright = cloud, dark = clear sky). Using it
// as alphaMap with a white base color gives transparent-where-dark clouds.
const clouds = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS * 1.01, 96, 96),
  new THREE.MeshStandardMaterial({
    color: 0xffffff,
    alphaMap: cloudsMap,
    transparent: true,
    depthWrite: false,
    roughness: 1.0,
    metalness: 0.0,
  })
);
clouds.rotation.z = THREE.MathUtils.degToRad(23.4);
scene.add(clouds);

// ─── Lat/lon helpers & great-circle paths ───────────────────────────────────

// Convention (in Earth's local frame, before tilt/spin):
//   lat= 0, lon=   0  →  +X   (prime meridian on equator)
//   lat= 0, lon= +90  →  -Z   (east of Greenwich → into the screen)
//   lat= 0, lon= -90  →  +Z   (west of Greenwich → out of the screen)
//   lat=+90, lon=any  →  +Y   (north pole)
// Three's SphereGeometry UVs trace -X→+Z→+X→-Z→-X as u goes 0→1, so an
// equirectangular map (u: -180°→+180°) ends up with longitude increasing
// clockwise around +Y — hence the negative sign on Z below.
function latLonToVec3(latDeg: number, lonDeg: number, radius: number): THREE.Vector3 {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(
    radius * cosLat * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * cosLat * Math.sin(lon)
  );
}

// Slerp between the two surface points and sample N+1 positions along the arc.
function greatCirclePoints(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  radius: number,
  segments = 128
): THREE.Vector3[] {
  const p1 = latLonToVec3(lat1, lon1, 1);
  const p2 = latLonToVec3(lat2, lon2, 1);
  const omega = Math.acos(THREE.MathUtils.clamp(p1.dot(p2), -1, 1));
  const sinOmega = Math.sin(omega);

  const points: THREE.Vector3[] = [];
  // Antipodal/coincident: slerp is undefined — fall back to a stable interpolation
  if (sinOmega < 1e-6) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      points.push(p1.clone().lerp(p2, t).normalize().multiplyScalar(radius));
    }
    return points;
  }

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = Math.sin((1 - t) * omega) / sinOmega;
    const b = Math.sin(t * omega) / sinOmega;
    points.push(
      new THREE.Vector3()
        .addScaledVector(p1, a)
        .addScaledVector(p2, b)
        .multiplyScalar(radius)
    );
  }
  return points;
}

// Lift the line slightly above the cloud layer (1.01) so it's always visible.
const PATH_LIFT = 1.02;

function createGreatCircleLine(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  color = 0xffaa33
): THREE.Line {
  const points = greatCirclePoints(lat1, lon1, lat2, lon2, EARTH_RADIUS * PATH_LIFT);
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, toneMapped: false });
  return new THREE.Line(geometry, material);
}

function createSurfaceMarker(lat: number, lon: number, color = 0xff3333): THREE.Mesh {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 16, 16),
    new THREE.MeshBasicMaterial({ color, toneMapped: false })
  );
  marker.position.copy(latLonToVec3(lat, lon, EARTH_RADIUS * PATH_LIFT));
  return marker;
}

// ─── Airports & routing ──────────────────────────────────────────────────────

type Airport = {
  name: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
  tz: string;  // IANA timezone, e.g. "America/New_York"
};

let airports: Record<string, Airport> = {};
let currentRoute: THREE.Group | null = null;

function clearRoute() {
  if (!currentRoute) return;
  earth.remove(currentRoute);
  currentRoute.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  currentRoute = null;
  clearFlight();
}

function setRoute(fromCode: string, toCode: string):
  | { ok: true; from: Airport; to: Airport }
  | { ok: false; error: string } {
  const from = airports[fromCode];
  const to   = airports[toCode];
  if (!from) return { ok: false, error: `Unknown airport: ${fromCode}` };
  if (!to)   return { ok: false, error: `Unknown airport: ${toCode}` };

  clearRoute();
  const g = new THREE.Group();
  g.add(createGreatCircleLine(from.lat, from.lon, to.lat, to.lon));
  g.add(createSurfaceMarker(from.lat, from.lon, 0x33ff66));   // green = departure
  g.add(createSurfaceMarker(to.lat,   to.lon,   0xff3333));   // red   = arrival
  // Parented to earth → inherits axial tilt + spin, so the path stays glued
  // to the surface as the Earth rotates.
  earth.add(g);
  currentRoute = g;
  return { ok: true, from, to };
}

// Expose for tinkering from the devtools console.
(window as unknown as { setRoute: typeof setRoute }).setRoute = setRoute;

// ─── Airport search (autocomplete) ──────────────────────────────────────────

const MAX_SUGGESTIONS = 8;

type Suggestion = { code: string; ap: Airport };

// Rank: exact IATA > IATA prefix > exact city > city prefix > name prefix >
// city contains > name contains > IATA contains. Returns top N.
function searchAirports(query: string): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<{ code: string; ap: Airport; score: number }> = [];
  for (const code in airports) {
    const ap = airports[code];
    const codeL = code.toLowerCase();
    const cityL = (ap.city || '').toLowerCase();
    const nameL = (ap.name || '').toLowerCase();
    let score = 0;
    if      (codeL === q)            score = 1000;
    else if (codeL.startsWith(q))    score = 900;
    else if (cityL === q)            score = 800;
    else if (cityL.startsWith(q))    score = 700;
    else if (nameL.startsWith(q))    score = 600;
    else if (cityL.includes(q))      score = 500;
    else if (nameL.includes(q))      score = 400;
    else if (codeL.includes(q))      score = 300;
    else continue;
    hits.push({ code, ap, score });
  }
  hits.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return hits.slice(0, MAX_SUGGESTIONS).map(({ code, ap }) => ({ code, ap }));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Resolve raw input text → IATA code. If user typed exactly a known IATA,
// use it; otherwise pick the top search hit. Returns '' if nothing matches.
function resolveAirportCode(value: string): string {
  const v = value.trim();
  if (!v) return '';
  const upper = v.toUpperCase();
  if (v.length === 3 && airports[upper]) return upper;
  const hits = searchAirports(v);
  return hits[0]?.code ?? '';
}

// ─── Astronomy: subsolar point ──────────────────────────────────────────────

// Subsolar point at a given UTC instant: where on Earth (lat/lon, in the
// Earth-fixed/ECEF frame) the sun is directly overhead. NOAA-derived formula,
// accurate to ~0.01° — well past anything we'd notice visually.
function subsolarPoint(utcMs: number): { lat: number; lon: number } {
  const jd = utcMs / 86400000 + 2440587.5;            // Julian date (UT1≈UTC)
  const n  = jd - 2451545.0;                          // days since J2000.0

  const mod360 = (x: number) => ((x % 360) + 360) % 360;
  const mod24  = (x: number) => ((x % 24)  + 24)  % 24;

  const L  = mod360(280.460 + 0.9856474 * n);                                  // mean longitude
  const g  = THREE.MathUtils.degToRad(mod360(357.528 + 0.9856003 * n));        // mean anomaly
  const lambda  = THREE.MathUtils.degToRad(
    L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)                          // ecliptic longitude
  );
  const epsilon = THREE.MathUtils.degToRad(23.439 - 0.0000004 * n);            // obliquity

  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ra   = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));

  // Greenwich Mean Sidereal Time (Meeus approximation)
  const gmstDeg = mod24(18.697374558 + 24.06570982441908 * n) * 15;

  let lon = THREE.MathUtils.radToDeg(ra) - gmstDeg;
  lon = ((lon + 540) % 360) - 180;
  return { lat: THREE.MathUtils.radToDeg(decl), lon };
}

// ─── Flight state & animation ────────────────────────────────────────────────

type Flight = {
  from: Airport; to: Airport;
  fromCode: string; toCode: string;
  depUtcMs: number; arrUtcMs: number; durationMs: number;
  // Cached slerp inputs (unit vectors on the sphere)
  p1: THREE.Vector3; p2: THREE.Vector3;
  omega: number; sinOmega: number;
  distanceKm: number; speedKmh: number;
};

const EARTH_RADIUS_KM = 6371;

let flight: Flight | null = null;
let progress = 0;              // 0..1 along the route
let playing  = false;
const PLAY_WALL_SECONDS = 25;  // how long the whole flight takes on screen

let planeMesh: THREE.Mesh | null = null;
function ensurePlane(): THREE.Mesh {
  if (planeMesh) return planeMesh;
  // ConeGeometry's axis is +Y; we'll align +Y with the flight heading each
  // frame, so the cone lies tangent to the surface with its tip pointing along
  // the direction of travel.
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(0.03, 0.1, 14),
    new THREE.MeshBasicMaterial({ color: 0xffee55, toneMapped: false })
  );
  earth.add(m);
  planeMesh = m;
  return m;
}

function clearFlight() {
  flight = null;
  progress = 0;
  playing = false;
  if (planeMesh) {
    earth.remove(planeMesh);
    planeMesh.geometry.dispose();
    (planeMesh.material as THREE.Material).dispose();
    planeMesh = null;
  }
  hideRecap();
}

// Position + heading along the great circle. Both are in Earth's local frame
// (unit vectors); heading is the slerp's derivative — tangent to the great
// circle, pointing from departure toward arrival.
function planeAt(f: Flight, t: number): { pos: THREE.Vector3; heading: THREE.Vector3 } {
  const { omega, sinOmega: s, p1, p2 } = f;
  const a = Math.sin((1 - t) * omega) / s;
  const b = Math.sin(t * omega)       / s;
  const pos = new THREE.Vector3()
    .addScaledVector(p1, a)
    .addScaledVector(p2, b)
    .normalize();
  const ka = -omega * Math.cos((1 - t) * omega) / s;
  const kb =  omega * Math.cos(t * omega)       / s;
  const heading = new THREE.Vector3()
    .addScaledVector(p1, ka)
    .addScaledVector(p2, kb)
    .normalize();
  return { pos, heading };
}

function setFlight(
  fromCode: string, toCode: string,
  depLocalStr: string, arrLocalStr: string
): { ok: true } | { ok: false; error: string } {
  const r = setRoute(fromCode, toCode);
  if (!r.ok) return r;

  const dep = DateTime.fromISO(depLocalStr, { zone: r.from.tz });
  const arr = DateTime.fromISO(arrLocalStr, { zone: r.to.tz });
  if (!dep.isValid) return { ok: false, error: `Bad departure: ${dep.invalidReason ?? 'invalid'}` };
  if (!arr.isValid) return { ok: false, error: `Bad arrival: ${arr.invalidReason ?? 'invalid'}` };
  const depMs = dep.toMillis();
  const arrMs = arr.toMillis();
  if (arrMs <= depMs) return { ok: false, error: 'Arrival must be after departure (UTC).' };

  const p1 = latLonToVec3(r.from.lat, r.from.lon, 1);
  const p2 = latLonToVec3(r.to.lat,   r.to.lon,   1);
  const omega = Math.acos(THREE.MathUtils.clamp(p1.dot(p2), -1, 1));
  const distanceKm = omega * EARTH_RADIUS_KM;
  const durationMs = arrMs - depMs;
  flight = {
    from: r.from, to: r.to, fromCode, toCode,
    depUtcMs: depMs, arrUtcMs: arrMs, durationMs,
    p1, p2, omega, sinOmega: Math.sin(omega),
    distanceKm,
    speedKmh: distanceKm / (durationMs / 3_600_000),
  };
  ensurePlane();
  progress = 0;
  playing = false;
  renderRecap(flight);
  updateFlightFrame(0);
  return { ok: true };
}

(window as unknown as { setFlight: typeof setFlight }).setFlight = setFlight;

// ─── Per-frame flight update ─────────────────────────────────────────────────

const flightHud = document.getElementById('flight-hud') as HTMLDivElement;

function fmt(n: number, digits = 1): string { return n.toFixed(digits); }

function formatClock(rightDot: number, forwardDot: number): string {
  // 12 = ahead, 3 = starboard, 6 = behind, 9 = port — clockwise from the
  // pilot's POV (looking down on the cockpit from above).
  const az = Math.atan2(rightDot, forwardDot);  // 0 = ahead, +π/2 = right
  let hours = az * 6 / Math.PI;                 // -6..+6
  if (hours <= 0) hours += 12;                  // 0..12 (with 12 = ahead)
  const h = Math.floor(hours) || 12;
  const m = Math.round((hours - Math.floor(hours)) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

function sideLabel(rightDot: number, forwardDot: number): string {
  const side = rightDot > 0 ? 'STARBOARD (right)' : 'PORT (left)';
  let qual: string;
  if (forwardDot > 0.5) qual = 'ahead';
  else if (forwardDot < -0.5) qual = 'behind';
  else qual = 'abeam';
  return `Sun: ${side}, ${qual}`;
}

// Civil-twilight-aware day/night label. Elevation is the sun's angle above
// the local horizon at the plane's position.
function daylightLabel(elevDeg: number): string {
  if (elevDeg >=  0) return 'DAY';
  if (elevDeg >= -6) return 'TWILIGHT';
  return 'NIGHT';
}

// Sample one moment along the flight and return the derived flight-frame
// quantities needed to decide phase + sun side. Shared by per-frame HUD and
// by the offline transition scan.
function flightSampleAt(f: Flight, t: number): {
  utcMs: number; pos: THREE.Vector3; heading: THREE.Vector3; sunLocal: THREE.Vector3;
  sR: number; sU: number; elevDeg: number; phase: 'DAY' | 'TWILIGHT' | 'NIGHT';
  side: 'LEFT' | 'RIGHT';
} {
  const utcMs = f.depUtcMs + t * f.durationMs;
  const { pos, heading } = planeAt(f, t);
  const sub = subsolarPoint(utcMs);
  const sunLocal = latLonToVec3(sub.lat, sub.lon, 1);
  const up    = pos;
  const right = new THREE.Vector3().crossVectors(heading, up).normalize();
  const sR = sunLocal.dot(right);
  const sU = sunLocal.dot(up);
  const elevDeg = THREE.MathUtils.radToDeg(Math.asin(sU));
  const phase = daylightLabel(elevDeg) as 'DAY' | 'TWILIGHT' | 'NIGHT';
  const side: 'LEFT' | 'RIGHT' = sR > 0 ? 'RIGHT' : 'LEFT';
  return { utcMs, pos, heading, sunLocal, sR, sU, elevDeg, phase, side };
}

// Scan the flight at fine resolution and collect phase / side transitions.
// Step count ≈ 2000 → ~25 s resolution for a 14 h flight, fine for visualization.
type RecapRow = { utcMs: number; phase: string; label: string; endpoint?: boolean };

function computeRecap(f: Flight): RecapRow[] {
  const N = 2000;
  const rows: RecapRow[] = [];
  const first = flightSampleAt(f, 0);
  const depExtra = first.phase === 'DAY' ? `, sun on the ${first.side}` : '';
  rows.push({
    utcMs: f.depUtcMs,
    phase: first.phase,
    label: `Depart ${f.fromCode} — ${first.phase}${depExtra}`,
    endpoint: true,
  });

  let prevPhase = first.phase;
  let prevSide  = first.side;
  for (let i = 1; i <= N; i++) {
    const s = flightSampleAt(f, i / N);
    if (s.phase !== prevPhase) {
      const extra = s.phase === 'DAY' ? `, sun on the ${s.side}` : '';
      rows.push({ utcMs: s.utcMs, phase: s.phase, label: `→ ${s.phase}${extra}` });
    } else if (s.phase === 'DAY' && s.side !== prevSide) {
      rows.push({ utcMs: s.utcMs, phase: 'DAY', label: `Sun → ${s.side}` });
    }
    prevPhase = s.phase;
    prevSide  = s.side;
  }

  rows.push({
    utcMs: f.arrUtcMs,
    phase: prevPhase,
    label: `Arrive ${f.toCode}`,
    endpoint: true,
  });
  return rows;
}

const recapEl     = document.getElementById('recap') as HTMLDivElement;
const recapTitle  = recapEl.querySelector('.title')   as HTMLDivElement;
const recapTable  = recapEl.querySelector('table')    as HTMLTableElement;

function renderRecap(f: Flight) {
  const rows = computeRecap(f);
  recapTitle.textContent = `Phase transitions — times in ${f.from.tz}`;
  recapTable.innerHTML = rows.map((r) => {
    const t = DateTime.fromMillis(r.utcMs).setZone(f.from.tz).toFormat('LLL dd HH:mm');
    const cls = `phase-${r.phase}${r.endpoint ? ' endpoint' : ''}`;
    return `<tr class="${cls}"><td class="time">${t}</td><td class="label">${r.label}</td></tr>`;
  }).join('');
  recapEl.classList.add('visible');
}

function hideRecap() {
  recapEl.classList.remove('visible');
  recapTable.innerHTML = '';
  recapTitle.textContent = '';
}

function updateFlightFrame(t: number) {
  if (!flight || !planeMesh) return;
  const utcMs = flight.depUtcMs + t * flight.durationMs;

  // Plane position & heading (Earth-local frame, unit vectors).
  const { pos, heading } = planeAt(flight, t);
  planeMesh.position.copy(pos).multiplyScalar(EARTH_RADIUS * PATH_LIFT);
  planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), heading);

  // Sun direction in Earth-local frame, then transformed to world for the light.
  const sub = subsolarPoint(utcMs);
  const sunLocal  = latLonToVec3(sub.lat, sub.lon, 1);
  const sunWorld  = sunLocal.clone().applyQuaternion(earth.getWorldQuaternion(new THREE.Quaternion()));
  sun.position.copy(sunWorld).multiplyScalar(50);

  // Sun-side math — both vectors live in Earth-local so dot products are valid.
  const up    = pos.clone();
  const right = new THREE.Vector3().crossVectors(heading, up).normalize();
  const sR = sunLocal.dot(right);
  const sF = sunLocal.dot(heading);
  const sU = sunLocal.dot(up);

  // Plane lat/lon for the HUD (inverse of latLonToVec3).
  const planeLat = THREE.MathUtils.radToDeg(Math.asin(pos.y));
  const planeLon = THREE.MathUtils.radToDeg(Math.atan2(-pos.z, pos.x));
  const elevDeg  = THREE.MathUtils.radToDeg(Math.asin(sU));

  const utcStr = new Date(utcMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const traveledKm  = t * flight.distanceKm;
  const remainingKm = flight.distanceKm - traveledKm;
  flightHud.textContent = [
    `${utcStr}   ${(t * 100).toFixed(0)}%   [${daylightLabel(elevDeg)}]`,
    `Plane: ${fmt(planeLat)}°, ${fmt(planeLon)}°   Sun elev: ${fmt(elevDeg, 0)}°`,
    `${sideLabel(sR, sF)}   at ${formatClock(sR, sF)}`,
    `Speed: ${Math.round(flight.speedKmh)} km/h   ` +
      `${Math.round(traveledKm)} / ${Math.round(flight.distanceKm)} km   ` +
      `${Math.round(remainingKm)} km left`,
  ].join('\n');
}

// ─── Route form wiring ───────────────────────────────────────────────────────

const form     = document.getElementById('route-form') as HTMLFormElement;
const inFrom   = document.getElementById('route-from') as HTMLInputElement;
const inTo     = document.getElementById('route-to')   as HTMLInputElement;
const inDep    = document.getElementById('dep-time')   as HTMLInputElement;
const inArr    = document.getElementById('arr-time')   as HTMLInputElement;
const depTzEl  = document.getElementById('dep-tz')     as HTMLSpanElement;
const arrTzEl  = document.getElementById('arr-tz')     as HTMLSpanElement;
const inDur    = document.getElementById('arr-duration') as HTMLInputElement;
const modeDtBtn  = document.getElementById('end-mode-dt')  as HTMLButtonElement;
const modeDurBtn = document.getElementById('end-mode-dur') as HTMLButtonElement;
const playBtn  = document.getElementById('play-btn')   as HTMLButtonElement;
const scrubEl  = document.getElementById('scrub')      as HTMLInputElement;
const statusEl = document.getElementById('route-status') as HTMLDivElement;

function showStatus(msg: string, error = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', error);
}

function commitAirportInput(inputEl: HTMLInputElement): string {
  const code = resolveAirportCode(inputEl.value);
  if (code) inputEl.value = code;
  return code;
}

// "America/New_York (UTC−4)" for the given local datetime in that zone.
// Offset is evaluated *at the given datetime* so DST switches are reflected.
function formatTzInfo(tz: string, localIso: string): string {
  if (!tz) return '';
  const dt = localIso
    ? DateTime.fromISO(localIso, { zone: tz })
    : DateTime.now().setZone(tz);
  if (!dt.isValid) return tz;
  const offMin = dt.offset;                              // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(offMin) / 60);
  const m = Math.abs(offMin) % 60;
  const offStr = m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, '0')}`;
  return `${tz} (UTC${offStr})`;
}

let lastRouteFrom: Airport | null = null;
let lastRouteTo:   Airport | null = null;

function refreshTzInfo() {
  depTzEl.textContent = lastRouteFrom ? formatTzInfo(lastRouteFrom.tz, inDep.value) : '';
  arrTzEl.textContent = lastRouteTo   ? formatTzInfo(lastRouteTo.tz,   inArr.value) : '';
}

// ─── End-time mode (Datetime ↔ Duration) ────────────────────────────────────

let endMode: 'datetime' | 'duration' = 'datetime';

// Accepts "11h 30m", "11:30", "11.5", "11h", "30m". Returns minutes or null.
function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})$/)))
    return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/)) && (m[1] || m[2]))
    return Math.round((m[1] ? parseFloat(m[1]) : 0) * 60 + (m[2] ? parseInt(m[2]) : 0));
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/)))
    return Math.round(parseFloat(m[1]) * 60);
  return null;
}

function formatDuration(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '';
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// arr_local (in toTz) = dep_local (in fromTz) + duration
function durationToArrIso(depIso: string, fromTz: string, durMin: number, toTz: string): string {
  const dep = DateTime.fromISO(depIso, { zone: fromTz });
  if (!dep.isValid) return '';
  return dep.plus({ minutes: durMin }).setZone(toTz).toFormat("yyyy-LL-dd'T'HH:mm");
}

function arrIsoToDurationMin(depIso: string, fromTz: string, arrIso: string, toTz: string): number | null {
  const dep = DateTime.fromISO(depIso, { zone: fromTz });
  const arr = DateTime.fromISO(arrIso, { zone: toTz });
  if (!dep.isValid || !arr.isValid) return null;
  return Math.round(arr.diff(dep, 'minutes').minutes);
}

// In Duration mode, the arrival datetime input is computed from
// dep + duration. Keeps inArr.value in sync so Play / setFlight see correct ISO.
function syncArrFromDuration() {
  if (!lastRouteFrom || !lastRouteTo) return;
  const dur = parseDuration(inDur.value);
  if (dur === null) return;
  const iso = durationToArrIso(inDep.value, lastRouteFrom.tz, dur, lastRouteTo.tz);
  if (iso) inArr.value = iso;
}

// In Datetime mode, keep the (hidden) duration field synced to arr - dep so
// toggling to Duration shows the right value.
function syncDurationFromArr() {
  if (!lastRouteFrom || !lastRouteTo) { inDur.value = ''; return; }
  const mins = arrIsoToDurationMin(inDep.value, lastRouteFrom.tz, inArr.value, lastRouteTo.tz);
  inDur.value = mins !== null && mins >= 0 ? formatDuration(mins) : '';
}

function setEndMode(mode: 'datetime' | 'duration') {
  if (mode === endMode) return;
  if (mode === 'duration') syncDurationFromArr();
  else                     syncArrFromDuration();
  endMode = mode;
  modeDtBtn.classList.toggle('active',  mode === 'datetime');
  modeDurBtn.classList.toggle('active', mode === 'duration');
  inArr.style.display = mode === 'datetime' ? '' : 'none';
  inDur.style.display = mode === 'duration' ? '' : 'none';
  refreshTzInfo();
}

modeDtBtn.addEventListener('click',  () => setEndMode('datetime'));
modeDurBtn.addEventListener('click', () => setEndMode('duration'));

inDep.addEventListener('input', () => {
  if (endMode === 'duration') syncArrFromDuration();
  else                        syncDurationFromArr();
  refreshTzInfo();
});
inDur.addEventListener('input', () => { syncArrFromDuration(); refreshTzInfo(); });
inArr.addEventListener('input', () => { syncDurationFromArr(); refreshTzInfo(); });

function submitRoute() {
  const from = commitAirportInput(inFrom);
  const to   = commitAirportInput(inTo);
  if (!from || !to) {
    showStatus('Could not match both airports — try IATA, city, or name.', true);
    return;
  }
  const r = setRoute(from, to);
  if (r.ok) {
    showStatus(`${from} ${r.from.city} → ${to} ${r.to.city}`);
    lastRouteFrom = r.from;
    lastRouteTo   = r.to;
    // The hidden mode's field becomes meaningful now that we have TZs.
    if (endMode === 'duration') syncArrFromDuration();
    else                        syncDurationFromArr();
    refreshTzInfo();
  } else {
    showStatus(r.error, true);
  }
}


form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitRoute();
});

// ─── Autocomplete wiring ─────────────────────────────────────────────────────

function setupAirportAutocomplete(input: HTMLInputElement, onPicked?: () => void) {
  const container = input.parentElement!;        // wrapped in <div class="iata-combo">
  const list = document.createElement('ul');
  list.className = 'iata-suggest';
  container.appendChild(list);

  let suggestions: Suggestion[] = [];
  let selectedIdx = -1;

  function close() {
    list.classList.remove('open');
    list.innerHTML = '';
    suggestions = [];
    selectedIdx = -1;
  }

  function render() {
    list.innerHTML = '';
    suggestions.forEach((s, i) => {
      const li = document.createElement('li');
      if (i === selectedIdx) li.className = 'selected';
      li.innerHTML =
        `<span class="code">${s.code}</span>` +
        `<span class="where">${escapeHtml(s.ap.city || '')}` +
        (s.ap.country ? `, ${escapeHtml(s.ap.country)}` : '') +
        `</span>` +
        `<span class="name">${escapeHtml(s.ap.name)}</span>`;
      // mousedown (not click): fires before the input's blur, so we can
      // preventDefault to keep focus.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(i);
      });
      list.appendChild(li);
    });
    list.classList.toggle('open', suggestions.length > 0);
  }

  function pick(idx: number) {
    if (idx < 0 || idx >= suggestions.length) return;
    input.value = suggestions[idx].code;
    close();
    if (onPicked) onPicked();
  }

  input.addEventListener('input', () => {
    suggestions = searchAirports(input.value);
    selectedIdx = suggestions.length > 0 ? 0 : -1;
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % suggestions.length;
      render();
    } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
      render();
    } else if (e.key === 'Enter' && selectedIdx >= 0 && suggestions.length > 0) {
      e.preventDefault();
      pick(selectedIdx);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  // Blur with a small delay so a mousedown-pick has time to complete.
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ─── Playback wiring ─────────────────────────────────────────────────────────

function updatePlayBtn() {
  playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
}

playBtn.addEventListener('click', () => {
  if (playing) {
    playing = false;
    updatePlayBtn();
    return;
  }
  const fromCode = commitAirportInput(inFrom);
  const toCode   = commitAirportInput(inTo);
  if (!fromCode || !toCode) {
    showStatus('Could not match both airports — try IATA, city, or name.', true);
    return;
  }
  if (!inDep.value || !inArr.value) {
    showStatus('Set both departure and arrival times.', true);
    return;
  }
  const r = setFlight(fromCode, toCode, inDep.value, inArr.value);
  if (!r.ok) { showStatus(r.error, true); return; }
  showStatus(`${fromCode} ${flight!.from.city} → ${toCode} ${flight!.to.city}`);
  if (progress >= 1) progress = 0;
  scrubEl.value = String(Math.round(progress * 1000));
  playing = true;
  updatePlayBtn();
});

scrubEl.addEventListener('input', () => {
  progress = Number(scrubEl.value) / 1000;
  if (playing) { playing = false; updatePlayBtn(); }
  if (flight)  updateFlightFrame(progress);
});

// ─── Initial load: airports + sensible default dep/arr times ────────────────

function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

airports = airportsData as Record<string, Airport>;
setupAirportAutocomplete(inFrom, () => inTo.focus());
setupAirportAutocomplete(inTo,   () => inDep.focus());
inFrom.value = 'JFK';
inTo.value   = 'HND';
// Pre-fill plausible JFK→HND times: 11:30 today (JFK local) → 14:30 next day
// (HND local). Times will be interpreted in each airport's IANA timezone
// when "Play" is clicked.
{
  const dep = new Date(); dep.setHours(11, 30, 0, 0);
  const arr = new Date(dep);
  arr.setDate(arr.getDate() + 1);
  arr.setHours(14, 30, 0, 0);
  inDep.value = toLocalIso(dep);
  inArr.value = toLocalIso(arr);
}
submitRoute();

// ─── View toggles (keyboard) ─────────────────────────────────────────────────

const NIGHT_INTENSITY = 1.0;  // baseline emissive intensity from the night-lights map
const earthMat = earth.material as THREE.MeshStandardMaterial;

let cloudsOn = true;
let nightOn  = true;
let liveOn   = false;
let liveDateLabel = '';  // YYYY-MM-DD currently displayed when live is on

const hud = document.getElementById('info-text')!;

function refreshHud() {
  hud.innerHTML =
    `Orbit: left-drag &nbsp;|&nbsp; Zoom: scroll<br>` +
    `[C] clouds: <b>${cloudsOn ? 'on' : 'off'}</b><br>` +
    `[N] night lights: <b>${nightOn ? 'on' : 'off'}</b><br>` +
    `[L] live satellite: <b>${liveOn ? `on (${liveDateLabel})` : 'off'}</b>`;
}
refreshHud();

// Day/night contrast slider drives three things at once so the effect at the
// extremes is actually dramatic:
//   - ambient (lifts the dark side)         0.20 → 0.00
//   - sun.intensity (brightens the lit side) 1.5 → 6.0
//   - toneMappingExposure (compresses bright) 1.1 → 0.40
// Slider 0 = soft, 50 = balanced (default), 100 = hard contrast.
const contrastEl = document.getElementById('contrast') as HTMLInputElement;
function applyContrast() {
  const v = Number(contrastEl.value) / 100;     // 0..1
  ambient.intensity = 0.20 * (1 - v);
  sun.intensity = 1.5 + 4.5 * v;
  renderer.toneMappingExposure = 1.10 - 0.70 * v;
}
contrastEl.addEventListener('input', applyContrast);
applyContrast();

// ─── Live satellite imagery (NASA GIBS) ──────────────────────────────────────
// Swap the Earth's day map with MODIS Terra true-color from a recent UTC date.
// Satellite imagery already has clouds baked in, so we also hide the curated
// cloud overlay while live is on. Reverts cleanly when toggled off.

function isoUtcDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function gibsTrueColorUrl(dateIso: string): string {
  // WMS 1.3.0, EPSG:4326, BBOX order is (minLat, minLon, maxLat, maxLon).
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    // VIIRS SNPP has a wider swath than MODIS Terra → fewer seams in the mosaic.
    LAYERS:  'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    CRS:     'EPSG:4326',
    BBOX:    '-90,-180,90,180',
    WIDTH:   '2048',
    HEIGHT:  '1024',
    FORMAT:  'image/jpeg',
    TIME:    dateIso,
  });
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params.toString()}`;
}

let liveTexture: THREE.Texture | null = null;
let cloudsBeforeLive = true;  // remember user's C state to restore on toggle off

function setLive(on: boolean) {
  if (on === liveOn) return;
  if (on) {
    // Two days back: gives the processing pipeline enough time to fill in
    // late-arriving swaths, so the global mosaic is essentially complete.
    const date = isoUtcDate(2);
    loader.load(
      gibsTrueColorUrl(date),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = maxAniso;
        liveTexture?.dispose();
        liveTexture = tex;
        earthMat.map = tex;
        earthMat.needsUpdate = true;
        cloudsBeforeLive = cloudsOn;
        cloudsOn = false;
        clouds.visible = false;
        liveOn = true;
        liveDateLabel = date;
        refreshHud();
      },
      undefined,
      () => {
        liveOn = false;
        showStatus('Failed to load live satellite imagery (network/CORS).', true);
        refreshHud();
      }
    );
  } else {
    earthMat.map = dayMap;
    earthMat.needsUpdate = true;
    cloudsOn = cloudsBeforeLive;
    clouds.visible = cloudsOn;
    liveOn = false;
    liveDateLabel = '';
    refreshHud();
  }
}

window.addEventListener('keydown', (e) => {
  // Ignore if a text field is focused (none here yet, but cheap to be safe)
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'c') {
    cloudsOn = !cloudsOn;
    clouds.visible = cloudsOn;
    refreshHud();
  } else if (k === 'n') {
    nightOn = !nightOn;
    earthMat.emissiveIntensity = nightOn ? NIGHT_INTENSITY : 0;
    refreshHud();
  } else if (k === 'l') {
    setLive(!liveOn);
  }
});

// ─── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation loop ──────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();

  if (flight) {
    if (playing) {
      progress = Math.min(1, progress + dt / PLAY_WALL_SECONDS);
      scrubEl.value = String(Math.round(progress * 1000));
      if (progress >= 1) { playing = false; updatePlayBtn(); }
    }
    updateFlightFrame(progress);
    // Clouds keep drifting subtly even during playback for visual life.
    clouds.rotation.y += dt * 0.01;
  } else {
    // Idle: slow Earth spin, fixed sun from Phase 1.
    earth.rotation.y  += dt * 0.05;
    clouds.rotation.y += dt * 0.065;
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
