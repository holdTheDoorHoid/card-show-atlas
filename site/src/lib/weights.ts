// The four weight presets of DESIGN 5.2, as shown on the Find and Plan pages.
// The ids are the planner's preset names (planner/src/factors.ts).
export type WeightPreset = 'balanced' | 'biggest_crowds' | 'cheapest' | 'closest';

export const WEIGHT_PRESETS: { id: WeightPreset; label: string; help: string }[] = [
  { id: 'balanced', label: 'Balanced', help: 'A bit of everything' },
  { id: 'biggest_crowds', label: 'Biggest crowds', help: 'Shows with the most people' },
  { id: 'cheapest', label: 'Cheapest', help: 'Low table prices first' },
  { id: 'closest', label: 'Closest', help: 'Short drives first' },
];

export const DEFAULT_WEIGHT: WeightPreset = 'balanced';

export function sanitizeWeight(raw: unknown): WeightPreset {
  return WEIGHT_PRESETS.some((p) => p.id === raw) ? (raw as WeightPreset) : DEFAULT_WEIGHT;
}
