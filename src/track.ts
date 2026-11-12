// Real flight tracks: KML / KMZ / GPX → a clean, time-stamped point list.
// Pure — no DOM (a regex scanner instead of DOMParser) so it runs under the
// Node test runner too. buildTrackFlight (flight.ts) turns the result into a
// Flight.
//
// The formats seen in the wild vary a lot in where the *time* lives:
//   • gx:Track (FlightAware, Google): parallel <when> / <gx:coord> lists.
//   • Timed placemarks (Flightradar24): one <Placemark> per fix, each with a
//     <TimeStamp><when> and a <Point>.
//   • Untimed LineString + sparse timed placemarks (NCAR/EOL live feeds): the
//     line has the geometry, the placemarks the clock — some only as "HH:MM"
//     in their name or description, with no date. Those are dated from the
//     full timestamps present, matched to the line in order, and the line's
//     vertices are timed by distance between matches. Placemarks too far from
//     the line (the feed's line often has coverage gaps) become track points.
//   • GPX: <trkpt lat lon><ele/><time/></trkpt>.
import * as THREE from 'three';
import { DateTime } from 'luxon';
import { EARTH_RADIUS_KM, arcPoint, latLonToVec3, makeArc } from './geo';

export type TrackPoint = { utcMs: number; lat: number; lon: number; altM: number | null };
export type ParsedTrack = { name: string; points: TrackPoint[]; notes: string[] };

export class TrackError extends Error {}

const FT = 0.3048;

// ─── File entry point ────────────────────────────────────────────────────────

export async function readTrackFile(fileName: string, bytes: Uint8Array): Promise<ParsedTrack> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;   // "PK"
  let text: string;
  if (isZip) {
    const kml = await unzipFirst(bytes, (n) => /\.kml$/i.test(n));
    if (!kml) throw new TrackError('No .kml file inside this archive.');
    text = new TextDecoder().decode(kml);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const base = fileName.replace(/\.[^.]+$/, '');
  if (/<gpx[\s>]/i.test(text)) return parseGpx(text, base);
  if (/<kml[\s>]/i.test(text)) return parseKml(text, base);
  throw new TrackError('Not a KML, KMZ or GPX file.');
}

// ─── Minimal ZIP reader (KMZ) ────────────────────────────────────────────────
// Walks the central directory and inflates the first matching entry with the
// platform's DecompressionStream (browsers and Node ≥ 18).

async function unzipFirst(buf: Uint8Array, want: (name: string) => boolean): Promise<Uint8Array | null> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new TrackError('Corrupt KMZ (no zip directory).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const dataOff = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    const data = buf.slice(dataOff, dataOff + compSize);
    if (method === 0) return data;
    if (method !== 8) throw new TrackError(`Unsupported zip compression (method ${method}).`);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return null;
}

