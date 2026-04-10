import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import {
  buildVariant,
  cardImageAssetPublicUrlSql,
  CardRow,
  formatCard,
  publicScanUrlSql,
  VariantRow,
  variantDisplayOrderSql,
} from "../format.js";
import { productDetailRouteSchema, productsListRouteSchema } from "../schemas/public.js";

type QueryExecutor = typeof query;

type ProductsRoutesOptions = {
  queryExecutor?: QueryExecutor;
};

type ProductSummaryRow = {
  id: string;
  name: string;
  product_set_code: string | null;
  set_codes: string[] | null;
  released_at: string | null;
  variant_count: number;
  card_count: number;
};

type ProductDetailRow = ProductSummaryRow;

type ProductVariantCardRow = CardRow & VariantRow & {
  variant_name: string | null;
  variant_product_name: string | null;
};

const VALID_PRODUCT_SORTS: Record<string, string> = {
  name: "p.name",
  variant_count: "variant_count",
  card_count: "card_count",
  released: "p.released_at",
  product_set_code: "p.product_set_code",
};

function defaultOrderForProductSort(sort: string): "asc" | "desc" {
  return sort === "released" || sort === "variant_count" || sort === "card_count" ? "desc" : "asc";
}

const PRODUCT_SUMMARY_SQL = `
  SELECT p.id,
         p.name,
         p.product_set_code,
         p.set_codes,
         p.released_at,
         COUNT(DISTINCT ci.id) FILTER (WHERE ci.classified = true)::int AS variant_count,
         COUNT(DISTINCT ci.card_id) FILTER (WHERE ci.classified = true)::int AS card_count
  FROM products p
  LEFT JOIN card_images ci ON ci.product_id = p.id
  WHERE p.language = 'en'
  GROUP BY p.id
`;

export async function productsRoutes(app: FastifyInstance, options: ProductsRoutesOptions = {}) {
  const runQuery = options.queryExecutor ?? query;

  app.get("/products", { schema: productsListRouteSchema, attachValidation: true }, async (req, reply) => {
    const qs = (req.query ?? {}) as { sort?: string; order?: string };
    const sortKey = qs.sort ?? "released";
    if (!VALID_PRODUCT_SORTS[sortKey]) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid sort: ${sortKey}` } };
    }

    const requestedOrder = (qs.order ?? "").toLowerCase();
    const order = requestedOrder
      ? (requestedOrder === "asc" || requestedOrder === "desc" ? requestedOrder : null)
      : defaultOrderForProductSort(sortKey);
    if (!order) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid order: ${qs.order}` } };
    }

    const sortSql = VALID_PRODUCT_SORTS[sortKey];
    const nullsSql = sortKey === "released" || sortKey === "product_set_code" ? " NULLS LAST" : "";

    const products = await runQuery<ProductSummaryRow>(
      `${PRODUCT_SUMMARY_SQL}
       ORDER BY ${sortSql} ${order.toUpperCase()}${nullsSql}, p.name ASC, p.id ASC`,
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return { data: products.rows };
  });

  app.get("/products/:product_id", { schema: productDetailRouteSchema }, async (req, reply) => {
    const { product_id } = req.params as { product_id: string };

    const productResult = await runQuery<ProductDetailRow>(
      `${PRODUCT_SUMMARY_SQL}
       HAVING p.id::text = $1`,
      [product_id],
    );
    const product = productResult.rows[0];

    if (!product) {
      reply.code(404);
      return { error: { status: 404, message: "Product not found" } };
    }

    const variantCards = await runQuery<ProductVariantCardRow>(
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
              cp.name AS product_name,
              cp.released_at,
              ci.variant_index,
              ci.name AS variant_name,
              ci.label,
              ci.artist,
              ci.product_id::text AS product_id,
              ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
              ${cardImageAssetPublicUrlSql("ci.id", "image_thumb", "ci.image_thumb_url")} AS image_thumb_url,
              ${publicScanUrlSql("ci.id", "ci.scan_url")} AS scan_display_url,
              ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_full_url,
              ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
              ip.name AS variant_product_name,
              ip.product_set_code,
              ip.released_at AS product_released_at,
              NULL::text AS tcgplayer_url,
              NULL::text AS market_price,
              NULL::text AS low_price,
              NULL::text AS mid_price,
              NULL::text AS high_price
       FROM card_images ci
       JOIN cards c ON c.id = ci.card_id
       LEFT JOIN products cp ON cp.id = c.product_id
       LEFT JOIN products ip ON ip.id = ci.product_id
       WHERE ci.product_id::text = $1
         AND ci.classified = true
         AND c.language = 'en'
       ORDER BY c.card_number ASC, ${variantDisplayOrderSql("ci", "ip")}`,
      [product_id],
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: {
        ...product,
        cards: variantCards.rows.map((row) => ({
          ...formatCard(row),
          variants: [buildVariant({
            ...row,
            name: row.variant_name,
            product_name: row.variant_product_name,
          })],
        })),
      },
    };
  });
}
