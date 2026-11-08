# Credits

## Inspiration

- [sunflight.org](https://sunflight.org) — picking the right side of the plane
  to sit on for sunrise / sunset views. The site went dark recently, which is
  what triggered this project.
- [flightside.app](https://flightside.app) — same idea, beautifully presented.

## Data sources

### Airport database
- **OurAirports** — <https://ourairports.com/data/>
  Public-domain CSV dump of the world's airports. Used at build time to
  generate `src/airports.json` (filtered to ~9 000 entries with a 3-letter
  IATA code).

### Timezone lookup (build time only)
- **tz-lookup** by Dan Iverson — <https://github.com/darkskyapp/tz-lookup>
  (CC0-1.0). Resolves each airport's lat / lon to an IANA timezone so the UI
  can interpret local departure / arrival times.
- The underlying **IANA tz database** is public domain.

### Live cloud overlay (runtime, optional)
- **NASA GIBS** (Global Imagery Browse Services) — <https://nasa-gibs.github.io/gibs-api-docs/>
  VIIRS SNPP `CorrectedReflectance_TrueColor` WMS layer. NASA imagery is in
  the public domain (see <https://www.earthdata.nasa.gov/engage/open-data-services-software-policies>).

## Textures

- **Solar System Scope** — <https://www.solarsystemscope.com/textures/>
  2K Earth (day, night, clouds, normal map) and Milky Way starfield.
  Licensed under **Creative Commons Attribution 4.0** (CC BY 4.0).
  Author: INOVE.

## 3D model

- **Airplane** by Poly by Google — <https://poly.pizza/m/fzIXe2paBN9>
  (via Poly Pizza). Licensed under **Creative Commons Attribution 3.0**
  (CC BY 3.0, <https://creativecommons.org/licenses/by/3.0/>).
  Used as `src/models/airplane.glb`; normals computed at load time, unmodified otherwise.

## Software dependencies

- **Three.js** (MIT) — <https://threejs.org>
- **Vite** (MIT) — <https://vitejs.dev>
- **luxon** (MIT) — <https://moment.github.io/luxon/>
- **vite-plugin-singlefile** (MIT)
- **TypeScript** (Apache-2.0)

All transitive licenses are MIT, Apache-2.0, BSD or CC0 — compatible with
this project's Apache-2.0 license.