// ─── Tiny XML helpers ────────────────────────────────────────────────────────
// Tags may carry a namespace prefix (kml:Placemark, gx:coord).

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>)`, 'g');
  return Array.from(xml.matchAll(re), (m) => m[1] ?? '');
}
function first(xml: string, tag: string): string | null {
  const b = blocks(xml, tag);
  return b.length ? b[0] : null;
}
function text(s: string | null): string {
  if (s == null) return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function parseIsoUtc(s: string): number | null {
  const d = DateTime.fromISO(s.trim(), { zone: 'utc' });   // no offset → UTC
  return d.isValid ? d.toMillis() : null;
}

type RawCoord = { lat: number; lon: number; alt: number | null };

// KML coordinate tuples: "lon,lat[,alt]" separated by whitespace.
function parseCoordList(s: string): RawCoord[] {
  const out: RawCoord[] = [];
  for (const tup of s.trim().split(/\s+/)) {
    const [lon, lat, alt] = tup.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ lat, lon, alt: Number.isFinite(alt) ? alt : null });
    }
  }
  return out;
}

// ─── KML ─────────────────────────────────────────────────────────────────────

type Anchor = RawCoord & { utcMs: number | null; secOfDay: number | null };

const CLOCK_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/;

export function parseKml(xml: string, fallbackName = 'Track'): ParsedTrack {
  const notes: string[] = [];
  const placemarks = blocks(xml, 'Placemark');
  const name = text(first(xml, 'name')) || fallbackName;

  if (placemarks.length === 0) {
    const link = first(xml, 'NetworkLink');
    if (link) {
      const href = text(first(link, 'href'));
      throw new TrackError(
        `This KML only links to a live feed${href ? ` (${href})` : ''} — download that file and load it instead.`);
    }
    throw new TrackError('No placemarks found in this KML.');
  }

  const gxTrack: RawCoord[] = [];
  const gxTimes: number[] = [];
  const line: RawCoord[] = [];
  const anchors: Anchor[] = [];
  let sawFeetLabel = false;

  for (const pm of placemarks) {
    const desc = text(first(pm, 'description'));
    if (/\b(feet|ft)\b/i.test(desc)) sawFeetLabel = true;

    for (const trk of blocks(pm, 'Track')) {
      const whens = blocks(trk, 'when').map((w) => parseIsoUtc(text(w)));
      const coords = blocks(trk, 'coord').map((c) => {
        const [lon, lat, alt] = text(c).split(/\s+/).map(Number);
        return { lat, lon, alt: Number.isFinite(alt) ? alt : null };
      });
      for (let i = 0; i < Math.min(whens.length, coords.length); i++) {
        const t = whens[i], c = coords[i];
        if (t != null && Number.isFinite(c.lat) && Number.isFinite(c.lon)) { gxTimes.push(t); gxTrack.push(c); }
      }
    }

    for (const ls of blocks(pm, 'LineString')) {
      for (const c of parseCoordList(text(first(ls, 'coordinates')))) {
        const last = line[line.length - 1];
        if (last && last.lat === c.lat && last.lon === c.lon && last.alt === c.alt) continue;
        line.push(c);
      }
    }

    const pt = first(pm, 'Point');
    if (pt != null) {
      const c = parseCoordList(text(first(pt, 'coordinates')))[0];
      if (!c) continue;
      const when = first(pm, 'when');
      const utcMs = when != null ? parseIsoUtc(text(when)) : null;
      let secOfDay: number | null = null;
      if (utcMs == null) {
        const m = CLOCK_RE.exec(text(first(pm, 'name'))) ?? CLOCK_RE.exec(desc);
        if (m) secOfDay = +m[1] * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0);
      }
      if (utcMs != null || secOfDay != null) anchors.push({ ...c, utcMs, secOfDay });
    }
  }

  // Altitude units: KML says metres, but some feeds write feet. Trust an
  // explicit "feet"/"ft" label, else anything above 16 km (52,000 ft) is too
  // high for an airliner in metres.
  const allAlts = [...gxTrack, ...line, ...anchors].map((c) => c.alt ?? 0);
  const maxAlt = allAlts.reduce((a, b) => Math.max(a, b), 0);
  const feet = sawFeetLabel || maxAlt > 16000;
  if (feet) notes.push('altitudes read as feet');
  const toM = (a: number | null) => (a == null ? null : feet ? a * FT : a);
  const pt = (c: RawCoord, utcMs: number): TrackPoint => ({ utcMs, lat: c.lat, lon: c.lon, altM: toM(c.alt) });

  let points: TrackPoint[];
  if (gxTrack.length >= 2) {
    points = gxTrack.map((c, i) => pt(c, gxTimes[i]));
  } else {
    const timed = dateAnchors(anchors, notes);
    if (line.length >= 2 && timed.length >= 2) {
      points = timeLine(line, timed, notes).map((p) => ({ ...p, altM: toM(p.altM) }));
    } else if (timed.length >= 2) {
      points = timed.map((a) => pt(a, a.utcMs));
    } else {
      throw new TrackError(line.length >= 2
        ? 'This KML has a track line but no timestamps to place it in time.'
        : 'No time-stamped track found in this KML.');
    }
  }
  return { name, points: sortDedupe(points), notes };
}

// Give "HH:MM[:SS]"-only anchors a date: the day that puts them inside (or
// closest to) the span of the fully-dated ones, within 12 h. Clock-only times
// are taken as UTC, as live feeds label them.
function dateAnchors(anchors: Anchor[], notes: string[]): Array<RawCoord & { utcMs: number }> {
  const dated = anchors.filter((a) => a.utcMs != null).map((a) => a.utcMs!);
  const out: Array<RawCoord & { utcMs: number }> = [];
  for (const a of anchors) if (a.utcMs != null) out.push({ ...a, utcMs: a.utcMs });
  const clockOnly = anchors.filter((a) => a.utcMs == null);
  if (clockOnly.length === 0) return out;
  if (dated.length === 0) {
    notes.push(`${clockOnly.length} time labels ignored (no date anywhere in the file)`);
    return out;
  }
  const lo = Math.min(...dated), hi = Math.max(...dated);
  const day0 = DateTime.fromMillis(lo, { zone: 'utc' }).startOf('day').toMillis();
  const dayN = DateTime.fromMillis(hi, { zone: 'utc' }).startOf('day').toMillis();
  let used = 0;
  for (const a of clockOnly) {
    let best: number | null = null, bestGap = Infinity;
    for (let d = day0 - 86_400_000; d <= dayN + 86_400_000; d += 86_400_000) {
      const t = d + a.secOfDay! * 1000;
      const gap = t < lo ? lo - t : t > hi ? t - hi : 0;
      if (gap < bestGap) { bestGap = gap; best = t; }
    }
    if (best != null && bestGap <= 12 * 3_600_000) { out.push({ ...a, utcMs: best }); used++; }
  }
  if (used) notes.push(`${used} clock-only time labels dated from the file's timestamps (as UTC)`);
  return out;
}

