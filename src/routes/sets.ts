import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { bestImageSubquery, setName, thumbnailUrl } from "../format.js";

export async function setsRoutes(app: FastifyInstance) {
  // GET /v1/sets — all sets
  app.get("/sets", async (_req, reply) => {
    const rows = await query<{
      true_set_code: string;
      product_name: string | null;
      released_at: string | null;
      card_count: string;
    }>(
      `SELECT c.true_set_code,
              -- Pick the product where this set code is the primary (first) code.
              (SELECT p2.name FROM products p2
               WHERE p2.language = 'en' AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS product_name,
              MIN(p.released_at) AS released_at,
              COUNT(*) AS card_count
       FROM cards c
       JOIN products p ON p.id = c.product_id
       WHERE c.language = 'en'
       GROUP BY c.true_set_code
       ORDER BY MIN(p.released_at) DESC NULLS LAST, c.true_set_code`,
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
  app.get("/sets/:set_code", async (req, reply) => {
    const { set_code } = req.params as { set_code: string };
    const code = set_code.toUpperCase();

    const cards = await query<{
      card_number: string;
      name: string;
      card_type: string;
      rarity: string | null;
      color: string[];
      cost: number | null;
      power: number | null;
      image_url: string | null;
    }>(
      `SELECT c.card_number, c.name, c.card_type, c.rarity, c.color,
              c.cost, c.power,
              ${bestImageSubquery("c.id")} AS image_url
       FROM cards c
       WHERE c.true_set_code = $1 AND c.language = 'en'
       ORDER BY c.card_number`,
      [code],
    );

    if (cards.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Set not found" } };
    }

    // Get products that contain cards from this set
    const setProducts = await query<{
      name: string;
      set_codes: string[] | null;
      released_at: string | null;
    }>(
      `SELECT DISTINCT p.name, p.set_codes, p.released_at, array_length(p.set_codes, 1) AS code_count
       FROM products p
       WHERE p.set_codes @> ARRAY[$1]::text[] AND p.language = 'en'
       ORDER BY code_count ASC, p.released_at ASC NULLS LAST, p.name`,
      [code],
    );

    // Prefer the product where this set code is the primary (first) code
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
          name: p.name,
          set_codes: p.set_codes,
          released_at: p.released_at,
        })),
        cards: cards.rows.map((card) => ({
          ...card,
          thumbnail_url: thumbnailUrl(card.image_url),
        })),
      },
    };
  });
}
