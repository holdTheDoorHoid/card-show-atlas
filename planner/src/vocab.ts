/**
 * Default display names for the vocabulary in DATA_MODEL section 3. The site can pass its own
 * labels (from `vocab.json`) and they win.
 */

export const VOCAB_GROUPS: Record<'tcg' | 'sports' | 'other', string[]> = {
  tcg: [
    'pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana', 'dragon_ball', 'digimon', 'fab', 'swu',
    'weiss_schwarz', 'union_arena', 'riftbound', 'sorcery', 'gundam', 'metazoo', 'grand_archive',
    'vanguard', 'altered', 'other_tcg',
  ],
  sports: [
    'baseball', 'basketball', 'football', 'hockey', 'soccer', 'racing', 'wrestling', 'combat', 'golf',
    'multi_sport',
  ],
  other: ['non_sport', 'comics', 'toys', 'video_games', 'memorabilia', 'coins', 'anime'],
};

export const DEFAULT_LABELS: Record<string, string> = {
  pokemon: 'Pokémon',
  mtg: 'Magic',
  yugioh: 'Yu-Gi-Oh',
  one_piece: 'One Piece',
  lorcana: 'Lorcana',
  dragon_ball: 'Dragon Ball',
  digimon: 'Digimon',
  fab: 'Flesh and Blood',
  swu: 'Star Wars Unlimited',
  weiss_schwarz: 'Weiss Schwarz',
  union_arena: 'Union Arena',
  riftbound: 'Riftbound',
  sorcery: 'Sorcery',
  gundam: 'Gundam',
  metazoo: 'MetaZoo',
  grand_archive: 'Grand Archive',
  vanguard: 'Vanguard',
  altered: 'Altered',
  other_tcg: 'other card games',
  baseball: 'baseball',
  basketball: 'basketball',
  football: 'football',
  hockey: 'hockey',
  soccer: 'soccer',
  racing: 'racing',
  wrestling: 'wrestling',
  combat: 'combat sports',
  golf: 'golf',
  multi_sport: 'sports',
  non_sport: 'non sport cards',
  comics: 'comics',
  toys: 'toys',
  video_games: 'video games',
  memorabilia: 'memorabilia',
  coins: 'coins',
  anime: 'anime',
};

const GROUP_OF = new Map<string, 'tcg' | 'sports' | 'other'>();
for (const [g, ids] of Object.entries(VOCAB_GROUPS) as ['tcg' | 'sports' | 'other', string[]][]) {
  for (const id of ids) GROUP_OF.set(id, g);
}

export function groupOf(id: string): 'tcg' | 'sports' | 'other' | null {
  return GROUP_OF.get(id) ?? null;
}

export function labelFor(id: string, labels?: Record<string, string>): string {
  return labels?.[id] ?? DEFAULT_LABELS[id] ?? id.replace(/_/g, ' ');
}

/**
 * How well a show's list of what is sold matches a wanted list, 0 to 1.
 * Unknown (either list empty) is neutral, 0.5. `multi_sport` matches any sport.
 */
export function matchSells(
  wanted: string[],
  sold: string[],
): { score: number; known: boolean; matched: string[] } {
  if (wanted.length === 0 || sold.length === 0) return { score: 0.5, known: false, matched: [] };
  const soldSet = new Set(sold);
  const soldGroups = new Set(sold.map(groupOf));
  const matched: string[] = [];
  let partial = 0;
  for (const w of wanted) {
    const g = groupOf(w);
    if (soldSet.has(w) || (g === 'sports' && soldSet.has('multi_sport')) || (w === 'multi_sport' && soldGroups.has('sports'))) {
      matched.push(w);
    } else if (g && soldGroups.has(g)) {
      partial += 1;
    }
  }
  const score = Math.min(1, (matched.length + 0.3 * partial) / wanted.length);
  return { score, known: true, matched };
}
