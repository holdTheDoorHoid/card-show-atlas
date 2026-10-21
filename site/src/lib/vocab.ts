// What is sold: the vocabulary of DATA_MODEL section 3. The built-in list below is the fallback;
// public/data/vocab.json (a copy of data/vocab.json) can add ids and change display names.
import type { Vocab, VocabEntry, VocabGroup } from './types.ts';

function e(id: string, name: string, label: string = name): VocabEntry {
  return { id, name, label };
}

export const DEFAULT_VOCAB: Vocab = {
  tcg: [
    e('pokemon', 'Pokémon'),
    e('mtg', 'Magic: The Gathering', 'Magic'),
    e('yugioh', 'Yu-Gi-Oh!', 'Yu-Gi-Oh'),
    e('one_piece', 'One Piece'),
    e('lorcana', 'Disney Lorcana', 'Lorcana'),
    e('dragon_ball', 'Dragon Ball Super', 'Dragon Ball'),
    e('digimon', 'Digimon'),
    e('fab', 'Flesh and Blood'),
    e('swu', 'Star Wars: Unlimited', 'Star Wars Unlimited'),
    e('weiss_schwarz', 'Weiss Schwarz'),
    e('union_arena', 'Union Arena'),
    e('riftbound', 'Riftbound'),
    e('sorcery', 'Sorcery: Contested Realm', 'Sorcery'),
    e('gundam', 'Gundam Card Game', 'Gundam'),
    e('metazoo', 'MetaZoo'),
    e('grand_archive', 'Grand Archive'),
    e('vanguard', 'Cardfight!! Vanguard', 'Vanguard'),
    e('altered', 'Altered'),
    e('other_tcg', 'Other card games'),
  ],
  sports: [
    e('baseball', 'Baseball cards', 'Baseball'),
    e('basketball', 'Basketball cards', 'Basketball'),
    e('football', 'Football cards', 'Football'),
    e('hockey', 'Hockey cards', 'Hockey'),
    e('soccer', 'Soccer cards', 'Soccer'),
    e('racing', 'Racing cards', 'Racing'),
    e('wrestling', 'Wrestling cards', 'Wrestling'),
    e('combat', 'Combat sports cards', 'Combat sports'),
    e('golf', 'Golf cards', 'Golf'),
    e('multi_sport', 'Multi sport cards', 'Multi sport'),
  ],
  other: [
    e('non_sport', 'Non-sport cards', 'Non-sport'),
    e('comics', 'Comics'),
    e('toys', 'Toys'),
    e('video_games', 'Video games'),
    e('memorabilia', 'Memorabilia'),
    e('coins', 'Coins'),
    e('anime', 'Anime'),
  ],
};

export const VOCAB_GROUPS: readonly VocabGroup[] = ['tcg', 'sports', 'other'];

/** The six chips shown before "More": the games and sports people ask for most. */
export const TOP_SELL_CHIPS: readonly string[] = ['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana'];

/** A pseudo id meaning "any of the sports ids". */
export const SPORTS_ANY = 'group:sports';

function cloneVocab(v: Vocab): Vocab {
  return { tcg: v.tcg.map((x) => ({ ...x })), sports: v.sports.map((x) => ({ ...x })), other: v.other.map((x) => ({ ...x })) };
}

function entryFrom(id: string, raw: unknown): VocabEntry | null {
  if (typeof raw === 'string') return { id, name: raw, label: raw };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const rawId = typeof r.id === 'string' ? r.id : id;
    if (!rawId) return null;
    const name = typeof r.name === 'string' ? r.name : typeof r.label === 'string' ? r.label : rawId;
    const label = typeof r.label === 'string' ? r.label : typeof r.short === 'string' ? r.short : name;
    return { id: rawId, name, label };
  }
  return null;
}

/**
 * Read vocab.json in whichever of the likely shapes it has (a list of entries or a map of ids, at the
 * top or under "groups" or "vocab") and merge it over the built-in list. Unknown ids are kept.
 */
export function normalizeVocab(raw: unknown): Vocab {
  const out = cloneVocab(DEFAULT_VOCAB);
  if (!raw || typeof raw !== 'object') return out;
  let root = raw as Record<string, unknown>;
  for (const wrapper of ['groups', 'vocab']) {
    const inner = root[wrapper];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && VOCAB_GROUPS.some((g) => g in (inner as object))) {
      root = inner as Record<string, unknown>;
    }
  }
  for (const group of VOCAB_GROUPS) {
    const src = root[group];
    if (!src || typeof src !== 'object') continue;
    const entries: VocabEntry[] = [];
    if (Array.isArray(src)) {
      for (const item of src) {
        if (typeof item === 'string') entries.push({ id: item, name: item, label: item });
        else {
          const en = entryFrom('', item);
          if (en && en.id) entries.push(en);
        }
      }
    } else {
      for (const [id, val] of Object.entries(src)) {
        const en = entryFrom(id, val);
        if (en) entries.push(en);
      }
    }
    const byId = new Map(out[group].map((x) => [x.id, x]));
    for (const en of entries) {
      const known = byId.get(en.id);
      if (known) {
        // Keep the built-in display text when the file only repeats the id.
        if (en.name !== en.id) known.name = en.name;
        if (en.label !== en.id) known.label = en.label;
      } else {
        out[group].push(en);
        byId.set(en.id, en);
      }
    }
  }
  return out;
}

export function allVocabEntries(v: Vocab): (VocabEntry & { group: VocabGroup })[] {
  return VOCAB_GROUPS.flatMap((g) => v[g].map((x) => ({ ...x, group: g })));
}

export function groupOf(v: Vocab, id: string): VocabGroup | null {
  for (const g of VOCAB_GROUPS) if (v[g].some((x) => x.id === id)) return g;
  return null;
}

export function labelFor(v: Vocab, id: string): string {
  for (const g of VOCAB_GROUPS) {
    const found = v[g].find((x) => x.id === id);
    if (found) return found.label;
  }
  return id.replace(/_/g, ' ');
}

export function nameFor(v: Vocab, id: string): string {
  for (const g of VOCAB_GROUPS) {
    const found = v[g].find((x) => x.id === id);
    if (found) return found.name;
  }
  return id.replace(/_/g, ' ');
}

export function sportsIds(v: Vocab): string[] {
  return v.sports.map((x) => x.id);
}
