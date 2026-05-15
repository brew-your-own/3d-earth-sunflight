// One-off build step: airports/airports.csv (OurAirports dump) → public/airports.json
// Run with: node scripts/build-airports.mjs
import fs from 'node:fs';
import path from 'node:path';
import tzlookup from 'tz-lookup';

const INPUT  = 'airports/airports.csv';
const OUTPUT = 'public/airports.json';

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

const result = {};
for (const line of lines) {
  const f = parseCsvLine(line);
  const iata = f[I_IATA];
  if (!iata || iata.length !== 3) continue;
  if (f[I_TYPE] === 'closed') continue;
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
  };
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(result));
console.log(
  `Wrote ${Object.keys(result).length} airports → ${OUTPUT} ` +
  `(${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB)`
);
