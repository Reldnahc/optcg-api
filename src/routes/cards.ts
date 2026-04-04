import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { parseSearch, SearchNode } from "../search/parser.js";
import { compileSearch } from "../search/compiler.js";
import { CARD_RARITY_ORDER_SQL, normalizeCardRarity } from "../rarity.js";
import { artistFilterSql, artistSortSql } from "../artist.js";
import { formatCardBlockLegalSql } from "../formatLegality.js";
import { normalizeColorFilter, toPgTextArrayLiteral } from "../colors.js";
import {
  cardAutocompleteRouteSchema,
  cardBatchRouteSchema,
  cardDetailRouteSchema,
  cardPlainTextRouteSchema,
  cardsSearchRouteSchema,
} from "../schemas/public.js";

/** Extract order:/direction: values from the AST and return them */
function extractInlineSort(node: SearchNode): { order?: string; direction?: string } {
  const result: { order?: string; direction?: string } = {};
  if (node.type === "filter") {
    if (node.field === "order") result.order = node.value;
    if (node.field === "direction") result.direction = node.value;
  } else if (node.type === "and" || node.type === "or") {
    for (const child of node.children) {
      Object.assign(result, extractInlineSort(child));
    }
  }
  return result;
}
import {
  formatCard,
  formatCardPlainText,
  CardRow,
  compareVariantDisplayOrder,
  cardImageAssetPublicUrlSql,
  labelOrder,
  LABEL_ORDER_SQL,
  bestImageSubquery,
  bestScanUrlSubquery,
  bestScanThumbSubquery,
  labelOrderSql,
  setName,
  thumbnailUrl,
  variantDisplayOrderSql,
} from "../format.js";

type QueryExecutor = typeof query;

type CardsRoutesOptions = {
  queryExecutor?: QueryExecutor;
};

const VALID_SORTS: Record<string, string> = {
  name: "c.name",
  cost: "c.cost",
  power: "c.power",
  card_number: "c.card_number",
  released: "p.released_at",
  rarity: CARD_RARITY_ORDER_SQL,
  color: "c.color[1]",
  market_price: "latest_price.market_price",
};

