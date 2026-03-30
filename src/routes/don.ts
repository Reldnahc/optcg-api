import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { thumbnailUrl } from "../format.js";
import { donDetailRouteSchema, donListRouteSchema } from "../schemas/public.js";

export async function donRoutes(app: FastifyInstance) {
  // GET /v1/don
  app.get("/don", { schema: donListRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (qs.set) {
      conditions.push(`p.name ILIKE '%' || $${idx} || '%'`);
      params.push(qs.set);
      idx++;
    }
    if (qs.character) {
      conditions.push(`d.character ILIKE $${idx}`);
      params.push(`%${qs.character}%`);
      idx++;
    }
    if (qs.finish) {
      conditions.push(`d.finish ILIKE $${idx}`);
      params.push(qs.finish);
      idx++;
    }

    const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const sortKey = qs.sort === "set" ? "p.name" : "d.character";
    const order = qs.order === "desc" ? "DESC" : "ASC";

    const rows = await query<{
      id: string;
      character: string;
      finish: string;
      image_url: string | null;
      product_name: string;
    }>(
      `SELECT d.id, d.character, d.finish, d.image_url, p.name AS product_name
       FROM don_cards d
       JOIN products p ON p.id = d.product_id
       ${where}
       ORDER BY ${sortKey} ${order}`,
      params,
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: rows.rows.map((row) => ({
        ...row,
        thumbnail_url: thumbnailUrl(row.image_url),
      })),
    };
  });

  // GET /v1/don/:id
  app.get("/don/:id", { schema: donDetailRouteSchema }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const row = await query<{
      id: string;
      character: string;
      finish: string;
      image_url: string | null;
      product_name: string;
    }>(
      `SELECT d.id, d.character, d.finish, d.image_url, p.name AS product_name
       FROM don_cards d
       JOIN products p ON p.id = d.product_id
       WHERE d.id = $1 LIMIT 1`,
      [id],
    );

    if (row.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "DON card not found" } };
    }

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: {
        ...row.rows[0],
        thumbnail_url: thumbnailUrl(row.rows[0].image_url),
      },
    };
  });
}
