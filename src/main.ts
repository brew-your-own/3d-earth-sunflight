import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type Airport, type Suggestion, airports, resolveAirportCode, searchAirports } from './airports';
import { greatCirclePoints, latLonToVec3, vec3ToLatLon } from './geo';
import { type Flight, type FlightSample, type Side, buildFlight, flightSampleAt } from './flight';
import { hideRecap, onAdvicePick, renderRecap, updateRecapHighlight, updateSunViz } from './recap-panel';
import { SEAT_LETTERS } from './seat';
import { createWindowView } from './window-view';
import { TERMINATOR_LAYER, createTerminatorOverlay, legendHtml } from './terminator';
import { moonVecER, topocentricMoonDir } from './moon';
import { arrIsoToDurationMin, durationToArrIso, formatDuration, formatTzInfo, parseDuration } from './time';

// Assets are imported (not fetched) so the bundler can decide per build
// whether to ship them as separate hashed files (normal build) or inline as
// base64 data URLs (singlefile build).
import dayMapUrl    from './textures/2k_earth_daymap.jpg';
import nightMapUrl  from './textures/2k_earth_nightmap.jpg';
import normalMapUrl from './textures/2k_earth_normal_map.png';
import cloudsMapUrl from './textures/2k_earth_clouds.jpg';
import starsMapUrl  from './textures/2k_stars_milky_way.jpg';

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

// Two control modes (toggle with [M]):
//   'orbit' — OrbitControls drives the camera; left-drag rotates view freely (current default).
//   'globe' — OrbitControls' rotate is disabled; left-drag rotates Earth around its pole,
//             right-drag rotates around the equatorial axis parallel to the screen.
type ControlMode = 'orbit' | 'globe';
let controlMode: ControlMode = 'orbit';

function applyControlMode() {
  controls.enableRotate = (controlMode === 'orbit');
}
applyControlMode();

// Suppress the OS context menu on the canvas so right-drag is usable in globe mode
// (and harmless in orbit mode, where right-click currently does nothing).
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Custom pointer drag for globe mode. Listeners are always attached but only act
// when controlMode === 'globe'; OrbitControls is short-circuited by enableRotate=false
// and the pre-existing enablePan=false, so the two systems don't collide.
const POLE_SENSITIVITY = 0.005;   // rad per pixel (horizontal drag, left button)
const EQ_SENSITIVITY   = 0.005;   // rad per pixel (vertical drag, right button)
let activeDrag: { button: number; x: number; y: number; pointerId: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (controlMode !== 'globe') return;
  if (e.button !== 0 && e.button !== 2) return;
  activeDrag = { button: e.button, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  const dx = e.clientX - activeDrag.x;
  const dy = e.clientY - activeDrag.y;
  activeDrag.x = e.clientX;
  activeDrag.y = e.clientY;

  if (activeDrag.button === 0) {
    // Left: rotate Earth around its own pole (local +Y, already tilted 23.4°).
    const angle = dx * POLE_SENSITIVITY;
    earth.rotateY(angle);
    clouds.rotateY(angle);
  } else if (activeDrag.button === 2) {
    // Right: rotate around the world-space axis that lies in Earth's equatorial
    // plane AND is parallel to the screen (i.e., the intersection of the equatorial
    // plane and the screen plane). Direction = pole × view.
    const view = controls.target.clone().sub(camera.position).normalize();
    const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(earth.quaternion).normalize();
    const eqAxis = pole.clone().cross(view);
    if (eqAxis.lengthSq() < 1e-6) return;   // singular when looking straight along the pole
    eqAxis.normalize();
    // Drag down (dy > 0) tips the north pole toward the camera, which is the
    // familiar tabletop-globe gesture.
    const q = new THREE.Quaternion().setFromAxisAngle(eqAxis, dy * EQ_SENSITIVITY);
    earth.quaternion.premultiply(q);
    clouds.quaternion.premultiply(q);
  }
});

function endDrag(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  renderer.domElement.releasePointerCapture(e.pointerId);
  activeDrag = null;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

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
  // fog: false — the window view turns scene fog on, and the stars sit far
  // beyond its range; they should fade by sky brightness, not by distance.
  new THREE.MeshBasicMaterial({ map: starsMap, side: THREE.BackSide, fog: false })
);
scene.add(stars);

