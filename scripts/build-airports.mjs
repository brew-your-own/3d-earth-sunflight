// One-off build step: airports/airports.csv (OurAirports dump) → src/airports.json
// Run with: node scripts/build-airports.mjs
import fs from 'node:fs';
import path from 'node:path';
import tzlookup from 'tz-lookup';

const INPUT  = 'airports/airports.csv';
const OUTPUT = 'src/airports.json';

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped "" → literal "
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === ',') { fields.push(cur); cur = ''; }
      else if (c === '"') inQuotes = true;
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

const raw = fs.readFileSync(INPUT, 'utf-8');
const [headerLine, ...lines] = raw.split('\n').filter((l) => l.length > 0);
const header = parseCsvLine(headerLine);

const idx = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column not found: ${name}`);
  return i;
};
const I_IATA    = idx('iata_code');
const I_NAME    = idx('name');
const I_LAT     = idx('latitude_deg');
const I_LON     = idx('longitude_deg');
const I_COUNTRY = idx('iso_country');
const I_CITY    = idx('municipality');
const I_TYPE    = idx('type');
const I_SCHED   = idx('scheduled_service');

// Search tiebreaker: size tier ×2, +1 for scheduled passenger service.
// Heliports, seaplane bases, balloonports and closed fields are dropped —
// nobody flies a long-haul route to them.
const SIZE = { large_airport: 3, medium_airport: 2, small_airport: 1 };

const result = {};
for (const line of lines) {
  const f = parseCsvLine(line);
  const iata = f[I_IATA];
  if (!iata || iata.length !== 3) continue;
  const size = SIZE[f[I_TYPE]];
  if (!size) continue;
  const lat = Number(f[I_LAT]);
  const lon = Number(f[I_LON]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  let tz;
  try { tz = tzlookup(lat, lon); } catch { continue; }
  result[iata] = {
    name: f[I_NAME],
    lat,
    lon,
    country: f[I_COUNTRY],
    city: f[I_CITY],
    tz,
    rank: size * 2 + (f[I_SCHED] === 'yes' ? 1 : 0),
  };
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(result));
console.log(
  `Wrote ${Object.keys(result).length} airports → ${OUTPUT} ` +
  `(${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB)`
);
