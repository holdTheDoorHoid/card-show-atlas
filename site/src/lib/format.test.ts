import { describe, expect, it } from 'vitest';
import { displayHost, escapeHtml, formatMoney, plural, roundedCount, safeUrl, slugify } from './format.ts';
import { absoluteUrl, basePath, dataUrl, fixShowUrl, issueFormUrl, showPath, withBase } from './urls.ts';
import { normalizeVocab, labelFor, nameFor, groupOf, DEFAULT_VOCAB } from './vocab.ts';
import { GOOGLE_FORM_URL, TILE_URL } from './config.ts';

describe('text helpers', () => {
  it('escapes HTML so show data cannot inject markup', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)"> & \'quotes\'')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;');
  });

  it('formats money', () => {
    expect(formatMoney(150)).toBe('$150');
    expect(formatMoney(12.5)).toBe('$12.50');
    expect(formatMoney(1500)).toBe('$1,500');
    expect(formatMoney(150, 'CAD')).toBe('$150 CAD');
    expect(formatMoney(null)).toBe('');
  });

  it('rounds counts for people', () => {
    expect(roundedCount(1234)).toBe(1200);
    expect(roundedCount(437)).toBe(440);
    expect(roundedCount(12)).toBe(10);
    expect(roundedCount(48000)).toBe(48000);
  });

  it('only lets web links through', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(displayHost('https://www.example.com/x')).toBe('example.com');
  });

  it('makes slugs and plurals', () => {
    expect(slugify('Pokémon & Magic: Fall Show!')).toBe('pokemon-and-magic-fall-show');
    expect(plural(1, 'show')).toBe('1 show');
    expect(plural(1234, 'show')).toBe('1,234 shows');
  });
});

describe('links', () => {
  it('puts the base path in front', () => {
    expect(basePath('/card-show-atlas/')).toBe('/card-show-atlas');
    expect(basePath('/')).toBe('');
    expect(withBase('shows/x/', '/card-show-atlas/')).toBe('/card-show-atlas/shows/x/');
    expect(withBase('/data/index.json', '/card-show-atlas')).toBe('/card-show-atlas/data/index.json');
    expect(withBase('', '/')).toBe('/');
    expect(dataUrl('index.json')).toMatch(/\/data\/index\.json$/);
  });

  it('has a stable address for each show', () => {
    expect(showPath('sample-a-2026-11-14')).toBe('shows/sample-a-2026-11-14/');
    expect(absoluteUrl(showPath('sample-a-2026-11-14'))).toBe('https://holdthedoorhoid.github.io/card-show-atlas/shows/sample-a-2026-11-14/');
  });

  it('prefills the GitHub fix form with the page address', () => {
    const url = new URL(fixShowUrl('sample-a-2026-11-14', 'Sample A & B'));
    expect(url.origin + url.pathname).toBe('https://github.com/holdTheDoorHoid/card-show-atlas/issues/new');
    expect(url.searchParams.get('template')).toBe('fix-show.yml');
    expect(url.searchParams.get('page')).toBe('https://holdthedoorhoid.github.io/card-show-atlas/shows/sample-a-2026-11-14/');
    expect(url.searchParams.get('title')).toBe('Fix show: Sample A & B');
    expect(new URL(issueFormUrl('add-show.yml')).searchParams.get('template')).toBe('add-show.yml');
  });

  it('keeps the owner decisions in one place', () => {
    expect(GOOGLE_FORM_URL).toBe(''); // empty until the owner makes the form: buttons that use it stay hidden
    expect(TILE_URL).toContain('{z}/{x}/{y}');
  });
});

describe('vocabulary', () => {
  it('reads a list shaped vocab file', () => {
    const v = normalizeVocab({ tcg: [{ id: 'pokemon', name: 'Pokémon TCG', label: 'Pokémon' }, { id: 'newgame', name: 'New Game', label: 'New' }], sports: [], other: [] });
    expect(nameFor(v, 'pokemon')).toBe('Pokémon TCG');
    expect(labelFor(v, 'newgame')).toBe('New');
    expect(groupOf(v, 'newgame')).toBe('tcg');
    expect(labelFor(v, 'baseball')).toBe('Baseball'); // built-ins stay
  });

  it('reads a map shaped vocab file, also under a wrapper key', () => {
    const v = normalizeVocab({ groups: { tcg: { pokemon: 'Pokémon', newgame: { name: 'New Game', short: 'New' } }, other: { comics: 'Comic books' } } });
    expect(labelFor(v, 'newgame')).toBe('New');
    expect(nameFor(v, 'comics')).toBe('Comic books');
  });

  it('falls back to the built-in list for anything unreadable', () => {
    expect(normalizeVocab(null)).toEqual(DEFAULT_VOCAB);
    expect(normalizeVocab('text')).toEqual(DEFAULT_VOCAB);
    expect(labelFor(DEFAULT_VOCAB, 'some_new_id')).toBe('some new id');
  });
});