// Match timed anchors (sorted by time) to the untimed line, monotonically in
// line order, minimising total distance (DP, O(anchors × vertices)). Vertices
// between two matched anchors get times by distance along the line; anchors
// that sit far from the line (coverage gaps) are kept as points of their own.
const MATCH_KM = 5;
const MATCH_CAP_KM = 25;   // outliers don't get to drag the alignment around

function timeLine(
  line: RawCoord[], anchorsIn: Array<RawCoord & { utcMs: number }>, notes: string[],
): TrackPoint[] {
  const anchors = anchorsIn.slice().sort((a, b) => a.utcMs - b.utcMs)
    .filter((a, i, arr) => i === 0 || a.utcMs !== arr[i - 1].utcMs);
  const V = line.map((c) => latLonToVec3(c.lat, c.lon, 1));
  const A = anchors.map((c) => latLonToVec3(c.lat, c.lon, 1));
  const km = (a: THREE.Vector3, b: THREE.Vector3) =>
    Math.atan2(new THREE.Vector3().crossVectors(a, b).length(), a.dot(b)) * EARTH_RADIUS_KM;

  const n = A.length, m = V.length;
  const from = new Int32Array(n * m);         // back-pointers: best j' ≤ j for row i-1
  let prev = new Float64Array(m);
  let cur = new Float64Array(m);
  for (let j = 0; j < m; j++) prev[j] = Math.min(km(A[0], V[j]), MATCH_CAP_KM);
  for (let i = 1; i < n; i++) {
    let bestJ = 0, best = Infinity;
    for (let j = 0; j < m; j++) {
      if (prev[j] < best) { best = prev[j]; bestJ = j; }
      cur[j] = best + Math.min(km(A[i], V[j]), MATCH_CAP_KM);
      from[i * m + j] = bestJ;
    }
    [prev, cur] = [cur, prev];
  }
  const idx = new Int32Array(n);
  let j = 0;
  for (let k = 1; k < m; k++) if (prev[k] < prev[j]) j = k;
  for (let i = n - 1; i >= 0; i--) { idx[i] = j; if (i > 0) j = from[i * m + j]; }

  const matched: number[] = [];   // anchor indices
  const loose: TrackPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (km(A[i], V[idx[i]]) <= MATCH_KM) matched.push(i);
    else loose.push({ utcMs: anchors[i].utcMs, lat: anchors[i].lat, lon: anchors[i].lon, altM: anchors[i].alt });
  }
  if (matched.length < 2) throw new TrackError('Could not line up the timestamps with the track line.');

  // Cumulative distance along the line.
  const cum = new Float64Array(m);
  for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + km(V[k - 1], V[k]);

  const out: TrackPoint[] = [];
  const vtx = (k: number, utcMs: number): TrackPoint =>
    ({ utcMs, lat: line[k].lat, lon: line[k].lon, altM: line[k].alt });
  for (let q = 0; q < matched.length - 1; q++) {
    const a = matched[q], b = matched[q + 1];
    const ja = idx[a], jb = idx[b];
    const ta = anchors[a].utcMs, tb = anchors[b].utcMs;
    out.push(vtx(ja, ta));
    const span = cum[jb] - cum[ja];
    for (let k = ja + 1; k < jb; k++) {
      out.push(vtx(k, ta + (span > 0 ? (cum[k] - cum[ja]) / span : 0) * (tb - ta)));
    }
  }
  const last = matched[matched.length - 1];
  out.push(vtx(idx[last], anchors[last].utcMs));

  const dropped = idx[matched[0]] + (m - 1 - idx[last]);
  notes.push(`line timed from ${matched.length} timestamps`);
  if (loose.length) notes.push(`${loose.length} off-line fixes fill gaps in the line`);
  if (dropped) notes.push(`${dropped} untimed line points outside the timestamps dropped`);
  return [...out, ...loose];
}

