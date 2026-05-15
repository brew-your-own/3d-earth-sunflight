# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive 3D Earth visualizer in the browser. Draws great-circle flight routes between two IATA airports, animates a plane along the route, and at every point computes the sun's position relative to the plane (clock direction, elevation, day/twilight/night).

## Commands

```bash
npm run dev      # Vite dev server at http://localhost:5173 (hot reload)
npm run build    # type-check + chunked production build → dist/ (separate hashed assets, suitable for web hosting)
npm run package  # type-check + single-file build → dist/index.html (one ~5 MB self-contained file, double-clickable)
npm run preview  # serve the dist/ build locally

# One-off: rebuild src/airports.json from airports/airports.csv.
# Adds an IANA `tz` field per airport via tz-lookup. Re-run only if the CSV changes.
node scripts/build-airports.mjs
```

## Stack

- **Vite 6** — bundler/dev server (no config file)
- **Three.js 0.175** with `@types/three`
- **luxon** — IANA timezone math for local↔UTC conversion at runtime
- **tz-lookup** (dev only) — lat/lon → IANA tz at build time
- All application code lives in `src/main.ts`; entry point is `index.html`

## Layout of `src/main.ts`

Single-file scene, organized top-to-bottom roughly in lifecycle order:

1. **Renderer** — `WebGLRenderer` with ACES filmic tone mapping; exposure driven by the contrast slider
2. **Scene + Camera + Controls** — `OrbitControls` with damping, no pan, clamped zoom
3. **Lights** — single directional "sun" + dim ambient; both controlled by the contrast slider, and the sun is repositioned to the real subsolar point during flight playback
4. **Textures** — `loadColor` (sRGB) vs `loadData` (linear) helpers
5. **Starfield + Earth (tilted 23.4° on Z) + Clouds**
6. **Lat/lon helpers + great-circle drawing** (`latLonToVec3`, `greatCirclePoints` via slerp with antipodal fallback)
7. **Airports + routing** — fetched from `/airports.json`; `setRoute(from, to)` swaps the visible great circle
8. **Subsolar point** — NOAA-derived (mean longitude + ecliptic correction + GMST); ~0.01° accuracy
9. **Flight state + playback** — `setFlight(from, to, depLocal, arrLocal)`; cached slerp params, plane mesh, `progress ∈ [0, 1]`
10. **Recap table** — offline 2000-sample scan that records DAY/TWILIGHT/NIGHT transitions and LEFT/RIGHT sun-side changes (during DAY); rendered bottom-right with timestamps in the departure airport's IANA TZ
11. **Form wiring, HUD, contrast slider, keyboard toggles**
12. **Animation loop** — flight playback when a flight is loaded, idle slow spin otherwise

## Key conventions

- **Lat/lon → 3D**: `latLonToVec3` puts `(lat 0, lon 0)` at `+X`, north pole at `+Y`, `lon +90°` at **`-Z`**. The negative Z is deliberate: Three's `SphereGeometry` UVs trace -X→+Z→+X→-Z→-X as `u` goes 0→1, so for an equirectangular texture (u: -180→+180) longitude increases clockwise around +Y.
- **Earth-local frame for routes**: great-circle line, endpoint markers, and the plane mesh are all parented to the Earth mesh — they inherit the axial tilt and any rotation, staying glued to the surface.
- **Sun positioning during a flight**: subsolar point is computed in Earth's *local* frame, then transformed to world via `earth.getWorldQuaternion(...)`. The directional light goes along that direction × 50.
- **Color spaces matter**: textures used for color (`map`, `emissiveMap`, sky) need `colorSpace = SRGBColorSpace`; data textures (`normalMap`, `alphaMap`) stay linear (the loader helpers enforce this).
- **`OrbitControls` requires `controls.update()` each frame** when `enableDamping = true`.
- **Day/twilight/night thresholds**: solar elevation ≥ 0° = DAY, (-6°, 0°) = TWILIGHT (civil), < -6° = NIGHT.

## Data files

- `airports/airports.csv` — OurAirports public-domain dump (~13 MB), source of truth.
- `src/airports.json` — slim per-IATA JSON built from the CSV (~9k entries, ~1.2 MB), `tz` filled at build time. **Imported** into `main.ts` (not fetched at runtime) so the bundler can inline it for the singlefile build.
- `src/textures/` — Solar System Scope Earth textures (2K) + Milky Way starfield. Also imported (not in `public/`) so Vite can hash-and-emit (normal build) or base64-inline (singlefile build).

No `public/` folder is used: keeping assets out of `public/` is what enables the singlefile packaging to work.

## Things future me will trip on

- **Don't reintroduce shadows or a `PlaneGeometry` floor** — those are remnants of the original cube/sphere/torus demo. The Earth scene has no floor and no shadow-casting.
- **Texture caveat**: if a new Earth texture comes in as TIFF, convert it (`sips -s format png ... --out ...` on macOS). Browsers can't decode TIFF.
- **Bundle warning** in the normal build (~1.7 MB) is dominated by `airports.json` being imported into the JS rather than fetched separately. Acceptable; can be split later if it matters.
- **Singlefile output is ~5 MB** of HTML (textures and JSON inlined as base64). Friend can double-click `dist/index.html`; no server, no network needed (except for Live satellite, `L`).

## TODO

### Stage 2 — real cloud forecasts for upcoming flights
The current Live-satellite toggle (`L`) shows recent *observed* clouds; it does not answer "what clouds will my flight fly through". The real feature uses a numerical weather model:

- Build-time / scheduled script fetches the latest **NOAA GFS** run from NOMADS (`nomads.ncep.noaa.gov`), or **ECMWF Open Data**, for the `Total Cloud Cover %` parameter at the forecast hour matching the flight's UTC midpoint.
- Convert GRIB2 → equirectangular PNG (`wgrib2` + ImageMagick, or a pure-JS lib like `@thi.ng/grib`). Save as `public/textures/clouds-{YYYYMMDD-HH}.png`.
- App picks the file matching the flight time, uses it as the cloud overlay's `alphaMap` (keeps the clean Solar System Scope base map underneath).
- Stretch: blend two adjacent forecast frames as the plane animates → weather visibly evolves along the flight.
- Fall back to Stage 1 (GIBS imagery) when the requested time is outside the forecast horizon (~10 days).

### Live-satellite freshness improvements (Stage 1 follow-ups)
Live mode currently uses GIBS `best/` endpoint, VIIRS SNPP, 2 days back UTC (chosen to avoid swath gaps). Options to push fresher / fill gaps:

- **NRT endpoint**: swap `best/` → `nrt/` in the WMS URL for ~3-6 h latency (lower-quality calibration, occasionally noisier-looking).
- **Multi-day composite**: fetch yesterday + 2 days back on a `<canvas>`, combine taking the freshest valid pixel per location.
- **Terra + Aqua composite**: fetch both MODIS layers (different overpass times), max-compose to eliminate residual swath seams.
- **Geostationary mosaic** (GOES + Himawari + Meteosat) for true near-real-time global imagery; requires per-source projection warping and is significantly more work.
