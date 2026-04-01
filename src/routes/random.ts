import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { formatCard, CardRow } from "../format.js";
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

    return { data: formatCard(row.rows[0]) };
  });
}