// ─── Earth ───────────────────────────────────────────────────────────────────

const EARTH_RADIUS = 2;

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

// ─── Terminator / twilight bands (main view only) ────────────────────────────
// Own render layer, enabled on the main camera only, so the window camera
// (layers 0 + 1) never sees it. Sun direction is fed from the directional
// light each rendered frame (see animate), so it always matches the shading.
const terminator = createTerminatorOverlay({ earth, earthRadius: EARTH_RADIUS });
camera.layers.enable(TERMINATOR_LAYER);
let twilightOn = true;
const twilightLegend = document.getElementById('twilight-legend');
if (twilightLegend) twilightLegend.innerHTML = legendHtml();

const windowView = createWindowView({
  renderer, scene, earth, clouds,
  earthRadius: EARTH_RADIUS, cloudRadiusFactor: 1.01,
});

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

// Canvas-rendered label sprite for a 3-letter IATA code. Pill-shaped background
// so it reads on light or dark terrain. Always faces the camera.
function createIataLabel(text: string, color = '#ffcc66'): THREE.Sprite {
  const fontSize = 64;
  const padX = 16, padY = 8;
  const fontStr = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = fontStr;
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width  = tw + padX * 2;
  canvas.height = fontSize + padY * 2;
  // Sizing the canvas clears the 2d context — re-apply font + baseline.
  ctx.font = fontStr;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 10);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, padX, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex });
  const sprite = new THREE.Sprite(mat);
  const h = 0.053;
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
  return sprite;
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

let currentRoute: THREE.Group | null = null;

function clearRoute() {
  if (!currentRoute) return;
  earth.remove(currentRoute);
  currentRoute.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Sprite) {
      const mat = obj.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
  currentRoute = null;
  clearFlight();
}

function setRoute(fromCode: string, toCode: string, viaCodes: string[] = []):
  | { ok: true; from: Airport; to: Airport; waypoints: Airport[] }
  | { ok: false; error: string } {
  const from = airports[fromCode];
  const to   = airports[toCode];
  if (!from) return { ok: false, error: `Unknown airport: ${fromCode}` };
  if (!to)   return { ok: false, error: `Unknown airport: ${toCode}` };
  const waypoints: Airport[] = [];
  for (const code of viaCodes) {
    const wp = airports[code];
    if (!wp) return { ok: false, error: `Unknown waypoint: ${code}` };
    waypoints.push(wp);
  }

  clearRoute();
  const g = new THREE.Group();
  // One great-circle arc per consecutive pair (from → wp1 → wp2 → … → to).
  const chain = [from, ...waypoints, to];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1];
    g.add(createGreatCircleLine(a.lat, a.lon, b.lat, b.lon));
  }
  const labelLift = EARTH_RADIUS * (PATH_LIFT + 0.04);
  const addLabel = (code: string, lat: number, lon: number, color: string) => {
    const label = createIataLabel(code, color);
    label.position.copy(latLonToVec3(lat, lon, labelLift));
    g.add(label);
  };
  g.add(createSurfaceMarker(from.lat, from.lon, 0x33ff66));      // green = departure
  addLabel(fromCode, from.lat, from.lon, '#66ff99');
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    g.add(createSurfaceMarker(wp.lat, wp.lon, 0xff9933));        // orange = waypoint
    addLabel(viaCodes[i], wp.lat, wp.lon, '#ffcc66');
  }
  g.add(createSurfaceMarker(to.lat,   to.lon,   0xff3333));      // red = arrival
  addLabel(toCode, to.lat, to.lon, '#ff7766');
  // Parented to earth → inherits axial tilt + spin, so the path stays glued
  // to the surface as the Earth rotates.
  earth.add(g);
  currentRoute = g;
  return { ok: true, from, to, waypoints };
}

// Expose for tinkering from the devtools console.
(window as unknown as { setRoute: typeof setRoute }).setRoute = setRoute;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ─── Flight state & animation ────────────────────────────────────────────────

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
  currentSample = null;
  lastFrameT = NaN;
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

