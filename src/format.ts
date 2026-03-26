/** Label priority — lower number = shown first / used as default thumbnail */
export const LABEL_ORDER: Record<string, number> = {
  Standard: 0,
  Reprint: 1,
  "Jolly Roger Foil": 2,
  "Textured Foil": 3,
  "Full Art": 4,
  Winner: 5,
  "Alternate Art": 6,
  "SP Card": 7,
  "Manga Art": 8,
  Promo: 9,
};

export function labelOrder(label: string | null): number {
  if (!label) return 0;
  return LABEL_ORDER[label] ?? 99;
}

export function labelOrderSql(alias?: string): string {
  const labelExpr = alias ? `${alias}.label` : "label";
  return `CASE ${labelExpr}
  ${Object.entries(LABEL_ORDER).map(([l, i]) => `WHEN '${l}' THEN ${i}`).join(" ")}
  ELSE 99 END`;
}

/** SQL CASE expression for ordering by label priority. Use in ORDER BY or subquery. */
export const LABEL_ORDER_SQL = labelOrderSql();

/** SQL subquery to get the best image_url for a card (by label priority). Bind card id column. */
export function bestImageSubquery(cardIdExpr: string): string {
  return bestImageFieldSubquery(cardIdExpr, "image_url");
}

/** SQL subquery to get a single field from the best classified image for a card. */
export function bestImageFieldSubquery(cardIdExpr: string, field: string): string {
  return `(SELECT ci.${field} FROM card_images ci
    WHERE ci.card_id = ${cardIdExpr} AND ci.classified = true
    ORDER BY ci.is_default DESC, ${labelOrderSql("ci")}, ci.variant_index LIMIT 1)`;
}

export function thumbnailUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;

  try {
    const url = new URL(imageUrl);
    const slashIndex = url.pathname.lastIndexOf("/");
    if (slashIndex === -1) return null;

    const dir = url.pathname.slice(0, slashIndex);
    const filename = url.pathname.slice(slashIndex + 1);
    const dotIndex = filename.lastIndexOf(".");
    const basename = dotIndex === -1 ? filename : filename.slice(0, dotIndex);

    url.pathname = `${dir}/thumbs/${basename}.webp`;
    return url.toString();
  } catch {
    return null;
  }
}

/** Derive a human-readable name from a set code like OP01, ST05, EB04, PRB01 */
export function setName(code: string): string {
  const prefixes: Record<string, string> = {
    OP: "One Piece",
    ST: "Starter Deck",
    EB: "Extra Booster",
    PRB: "Premium Booster",
  };
  // Match prefix letters + trailing digits
  const m = code.match(/^([A-Z]+?)(\d+)$/i);
  if (!m) return code;
  const [, prefix, num] = m;
  const label = prefixes[prefix.toUpperCase()];
  if (!label) return code;
  return `${label} ${parseInt(num, 10)}`;
}

/** Shared card row type returned from queries */
export interface CardRow {
  id: string;
  card_number: string;
  language: string;
  product_id: string;
  true_set_code: string;
  name: string;
  card_type: string;
  rarity: string | null;
  color: string[];
  cost: number | null;
  power: number | null;
  counter: number | null;
  life: number | null;
  attribute: string[] | null;
  types: string[];
  effect: string | null;
  trigger: string | null;
  block: string | null;
  artist: string | null;
  product_name: string;
  released_at: string | null;
}

/** Format a card row for API response */
export function formatCard(row: CardRow & { image_url?: string | null }) {
  const now = new Date();
  const released = row.released_at ? new Date(row.released_at) <= now : false;

  return {
    card_number: row.card_number,
    name: row.name,
    language: row.language,
    set: row.true_set_code,
    set_name: setName(row.true_set_code),
    product: row.product_name,
    released_at: row.released_at,
    released,
    card_type: row.card_type,
    rarity: row.rarity,
    color: row.color,
    cost: row.cost,
    power: row.power,
    counter: row.counter,
    life: row.life,
    attribute: row.attribute,
    types: row.types,
    effect: row.effect,
    trigger: row.trigger,
    block: row.block,
    artist: row.artist,
    ...(row.image_url !== undefined
      ? {
          image_url: row.image_url,
          thumbnail_url: thumbnailUrl(row.image_url),
        }
      : {}),
  };
}
