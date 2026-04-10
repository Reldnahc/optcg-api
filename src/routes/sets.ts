import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import {
  buildVariant,
  cardImageAssetPublicUrlSql,
  CardRow,
  formatCard,
  setName,
  VariantRow,
  variantDisplayOrderSql,
} from "../format.js";
import { setDetailRouteSchema, setsListRouteSchema } from "../schemas/public.js";

type QueryExecutor = typeof query;

type SetsRoutesOptions = {
  queryExecutor?: QueryExecutor;
};

const VALID_SET_SORTS: Record<string, string> = {
  name: "name_sort",
  card_count: "card_count",
  released: "released_at",
  set_code: "true_set_code",
};

function tcgplayerProductOrderSql(alias: string): string {
  return `CASE
    WHEN NULLIF(${alias}.sub_type, '') IS NULL OR ${alias}.sub_type = 'Normal' THEN 0
    ELSE 1
  END, ${alias}.tcgplayer_product_id`;
}

function defaultOrderForSetSort(sort: string): "asc" | "desc" {
  return sort === "released" || sort === "card_count" ? "desc" : "asc";
}

export async function setsRoutes(app: FastifyInstance, options: SetsRoutesOptions = {}) {
  const runQuery = options.queryExecutor ?? query;

  // GET /v1/sets — all sets
  app.get("/sets", { schema: setsListRouteSchema, attachValidation: true }, async (req, reply) => {
    const qs = (req.query ?? {}) as { sort?: string; order?: string };
    const sortKey = qs.sort ?? "released";
    if (!VALID_SET_SORTS[sortKey]) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid sort: ${sortKey}` } };
    }

    const requestedOrder = (qs.order ?? "").toLowerCase();
    const order = requestedOrder
      ? (requestedOrder === "asc" || requestedOrder === "desc" ? requestedOrder : null)
      : defaultOrderForSetSort(sortKey);
    if (!order) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid order: ${qs.order}` } };
    }

    const sortSql = VALID_SET_SORTS[sortKey];
    const nullsSql = sortKey === "released" ? " NULLS LAST" : "";

    const rows = await runQuery<{
      true_set_code: string;
      product_name: string | null;
      name_sort: string;
      released_at: string | null;
      card_count: string;
    }>(
      `SELECT c.true_set_code,
              -- Pick the product where this set code is the primary (first) code.
              (SELECT p2.name FROM products p2
               WHERE p2.language = 'en' AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS product_name,
              COALESCE((SELECT p2.name FROM products p2
                        WHERE p2.language = 'en' AND p2.set_codes[1] = c.true_set_code
                        LIMIT 1), c.true_set_code) AS name_sort,
              MIN(p.released_at) AS released_at,
              COUNT(*) AS card_count
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE c.language = 'en'
       GROUP BY c.true_set_code
       ORDER BY ${sortSql} ${order.toUpperCase()}${nullsSql}, c.true_set_code ASC`,
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: rows.rows.map((r) => ({
        code: r.true_set_code,
        name: r.product_name ?? setName(r.true_set_code),
        released_at: r.released_at,
        card_count: parseInt(r.card_count, 10),
      })),
    };
  });

  // GET /v1/sets/:set_code
  app.get("/sets/:set_code", { schema: setDetailRouteSchema }, async (req, reply) => {
    const { set_code } = req.params as { set_code: string };
    const code = set_code.toUpperCase();

    const cards = await runQuery<CardRow>(
      `SELECT c.id,
              c.card_number,
              c.language,
              c.product_id,
              c.true_set_code,
              c.name,
              c.card_type,
              c.rarity,
              c.color,
              c.cost,
              c.power,
              c.counter,
              c.life,
              c.attribute,
              c.types,
              c.effect,
              c.trigger,
              c.block,
              p.name AS product_name,
              p.released_at
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE c.true_set_code = $1 AND c.language = 'en'
       ORDER BY c.card_number`,
      [code],
    );

    if (cards.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Set not found" } };
    }

    const variants = await runQuery<VariantRow & { card_id: string }>(
      `SELECT ci.card_id,
              ci.product_id::text AS product_id,
              ci.variant_index,
              ci.name,
              ci.label,
              ci.artist,
              ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
              ${cardImageAssetPublicUrlSql("ci.id", "image_thumb", "ci.image_thumb_url")} AS image_thumb_url,
              COALESCE(
                ${cardImageAssetPublicUrlSql("ci.id", "scan_display", "NULL")},
                ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")}
              ) AS scan_display_url,
              ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_full_url,
              ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
              ip.name AS product_name,
              ip.product_set_code AS product_set_code,
              ip.released_at AS product_released_at,
              latest_price.tcgplayer_url AS tcgplayer_url,
              latest_price.market_price,
              latest_price.low_price,
              latest_price.mid_price,
              latest_price.high_price
       FROM card_images ci
       JOIN cards c ON c.id = ci.card_id
       LEFT JOIN products ip ON ip.id = ci.product_id
       LEFT JOIN LATERAL (
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
       ) latest_price ON true
       WHERE c.true_set_code = $1
         AND c.language = 'en'
         AND ci.classified = true
       ORDER BY c.card_number, ${variantDisplayOrderSql("ci", "ip")}`,
      [code],
    );

    const variantsByCardId = new Map<string, VariantRow[]>();
    for (const row of variants.rows) {
      const list = variantsByCardId.get(row.card_id) ?? [];
      list.push(row);
      variantsByCardId.set(row.card_id, list);
    }

    const setProducts = await runQuery<{
      id: string;
      name: string;
      set_codes: string[] | null;
      released_at: string | null;
    }>(
      `SELECT DISTINCT p.id, p.name, p.set_codes, p.released_at, array_length(p.set_codes, 1) AS code_count
       FROM products p
       WHERE p.set_codes @> ARRAY[$1]::text[] AND p.language = 'en'
       ORDER BY code_count ASC, p.released_at ASC NULLS LAST, p.name`,
      [code],
    );

    const primaryProduct = setProducts.rows.find(
      (p) => p.set_codes && p.set_codes[0] === code
    );
    const name = primaryProduct?.name ?? setName(code);
    const releasedAt = primaryProduct?.released_at ?? setProducts.rows[0]?.released_at ?? null;

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: {
        code,
        name,
        released_at: releasedAt,
        card_count: cards.rows.length,
        products: setProducts.rows.map((p) => ({
          id: p.id,
          name: p.name,
          set_codes: p.set_codes,
          released_at: p.released_at,
        })),
        cards: cards.rows.map((card) => ({
          ...formatCard(card),
          variants: (variantsByCardId.get(card.id) ?? []).map(buildVariant),
        })),
      },
    };
  });
}
