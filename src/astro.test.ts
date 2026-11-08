import { describe, expect, it } from 'vitest';
import { HORIZON_DIP_DEG, NIGHT_ELEV_DEG, SUNRISE_ELEV_DEG, daylightLabel, subsolarPoint } from './astro';

const at = (iso: string) => Date.parse(iso);

describe('subsolarPoint', () => {
  // Equinox/solstice instants from the USNO tables.
  it('is on the equator at the March 2024 equinox', () => {
    expect(Math.abs(subsolarPoint(at('2024-03-20T03:06Z')).lat)).toBeLessThan(0.05);
  });

  it('is on the Tropic of Cancer at the June 2024 solstice', () => {
    expect(subsolarPoint(at('2024-06-20T20:51Z')).lat).toBeCloseTo(23.44, 1);
  });

  it('is on the Tropic of Capricorn at the December 2024 solstice', () => {
    expect(subsolarPoint(at('2024-12-21T09:20Z')).lat).toBeCloseTo(-23.44, 1);
  });

  it('reflects the equation of time in longitude', () => {
    // Early November the sun runs ~16.4 min fast, so at 12:00 UTC it has
    // already crossed Greenwich and sits ~4.1° to the west.
    expect(subsolarPoint(at('2024-11-03T12:00Z')).lon).toBeCloseTo(-4.1, 0);
    // Mid-February it runs ~14.2 min slow → ~3.6° east.
    expect(subsolarPoint(at('2024-02-11T12:00Z')).lon).toBeCloseTo(3.55, 0);
  });

  it('moves west 15° per hour', () => {
    const a = subsolarPoint(at('2026-07-01T06:00Z')).lon;
    const b = subsolarPoint(at('2026-07-01T07:00Z')).lon;
    expect(a - b).toBeCloseTo(15, 1);
  });

  it('keeps longitude in [-180, 180)', () => {
    for (let h = 0; h < 48; h++) {
      const { lon } = subsolarPoint(at('2026-01-01T00:00Z') + h * 1_800_000);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
    }
  });
});

describe('cruise-altitude day/night thresholds', () => {
  it('puts apparent sunrise ~4.2° below the geometric horizon at 11 km', () => {
    expect(HORIZON_DIP_DEG).toBeCloseTo(3.36, 2);
    expect(SUNRISE_ELEV_DEG).toBeCloseTo(-4.20, 2);   // 3.364 + 0.833
    expect(NIGHT_ELEV_DEG).toBeCloseTo(SUNRISE_ELEV_DEG - 6, 9);
  });

  it('classifies elevations', () => {
    expect(daylightLabel(30)).toBe('DAY');
    expect(daylightLabel(-3)).toBe('DAY');          // below 0° but visible from altitude
    expect(daylightLabel(SUNRISE_ELEV_DEG)).toBe('DAY');
    expect(daylightLabel(-5)).toBe('TWILIGHT');
    expect(daylightLabel(-10)).toBe('TWILIGHT');
    expect(daylightLabel(-10.5)).toBe('NIGHT');
    expect(daylightLabel(-60)).toBe('NIGHT');
  });
});
