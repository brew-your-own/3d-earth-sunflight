# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive 3D Earth visualizer in the browser. Draws great-circle flight routes between two IATA airports, animates a plane along the route, and at every point computes the sun's position relative to the plane (clock direction, elevation, day/twilight/night).

## Commands

```bash
npm run dev      # Vite dev server at :5173 (hot reload); binds --host for LAN/phone testing
npm run build    # type-check + chunked production build → dist/ (separate hashed assets, suitable for web hosting)
npm run package  # type-check + single-file build → dist/index.html (one ~5 MB self-contained file, double-clickable)
npm run preview  # serve the dist/ build locally
npm test         # vitest unit tests for the pure modules (also gates the Pages deploy)
npm run typecheck

# One-off: rebuild src/airports.json from airports/airports.csv.
# Adds an IANA `tz` field per airport via tz-lookup and a search `rank`
# (size tier ×2 + scheduled service). Drops heliports/seaplane bases/closed.
# Re-run only if the CSV changes.
node scripts/build-airports.mjs
```

## Stack

- **Vite 6** — bundler/dev server; config in `vite.config.ts` (build modes, `__GIT_REV__` / `__GIT_DESCRIBE__` defines, dev `server.allowedHosts` for `*.home.arpa`)
- **Three.js 0.175** with `@types/three`
- **luxon** — IANA timezone math for local↔UTC conversion at runtime
- **tz-lookup** (dev only) — lat/lon → IANA tz at build time
- **vitest** — unit tests (`src/*.test.ts`), run in Node; pure modules only
- Entry point is `index.html` → `src/main.ts`

## Source layout

Pure modules (no DOM, no scene state — import freely from tests):

