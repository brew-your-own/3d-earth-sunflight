import { describe, expect, it } from 'vitest';
import { arrIsoToDurationMin, durationToArrIso, formatDuration, formatTzInfo, parseDuration } from './time';

describe('parseDuration', () => {
  it.each([
    ['11h 30m', 690],
    ['11h30m',  690],
    ['11:30',   690],
    ['11:05',   665],
    ['11.5',    690],
    ['11',      660],
    ['11h',     660],
    ['45m',      45],
    ['45min',    45],
    ['  2H 5M ', 125],
    ['1.25h',    75],
  ])('%j → %i min', (raw, min) => {
    expect(parseDuration(raw)).toBe(min);
  });

  it.each(['', 'abc', 'h', '11:', '-3h', '1d'])('rejects %j', (raw) => {
    expect(parseDuration(raw)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats minutes as "Hh Mm"', () => {
    expect(formatDuration(690)).toBe('11h 30m');
    expect(formatDuration(0)).toBe('0h 0m');
  });
  it('returns empty for invalid input', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('durationToArrIso / arrIsoToDurationMin', () => {
  it('converts across timezones (JFK 11:00 + 14h → HND 15:00 next day)', () => {
    expect(durationToArrIso('2026-11-08T11:00', 'America/New_York', 14 * 60, 'Asia/Tokyo'))
      .toBe('2026-11-09T15:00');
  });

  it('accounts for a DST jump inside the flight', () => {
    // US clocks spring forward at 02:00 on 2026-03-08: 1 h after 01:30 is 03:30.
    expect(durationToArrIso('2026-03-08T01:30', 'America/New_York', 60, 'America/New_York'))
      .toBe('2026-03-08T03:30');
    expect(arrIsoToDurationMin('2026-03-08T01:30', 'America/New_York', '2026-03-08T03:30', 'America/New_York'))
      .toBe(60);
  });

  it('round-trips', () => {
    const arr = durationToArrIso('2026-07-01T21:40', 'Europe/London', 22 * 60 + 15, 'Australia/Sydney');
    expect(arrIsoToDurationMin('2026-07-01T21:40', 'Europe/London', arr, 'Australia/Sydney')).toBe(22 * 60 + 15);
  });

  it('returns empty / null on bad input', () => {
    expect(durationToArrIso('nope', 'UTC', 60, 'UTC')).toBe('');
    expect(arrIsoToDurationMin('nope', 'UTC', '2026-01-01T00:00', 'UTC')).toBeNull();
  });
});

describe('formatTzInfo', () => {
  it('shows the offset in effect at that date (DST-aware)', () => {
    expect(formatTzInfo('America/New_York', '2026-07-01T12:00')).toBe('America/New_York (UTC−4)');
    expect(formatTzInfo('America/New_York', '2026-01-01T12:00')).toBe('America/New_York (UTC−5)');
  });
  it('shows half-hour offsets', () => {
    expect(formatTzInfo('Asia/Kolkata', '2026-01-01T12:00')).toBe('Asia/Kolkata (UTC+5:30)');
  });
});
