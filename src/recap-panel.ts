// Recap panel (top-right): transition table, time breakdown, plane/sun
// diagram, plus the phase timeline strip under the scrubber. DOM only — the
// numbers come from flight.ts.
import { DateTime } from 'luxon';
import { CRUISE_ALT_KM, NIGHT_ELEV_DEG, SUNRISE_ELEV_DEG } from './astro';
import { type Flight, type RecapRow, computeRecap } from './flight';

const recapEl         = document.getElementById('recap')          as HTMLDivElement;
const recapTitle      = recapEl.querySelector('.title')           as HTMLDivElement;
const recapTable      = recapEl.querySelector('table')            as HTMLTableElement;
const recapStatsTitle = recapEl.querySelector('.stats-title')     as HTMLDivElement;
const recapStatsTable = recapEl.querySelector('table.stats')      as HTMLTableElement;
const sunIcon         = document.getElementById('sun-icon')       as SVGGElement | null;
const timelineEl      = document.getElementById('timeline')       as HTMLDivElement;
const timelinePhase   = timelineEl.querySelector('.tl-phase')     as HTMLDivElement;
const timelineSide    = timelineEl.querySelector('.tl-side')      as HTMLDivElement;

let rowTimes: number[] = [];                 // utcMs per row, ascending
let rowEls:   HTMLTableRowElement[] = [];
let currentRowIdx = -1;

export function renderRecap(f: Flight) {
  const { rows, stats } = computeRecap(f);
  recapTitle.textContent = `Phase transitions — times in ${f.from.tz}`;
  recapTable.innerHTML = rows.map((r) => {
    const t = DateTime.fromMillis(r.utcMs).setZone(f.from.tz).toFormat('LLL dd HH:mm');
    const cls = `phase-${r.phase}${r.kind === 'endpoint' ? ' endpoint' : ''}`;
    return `<tr class="${cls}"><td class="time">${t}</td><td class="label">${r.label}</td></tr>`;
  }).join('');
  recapStatsTitle.textContent = 'Time breakdown';
  const pct = (v: number) => `${v.toFixed(0)}%`;
  recapStatsTable.innerHTML = [
    `<tr class="phase-DAY"><td colspan="2" class="sun-pct">` +
      `<span class="side-LEFT">${pct(stats.leftPct)} ←</span> Sun <span class="side-RIGHT">→ ${pct(stats.rightPct)}</span></td></tr>`,
    `<tr class="phase-TWILIGHT"><td class="label">Twilight</td><td class="pct">${pct(stats.twilightPct)}</td></tr>`,
    `<tr class="phase-NIGHT"><td class="label">Night</td><td class="pct">${pct(stats.nightPct)}</td></tr>`,
    `<tr><td colspan="2" class="footnote">Sunrise/sunset at ${CRUISE_ALT_KM} km cruise: sun elev ${SUNRISE_ELEV_DEG.toFixed(1)}°</td></tr>`,
  ].join('');
  renderTimeline(f, rows);
  recapEl.classList.add('visible');
  rowTimes = rows.map((r) => r.utcMs);
  rowEls   = Array.from(recapTable.querySelectorAll('tr'));
  currentRowIdx = -1;
}

// Highlight the last row whose timestamp is ≤ utcMs (the segment we're inside).
export function updateRecapHighlight(utcMs: number) {
  if (rowEls.length === 0) return;
  let idx = -1;
  for (let i = 0; i < rowTimes.length; i++) {
    if (rowTimes[i] <= utcMs) idx = i; else break;
  }
  if (idx === currentRowIdx) return;
  if (currentRowIdx >= 0) rowEls[currentRowIdx].classList.remove('current');
  if (idx >= 0) {
    rowEls[idx].classList.add('current');
    rowEls[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  currentRowIdx = idx;
}

export function hideRecap() {
  hideTimeline();
  recapEl.classList.remove('visible');
  recapTable.innerHTML = '';
  recapTitle.textContent = '';
  recapStatsTable.innerHTML = '';
  recapStatsTitle.textContent = '';
  rowTimes = [];
  rowEls = [];
  currentRowIdx = -1;
}

// ─── Plane/sun diagram ───────────────────────────────────────────────────────
// Sun orbits the plane silhouette at a fixed radius. Plane is drawn facing up
// (-y in SVG), so:
//   sun ahead (sF > 0, sR = 0) → top of viz
//   sun right (sR > 0, sF = 0) → right of viz
// Hidden during NIGHT.
const SUN_VIZ_RADIUS = 82;
export function updateSunViz(sR: number, sF: number, elevDeg: number) {
  if (!sunIcon) return;
  if (elevDeg < NIGHT_ELEV_DEG) {
    sunIcon.classList.add('hidden');
    return;
  }
  sunIcon.classList.remove('hidden');
  const a = Math.atan2(sR, sF);
  const x = SUN_VIZ_RADIUS * Math.sin(a);
  const y = -SUN_VIZ_RADIUS * Math.cos(a);
  sunIcon.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
}

// ─── Timeline strip under the scrubber ──────────────────────────────────────
// Two hard-stop gradient bands, aligned with the scrub slider's track:
//   top    — DAY / TWILIGHT / NIGHT (same colors as the recap table)
//   bottom — sun side during DAY (left / right), empty otherwise
// Built from the recap rows: each row starts a run that lasts until the next.

const PHASE_COLORS: Record<string, string> = {
  DAY: '#ffd84d', TWILIGHT: '#9b6bff', NIGHT: '#2f4fa8',
};
const SIDE_COLORS = { LEFT: '#4fc3ff', RIGHT: '#ff8a3d' } as const;

type Run = { t0: number; t1: number; color: string };

function hardStopGradient(runs: Run[]): string {
  const stops = runs.flatMap(({ t0, t1, color }) =>
    [`${color} ${(t0 * 100).toFixed(2)}%`, `${color} ${(t1 * 100).toFixed(2)}%`]);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function renderTimeline(f: Flight, rows: RecapRow[]) {
  const tOf = (utcMs: number) => Math.min(1, Math.max(0, (utcMs - f.depUtcMs) / f.durationMs));
  const phaseRuns: Run[] = [];
  const sideRuns:  Run[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const t0 = tOf(rows[i].utcMs), t1 = tOf(rows[i + 1].utcMs);
    phaseRuns.push({ t0, t1, color: PHASE_COLORS[rows[i].phase] });
    sideRuns.push({ t0, t1, color: rows[i].phase === 'DAY' ? SIDE_COLORS[rows[i].side] : 'transparent' });
  }
  timelinePhase.style.background = hardStopGradient(phaseRuns);
  timelineSide.style.background  = hardStopGradient(sideRuns);
  timelineEl.classList.add('visible');
}

function hideTimeline() {
  timelineEl.classList.remove('visible');
  timelinePhase.style.background = '';
  timelineSide.style.background  = '';
}