- `src/geo.ts` — `latLonToVec3` / `vec3ToLatLon`, `EARTH_RADIUS_KM`, great-circle `Arc` (`makeArc`, `arcPoint`, `arcHeading`: p1 + unit tangent, robust for coincident/antipodal points), `greatCirclePoints`
- `src/astro.ts` — `subsolarPoint` (NOAA-derived, ~0.01°), cruise-altitude thresholds, `daylightLabel`
- `src/flight.ts` — `buildFlight` (local times → UTC via each airport's tz, segments split by arc length, zero-length legs dropped), `planeAt`, `flightSampleAt` (sun right/forward/up components, elevation, phase, side — the single source of truth for both HUD and recap), `computeRecap` (2000-sample scan → rows + stats)
- `src/airports.ts` — `Airport` type, the imported `airports` record, `searchAirports` (tiered match + rank tiebreak, lowercased index built lazily), `resolveAirportCode`
- `src/aurora.ts` — geomagnetic latitude, aurora visibility tiers, `auroraWindows` (see the Aurora section)
- `src/seat.ts` — `seatAdvice`: sunrise/sunset events (from recap rows) with window side + relative bearing, hours of direct sun per side (DAY and |sR| ≥ 0.25), shade recommendation; `SEAT_LETTERS` (A left, F/K right)
- `src/moon.ts` — Moon position (Meeus ch. 47 truncated: 27 λ/r + 20 β terms + A1–A3; ≈0.01° vs Meeus ex. 47.a, no nutation), `sublunarPoint`/`moonVecER` (Earth radii, scene frame), `topocentricMoonDir` (parallax up to ~0.95°, matters for horizon tests and drawing), `moonPhase` (illuminated fraction via phase angle, waxing, age), `moonSummary` (hours up while not DAY, side split, rise/set events en route; visible horizon = `sunriseElevDeg(altKm)`). `src/moon-advice.ts` turns it into seat-advice rows. Sun/time helpers it uses (`sunEclipticLongitudeDeg`, `gmstDeg`, `obliquityDeg`) are exported from `astro.ts`.
- `src/time-ref.ts` — recap time reference (`TimeRef`: dep / arr / UTC / plane-local): `zoneAt` (local = tz of `nearestAirport` under the plane, rank ≥ 5), `formatAt`, `formatRange` (adds the weekday when a range crosses midnight)
- `src/time.ts` — `parseDuration`, `formatDuration`, dep+duration ↔ arrival across timezones, `formatTzInfo`

DOM / scene modules:

- `src/recap-panel.ts` — time-reference toggle (persisted in localStorage `recap-time-ref`, all times go through `time-ref.ts`), seat advice (clickable → `onAdvicePick`), recap table, time breakdown, plane/sun SVG, timeline strip under the scrubber
- `src/window-view.ts` — window-seat / cockpit camera (`[W]`: off → left → right → cockpit; `ViewSeat = Side | 'COCKPIT'`; cockpit = over the nose, 70° FOV, −4° pitch, no leaning, wide 16:9 windscreen inset styled by `#window-view.cockpit`), rendered into the `#window-view` overlay's rect with scissor after the main render
- `src/globe-visuals.ts` — atmosphere rim shell (`createAtmosphere`, layer 3, additive, sun-following), ocean glint (`buildOceanRoughness`: roughness map derived from the day map via `isOceanPixel`, built in the day map's onLoad), `patchNightLights` (`onBeforeCompile` fades the emissive night map by geometric N·L of directional light 0, so city lights vanish on the day side), Line2 route lines (`createRouteLineMaterial` — one shared material, `resolution` updated in `applyRendererSize`; `clearRoute` must not dispose it)
- `src/plane-model.ts` — the airliner on the globe: `src/models/airplane.glb` (CC-BY, see CREDITS.md; nose +Z, up +Y, +X = left wing; no normals in the file → computed flat at load), normalised to length 1, cone placeholder until loaded, red/green wingtip nav lights. `place(pos, heading, r)` orients it from heading + radial up; `fitToScreen` (called every rendered frame) keeps it `PLANE_SCREEN_PX` long on screen
- `src/terminator.ts` — day/night terminator + twilight band overlay (`[T]` toggle, legend in the settings panel): shell at 1.002 R parented to the Earth, shader lines at ground-standard sunrise (−0.833°), civil (−6°), nautical (−12°), astronomical (−18°) with faint zone fills; sun direction fed from `sun.position` every rendered frame
- `src/main.ts` — renderer, camera/controls (orbit + globe drag), lights, textures, Earth/clouds/stars, route drawing (`setRoute`), flight state + playback (`setFlight`, `updateFlightFrame`), form/autocomplete/presets/URL wiring, HUD + hotkeys, live satellite, collapsible panels, animation loop

## Key conventions

- **Lat/lon → 3D**: `latLonToVec3` puts `(lat 0, lon 0)` at `+X`, north pole at `+Y`, `lon +90°` at **`-Z`**. The negative Z is deliberate: Three's `SphereGeometry` UVs trace -X→+Z→+X→-Z→-X as `u` goes 0→1, so for an equirectangular texture (u: -180→+180) longitude increases clockwise around +Y.
- **Earth-local frame for routes**: great-circle line, endpoint markers, and the plane mesh are all parented to the Earth mesh — they inherit the axial tilt and any rotation, staying glued to the surface.
- **Sun positioning during a flight**: subsolar point is computed in Earth's *local* frame, then transformed to world via `earth.getWorldQuaternion(...)`. The directional light goes along that direction × 50. The light is re-aimed every frame (a globe-mode drag rotates the Earth even when paused), but `updateFlightFrame` skips the sample math and DOM writes when `t` hasn't changed — reset `lastFrameT = NaN` whenever the flight changes.
- **Color spaces matter**: textures used for color (`map`, `emissiveMap`, sky) need `colorSpace = SRGBColorSpace`; data textures (`normalMap`, `alphaMap`) stay linear (the loader helpers enforce this).
- **`OrbitControls` requires `controls.update()` each frame** when `enableDamping = true`.
- **Render on demand**: the rAF loop always ticks but only renders when playing, idle-spinning, `controls.update()` returns true (camera/damping moving), the window view is still easing, or `invalidate()` was called. Any user input event and every texture load (`DefaultLoadingManager`) invalidates automatically; **call `invalidate()` yourself for changes from async non-input sources** (e.g. the geolocation callback in `centerOn`). Clouds only drift while playing or idle, so a paused scene is static (0 draw calls).
- **Pixel density changes** (window moved to another screen) are caught with a re-armed `matchMedia('(resolution: Ndppx)')` listener → `applyRendererSize()`.
- **Day/twilight/night thresholds depend on the plane's altitude**: `sunriseElevDeg(altKm)` = −(horizon dip + 0.833°) — −0.833° on the ground, ≈ −4.2° at the 11 km cruise (`SUNRISE_ELEV_DEG`). DAY above, TWILIGHT for the next 6° (civil), NIGHT below. Altitude comes from a trapezoid profile (`altitudeKm`: 20-min climb, 30-min descent) and is carried on every `FlightSample` (`altKm`), so a sun that set before take-off stays set. Use `sample.phase`, not the cruise constants, for anything per-moment.
- **Sun side has hysteresis** in the recap/stats (`sideAfter`, `SIDE_DEADBAND` = 0.05): it only flips once |sR| clears the dead band, so a sun grazing the nose/tail axis doesn't spam side rows. `FlightSample.side` itself is the raw sign (HUD).
- **Earth spin must use `rotateY()`** (local axis), never `rotation.y +=` — with the tilt on `rotation.z`, the default XYZ Euler order would spin around world Y and make the pole precess.
- **Recap transitions are bisected** (`refineTransition`) after the 2000-sample scan, so sunrise/sunset/side-change times are exact to < 1 s.
- **Render layers**: 0 = everything shared; 1 = window-view sky dome (window camera only); 2 = terminator/twilight overlay (main camera only — `camera.layers.enable(TERMINATOR_LAYER)`); 3 = atmosphere rim (main camera only, `ATMOSPHERE_LAYER` — the window camera sits inside that shell). The window camera enables 0 + 1, so main-view-only overlays go on a layer ≥ 2. Transparent draw order: terminator `renderOrder -0.5` < clouds `0` < atmosphere `1`, so clouds blend over the bands.
- **Window view tricks** (all in `window-view.ts`): the sky dome is on layer 1 (main camera never sees it), `renderOrder = -1` so it draws before the transparent clouds, depth-tested so the Earth occludes it — the horizon dip and the sun sinking behind the curve come from real geometry. `scene.fog` always exists but sits at 1e6 except during the window render (avoids shader recompiles); the starfield has `fog: false`. The window camera's height follows `sample.altKm` (min 100 m) with a near plane scaled to it. During the window render the route group and plane cone are hidden (they float at 1.02 R ≈ 127 km) and the cloud shell is shrunk to ~6 km so it's below the plane. The camera "leans" toward the sun up to ±55° from straight-out; a sun closer to the nose/tail is genuinely out of view (advice says "oblique"). The sun disc is drawn ~1.2° radius (4× real) to be visible in the inset. The Moon (topocentric dir passed as the optional last arg of `render()`) is drawn at 1.0° radius with its phase from lighting a reconstructed sphere normal by the sun direction, plus faint earthshine; at night the view leans toward the aurora if it's out this window, else toward the Moon, else straight out.
- **Timeline strip** under the scrubber is built from the recap rows (`renderTimeline` in `recap-panel.ts`): top band = phase, bottom band = sun side during DAY (blue left / orange right, matching the recap stats).
- **Three collapsible UI panels** — settings (top-left), route (bottom-left, with presets merged in), recap (top-right). Layout/CSS lives in `index.html`: each is a `.panel` whose body hides under a `.collapsed` class, toggled by one `.panel-toggle` button. The wiring in `main.ts` is tiny — click toggles `.collapsed`; on viewports < 760px panels start collapsed and opening one collapses the others. Same markup at every screen size (no separate mobile codepath); widths use `min(…, 100vw - 24px)` to cap on a phone.

## Aurora (`src/aurora.ts`)

- Centred-dipole geomagnetic latitude, pole at 80.8°N 72.8°W (IGRF-14, 2025.0; `GEOMAG_NORTH_POLE`).
- Tiers on |magLat| during NIGHT only: `likely` ≥ 62°, `possible` ≥ 55° (oval edge ~63° quiet / ~59° at Kp 4–5, plus ~4° extra reach from 11 km). Above 74° (polar cap) the glow is on the *equatorward* side. No live Kp (offline build) — advice is hedged.
- `auroraAt(sample)` → tier, strength, side (window facing the aurora), horizontal direction; `auroraWindows(f)` merges NIGHT stretches (gaps < 10 min bridged), `tPeak` = closest approach to the 67° oval centre.
- Seat advice adds one clickable `🌌` line per window (`auroraAdviceLines` in recap-panel.ts) → jumps to `tPeak` and opens that window. The window-view sky shader has a separate "Aurora block" (`uAuroraDir`, `uAuroraStrength`, `uTime`); while aurora strength > 0 the rays drift, so `render()` reports "still animating" and the loop keeps drawing (only while the window view shows aurora).

## Data files

- `airports/airports.csv` — OurAirports public-domain dump (~13 MB), source of truth.
- `src/airports.json` — slim per-IATA JSON built from the CSV (~8.8k entries, ~1.2 MB), `tz` and `rank` filled at build time. **Imported** into `airports.ts` (not fetched at runtime) so the bundler can inline it for the singlefile build.
- `src/models/airplane.glb` — 15 KB airliner (imported with `?url`, so it's hashed in the normal build and inlined in the singlefile one).
- `src/textures/` — Solar System Scope Earth textures (2K) + Milky Way starfield. Also imported (not in `public/`) so Vite can hash-and-emit (normal build) or base64-inline (singlefile build).

No `public/` folder is used: keeping assets out of `public/` is what enables the singlefile packaging to work.

## Things future me will trip on

- **Don't reintroduce shadows or a `PlaneGeometry` floor** — those are remnants of the original cube/sphere/torus demo. The Earth scene has no floor and no shadow-casting.
- **Texture caveat**: if a new Earth texture comes in as TIFF, convert it (`sips -s format png ... --out ...` on macOS). Browsers can't decode TIFF.
- **Bundle warning** in the normal build (~1.7 MB) is dominated by `airports.json` being imported into the JS rather than fetched separately. Acceptable; can be split later if it matters.
- **Singlefile output is ~5 MB** of HTML (textures and JSON inlined as base64). Friend can double-click `dist/index.html`; no server, no network needed (except for Live satellite, `L`).
