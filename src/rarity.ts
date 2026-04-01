export const CARD_RARITIES = ["L", "C", "UC", "R", "SR", "SEC", "P"] as const;

export type CardRarity = (typeof CARD_RARITIES)[number];

const CARD_RARITY_SET = new Set<string>(CARD_RARITIES);

export function normalizeCardRarity(value: string): CardRarity | null {
  const rarity = value.toUpperCase();
  return CARD_RARITY_SET.has(rarity) ? (rarity as CardRarity) : null;
}

export function requireCardRarity(value: string): CardRarity {
  const rarity = normalizeCardRarity(value);
  if (!rarity) throw new Error(`Invalid rarity: ${value}`);
  return rarity;
}

export const CARD_RARITY_ORDER_SQL = `array_position(ARRAY[${CARD_RARITIES.map((rarity) => `'${rarity}'`).join(", ")}]::text[], c.rarity)`;
