import { describe, expect, it } from 'vitest';
import { airports, resolveAirportCode, searchAirports } from './airports';

const codes = (q: string, n?: number) => searchAirports(q, n).map((s) => s.code);

describe('airport data', () => {
  it('has a timezone and rank for every entry', () => {
    for (const ap of Object.values(airports)) {
      expect(ap.tz).toMatch(/\//);
      expect(ap.rank).toBeGreaterThanOrEqual(2);
      expect(ap.rank).toBeLessThanOrEqual(7);
    }
  });
});

describe('searchAirports', () => {
  it('puts an exact IATA match first', () => {
    expect(codes('jfk')[0]).toBe('JFK');
    expect(codes('SYD')[0]).toBe('SYD');
  });

  it('ranks big airports above small ones within a match tier', () => {
    const london = codes('London', 4);
    expect(london.slice(0, 2).sort()).toEqual(['LGW', 'LHR']);
    expect(london).not.toContain('BQH');   // Biggin Hill used to come first
  });

  it('matches city, name and partial text', () => {
    expect(codes('Sydney')).toContain('SYD');
    expect(codes('heathrow')[0]).toBe('LHR');
    expect(codes('narita')[0]).toBe('NRT');
  });

  it('respects the limit and handles empty input', () => {
    expect(codes('a', 5)).toHaveLength(5);
    expect(codes('   ')).toEqual([]);
  });
});

describe('resolveAirportCode', () => {
  it('accepts an exact code regardless of case', () => {
    expect(resolveAirportCode('lhr')).toBe('LHR');
  });
  it('falls back to the top search hit', () => {
    expect(resolveAirportCode('Tokyo Haneda')).toBe('HND');
  });
  it('returns empty when nothing matches', () => {
    expect(resolveAirportCode('zzzzzz')).toBe('');
    expect(resolveAirportCode('')).toBe('');
  });
});
