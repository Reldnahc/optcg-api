import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { parseSearch, SearchNode } from "../search/parser.js";
import { compileSearch } from "../search/compiler.js";
import { CARD_RARITY_ORDER_SQL, normalizeCardRarity } from "../rarity.js";

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
import { formatCard, CardRow, LABEL_ORDER, labelOrder, LABEL_ORDER_SQL, setName, thumbnailUrl } from "../format.js";

const VALID_SORTS: Record<string, string> = {
  name: "c.name",
  cost: "c.cost",
  power: "c.power",
  card_number: "c.card_number",
  released: "p.released_at",
  rarity: CARD_RARITY_ORDER_SQL,
  color: "c.color[1]",
  artist: "c.artist",
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

export async function cardsRoutes(app: FastifyInstance) {
  // GET /v1/cards — search/list
  app.get("/cards", async (req, reply) => {
    const qs = req.query as Record<string, string>;

    const page = Math.max(1, parseInt(qs.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "20", 10)));
    const offset = (page - 1) * limit;
    const lang = qs.lang || "en";

    // Inline order:/dir: from q= override query params
    let sortKey = qs.sort || "card_number";
    let order = qs.order === "desc" ? "DESC" : "ASC";

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
      conditions.push(`c.color @> $${paramIdx}::text[]`);
      params.push(`{${qs.color.split(",").map((c) => c.trim().charAt(0).toUpperCase() + c.trim().slice(1).toLowerCase()).join(",")}}`);
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
      conditions.push(`c.artist ILIKE $${paramIdx}`);
      params.push(`%${qs.artist}%`);
      paramIdx++;
    }

    const unique = qs.unique || "prints";

    // Advanced search query
    if (qs.q) {
      try {
        const ast = parseSearch(qs.q);
        // Extract inline sort/direction before compiling
        const inlineSort = extractInlineSort(ast);
        if (inlineSort.order) sortKey = inlineSort.order;
        if (inlineSort.direction) order = inlineSort.direction === "desc" ? "DESC" : "ASC";
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
    const sortCol = VALID_SORTS[sortKey];
    if (!sortCol) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid sort: ${sortKey}` } };
    }

    const where = conditions.join(" AND ");
    const needsPriceJoin = sortKey === "market_price";

    const priceJoin = `LEFT JOIN LATERAL (
         SELECT tp.tcgplayer_product_id, pr.market_price
         FROM card_images ci2
         JOIN tcgplayer_products tp ON tp.card_image_id = ci2.id
         LEFT JOIN LATERAL (
           SELECT market_price FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE ci2.card_id = c.id AND ci2.is_default = true
         LIMIT 1
       ) latest_price ON true`;

    if (unique === "prints") {
      // One row per classified variant
      const [countResult, rows] = await Promise.all([
        query<{ total: string }>(
          `SELECT COUNT(*) AS total
           FROM cards c
           JOIN products p ON p.id = c.product_id
           JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true
           LEFT JOIN products ip ON ip.id = ci.product_id
           WHERE ${where}`,
          params,
        ),
        query<CardRow & { image_url: string | null; label: string | null; variant_index: number; variant_product_name: string | null }>(
          `SELECT c.*, p.name AS product_name, p.released_at,
                  ci.image_url, ci.label, ci.variant_index,
                  ip.name AS variant_product_name
           FROM cards c
           JOIN products p ON p.id = c.product_id
           JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true
           LEFT JOIN products ip ON ip.id = ci.product_id
           ${needsPriceJoin ? priceJoin : ""}
           WHERE ${where}
           ORDER BY ${sortCol} ${order} NULLS LAST, c.card_number ASC, ci.variant_index ASC
           LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, limit, offset],
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
      };
    }

    // unique=cards — one row per card (original behavior)
    const [countResult, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM cards c
         JOIN products p ON p.id = c.product_id
         WHERE ${where}`,
        params,
      ),
      query<CardRow & { image_url: string | null }>(
        `SELECT c.*, p.name AS product_name, p.released_at, ci_default.image_url
         FROM cards c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN LATERAL (
           SELECT image_url FROM card_images
           WHERE card_id = c.id AND classified = true
           ORDER BY ${LABEL_ORDER_SQL}
           LIMIT 1
         ) ci_default ON true
         ${needsPriceJoin ? priceJoin : ""}
         WHERE ${where}
         ORDER BY ${sortCol} ${order} NULLS LAST, c.card_number ASC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
    ]);
    const total = parseInt(countResult.rows[0].total, 10);

    reply.header("Cache-Control", "public, max-age=3600");
    return {
      data: rows.rows.map(formatCard),
      pagination: { page, limit, total, has_more: offset + limit < total },
    };
  });

  // GET /v1/cards/autocomplete
  app.get("/cards/autocomplete", async (req, reply) => {
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

    const rows = await query<{ name: string }>(
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

  // GET /v1/cards/:card_number
  app.get("/cards/:card_number", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const lang = qs.lang || "en";

    const cardResult = await query<CardRow & { set_product_name: string | null }>(
      `SELECT c.*, p.name AS product_name, p.released_at,
              (SELECT p2.name FROM products p2
               WHERE p2.language = c.language AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS set_product_name
       FROM cards c
       JOIN products p ON p.id = c.product_id
       WHERE c.card_number ILIKE $1 AND c.language = $2
       LIMIT 1`,
      [card_number, lang],
    );

    if (cardResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const card = cardResult.rows[0];

    // Run images, manga check, legality, and available languages in parallel
    const [images, hasManga, legality, cardBans, languages] = await Promise.all([
      query<{
        variant_index: number;
        image_url: string | null;
        scan_url: string | null;
        label: string | null;
        classified: boolean;
        is_default: boolean;
        product_name: string | null;
        product_released_at: string | null;
        canonical_tcgplayer_url: string | null;
        tcgplayer_url: string | null;
        market_price: string | null;
        low_price: string | null;
        mid_price: string | null;
        high_price: string | null;
        sub_type: string | null;
      }>(
        `SELECT ci.variant_index, ci.image_url, ci.scan_url, ci.label, ci.classified, ci.is_default,
                ip.name AS product_name, ip.released_at AS product_released_at,
                canonical_tp.tcgplayer_url AS canonical_tcgplayer_url,
                tp.tcgplayer_url, tp.sub_type,
                pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM card_images ci
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
      query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM card_images ci WHERE ci.card_id = $1 AND ci.label = 'Manga Art') AS exists`,
        [card.id],
      ),
      query<{
        format_name: string;
        legal: boolean;
      }>(
        `SELECT f.name AS format_name,
                BOOL_AND(flb.legal) AS legal
         FROM formats f
         LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id AND flb.block = $1
         GROUP BY f.id, f.name`,
        [card.block],
      ),
      query<{
        format_name: string;
        ban_type: string;
        max_copies: number | null;
        banned_at: string;
        reason: string | null;
        paired_card_number: string | null;
      }>(
        `SELECT f.name AS format_name, fb.ban_type, fb.max_copies, fb.banned_at, fb.reason, fb.paired_card_number
         FROM format_bans fb
         JOIN formats f ON f.id = fb.format_id
         WHERE fb.card_number = $1 AND fb.unbanned_at IS NULL`,
        [card.card_number],
      ),
      query<{ language: string }>(
        `SELECT DISTINCT language FROM cards WHERE card_number ILIKE $1 ORDER BY language`,
        [card_number],
      ),
    ]);

    const mangaExempt = hasManga.rows[0].exists;

    // Determine if the card is released
    const now = new Date();
    const isReleased = card.released_at ? new Date(card.released_at) <= now : false;

    // Group classified images by variant, aggregate prices by sub_type
    const imageMap = new Map<number, {
      variant_index: number;
      image_url: string | null;
      scan_url: string | null;
      label: string | null;
      is_default: boolean;
      product_name: string | null;
      product_released_at: string | null;
      tcgplayer_url: string | null;
      prices: Record<string, {
        market_price: string | null;
        low_price: string | null;
        mid_price: string | null;
        high_price: string | null;
        tcgplayer_url: string | null;
      }>;
    }>();

    for (const img of images.rows) {
      if (!img.classified) continue;
      let entry = imageMap.get(img.variant_index);
      if (!entry) {
        entry = {
          variant_index: img.variant_index,
          image_url: img.image_url,
          scan_url: img.scan_url,
          label: img.label,
          is_default: img.is_default,
          product_name: img.product_name,
          product_released_at: img.product_released_at,
          tcgplayer_url: img.canonical_tcgplayer_url,
          prices: {},
        };
        imageMap.set(img.variant_index, entry);
      }
      if (!entry.tcgplayer_url && img.canonical_tcgplayer_url) {
        entry.tcgplayer_url = img.canonical_tcgplayer_url;
      }
      if (img.market_price !== null) {
        const key = img.sub_type || "Normal";
        entry.prices[key] = {
          market_price: img.market_price,
          low_price: img.low_price,
          mid_price: img.mid_price,
          high_price: img.high_price,
          tcgplayer_url: img.tcgplayer_url,
        };
      }
    }

    // Group bans by format
    const bansByFormat = new Map<string, typeof cardBans.rows>();
    for (const ban of cardBans.rows) {
      const arr = bansByFormat.get(ban.format_name) ?? [];
      arr.push(ban);
      bansByFormat.set(ban.format_name, arr);
    }

    const legalityObj: Record<string, {
      status: string;
      banned_at?: string;
      reason?: string;
      max_copies?: number;
      paired_with?: string[];
    }> = {};
    for (const row of legality.rows) {
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

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: {
        ...formatCard(card),
        set_name: card.set_product_name ?? setName(card.true_set_code),
        images: [...imageMap.values()].sort((a, b) => {
          // Sort by label priority first so Standard always leads,
          // then by product release date within the same label tier
          const labelDiff = labelOrder(a.label) - labelOrder(b.label);
          if (labelDiff !== 0) return labelDiff;
          const dateA = a.product_released_at ?? "";
          const dateB = b.product_released_at ?? "";
          if (dateA !== dateB) return dateA < dateB ? -1 : 1;
          return a.variant_index - b.variant_index;
        }).map(({ is_default: _, product_released_at: __, scan_url, ...rest }) => ({
          ...rest,
          thumbnail_url: thumbnailUrl(rest.image_url),
          ...(scan_url ? { scan_url } : {}),
        })),
        legality: legalityObj,
        available_languages: languages.rows.map((r) => r.language),
      },
    };
  });
}
