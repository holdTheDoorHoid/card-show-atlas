import { describe, expect, it } from 'vitest';
import { distanceText, entryText, vendorNote } from './rowtext.ts';
import { makeRow } from './testing.ts';

describe('row text', () => {
  it('describes entry', () => {
    expect(entryText(makeRow({ i: 'a', fr: 1 }))).toBe('Free entry');
    expect(entryText(makeRow({ i: 'a', ad: 5 }))).toBe('Entry $5');
    expect(entryText(makeRow({ i: 'a', ad: 8, cu: 'CAD' }))).toBe('Entry $8 CAD');
    expect(entryText(makeRow({ i: 'a' }))).toBe('Entry price not listed');
  });

  it('describes distance in the right unit', () => {
    expect(distanceText(100, 130, 'mi')).toBe('100 mi, about 2 h 10 min');
    expect(distanceText(100, 130, 'km')).toBe('161 km, about 2 h 10 min');
    expect(distanceText(null, null, 'mi')).toBe('');
  });

  it('writes the vendors note in plain words', () => {
    expect(vendorNote(makeRow({ i: 'a' }))).toBe('');
    expect(vendorNote(makeRow({ i: 'a', vs: 'open', vp: 90, vd: '2026-11-03' }))).toBe('Vendors: tables open, from $90, apply by Nov 3');
    expect(vendorNote(makeRow({ i: 'a', vs: 'sold_out', vp: 90, vd: '2026-11-03' }))).toBe('Vendors: sold out');
    expect(vendorNote(makeRow({ i: 'a', vs: 'waitlist' }))).toBe('Vendors: waitlist only');
    expect(vendorNote(makeRow({ i: 'a', vs: 'closed' }))).toBe('Vendors: applications closed');
    expect(vendorNote(makeRow({ i: 'a', vs: 'unknown' }))).toBe('Vendors: info on the show page');
    expect(vendorNote(makeRow({ i: 'a', vs: 'unknown', vp: 100 }))).toBe('Vendors: tables from $100');
  });
});
