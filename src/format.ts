/** Label priority — lower number = shown first / used as default thumbnail */
export const LABEL_ORDER: Record<string, number> = {
  Standard: 0,
  Reprint: 1,
  "Jolly Roger Foil": 2,
  "Textured Foil": 3,
  "Full Art": 4,
  Winner: 5,
  "Alternate Art": 6,
  SP: 7,
  TR: 7,
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

export function cardImageAssetPublicUrlSql(
  cardImageIdExpr: string,
  role: "image_url" | "image_thumb" | "scan_source" | "scan_url" | "scan_thumb" | "scan_display",
  fallbackExpr: string,
): string {
  return `COALESCE((
    SELECT cia.public_url
    FROM card_image_assets cia
    WHERE cia.card_image_id = ${cardImageIdExpr}
      AND cia.role = '${role}'
    LIMIT 1
  ), ${fallbackExpr})`;
}

export function publicScanUrlSql(cardImageIdExpr: string, fallbackExpr: string): string {
  return `COALESCE(
    (SELECT cia.public_url
     FROM card_image_assets cia
     WHERE cia.card_image_id = ${cardImageIdExpr}
       AND cia.role = 'scan_display'
     LIMIT 1),
    ${cardImageAssetPublicUrlSql(cardImageIdExpr, "scan_url", fallbackExpr)}
  )`;
}

/** SQL expression for the public card-page variant ordering. */
export function variantDisplayOrderSql(cardImageAlias: string, productAlias: string): string {
  return [
    `CASE WHEN NULLIF(BTRIM(COALESCE(${cardImageAssetPublicUrlSql(`${cardImageAlias}.id`, "image_url", `${cardImageAlias}.image_url`)}, '')), '') IS NULL THEN 1 ELSE 0 END`,
    `CASE WHEN ${productAlias}.released_at IS NULL THEN 1 ELSE 0 END`,
    `${productAlias}.released_at ASC`,
    labelOrderSql(cardImageAlias),
    `${cardImageAlias}.variant_index`,
  ].join(", ");
}

export function compareVariantDisplayOrder(
  a: { image_url: string | null; label: string | null; variant_index: number; released_at: string | null },
  b: { image_url: string | null; label: string | null; variant_index: number; released_at: string | null },
): number {
  const aHasImage = !!a.image_url?.trim();
  const bHasImage = !!b.image_url?.trim();
  if (aHasImage !== bHasImage) {
    return aHasImage ? -1 : 1;
  }

  const dateA = a.released_at;
  const dateB = b.released_at;
  if (dateA && dateB && dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (dateA && !dateB) return -1;
  if (!dateA && dateB) return 1;

  const labelDiff = labelOrder(a.label) - labelOrder(b.label);
  if (labelDiff !== 0) return labelDiff;

  return a.variant_index - b.variant_index;
}

/** SQL subquery to get the best image_url for a card (by label priority). Bind card id column. */
export function bestImageSubquery(cardIdExpr: string): string {
  return `(SELECT ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} FROM card_images ci
    LEFT JOIN products ip ON ip.id = ci.product_id
    WHERE ci.card_id = ${cardIdExpr} AND ci.classified = true
    ORDER BY ${variantDisplayOrderSql("ci", "ip")} LIMIT 1)`;
}

/** SQL subquery to get the best scan_url for a card using the same best-variant ordering. */
export function bestScanUrlSubquery(cardIdExpr: string): string {
  return `(SELECT ${publicScanUrlSql("ci.id", "ci.scan_url")} FROM card_images ci
    LEFT JOIN products ip ON ip.id = ci.product_id
    WHERE ci.card_id = ${cardIdExpr} AND ci.classified = true
    ORDER BY ${variantDisplayOrderSql("ci", "ip")} LIMIT 1)`;
}

/** SQL subquery to get the best scan thumbnail url for a card using the same best-variant ordering. */
export function bestScanThumbSubquery(cardIdExpr: string): string {
  return `(SELECT ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} FROM card_images ci
    LEFT JOIN products ip ON ip.id = ci.product_id
    WHERE ci.card_id = ${cardIdExpr} AND ci.classified = true
    ORDER BY ${variantDisplayOrderSql("ci", "ip")} LIMIT 1)`;
}

/** SQL subquery to get the most relevant non-null artist for a card. */
export function bestArtistSubquery(cardIdExpr: string): string {
  return `(SELECT ci.artist FROM card_images ci
    LEFT JOIN products ip ON ip.id = ci.product_id
    WHERE ci.card_id = ${cardIdExpr}
    ORDER BY
      CASE WHEN NULLIF(BTRIM(COALESCE(ci.artist, '')), '') IS NULL THEN 1 ELSE 0 END,
      ${variantDisplayOrderSql("ci", "ip")}
    LIMIT 1)`;
}

/**
 * Shape of a row from a card_images query joined with product + price data,
 * as consumed by buildVariant() to produce the unified variant object.
 */
export interface VariantRow {
  variant_index: number;
  name?: string | null;
  label: string | null;
  artist: string | null;
  image_url: string | null;
  image_thumb_url?: string | null;
  scan_display_url: string | null;
  scan_full_url: string | null;
  scan_thumb_url: string | null;
  product_name: string | null;
  product_set_code: string | null;
  product_released_at: string | null;
  tcgplayer_url: string | null;
  market_price: string | null;
  low_price: string | null;
  mid_price: string | null;
  high_price: string | null;
}

/** The unified per-variant object emitted by both detail and search endpoints. */
export interface CardVariant {
  index: number;
  name: string | null;
  label: string | null;
  artist: string | null;
  product: {
    name: string | null;
    set_code: string | null;
    released_at: string | null;
  };
  images: {
    stock: {
      full: string | null;
      thumb: string | null;
    };
    scan: {
      display: string | null;
      full: string | null;
      thumb: string | null;
    };
  };
  market: {
    tcgplayer_url: string | null;
    market_price: string | null;
    low_price: string | null;
    mid_price: string | null;
    high_price: string | null;
  };
}

/**
 * Map a card_images+product+price row to the unified variant object.
 *
 * Field naming aligns with migration 026_rewrite_image_urls_to_r2.sql:
 * - images.stock.{full,thumb} → role image_url / image_thumb
 * - images.scan.{display,full,thumb} → role scan_display / scan_url / scan_thumb
 *
 * The Normal/Foil sub_type wrapper from the old detail shape is dropped —
 * OPTCG prints are exclusively one sub_type per printing, so the single
 * price row returned by the caller's price join is the variant's price.
 */
export function buildVariant(row: VariantRow): CardVariant {
  const stockFull = row.image_url;
  const stockThumb = row.image_thumb_url ?? thumbnailUrl(stockFull);

  return {
    index: row.variant_index,
    name: row.name ?? null,
    label: row.label,
    artist: row.artist,
    product: {
      name: row.product_name,
      set_code: row.product_set_code,
      released_at: row.product_released_at,
    },
    images: {
      stock: {
        full: stockFull,
        thumb: stockThumb,
      },
      scan: {
        display: row.scan_display_url,
        full: row.scan_full_url,
        thumb: row.scan_thumb_url,
      },
    },
    market: {
      tcgplayer_url: row.tcgplayer_url,
      market_price: row.market_price,
      low_price: row.low_price,
      mid_price: row.mid_price,
      high_price: row.high_price,
    },
  };
}

export function thumbnailUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;

  try {
    const url = new URL(imageUrl);
    const hostname = url.hostname.toLowerCase();
    if (
      url.search
      || hostname.includes("discordapp.com")
      || hostname.includes("discordapp.net")
      || hostname.includes("discord.com")
    ) {
      return imageUrl;
    }

    // Already a thumb under the new layout (.../thumb.webp).
    if (/\/thumb\.webp$/i.test(url.pathname)) {
      return imageUrl;
    }

    // New canonical layout: images/{CARD}/{lang}/stock/{variant}/full.png
    //   → images/{CARD}/{lang}/stock/{variant}/thumb.webp
    // Same for scans/.
    const newLayoutMatch = url.pathname.match(
      /^(.*\/images\/[^/]+\/[^/]+\/(?:stock|scans)\/\d+)\/full\.(?:png|jpg|jpeg|webp)$/i,
    );
    if (newLayoutMatch) {
      url.pathname = `${newLayoutMatch[1]}/thumb.webp`;
      return url.toString();
    }

    return null;
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
  product_id: string | null;
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
  product_name: string | null;
  released_at: string | null;
}

/** Format a card row for API response */
export function formatCard(row: CardRow & {
  image_url?: string | null;
  image_thumb_url?: string | null;
  scan_url?: string | null;
  scan_thumb_url?: string | null;
  tcgplayer_url?: string | null;
  market_price?: string | null;
  low_price?: string | null;
  mid_price?: string | null;
  high_price?: string | null;
}) {
  const now = new Date();
  const released = row.released_at ? new Date(row.released_at) <= now : false;

  return {
    card_number: row.card_number,
    name: row.name,
    language: row.language,
    set: row.true_set_code,
    set_name: setName(row.true_set_code),
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
    ...(row.image_url !== undefined
      ? {
          image_url: row.image_url,
          image_thumb_url: row.image_thumb_url ?? thumbnailUrl(row.image_url),
          thumbnail_url: row.image_thumb_url ?? thumbnailUrl(row.image_url),
        }
      : {}),
    ...(row.scan_url !== undefined
      ? {
          scan_url: row.scan_url,
        }
      : {}),
    ...(row.scan_thumb_url !== undefined
      ? {
          scan_thumb_url: row.scan_thumb_url,
        }
      : {}),
    ...(row.tcgplayer_url !== undefined
      ? {
          tcgplayer_url: row.tcgplayer_url,
        }
      : {}),
    ...(row.market_price !== undefined
      ? {
          market_price: row.market_price,
          low_price: row.low_price ?? null,
          mid_price: row.mid_price ?? null,
          high_price: row.high_price ?? null,
        }
      : {}),
  };
}

function normalizeTextBlock(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatCardHeadline(row: CardRow): string {
  return [
    row.color.join("/"),
    row.card_type,
    row.card_number,
    row.rarity,
  ].filter((part): part is string => Boolean(part && part.trim())).join(" ");
}

function formatCardStats(row: CardRow): string | null {
  const parts: string[] = [];
  if (row.cost != null) parts.push(`${row.cost} Cost`);
  if (row.life != null) parts.push(`${row.life} Life`);
  if (row.power != null) parts.push(`${row.power} Power`);

  const attribute = row.attribute?.filter(Boolean).join("/") || "";
  const stats = parts.join(" / ");
  if (stats && attribute) return `${stats} (${attribute})`;
  if (stats) return stats;
  if (attribute) return `(${attribute})`;
  return null;
}

export function formatCardPlainText(row: CardRow): string {
  const lines = [
    row.name,
    formatCardHeadline(row),
    formatCardStats(row),
    row.types.join(" / "),
    row.counter != null ? `Counter +${row.counter}` : null,
  ].filter((line): line is string => Boolean(line && line.trim()));

  const effect = normalizeTextBlock(row.effect);
  const triggerBody = normalizeTextBlock(row.trigger);
  const trigger = triggerBody
    ? (triggerBody.startsWith("[Trigger]") ? triggerBody : `[Trigger] ${triggerBody}`)
    : null;
  const textBlocks = [effect, trigger].filter((block): block is string => Boolean(block));

  if (textBlocks.length === 0) {
    return lines.join("\n");
  }

  return `${lines.join("\n")}\n\n${textBlocks.join("\n\n")}`;
}