function setFlight(
  fromCode: string, toCode: string,
  depLocalStr: string, arrLocalStr: string,
  viaCodes: string[] = []
): { ok: true } | { ok: false; error: string } {
  const r = setRoute(fromCode, toCode, viaCodes);
  if (!r.ok) return r;
  const built = buildFlight(
    { from: r.from, to: r.to, fromCode, toCode, waypoints: r.waypoints, waypointCodes: viaCodes },
    depLocalStr, arrLocalStr,
  );
  if (!built.ok) return built;
  flight = built.flight;
  lastFrameT = NaN;
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

// Sun direction (Earth-local) for the frame last drawn. The light is re-aimed
// every frame from this, because the Earth can be rotated by a drag even
// while the flight is paused; everything else only changes with t.
const sunLocalNow = new THREE.Vector3(1, 0, 0);
const earthWorldQ = new THREE.Quaternion();
let lastFrameT = NaN;   // NaN → force a redraw on the next call
let currentSample: FlightSample | null = null;   // sample for the frame on screen

function aimSunLight() {
  earth.getWorldQuaternion(earthWorldQ);
  sun.position.copy(sunLocalNow).applyQuaternion(earthWorldQ).multiplyScalar(50);
}

function updateFlightFrame(t: number) {
  if (!flight || !planeMesh) return;
  aimSunLight();
  if (t === lastFrameT) return;   // paused: skip the math and DOM writes
  lastFrameT = t;

  const s = flightSampleAt(flight, t);
  currentSample = s;
  sunLocalNow.copy(s.sunLocal);
  aimSunLight();

  // Plane mesh: position & heading in Earth-local frame.
  planeMesh.position.copy(s.pos).multiplyScalar(EARTH_RADIUS * PATH_LIFT);
  planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.heading);

  updateRecapHighlight(s.utcMs);
  updateSunViz(s.sR, s.sF, s.phase !== 'NIGHT');

  const { lat: planeLat, lon: planeLon } = vec3ToLatLon(s.pos);
  const utcStr = new Date(s.utcMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const traveledKm  = t * flight.distanceKm;
  const remainingKm = flight.distanceKm - traveledKm;
  flightHud.textContent = [
    `${utcStr}   ${(t * 100).toFixed(0)}%   [${s.phase}]`,
    `Plane: ${fmt(planeLat)}°, ${fmt(planeLon)}°   Alt: ${fmt(s.altKm)} km   Sun elev: ${fmt(s.elevDeg, 0)}°`,
    `${sideLabel(s.sR, s.sF)}   at ${formatClock(s.sR, s.sF)}`,
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
const viaList    = document.getElementById('via-list')     as HTMLDivElement;
const addWpBtn   = document.getElementById('add-waypoint') as HTMLButtonElement;
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

// Read each waypoint input; resolve to IATA (committing the value back to the
// input). Skip empty rows so the default no-waypoint case still works.
function collectWaypointCodes(): string[] {
  const inputs = Array.from(viaList.querySelectorAll('input.via')) as HTMLInputElement[];
  const codes: string[] = [];
  for (const inp of inputs) {
    if (!inp.value.trim()) continue;
    const code = commitAirportInput(inp);
    if (code) codes.push(code);
  }
  return codes;
}

let lastRouteFrom: Airport | null = null;
let lastRouteTo:   Airport | null = null;

function refreshTzInfo() {
  depTzEl.textContent = lastRouteFrom ? formatTzInfo(lastRouteFrom.tz, inDep.value) : '';
  arrTzEl.textContent = lastRouteTo   ? formatTzInfo(lastRouteTo.tz,   inArr.value) : '';
}

// ─── End-time mode (Datetime ↔ Duration) ────────────────────────────────────

let endMode: 'datetime' | 'duration' = 'datetime';

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

// Point the dep/arr timezone context at these airports and re-derive the
// hidden end-time field. Must run whenever the airports change and before
// times are read — otherwise in Duration mode inArr would still hold an
// arrival computed in the *previous* destination's timezone.
function syncRouteTimezones(from: Airport, to: Airport) {
  if (from === lastRouteFrom && to === lastRouteTo) return;
  lastRouteFrom = from;
  lastRouteTo   = to;
  if (endMode === 'duration') syncArrFromDuration();
  else                        syncDurationFromArr();
  refreshTzInfo();
}

function submitRoute() {
  const from = commitAirportInput(inFrom);
  const to   = commitAirportInput(inTo);
  if (!from || !to) {
    showStatus('Could not match both airports — try IATA, city, or name.', true);
    return;
  }
  const via = collectWaypointCodes();
  const r = setRoute(from, to, via);
  if (r.ok) {
    const viaStr = via.length > 0 ? ` via ${via.join(' → ')}` : '';
    showStatus(`${from} ${r.from.city} → ${to} ${r.to.city}${viaStr}`);
    syncRouteTimezones(r.from, r.to);
    updateUrl(from, to, via);
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

// Signature of the inputs used to build the currently-loaded flight. Lets Play
// distinguish "resume the paused flight" from "the form changed, rebuild".
let flightInputSig: string | null = null;

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
  // Airports may have been edited without pressing "Show route".
  syncRouteTimezones(airports[fromCode], airports[toCode]);
  if (!inDep.value || !inArr.value) {
    showStatus('Set both departure and arrival times.', true);
    return;
  }
  const via = collectWaypointCodes();
  const sig = [fromCode, toCode, inDep.value, inArr.value, ...via].join('|');

  // Resume in place if the flight on screen was built from these exact inputs
  // and we're partway through. Otherwise (no flight, inputs changed, or at end)
  // rebuild from scratch.
  if (flight && sig === flightInputSig && progress < 1) {
    playing = true;
    updatePlayBtn();
    return;
  }

  const r = setFlight(fromCode, toCode, inDep.value, inArr.value, via);
  if (!r.ok) { showStatus(r.error, true); return; }
  flightInputSig = sig;
  updateUrl(fromCode, toCode, via);
  const viaStr = via.length > 0 ? ` via ${via.join(' → ')}` : '';
  showStatus(`${fromCode} ${flight!.from.city} → ${toCode} ${flight!.to.city}${viaStr}`);
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

function addWaypointRow(prefill = '', focus = true) {
  const item  = document.createElement('div');
  item.className = 'via-item';
  const combo = document.createElement('div');
  combo.className = 'iata-combo';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'iata via';
  input.placeholder = 'IATA, city, or name';
  input.autocomplete = 'off';
  if (prefill) input.value = prefill;
  combo.appendChild(input);
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'remove-via';
  rm.title = 'Remove waypoint';
  rm.textContent = '×';
  rm.addEventListener('click', () => item.remove());
  item.append(combo, rm);
  viaList.appendChild(item);
  setupAirportAutocomplete(input);
  if (focus) input.focus();
}

addWpBtn.addEventListener('click', () => addWaypointRow());

// ─── Preset routes + URL parameters ─────────────────────────────────────────

type RouteSpec = { from: string; to: string; via?: string[]; dep?: string; arr?: string };

const PRESETS: RouteSpec[] = [
  { from: 'JFK', to: 'HND' },
  { from: 'LHR', to: 'SYD' },
  { from: 'SFO', to: 'SIN' },
  { from: 'JFK', to: 'HND', via: ['LAX'] },
  { from: 'LHR', to: 'SYD', via: ['DXB', 'SIN'] },     // classic Kangaroo Route
];

// ?from=JFK&to=HND&via=LAX,SFO&dep=2026-05-16T11:30&arr=2026-05-17T14:30
function readUrlRoute(): RouteSpec | null {
  const p = new URLSearchParams(window.location.search);
  const from = p.get('from')?.toUpperCase();
  const to   = p.get('to')?.toUpperCase();
  if (!from || !to) return null;
  const via = (p.get('via') || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    from, to, via,
    dep: p.get('dep') || undefined,
    arr: p.get('arr') || undefined,
  };
}

// Times are written as the local wall-clock values from the form (each read
// in its airport's timezone), so a shared link reproduces the exact flight.
function updateUrl(from: string, to: string, via: string[]) {
  const p = new URLSearchParams();
  p.set('from', from);
  p.set('to',   to);
  if (via.length) p.set('via', via.join(','));
  if (inDep.value) p.set('dep', inDep.value);
  if (inArr.value) p.set('arr', inArr.value);
  history.replaceState(null, '', `${window.location.pathname}?${p}`);
}

function applyRoute(spec: RouteSpec) {
  inFrom.value = spec.from;
  inTo.value   = spec.to;
  viaList.innerHTML = '';
  for (const code of spec.via || []) addWaypointRow(code, false);
  if (spec.dep) inDep.value = spec.dep;
  if (spec.arr) inArr.value = spec.arr;
  submitRoute();
}

function renderPresets() {
  const list = document.getElementById('presets-list') as HTMLUListElement;
  list.innerHTML = '';
  for (const p of PRESETS) {
    const li = document.createElement('li');
    const v = p.via && p.via.length ? ` via ${p.via.join(', ')}` : '';
    li.textContent = `${p.from} → ${p.to}${v}`;
    li.addEventListener('click', () => applyRoute(p));
    list.appendChild(li);
  }
}

setupAirportAutocomplete(inFrom, () => inTo.focus());
setupAirportAutocomplete(inTo,   () => inDep.focus());

// Default times: today 11:30 → next-day 14:30 (interpreted in each airport's
// IANA timezone when Play is clicked). URL params can override; presets don't.
{
  const dep = new Date(); dep.setHours(11, 30, 0, 0);
  const arr = new Date(dep);
  arr.setDate(arr.getDate() + 1);
  arr.setHours(14, 30, 0, 0);
  inDep.value = toLocalIso(dep);
  inArr.value = toLocalIso(arr);
}

renderPresets();
applyRoute(readUrlRoute() || PRESETS[0]);

// ─── View toggles (keyboard) ─────────────────────────────────────────────────

const NIGHT_INTENSITY = 1.0;  // baseline emissive intensity from the night-lights map
const earthMat = earth.material as THREE.MeshStandardMaterial;

let cloudsOn = true;
let nightOn  = true;
let liveOn   = false;
let windowSide: Side | null = null;   // window-seat view: null = off
let liveLoading = false;  // a GIBS request is in flight; ignore repeat presses
let liveDateLabel = '';  // YYYY-MM-DD currently displayed when live is on

const hud = document.getElementById('info-text')!;

function refreshHud() {
  hud.innerHTML =
    `<a class="github-link" href="https://github.com/brew-your-own/3d-earth-sunflight" target="_blank" rel="noopener" aria-label="GitHub repository">` +
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">` +
    `<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>` +
    `</svg></a>` +
    `Rev: <a href="https://github.com/brew-your-own/3d-earth-sunflight/commit/${__GIT_REV__}" target="_blank" rel="noopener">${__GIT_REV__}</a><br>` +
    `<span class="hud-cmd" data-key="c">[C] clouds: <b>${cloudsOn ? 'on' : 'off'}</b></span><br>` +
    `<span class="hud-cmd" data-key="n">[N] night lights: <b>${nightOn ? 'on' : 'off'}</b></span><br>` +
    `<span class="hud-cmd" data-key="l">[L] live satellite: <b>${liveLoading ? 'loading…' : liveOn ? `on (${liveDateLabel})` : 'off'}</b></span><br>` +
    `<span class="hud-cmd" data-key="m">[M] control mode: <b>${controlMode}</b></span><br>` +
    `<span class="hud-cmd" data-key="w">[W] window view: <b>${windowSide ? windowSide.toLowerCase() : 'off'}</b></span><br>` +
    `<span class="hud-cmd" data-key="t">[T] twilight bands: <b>${twilightOn ? 'on' : 'off'}</b></span><br>` +
    `<span class="hud-cmd" data-key=" ">[Space] play/pause</span><br>` +
    `<span class="hud-cmd" data-key="g">[G] center on your location (Barcelona fallback)</span>`;
}

// Reset orbit so the camera faces Earth's (lat, lon) with the north pole
// straight up. Honors current Earth rotation (idle spin + axial tilt) by
// transforming Earth-local axes into world space. Preserves zoom distance.
function centerOn(lat: number, lon: number) {
  const q  = earth.getWorldQuaternion(new THREE.Quaternion());
  const wp = latLonToVec3(lat, lon, 1).applyQuaternion(q);
  const wy = new THREE.Vector3(0, 1, 0).applyQuaternion(q);   // north pole
  const dist = camera.position.distanceTo(controls.target);
  controls.target.set(0, 0, 0);
  camera.up.copy(wy);
  camera.position.copy(wp).multiplyScalar(dist);
  controls.update();
  invalidate();   // may run from an async geolocation callback, not user input
}

// Barcelona-El Prat airport (BCN). Used as fallback when the browser doesn't
// know the user's location (no Geolocation API, denied, or timed out).
const BCN_FALLBACK = { lat: 41.2974, lon: 2.0833 };

function goToUserLocation() {
  if (!navigator.geolocation) {
    centerOn(BCN_FALLBACK.lat, BCN_FALLBACK.lon);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => centerOn(pos.coords.latitude, pos.coords.longitude),
    ()    => centerOn(BCN_FALLBACK.lat, BCN_FALLBACK.lon),
    { timeout: 4000, maximumAge: 5 * 60 * 1000 },
  );
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
  if (on === liveOn || liveLoading) return;
  if (on) {
    // Two days back: gives the processing pipeline enough time to fill in
    // late-arriving swaths, so the global mosaic is essentially complete.
    const date = isoUtcDate(2);
    liveLoading = true;
    refreshHud();
    loader.load(
      gibsTrueColorUrl(date),
      (tex) => {
        liveLoading = false;
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
        liveLoading = false;
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

// Single dispatch table for hotkey actions, so the keyboard handler and the
// clickable HUD lines invoke the same code paths.
const hudActions: Record<string, () => void> = {
  c: () => { cloudsOn = !cloudsOn; clouds.visible = cloudsOn; refreshHud(); },
  n: () => { nightOn = !nightOn; earthMat.emissiveIntensity = nightOn ? NIGHT_INTENSITY : 0; refreshHud(); },
  l: () => { setLive(!liveOn); },
  g: () => { goToUserLocation(); },
  m: () => { controlMode = (controlMode === 'orbit') ? 'globe' : 'orbit'; applyControlMode(); refreshHud(); },
  // off → left → right → off
  w: () => { setWindowSide(windowSide === null ? 'LEFT' : windowSide === 'LEFT' ? 'RIGHT' : null); },
  t: () => {
    twilightOn = !twilightOn;
    terminator.visible = twilightOn;
    twilightLegend?.classList.toggle('hidden', !twilightOn);
    refreshHud();
  },
  ' ': () => { playBtn.click(); },
};

window.addEventListener('keydown', (e) => {
  // Leave browser/OS shortcuts alone (Cmd+C, Cmd+L, Ctrl+M…).
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Ignore typing in form fields.
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  const action = hudActions[e.key.toLowerCase()];
  if (!action) return;
  // Stop space from re-triggering a focused button (it would double-fire after a click)
  // and from scrolling the page.
  if (e.key === ' ') e.preventDefault();
  action();
});

// Click delegation: any element inside #info-text carrying data-key="<letter>"
// triggers the matching hudActions entry, mirroring the keyboard shortcut.
hud.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
  if (!el) return;
  const action = hudActions[el.dataset.key!];
  if (action) action();
});

// ─── Window-seat view wiring ─────────────────────────────────────────────────
// The overlay element defines where the inset goes (CSS layout) and draws
// the cabin-wall frame; window-view.ts renders the 3D view into its rect.

const windowEl    = document.getElementById('window-view') as HTMLDivElement;
const windowLabel = windowEl.querySelector('.window-label') as HTMLDivElement;

function setWindowSide(side: Side | null) {
  windowSide = side;
  if (side) windowLabel.textContent = `${side.toLowerCase()} window (${SEAT_LETTERS[side]}) · [W]`;
  refreshHud();
}

// Returns true while the window view is still easing toward its target.
function renderWindowView(): boolean {
  const show = windowSide !== null && flight !== null && currentSample !== null;
  windowEl.classList.toggle('visible', show);
  if (!show) return false;
  const rect = windowEl.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const cs = currentSample!;
  const moonDir = topocentricMoonDir(moonVecER(cs.utcMs), cs.pos, cs.altKm);
  return windowView.render(cs, windowSide!, rect, [currentRoute, planeMesh], moonDir);
}

// Seat advice click: jump to that sunrise/sunset (paused) and look out the
// window the sun is on. The shade line passes t = null: just switch window.
onAdvicePick((t, side) => {
  if (!flight) return;
  if (t !== null) {
    progress = t;
    playing = false;
    updatePlayBtn();
    scrubEl.value = String(Math.round(progress * 1000));
  }
  setWindowSide(side);
});

// ─── Collapsible panels ──────────────────────────────────────────────────────
// Each panel (settings / route / recap) collapses to a compact header via a
// `.collapsed` class. On a narrow screen they start collapsed, and opening one
// closes the others so they never overlap on a phone.
const PANEL_NARROW_PX = 760;
const panelEls = Array.from(document.querySelectorAll<HTMLElement>('.panel'));

for (const toggle of document.querySelectorAll<HTMLElement>('.panel-toggle')) {
  toggle.addEventListener('click', () => {
    const panel = toggle.closest('.panel') as HTMLElement;
    const expanding = panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    if (expanding && window.innerWidth < PANEL_NARROW_PX) {
      for (const p of panelEls) if (p !== panel) p.classList.add('collapsed');
    }
  });
}

if (window.innerWidth < PANEL_NARROW_PX) {
  for (const p of panelEls) p.classList.add('collapsed');
}

// ─── Resize & pixel density ──────────────────────────────────────────────────

function applyRendererSize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  invalidate();
}
window.addEventListener('resize', applyRendererSize);

// Dragging the window to a screen with a different devicePixelRatio fires no
// resize event (CSS size is unchanged). A resolution media query matching the
// *current* DPR flips when it changes; re-arm it for the new value each time.
function watchPixelRatio() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener('change', () => { applyRendererSize(); watchPixelRatio(); }, { once: true });
}
watchPixelRatio();

// ─── Render on demand ────────────────────────────────────────────────────────
// The loop still ticks every animation frame, but only renders when something
// can have changed: playback, the idle spin, camera damping, the window view
// easing, or an explicit invalidate(). With a paused flight and no input the
// GPU sits idle. Rather than sprinkling invalidate() over every handler, any
// user input on the page invalidates (handlers run before the next frame), and
// so does every finished texture load (startup maps, live satellite).

let needsRender = true;
function invalidate() { needsRender = true; }

for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'input', 'click', 'touchmove']) {
  window.addEventListener(type, invalidate, { capture: true, passive: true });
}
THREE.DefaultLoadingManager.onProgress = invalidate;
THREE.DefaultLoadingManager.onLoad = invalidate;

// ─── Animation loop ──────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  let dirty = needsRender;
  needsRender = false;

  if (flight) {
    if (playing) {
      progress = Math.min(1, progress + dt / PLAY_WALL_SECONDS);
      scrubEl.value = String(Math.round(progress * 1000));
      if (progress >= 1) { playing = false; updatePlayBtn(); }
      // Clouds drift subtly during playback for visual life (frozen when
      // paused, so a paused scene is truly static).
      clouds.rotateY(dt * 0.01);
      dirty = true;
    }
    updateFlightFrame(progress);
  } else if (controlMode === 'orbit') {
    // Idle: slow Earth spin, fixed sun from Phase 1.
    // Suspended in 'globe' mode so user drags aren't fought by the spin.
    // rotateY (local axis) — NOT rotation.y += …: with the 23.4° tilt on
    // rotation.z, the default XYZ Euler order would spin around *world* Y and
    // make the pole precess in a cone instead of spinning around itself.
    earth.rotateY(dt * 0.05);
    clouds.rotateY(dt * 0.065);
    dirty = true;
  }

  // update() returns true while the camera is still moving (incl. damping).
  if (controls.update()) dirty = true;
  if (!dirty) return;

  terminator.setSunPosition(sun.position);
  renderer.render(scene, camera);
  if (renderWindowView()) needsRender = true;
}

animate();
