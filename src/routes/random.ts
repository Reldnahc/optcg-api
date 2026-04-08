import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import {
  formatCard,
  CardRow,
  VariantRow,
  buildVariant,
  cardImageAssetPublicUrlSql,
  publicScanUrlSql,
  variantDisplayOrderSql,
} from "../format.js";
import { normalizeCardRarity } from "../rarity.js";
import { randomRouteSchema } from "../schemas/public.js";
import { normalizeColorFilter, toPgTextArrayLiteral } from "../colors.js";

export async function randomRoute(app: FastifyInstance) {
  app.get("/random", { schema: randomRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const lang = qs.lang || "en";

    const conditions: string[] = ["c.language = $1"];
    const params: unknown[] = [lang];
    let idx = 2;

    if (qs.set) {
      conditions.push(`c.true_set_code = $${idx}`);
      params.push(qs.set.toUpperCase());
      idx++;
    }
    if (qs.color) {
      const colors = normalizeColorFilter(qs.color);
      if (colors.length === 0) {
        reply.code(400);
        return { error: { status: 400, message: `Invalid color: ${qs.color}` } };
      }
      conditions.push(`c.color && $${idx}::text[]`);
      params.push(toPgTextArrayLiteral(colors));
      idx++;
    }
    if (qs.type) {
      conditions.push(`c.card_type ILIKE $${idx}`);
      params.push(qs.type);
      idx++;
    }
    if (qs.rarity) {
      const rarity = normalizeCardRarity(qs.rarity);
      if (!rarity) {
        reply.code(400);
        return { error: { status: 400, message: `Invalid rarity: ${qs.rarity}` } };
      }
      conditions.push(`c.rarity = $${idx}`);
      params.push(rarity);
      idx++;
    }

    const where = conditions.join(" AND ");

    const row = await query<CardRow>(
      `SELECT c.*, p.name AS product_name, p.released_at
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE ${where}
       ORDER BY RANDOM()
       LIMIT 1`,
      params,
    );

    if (row.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "No cards match filters" } };
    }

    const card = row.rows[0];
    const variants = await query<VariantRow>(
      `SELECT ci.variant_index, ci.name, ci.label, ci.artist,
              ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
              ${cardImageAssetPublicUrlSql("ci.id", "image_thumb", "ci.image_thumb_url")} AS image_thumb_url,
              ${publicScanUrlSql("ci.id", "ci.scan_url")} AS scan_display_url,
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
         ORDER BY CASE WHEN NULLIF(tp.sub_type, '') IS NULL OR tp.sub_type = 'Normal' THEN 0 ELSE 1 END
         LIMIT 1
       ) latest_price ON true
       WHERE ci.card_id = $1 AND ci.classified = true
       ORDER BY ${variantDisplayOrderSql("ci", "ip")}`,
      [(card as CardRow & { id: string }).id],
    );

    return { data: { ...formatCard(card), variants: variants.rows.map(buildVariant) } };
  });
}
