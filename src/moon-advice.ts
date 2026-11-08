// Seat-advice lines for the Moon (HTML rows for the recap panel's advice
// block). Kept separate from recap-panel.ts so it plugs in with one call.
import type { Flight, Side } from './flight';
import { moonEmoji, moonSummary } from './moon';

export type AdviceFormat = {
  sideHtml: (side: Side) => string;        // e.g. "<b>left (A)</b>"
  viewText: (relAzDeg: number) => string;  // e.g. "forward", "abeam"
  time: (utcMs: number) => string;         // e.g. "Tue 23:40" in the recap's chosen zone
};

export function moonAdviceLines(f: Flight, fmt: AdviceFormat): string[] {
  const m = moonSummary(f);
  const pct = Math.round(m.phase.illuminated * 100);
  const trend = pct >= 99 ? 'full' : pct <= 1 ? 'new' : m.phase.waxing ? 'waxing' : 'waning';
  const head = `${moonEmoji(m.phase.ageDeg)} Moon ${pct}% ${trend}`;
  const h = (x: number) => (x < 1 ? `${Math.round(x * 60)} min` : `${x.toFixed(1)} h`);

  let summary: string;
  if (m.nightHours < 0.05)      summary = 'daytime flight';
  else if (m.upHours < 0.05)    summary = 'below the horizon all night';
  else {
    const where = m.mainSide ? `mostly ${fmt.sideHtml(m.mainSide)}` : 'on both sides';
    const of = m.upHours >= m.nightHours - 0.05 ? 'all night' : `${h(m.upHours)} of the night`;
    summary = `up ${of}, ${where}`;
  }
  const lines = [`<div class="advice-row${m.upHours < 0.05 ? ' muted' : ''}">${head} — ${summary}</div>`];

  for (const e of m.events) {
    const when = fmt.time(e.utcMs);
    const name = e.kind === 'moonrise' ? 'Moonrise' : 'Moonset';
    lines.push(
      `<div class="advice-row pick" data-t="${e.t}" data-side="${e.side}" title="Jump there and look out that window">` +
      `🌙 ${name} ${when} · ${fmt.sideHtml(e.side)}, ${fmt.viewText(e.relAzDeg)}</div>`);
  }
  return lines;
}