// ─── GPX ─────────────────────────────────────────────────────────────────────

export function parseGpx(xml: string, fallbackName = 'Track'): ParsedTrack {
  const name = text(first(first(xml, 'trk') ?? xml, 'name')) || fallbackName;
  const points: TrackPoint[] = [];
  const re = /<(?:[\w-]+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?trkpt\s*>)/g;
  for (const m of xml.matchAll(re)) {
    const lat = Number(/\blat\s*=\s*["']([^"']+)/.exec(m[1])?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)/.exec(m[1])?.[1]);
    const body = m[2] ?? '';
    const t = parseIsoUtc(text(first(body, 'time')));
    const ele = Number(text(first(body, 'ele')));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || t == null) continue;
    points.push({ utcMs: t, lat, lon, altM: first(body, 'ele') != null && Number.isFinite(ele) ? ele : null });
  }
  if (points.length < 2) throw new TrackError('No time-stamped track points found in this GPX.');
  return { name, points: sortDedupe(points), notes: [] };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function sortDedupe(points: TrackPoint[]): TrackPoint[] {
  const s = points.slice().sort((a, b) => a.utcMs - b.utcMs);
  return s.filter((p, i) => i === 0 || p.utcMs !== s[i - 1].utcMs);
}

function kmBetween(a: TrackPoint, b: TrackPoint): number {
  const va = latLonToVec3(a.lat, a.lon, 1), vb = latLonToVec3(b.lat, b.lon, 1);
  return Math.atan2(new THREE.Vector3().crossVectors(va, vb).length(), va.dot(vb)) * EARTH_RADIUS_KM;
}

export const MAX_SPEED_KMH = 1500;        // faster than any jet-stream airliner → a GPS spike
export const AIRBORNE_KMH = 150;          // past rotation speed: rolling for take-off
export const SIMPLIFY_KM = 0.25;
export const GAP_NOTE_MS = 15 * 60_000;   // shorter holes are routine

const fmtHm = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
};

export type CleanTrack = { points: TrackPoint[]; notes: string[] };

// Drop spikes, trim ground time before take-off / after landing, and thin
// the points with a time-aware Douglas–Peucker (see simplify).
export function cleanTrack(raw: TrackPoint[]): CleanTrack {
  const notes: string[] = [];
  const pts = sortDedupe(raw);

  const kept: TrackPoint[] = [];
  for (const p of pts) {
    const q = kept[kept.length - 1];
    if (q && kmBetween(q, p) / ((p.utcMs - q.utcMs) / 3_600_000) > MAX_SPEED_KMH) continue;
    kept.push(p);
  }
  if (kept.length < pts.length) notes.push(`${pts.length - kept.length} GPS spikes removed`);
  if (kept.length < 2) throw new TrackError('Track has fewer than two usable points.');

  // Ground speed over ≥ 60 s windows, so 1-second jitter doesn't count as flying.
  const fastAt = (i: number): boolean => {
    let k = i + 1;
    while (k < kept.length && kept[k].utcMs - kept[i].utcMs < 60_000) k++;
    if (k >= kept.length) return false;
    return kmBetween(kept[i], kept[k]) / ((kept[k].utcMs - kept[i].utcMs) / 3_600_000) > AIRBORNE_KMH;
  };
  let a = 0;
  while (a < kept.length - 1 && !fastAt(a)) a++;
  let b = kept.length - 1;
  while (b > a && !fastAt(b)) b--;
  let trimmed = kept;
  if (a < b) {
    // Extend the end to the close of the last fast window (the landing roll).
    let e = b + 1;
    while (e < kept.length - 1 && kept[e].utcMs - kept[b].utcMs < 60_000) e++;
    e = Math.min(e, kept.length - 1);
    const before = kept[a].utcMs - kept[0].utcMs;
    const after = kept[kept.length - 1].utcMs - kept[e].utcMs;
    trimmed = kept.slice(a, e + 1);
    if (before >= 60_000 || after >= 60_000) {
      notes.push(`ground time trimmed (${fmtHm(before)} before take-off, ${fmtHm(after)} after landing)`);
    }
  }

  // Long holes in coverage (oceans, no ADS-B receivers) are flown as a great
  // circle between the fixes either side. Say so, since the real path may differ.
  const gaps = trimmed.slice(1).map((p, i) => p.utcMs - trimmed[i].utcMs).filter((g) => g >= GAP_NOTE_MS);
  if (gaps.length) {
    const longest = Math.max(...gaps);
    const total = gaps.reduce((a, b) => a + b, 0);
    notes.push(gaps.length === 1
      ? `1 coverage gap bridged by great circle (${fmtHm(longest)})`
      : `${gaps.length} coverage gaps bridged by great circle (${fmtHm(total)} in all, longest ${fmtHm(longest)})`);
  }

  const simple = simplify(trimmed, SIMPLIFY_KM);
  return { points: simple, notes };
}

// Douglas–Peucker with the synchronised distance: a point's error is how far
// it is from where the simplified segment would put the plane *at that
// point's time* (plus the altitude difference), so speed changes survive too.
export function simplify(pts: TrackPoint[], tolKm: number): TrackPoint[] {
  if (pts.length <= 2) return pts.slice();
  const V = pts.map((p) => latLonToVec3(p.lat, p.lon, 1));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  const tmp = new THREE.Vector3();
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j - i < 2) continue;
    const arc = makeArc(V[i], V[j]);
    const t0 = pts[i].utcMs, dt = pts[j].utcMs - t0;
    let worst = -1, worstErr = 0;
    for (let k = i + 1; k < j; k++) {
      const u = dt > 0 ? (pts[k].utcMs - t0) / dt : 0;
      arcPoint(arc, u, tmp);
      const h = Math.atan2(tmp.clone().cross(V[k]).length(), tmp.dot(V[k])) * EARTH_RADIUS_KM;
      const ai = pts[i].altM, aj = pts[j].altM, ak = pts[k].altM;
      const v = ai != null && aj != null && ak != null ? (ak - (ai + (aj - ai) * u)) / 1000 : 0;
      const err = Math.hypot(h, v);
      if (err > worstErr) { worstErr = err; worst = k; }
    }
    if (worstErr > tolKm) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
