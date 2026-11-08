import { describe, expect, it } from 'vitest';
import { TWILIGHT_LINES, legendHtml, thresholdSines } from './terminator';

describe('twilight lines', () => {
  it('uses the standard ground-level definitions, in descending order', () => {
    expect(TWILIGHT_LINES.map((l) => l.elevDeg)).toEqual([-0.833, -6, -12, -18]);
  });

  it('converts thresholds to sines for the shader', () => {
    const s = thresholdSines();
    expect(s).toHaveLength(4);
    expect(s[0]).toBeCloseTo(Math.sin(-0.833 * Math.PI / 180), 12);
    expect(s[3]).toBeCloseTo(-0.30902, 5);          // sin(-18°)
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThan(s[i - 1]);
  });

  it('builds a legend entry per line with its colour', () => {
    const html = legendHtml();
    for (const l of TWILIGHT_LINES) expect(html).toContain(l.color);
    expect(html).toContain('sunrise -0.833°');
    expect(html).toContain('astronomical -18°');
  });
});
