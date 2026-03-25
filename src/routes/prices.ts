import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";

export async function pricesRoute(app: FastifyInstance) {
  // GET /v1/prices/:card_number
  app.get("/prices/:card_number", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const days = Math.min(365, Math.max(1, parseInt(qs.days || "30", 10)));

    const rows = await query<{
      variant_index: number;
      label: string | null;
      sub_type: string | null;
      tcgplayer_url: string | null;
      market_price: string | null;
      low_price: string | null;
      mid_price: string | null;
      high_price: string | null;
      fetched_at: string;
    }>(
      `SELECT ci.variant_index, ci.label, tp.sub_type, tp.tcgplayer_url,
              pr.market_price, pr.low_price, pr.mid_price, pr.high_price, pr.fetched_at
       FROM cards c
       JOIN card_images ci ON ci.card_id = c.id
       JOIN tcgplayer_products tp ON tp.card_image_id = ci.id
       JOIN tcgplayer_prices pr ON pr.tcgplayer_product_id = tp.tcgplayer_product_id
         AND pr.sub_type IS NOT DISTINCT FROM tp.sub_type
       WHERE c.card_number ILIKE $1
         AND c.language = 'en'
         AND pr.fetched_at >= NOW() - ($2 || ' days')::interval
       ORDER BY ci.variant_index, tp.sub_type, pr.fetched_at DESC`,
      [card_number, days.toString()],
    );

    if (rows.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "No price data found" } };
    }

    reply.header("Cache-Control", "public, max-age=3600");
    return { data: rows.rows };
  });
}
