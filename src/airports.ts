// Airport data + free-text search. Pure (no DOM) — safe to import from tests.
import airportsData from './airports.json';

export type Airport = {
  name: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
  tz: string;    // IANA timezone, e.g. "America/New_York"
  rank: number;  // 1 small … 3 large, ×2, +1 if scheduled service (see build-airports.mjs)
};

// Imported (not fetched) so the singlefile build can inline it.
export const airports = airportsData as Record<string, Airport>;

export type Suggestion = { code: string; ap: Airport };

// Lowercased copies built once, so a keystroke doesn't re-lowercase ~8k
// names. Built lazily to keep module load cheap.
type IndexEntry = { code: string; ap: Airport; codeL: string; cityL: string; nameL: string };
let index: IndexEntry[] | null = null;
function getIndex(): IndexEntry[] {
  if (!index) {
    index = Object.entries(airports).map(([code, ap]) => ({
      code, ap,
      codeL: code.toLowerCase(),
      cityL: (ap.city || '').toLowerCase(),
      nameL: (ap.name || '').toLowerCase(),
    }));
  }
  return index;
}

// Match tiers (100 apart): exact IATA > IATA prefix > exact city > city prefix
// > name prefix > city contains > name contains > IATA contains. Within a
// tier, bigger airports with scheduled service win (rank ≤ 7 ≪ 100), then
// alphabetical — so "London" lists Heathrow/Gatwick before Biggin Hill.
export function searchAirports(query: string, limit = 8): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<{ code: string; ap: Airport; score: number }> = [];
  for (const { code, ap, codeL, cityL, nameL } of getIndex()) {
    let score: number;
    if      (codeL === q)            score = 1000;
    else if (codeL.startsWith(q))    score = 900;
    else if (cityL === q)            score = 800;
    else if (cityL.startsWith(q))    score = 700;
    else if (nameL.startsWith(q))    score = 600;
    else if (cityL.includes(q))      score = 500;
    else if (nameL.includes(q))      score = 400;
    else if (codeL.includes(q))      score = 300;
    else continue;
    hits.push({ code, ap, score: score + (ap.rank ?? 0) });
  }
  hits.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return hits.slice(0, limit).map(({ code, ap }) => ({ code, ap }));
}

// Resolve raw input text → IATA code. If the user typed exactly a known IATA,
// use it; otherwise pick the top search hit. Returns '' if nothing matches.
export function resolveAirportCode(value: string): string {
  const v = value.trim();
  if (!v) return '';
  const upper = v.toUpperCase();
  if (v.length === 3 && airports[upper]) return upper;
  return searchAirports(v)[0]?.code ?? '';
}