function tcgplayerProductOrderSql(alias: string): string {
  return `CASE
    WHEN NULLIF(${alias}.tcgplayer_url, '') IS NULL THEN 1
    ELSE 0
  END,
  CASE
    WHEN NULLIF(${alias}.sub_type, '') IS NULL OR ${alias}.sub_type = 'Normal' THEN 0
    ELSE 1
  END,
  COALESCE(NULLIF(${alias}.sub_type, ''), ''),
  ${alias}.tcgplayer_product_id`;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function squeezeRepeatedChars(value: string): string {
  return value.replace(/([a-z0-9])\1+/g, "$1");
}

const NATURAL_LANGUAGE_TYPE_KEYWORDS: Record<string, string> = {
  leader: "Leader",
  leaders: "Leader",
  character: "Character",
  characters: "Character",
  event: "Event",
  events: "Event",
  stage: "Stage",
  stages: "Stage",
};

const NATURAL_LANGUAGE_RARITY_KEYWORDS: Record<string, string> = {
  uc: "UC",
  sr: "SR",
  sec: "SEC",
};

const NATURAL_LANGUAGE_VARIANT_KEYWORDS: Record<string, string> = {
  sp: "SP",
  tr: "TR",
  manga: "Manga Art",
};

function collectPositiveNameTerms(node: SearchNode): string[] {
  switch (node.type) {
    case "name":
      return node.negated ? [] : [node.value];
    case "filter":
      return !node.negated && node.field === "name" ? [node.value] : [];
    case "and":
      return node.children.flatMap(collectPositiveNameTerms);
    case "or":
      return isNaturalLanguageExpansionNode(node) ? [] : node.children.flatMap(collectPositiveNameTerms);
  }
}

function isNaturalLanguageExpansionNode(node: SearchNode): boolean {
  if (node.type !== "or" || node.children.length !== 2) return false;
  const [left, right] = node.children;
  if (left.type !== "name" || left.negated || right.type !== "filter" || right.negated) return false;
  const keyword = left.value.toLowerCase();
  return (right.field === "type" && NATURAL_LANGUAGE_TYPE_KEYWORDS[keyword] === right.value)
    || (right.field === "rarity" && NATURAL_LANGUAGE_RARITY_KEYWORDS[keyword] === right.value)
    || (right.field === "is" && NATURAL_LANGUAGE_VARIANT_KEYWORDS[keyword] !== undefined && right.value === keyword);
}

function collectPositiveFilterValues(node: SearchNode, field: string): string[] {
  switch (node.type) {
    case "name":
      return [];
    case "filter":
      return !node.negated && node.field === field ? [node.value] : [];
    case "and":
    case "or":
      return node.children.flatMap((child) => collectPositiveFilterValues(child, field));
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

type CardDetailRow = CardRow & { set_product_name: string | null };

type CardImageRow = {
  card_id: string;
  card_number: string;
  variant_index: number;
  image_url: string | null;
  scan_url: string | null;
  scan_thumb_url: string | null;
  artist: string | null;
  label: string | null;
  classified: boolean;
  product_name: string | null;
  product_set_code: string | null;
  product_released_at: string | null;
  canonical_tcgplayer_url: string | null;
  tcgplayer_url: string | null;
  market_price: string | null;
  low_price: string | null;
  mid_price: string | null;
  high_price: string | null;
  sub_type: string | null;
};

type FormatLegalityRow = {
  block: string | null;
  format_name: string;
  legal: boolean;
};

type CardBanRow = {
  card_number: string;
  format_name: string;
  ban_type: string;
  max_copies: number | null;
  banned_at: string;
  reason: string | null;
  paired_card_number: string | null;
};

type CardLanguageRow = {
  card_number: string;
  language: string;
};

type VariantDetail = {
  variant_index: number;
  label: string | null;
  artist: string | null;
  image_url: string | null;
  scan_url: string | null;
  scan_thumb_url: string | null;
  product: {
    name: string | null;
    set_code: string | null;
    released_at: string | null;
  };
  market: {
    tcgplayer_url: string | null;
    prices: Record<string, {
      market_price: string | null;
      low_price: string | null;
      mid_price: string | null;
      high_price: string | null;
      tcgplayer_url: string | null;
    }>;
  };
};

function normalizeRequestedCardNumbers(cardNumbers: unknown): string[] {
  if (!Array.isArray(cardNumbers)) return [];
  return [...new Set(cardNumbers
    .map((value) => typeof value === "string" ? value.trim().toUpperCase() : "")
    .filter(Boolean))];
}

function groupImagesByCardNumber(imageRows: CardImageRow[]): Map<string, CardImageRow[]> {
  const rowsByCardNumber = new Map<string, CardImageRow[]>();
  for (const row of imageRows) {
    const key = row.card_number.toUpperCase();
    const rows = rowsByCardNumber.get(key) ?? [];
    rows.push(row);
    rowsByCardNumber.set(key, rows);
  }
  return rowsByCardNumber;
}

function buildVariants(imageRows: CardImageRow[]) {
  const imageMap = new Map<number, VariantDetail>();

  for (const img of imageRows) {
    if (!img.classified) continue;

    let entry = imageMap.get(img.variant_index);
    if (!entry) {
      entry = {
        variant_index: img.variant_index,
        label: img.label,
        artist: img.artist,
        image_url: img.image_url,
        scan_url: img.scan_url,
        scan_thumb_url: img.scan_thumb_url,
        product: {
          name: img.product_name,
          set_code: img.product_set_code,
          released_at: img.product_released_at,
        },
        market: {
          tcgplayer_url: img.canonical_tcgplayer_url,
          prices: {},
        },
      };
      imageMap.set(img.variant_index, entry);
    }

    if (!entry.market.tcgplayer_url && img.canonical_tcgplayer_url) {
      entry.market.tcgplayer_url = img.canonical_tcgplayer_url;
    }

    if (img.market_price !== null) {
      const key = img.sub_type || "Normal";
      entry.market.prices[key] = {
        market_price: img.market_price,
        low_price: img.low_price,
        mid_price: img.mid_price,
        high_price: img.high_price,
        tcgplayer_url: img.tcgplayer_url,
      };
    }
  }

  return [...imageMap.values()].sort((a, b) => compareVariantDisplayOrder(
    {
      image_url: a.image_url,
      label: a.label,
      variant_index: a.variant_index,
      released_at: a.product.released_at,
    },
    {
      image_url: b.image_url,
      label: b.label,
      variant_index: b.variant_index,
      released_at: b.product.released_at,
    },
  )).map((variant) => ({
    variant_index: variant.variant_index,
    label: variant.label,
    artist: variant.artist,
    product: variant.product,
    media: {
      image_url: variant.image_url,
      thumbnail_url: thumbnailUrl(variant.image_url),
      scan_url: variant.scan_url,
      scan_thumbnail_url: variant.scan_thumb_url,
    },
    market: variant.market,
  }));
}

function hasMangaVariant(imageRows: CardImageRow[]): boolean {
  return imageRows.some((row) => row.label === "Manga Art");
}

function buildLegality(
  card: CardDetailRow,
  legalityRows: FormatLegalityRow[],
  cardBanRows: CardBanRow[],
  mangaExempt: boolean,
) {
  const now = new Date();
  const isReleased = card.released_at ? new Date(card.released_at) <= now : false;

  const bansByFormat = new Map<string, CardBanRow[]>();
  for (const ban of cardBanRows) {
    const rows = bansByFormat.get(ban.format_name) ?? [];
    rows.push(ban);
    bansByFormat.set(ban.format_name, rows);
  }

  const legalityObj: Record<string, {
    status: string;
    banned_at?: string;
    reason?: string;
    max_copies?: number;
    paired_with?: string[];
  }> = {};

  for (const row of legalityRows) {
    const bans = bansByFormat.get(row.format_name) ?? [];

    if (!isReleased) {
      const releaseDate = card.released_at ? new Date(card.released_at) : null;
      const status = releaseDate
        ? `Releases ${releaseDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
        : "unreleased";
      legalityObj[row.format_name] = { status };
    } else if (bans.length > 0) {
      const ban = bans[0];
      const entry: typeof legalityObj[string] = { status: ban.ban_type };
      if (ban.banned_at) entry.banned_at = ban.banned_at;
      if (ban.reason) entry.reason = ban.reason;
      if (ban.ban_type === "restricted" && ban.max_copies != null) {
        entry.max_copies = ban.max_copies;
      }
      if (ban.ban_type === "pair") {
        entry.paired_with = bans
          .filter((b) => b.paired_card_number)
          .map((b) => b.paired_card_number!);
      }
      legalityObj[row.format_name] = entry;
    } else if (row.legal || mangaExempt) {
      legalityObj[row.format_name] = { status: "legal" };
    } else {
      legalityObj[row.format_name] = { status: "not_legal" };
    }
  }

  return legalityObj;
}

function buildCardDetail(
  card: CardDetailRow,
  imageRows: CardImageRow[],
  legalityRows: FormatLegalityRow[],
  cardBanRows: CardBanRow[],
  languageRows: CardLanguageRow[],
) {
  return {
    ...formatCard(card),
    set_name: card.set_product_name ?? setName(card.true_set_code),
    variants: buildVariants(imageRows),
    legality: buildLegality(card, legalityRows, cardBanRows, hasMangaVariant(imageRows)),
    available_languages: languageRows.map((row) => row.language),
  };
}

export async function cardsRoutes(app: FastifyInstance, options: CardsRoutesOptions = {}) {
  const runQuery = options.queryExecutor ?? query;

  // GET /v1/cards — search/list
  app.get("/cards", { schema: cardsSearchRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;

    const page = Math.max(1, parseInt(qs.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "20", 10)));
    const offset = (page - 1) * limit;
    const lang = qs.lang || "en";

    // Inline order:/dir: from q= override query params
    let sortKey = qs.sort || "card_number";
    let order = qs.order === "desc" ? "DESC" : "ASC";
    let inlineSortProvided = false;
    let sequentialNameQuery = "";
    let typeBoostValues: string[] = [];
    let rarityBoostValues: string[] = [];
    let variantBoostValues: string[] = [];
    const unique = qs.unique || "prints";

    const conditions: string[] = ["c.language = $1"];
    const params: unknown[] = [lang];
    let paramIdx = 2;

    // Simple query params
    if (qs.name) {
      conditions.push(`c.name ILIKE $${paramIdx}`);
      params.push(`%${qs.name}%`);
      paramIdx++;
    }
    if (qs.set) {
      conditions.push(`c.true_set_code = $${paramIdx}`);
      params.push(qs.set.toUpperCase());
      paramIdx++;
    }
    if (qs.color) {
      const colors = normalizeColorFilter(qs.color);
      if (colors.length === 0) {
        reply.code(400);
        return { error: { status: 400, message: `Invalid color: ${qs.color}` } };
      }
      conditions.push(`c.color && $${paramIdx}::text[]`);
      params.push(toPgTextArrayLiteral(colors));
      paramIdx++;
    }
    if (qs.type) {
      conditions.push(`c.card_type ILIKE $${paramIdx}`);
      params.push(qs.type);
      paramIdx++;
    }
    if (qs.cost) {
      conditions.push(`c.cost = $${paramIdx}`);
      params.push(parseInt(qs.cost, 10));
      paramIdx++;
    }
    if (qs.power) {
      conditions.push(`c.power = $${paramIdx}`);
      params.push(parseInt(qs.power, 10));
      paramIdx++;
    }
    if (qs.counter) {
      conditions.push(`c.counter = $${paramIdx}`);
      params.push(parseInt(qs.counter, 10));
      paramIdx++;
    }
    if (qs.rarity) {
      const rarity = normalizeCardRarity(qs.rarity);
      if (!rarity) {
        reply.code(400);
        return { error: { status: 400, message: `Invalid rarity: ${qs.rarity}` } };
      }
      conditions.push(`c.rarity = $${paramIdx}`);
      params.push(rarity);
      paramIdx++;
    }
    if (qs.artist) {
      conditions.push(artistFilterSql(`$${paramIdx}`, unique));
      params.push(`%${qs.artist}%`);
      paramIdx++;
    }

    // Advanced search query
    if (qs.q) {
      try {
        const ast = parseSearch(qs.q);
        // Extract inline sort/direction before compiling
        const inlineSort = extractInlineSort(ast);
        inlineSortProvided = Boolean(inlineSort.order);
        if (inlineSort.order) sortKey = inlineSort.order;
        if (inlineSort.direction) order = inlineSort.direction === "desc" ? "DESC" : "ASC";
        sequentialNameQuery = collectPositiveNameTerms(ast).join(" ").trim();
        typeBoostValues = uniqueStrings(collectPositiveFilterValues(ast, "type"));
        rarityBoostValues = uniqueStrings(collectPositiveFilterValues(ast, "rarity"));
        variantBoostValues = uniqueStrings(collectPositiveFilterValues(ast, "is"))
          .filter((value) => NATURAL_LANGUAGE_VARIANT_KEYWORDS[value.toLowerCase()] !== undefined);
        const compiled = compileSearch(ast, paramIdx, unique);
        if (compiled.sql) {
          conditions.push(compiled.sql);
          params.push(...compiled.params);
          paramIdx += compiled.params.length;
        }
      } catch (e: any) {
        reply.code(400);
        return { error: { status: 400, message: e.message } };
      }
    }

    // Validate sort (after q parsing so inline order: is included)
    // Map some aliases
    if (sortKey === "number") sortKey = "card_number";
    if (sortKey === "set") sortKey = "card_number";
    if (sortKey === "usd") sortKey = "market_price";
    const wantsRelevanceSort = sortKey === "relevance";
    if (wantsRelevanceSort && !qs.q) {
      reply.code(400);
      return { error: { status: 400, message: "Relevance sort requires q" } };
    }
    const sortCol = wantsRelevanceSort
      ? null
      : sortKey === "artist"
        ? artistSortSql(unique)
        : VALID_SORTS[sortKey];
    if (!wantsRelevanceSort && !sortCol) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid sort: ${sortKey}` } };
    }

    const where = conditions.join(" AND ");
    const needsPriceJoin = sortKey === "market_price";
    const useSearchRank = Boolean(qs.q)
      && (
        Boolean(sequentialNameQuery)
        || typeBoostValues.length > 0
        || rarityBoostValues.length > 0
        || variantBoostValues.length > 0
      )
      && (wantsRelevanceSort || (!qs.sort && !inlineSortProvided));

    const filterParams = [...params];
    const rowParams = [...params];
    let rowParamIdx = paramIdx;

    let searchRankSql = "0";
    let hasSearchRankComponent = false;
    if (useSearchRank && sequentialNameQuery) {
      const normalizedCardNameSql = `regexp_replace(lower(COALESCE(c.name, '')), '[^a-z0-9]+', '', 'g')`;
      const squeezedCardNameSql = `regexp_replace(${normalizedCardNameSql}, '([a-z0-9])\\1+', '\\1', 'g')`;
      const normalizedSequentialNameQuery = normalizeSearchText(sequentialNameQuery);
      const squeezedSequentialNameQuery = squeezeRepeatedChars(normalizedSequentialNameQuery);

      const rawExactParam = `$${rowParamIdx++}`;
      rowParams.push(sequentialNameQuery);
      const normalizedExactParam = `$${rowParamIdx++}`;
      rowParams.push(normalizedSequentialNameQuery);
      const rawPrefixParam = `$${rowParamIdx++}`;
      rowParams.push(`${sequentialNameQuery}%`);
      const normalizedPrefixParam = `$${rowParamIdx++}`;
      rowParams.push(`${normalizedSequentialNameQuery}%`);
      const rawContainsParam = `$${rowParamIdx++}`;
      rowParams.push(`%${sequentialNameQuery}%`);
      const normalizedContainsParam = `$${rowParamIdx++}`;
      rowParams.push(`%${normalizedSequentialNameQuery}%`);
      const squeezedContainsParam = `$${rowParamIdx++}`;
      rowParams.push(`%${squeezedSequentialNameQuery}%`);

      searchRankSql = `CASE
        WHEN lower(COALESCE(c.name, '')) = lower(${rawExactParam}) THEN 700
        WHEN ${normalizedCardNameSql} = ${normalizedExactParam} THEN 650
        WHEN c.name ILIKE ${rawPrefixParam} THEN 600
        WHEN ${normalizedCardNameSql} LIKE ${normalizedPrefixParam} THEN 550
        WHEN c.name ILIKE ${rawContainsParam} THEN 500
        WHEN ${normalizedCardNameSql} LIKE ${normalizedContainsParam} THEN 450
        WHEN ${squeezedCardNameSql} LIKE ${squeezedContainsParam} THEN 400
        ELSE 0
      END`;
      hasSearchRankComponent = true;
    }

    if (useSearchRank) {
      for (const typeValue of typeBoostValues) {
        const typeParam = `$${rowParamIdx++}`;
        rowParams.push(typeValue);
        searchRankSql += ` + CASE WHEN c.card_type ILIKE ${typeParam} THEN 120 ELSE 0 END`;
        hasSearchRankComponent = true;
      }

      for (const rarityValue of rarityBoostValues) {
        const rarityParam = `$${rowParamIdx++}`;
        rowParams.push(rarityValue);
        searchRankSql += ` + CASE WHEN c.rarity = ${rarityParam} THEN 100 ELSE 0 END`;
        hasSearchRankComponent = true;
      }

      for (const variantValue of variantBoostValues) {
        const variantParam = `$${rowParamIdx++}`;
        rowParams.push(NATURAL_LANGUAGE_VARIANT_KEYWORDS[variantValue.toLowerCase()]);
        searchRankSql += ` + CASE WHEN EXISTS (
          SELECT 1 FROM card_images ci_variant_boost
          WHERE ci_variant_boost.card_id = c.id AND ci_variant_boost.label = ${variantParam}
        ) THEN 90 ELSE 0 END`;
        hasSearchRankComponent = true;
      }
    }
    const relevanceActive = Boolean(useSearchRank && hasSearchRankComponent);
    const requestedSort = (wantsRelevanceSort || (relevanceActive && !qs.sort && !inlineSortProvided))
      ? "relevance"
      : sortKey;
    const requestedOrder = order === "DESC" ? "desc" : "asc";
    const appliedSort = relevanceActive
      ? "relevance"
      : wantsRelevanceSort
        ? "card_number"
        : sortKey;
    const appliedOrder = relevanceActive ? "desc" : requestedOrder;
    const searchMeta = {
      sort_requested: requestedSort,
      sort_applied: appliedSort,
      order_requested: requestedOrder,
      order_applied: appliedOrder,
      relevance_active: relevanceActive,
    };
    const fallbackSortSql = sortCol ?? VALID_SORTS.card_number;
    const primaryOrderSql = useSearchRank && searchRankSql
      ? `${searchRankSql} DESC`
      : `${fallbackSortSql} ${order} NULLS LAST`;

    const cardPriceJoin = `LEFT JOIN LATERAL (
         SELECT tp.tcgplayer_url, pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM card_images ci2
         LEFT JOIN products ip2 ON ip2.id = ci2.product_id
         LEFT JOIN LATERAL (
           SELECT tp2.tcgplayer_product_id, tp2.tcgplayer_url, tp2.sub_type
           FROM tcgplayer_products tp2
           WHERE tp2.card_image_id = ci2.id
           ORDER BY ${tcgplayerProductOrderSql("tp2")}
           LIMIT 1
         ) tp ON true
         LEFT JOIN LATERAL (
           SELECT market_price, low_price, mid_price, high_price
           FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE ci2.card_id = c.id AND ci2.classified = true
         ORDER BY ${variantDisplayOrderSql("ci2", "ip2")}
         LIMIT 1
       ) latest_price ON true`;

    const variantPriceJoin = `LEFT JOIN LATERAL (
         SELECT tp.tcgplayer_url, pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM tcgplayer_products tp
         LEFT JOIN LATERAL (
           SELECT market_price, low_price, mid_price, high_price
           FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE tp.card_image_id = ci.id
         ORDER BY ${tcgplayerProductOrderSql("tp")}
         LIMIT 1
       ) latest_price ON true`;

    if (unique === "prints") {
      // One row per classified variant
      const [countResult, rows] = await Promise.all([
        runQuery<{ total: string }>(
          `SELECT COUNT(*) AS total
           FROM cards c
           LEFT JOIN products p ON p.id = c.product_id
           JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true
           LEFT JOIN products ip ON ip.id = ci.product_id
           WHERE ${where}`,
          filterParams,
        ),
        runQuery<CardRow & {
          image_url: string | null;
          scan_url: string | null;
          scan_thumb_url: string | null;
          tcgplayer_url: string | null;
          market_price: string | null;
          low_price: string | null;
          mid_price: string | null;
          high_price: string | null;
          label: string | null;
          variant_index: number;
          variant_product_name: string | null;
        }>(
          `SELECT c.*, p.name AS product_name, p.released_at,
                  ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
                  ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_url,
                  ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
                  latest_price.tcgplayer_url, latest_price.market_price, latest_price.low_price, latest_price.mid_price, latest_price.high_price,
                  ci.label, ci.variant_index,
                  ci.artist,
                  ip.name AS variant_product_name
           FROM cards c
           LEFT JOIN products p ON p.id = c.product_id
           JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true
           LEFT JOIN products ip ON ip.id = ci.product_id
           ${variantPriceJoin}
           WHERE ${where}
           ORDER BY ${primaryOrderSql}, c.card_number ASC, ci.variant_index ASC
           LIMIT $${rowParamIdx} OFFSET $${rowParamIdx + 1}`,
          [...rowParams, limit, offset],
        ),
      ]);
      const total = parseInt(countResult.rows[0].total, 10);

      reply.header("Cache-Control", "public, max-age=3600");
      return {
        data: rows.rows.map((row) => ({
          ...formatCard(row),
          label: row.label,
          variant_index: row.variant_index,
          variant_product_name: row.variant_product_name,
        })),
        pagination: { page, limit, total, has_more: offset + limit < total },
        meta: searchMeta,
      };
    }

    // unique=cards — one row per card (original behavior)
    const [countResult, rows] = await Promise.all([
      runQuery<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM cards c
         LEFT JOIN products p ON p.id = c.product_id
         WHERE ${where}`,
        filterParams,
      ),
      runQuery<CardRow & {
        image_url: string | null;
        scan_url: string | null;
        scan_thumb_url: string | null;
        tcgplayer_url: string | null;
        market_price: string | null;
        low_price: string | null;
        mid_price: string | null;
        high_price: string | null;
      }>(
        `SELECT c.*, p.name AS product_name, p.released_at,
                ${bestImageSubquery("c.id")} AS image_url,
                ${bestScanUrlSubquery("c.id")} AS scan_url,
                ${bestScanThumbSubquery("c.id")} AS scan_thumb_url,
                latest_price.tcgplayer_url, latest_price.market_price, latest_price.low_price, latest_price.mid_price, latest_price.high_price
         FROM cards c
         LEFT JOIN products p ON p.id = c.product_id
         ${cardPriceJoin}
         WHERE ${where}
         ORDER BY ${primaryOrderSql}, c.card_number ASC
         LIMIT $${rowParamIdx} OFFSET $${rowParamIdx + 1}`,
        [...rowParams, limit, offset],
      ),
    ]);
    const total = parseInt(countResult.rows[0].total, 10);

    reply.header("Cache-Control", "public, max-age=3600");
    return {
      data: rows.rows.map(formatCard),
      pagination: { page, limit, total, has_more: offset + limit < total },
      meta: searchMeta,
    };
  });

  // GET /v1/cards/autocomplete
  app.get("/cards/autocomplete", { schema: cardAutocompleteRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const q = qs.q || "";
    if (q.length < 2) {
      reply.code(400);
      return { error: { status: 400, message: "Query must be at least 2 characters" } };
    }

    const normalizedQ = normalizeSearchText(q);
    const normalizedNameSql = `regexp_replace(lower(name), '[^a-z0-9]+', '', 'g')`;
    const squeezedNormalizedNameSql = `regexp_replace(${normalizedNameSql}, '([a-z0-9])\\1+', '\\1', 'g')`;
    const rawLike = `%${q}%`;
    const normalizedLike = `%${normalizedQ}%`;
    const squeezedLike = `%${squeezeRepeatedChars(normalizedQ)}%`;

    const autocompleteWhere = [
      "language = 'en'",
      "AND",
      "(",
      `name ILIKE $1`,
      `OR ${normalizedNameSql} LIKE $2`,
      `OR ${squeezedNormalizedNameSql} LIKE $3`,
      ")",
    ].join(" ");

    const autocompleteRankSql = [
      "CASE",
      "WHEN lower(name) = lower($4) THEN 0",
      `WHEN ${normalizedNameSql} = $5 THEN 1`,
      "WHEN name ILIKE $6 THEN 2",
      `WHEN ${normalizedNameSql} LIKE $2 THEN 3`,
      `WHEN ${squeezedNormalizedNameSql} LIKE $3 THEN 4`,
      "ELSE 5",
      "END",
    ].join(" ");

    const params: unknown[] = [rawLike, normalizedLike, squeezedLike, q, normalizedQ, `${q}%`];

    const rows = await runQuery<{ name: string }>(
      `SELECT name
       FROM (
         SELECT name,
                MIN(${autocompleteRankSql}) AS sort_rank,
                MIN(LENGTH(name)) AS name_length
         FROM cards
         WHERE ${autocompleteWhere}
         GROUP BY name
       ) ranked_names
       ORDER BY sort_rank, name_length, name
       LIMIT 10`,
      params,
    );

    reply.header("Cache-Control", "public, max-age=3600");
    return { data: rows.rows.map((r: { name: string }) => r.name) };
  });

  app.post("/cards/batch", { schema: cardBatchRouteSchema }, async (req, reply) => {
    const body = (req.body ?? {}) as { card_numbers?: unknown; lang?: string };
    const requestedCardNumbers = normalizeRequestedCardNumbers(body.card_numbers);
    const lang = body.lang || "en";

    if (requestedCardNumbers.length === 0) {
      reply.code(400);
      return { error: { status: 400, message: "card_numbers must include at least one card number" } };
    }

    const cardResult = await runQuery<CardDetailRow>(
      `SELECT c.*, p.name AS product_name, p.released_at,
              (SELECT p2.name FROM products p2
               WHERE p2.language = c.language AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS set_product_name
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE UPPER(c.card_number) = ANY($1::text[]) AND c.language = $2`,
      [requestedCardNumbers, lang],
    );

    const cardsByNumber = new Map(
      cardResult.rows.map((row) => [row.card_number.toUpperCase(), row]),
    );
    const foundCards = requestedCardNumbers
      .map((cardNumber) => cardsByNumber.get(cardNumber))
      .filter((row): row is CardDetailRow => Boolean(row));

    if (foundCards.length === 0) {
      reply.header("Cache-Control", "public, max-age=86400");
      return {
        data: {},
        missing: requestedCardNumbers,
      };
    }

    const cardIds = foundCards.map((card) => card.id);
    const distinctBlocks = uniqueStrings(foundCards.map((card) => card.block).filter((block): block is string => Boolean(block)));
    const foundCardNumbers = foundCards.map((card) => card.card_number.toUpperCase());

    const [images, legality, cardBans, languages] = await Promise.all([
      runQuery<CardImageRow>(
        `SELECT ci.card_id, c.card_number, ci.variant_index,
                ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
                ci.artist,
                ci.label, ci.classified,
                ip.name AS product_name, ip.product_set_code, ip.released_at AS product_released_at,
                canonical_tp.tcgplayer_url AS canonical_tcgplayer_url,
                tp.tcgplayer_url, tp.sub_type,
                pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM card_images ci
         JOIN cards c ON c.id = ci.card_id
         LEFT JOIN products ip ON ip.id = ci.product_id
         LEFT JOIN LATERAL (
           SELECT tp2.tcgplayer_url
           FROM tcgplayer_products tp2
           WHERE tp2.card_image_id = ci.id
           ORDER BY ${tcgplayerProductOrderSql("tp2")}
           LIMIT 1
         ) canonical_tp ON true
         LEFT JOIN tcgplayer_products tp ON tp.card_image_id = ci.id
         LEFT JOIN LATERAL (
           SELECT market_price, low_price, mid_price, high_price
           FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE ci.card_id = ANY($1::uuid[])
         ORDER BY c.card_number, ci.variant_index, ${tcgplayerProductOrderSql("tp")}`,
        [cardIds],
      ),
      distinctBlocks.length > 0
        ? runQuery<FormatLegalityRow>(
          `WITH requested_blocks AS (
             SELECT DISTINCT UNNEST($1::text[]) AS block
           )
           SELECT rb.block, f.name AS format_name,
                 COALESCE(BOOL_OR(${formatCardBlockLegalSql("rb.block", "flb", "f")}), false) AS legal
           FROM requested_blocks rb
           CROSS JOIN formats f
           LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id AND flb.block = rb.block
           GROUP BY rb.block, f.id, f.name`,
          [distinctBlocks],
        )
        : Promise.resolve({ rows: [] as FormatLegalityRow[] }),
      runQuery<CardBanRow>(
        `SELECT fb.card_number, f.name AS format_name, fb.ban_type, fb.max_copies, fb.banned_at, fb.reason, fb.paired_card_number
         FROM format_bans fb
         JOIN formats f ON f.id = fb.format_id
         WHERE UPPER(fb.card_number) = ANY($1::text[]) AND fb.unbanned_at IS NULL`,
        [foundCardNumbers],
      ),
      runQuery<CardLanguageRow>(
        `SELECT DISTINCT card_number, language
         FROM cards
         WHERE UPPER(card_number) = ANY($1::text[])
         ORDER BY card_number, language`,
        [foundCardNumbers],
      ),
    ]);

    const imagesByCardNumber = groupImagesByCardNumber(images.rows);
    const legalityByBlock = new Map<string, FormatLegalityRow[]>();
    for (const row of legality.rows) {
      const key = row.block ?? "";
      const rows = legalityByBlock.get(key) ?? [];
      rows.push(row);
      legalityByBlock.set(key, rows);
    }

    const bansByCardNumber = new Map<string, CardBanRow[]>();
    for (const row of cardBans.rows) {
      const key = row.card_number.toUpperCase();
      const rows = bansByCardNumber.get(key) ?? [];
      rows.push(row);
      bansByCardNumber.set(key, rows);
    }

    const languagesByCardNumber = new Map<string, CardLanguageRow[]>();
    for (const row of languages.rows) {
      const key = row.card_number.toUpperCase();
      const rows = languagesByCardNumber.get(key) ?? [];
      rows.push(row);
      languagesByCardNumber.set(key, rows);
    }

    const data = Object.fromEntries(foundCards.map((card) => {
      const key = card.card_number.toUpperCase();
      return [
        card.card_number,
        buildCardDetail(
          card,
          imagesByCardNumber.get(key) ?? [],
          legalityByBlock.get(card.block ?? "") ?? [],
          bansByCardNumber.get(key) ?? [],
          languagesByCardNumber.get(key) ?? [],
        ),
      ];
    }));

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data,
      missing: requestedCardNumbers.filter((cardNumber) => !cardsByNumber.has(cardNumber)),
    };
  });

  app.get("/cards/:card_number/text", { schema: cardPlainTextRouteSchema }, async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const lang = qs.lang || "en";

    const cardResult = await runQuery<CardRow>(
      `SELECT c.*, p.name AS product_name, p.released_at
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE c.card_number ILIKE $1 AND c.language = $2
       LIMIT 1`,
      [card_number, lang],
    );

    if (cardResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    reply.type("text/plain; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=86400");
    return formatCardPlainText(cardResult.rows[0]);
  });

  // GET /v1/cards/:card_number
  app.get("/cards/:card_number", { schema: cardDetailRouteSchema }, async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const lang = qs.lang || "en";

    const cardResult = await runQuery<CardRow & { set_product_name: string | null }>(
      `SELECT c.*, p.name AS product_name, p.released_at,
              (SELECT p2.name FROM products p2
               WHERE p2.language = c.language AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS set_product_name
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE c.card_number ILIKE $1 AND c.language = $2
       LIMIT 1`,
      [card_number, lang],
    );

    if (cardResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const card = cardResult.rows[0];

    const [images, legality, cardBans, languages] = await Promise.all([
      runQuery<CardImageRow>(
        `SELECT ci.card_id, c.card_number, ci.variant_index,
                ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
                ci.artist,
                ci.label, ci.classified,
                ip.name AS product_name, ip.product_set_code, ip.released_at AS product_released_at,
                canonical_tp.tcgplayer_url AS canonical_tcgplayer_url,
                tp.tcgplayer_url, tp.sub_type,
                pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM card_images ci
         JOIN cards c ON c.id = ci.card_id
         LEFT JOIN products ip ON ip.id = ci.product_id
         LEFT JOIN LATERAL (
           SELECT tp2.tcgplayer_url
           FROM tcgplayer_products tp2
           WHERE tp2.card_image_id = ci.id
           ORDER BY ${tcgplayerProductOrderSql("tp2")}
           LIMIT 1
         ) canonical_tp ON true
         LEFT JOIN tcgplayer_products tp ON tp.card_image_id = ci.id
         LEFT JOIN LATERAL (
           SELECT market_price, low_price, mid_price, high_price
           FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE ci.card_id = $1
         ORDER BY ci.variant_index, ${tcgplayerProductOrderSql("tp")}`,
        [card.id],
      ),
      runQuery<FormatLegalityRow>(
        `SELECT $1::text AS block, f.name AS format_name,
                COALESCE(BOOL_OR(${formatCardBlockLegalSql("$1", "flb", "f")}), false) AS legal
         FROM formats f
         LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id AND flb.block = $1
         GROUP BY f.id, f.name`,
        [card.block],
      ),
      runQuery<CardBanRow>(
        `SELECT fb.card_number, f.name AS format_name, fb.ban_type, fb.max_copies, fb.banned_at, fb.reason, fb.paired_card_number
         FROM format_bans fb
         JOIN formats f ON f.id = fb.format_id
         WHERE fb.card_number = $1 AND fb.unbanned_at IS NULL`,
        [card.card_number],
      ),
      runQuery<CardLanguageRow>(
        `SELECT DISTINCT card_number, language FROM cards WHERE card_number ILIKE $1 ORDER BY language`,
        [card_number],
      ),
    ]);

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: buildCardDetail(card, images.rows, legality.rows, cardBans.rows, languages.rows),
    };
  });
}
