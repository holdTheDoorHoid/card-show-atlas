import { describe, expect, it } from 'vitest';
import { lookupInTable, lookupPostal, parsePostalInput, postalErrorMessage, type PostalTable } from './postal.ts';

const US: PostalTable = { '08837': [40.52, -74.35], '90210': [34.1, -118.41], '02108': [42.36, -71.06] };
const CA: PostalTable = { M5V: [43.64, -79.4], V6B: [49.28, -123.12] };
const load = async (c: 'US' | 'CA') => (c === 'US' ? US : CA);

describe('reading what was typed', () => {
  it('knows a US ZIP code, with or without the plus four', () => {
    expect(parsePostalInput('08837')).toEqual({ country: 'US', key: '08837', display: '08837' });
    expect(parsePostalInput('  08837-1234 ')).toEqual({ country: 'US', key: '08837', display: '08837' });
    expect(parsePostalInput('088371234')).toEqual({ country: 'US', key: '08837', display: '08837' });
  });

  it('knows a Canadian postal code in any common shape, keyed by its first three characters', () => {
    for (const typed of ['M5V 2T6', 'm5v2t6', 'M5V-2T6', 'M5V', ' m5v ']) {
      expect(parsePostalInput(typed)).toEqual({ country: 'CA', key: 'M5V', display: 'M5V' });
    }
  });

  it('rejects things that are neither', () => {
    for (const bad of ['', '   ', '1234', '123456', 'ABCDE', 'M5', 'M5V 2T', 'D5V 2T6x', '08837 NJ']) {
      expect(parsePostalInput(bad)).toBeNull();
    }
  });
});

describe('looking it up', () => {
  it('finds coordinates', () => {
    expect(lookupInTable(US, { country: 'US', key: '08837', display: '08837' })).toEqual({ lat: 40.52, lon: -74.35 });
    expect(lookupInTable(US, { country: 'US', key: '99999', display: '99999' })).toBeNull();
  });

  it('returns the place for a ZIP or a postal code', async () => {
    expect(await lookupPostal('08837', load)).toEqual({ ok: true, lat: 40.52, lon: -74.35, country: 'US', display: '08837' });
    expect(await lookupPostal('M5V 2T6', load)).toEqual({ ok: true, lat: 43.64, lon: -79.4, country: 'CA', display: 'M5V' });
  });

  it('says why it failed', async () => {
    expect(await lookupPostal('hello', load)).toEqual({ ok: false, reason: 'invalid' });
    expect(await lookupPostal('99999', load)).toEqual({ ok: false, reason: 'unknown' });
    expect(await lookupPostal('08837', async () => null)).toEqual({ ok: false, reason: 'unavailable' });
    expect(
      await lookupPostal('08837', async () => {
        throw new Error('offline');
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('only loads the file for the country that was typed', async () => {
    const asked: string[] = [];
    await lookupPostal('M5V', async (c) => {
      asked.push(c);
      return CA;
    });
    expect(asked).toEqual(['CA']);
  });

  it('has a plain message for each failure', () => {
    for (const r of ['invalid', 'unknown', 'unavailable'] as const) expect(postalErrorMessage(r).length).toBeGreaterThan(10);
  });
});
