import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { formatBlockIsLegalSql } from "../formatLegality.js";
import { formatDetailRouteSchema, formatsListRouteSchema } from "../schemas/public.js";

export async function formatsRoutes(app: FastifyInstance) {
  // GET /v1/formats
  app.get("/formats", { schema: formatsListRouteSchema }, async (_req, reply) => {
    const rows = await query<{
      id: string;
      name: string;
      description: string | null;
      has_rotation: boolean;
      legal_blocks: string;
      ban_count: string;
    }>(
      `SELECT f.id, f.name, f.description, f.has_rotation,
              COUNT(DISTINCT flb.id) FILTER (WHERE ${formatBlockIsLegalSql("flb")}) AS legal_blocks,
              COUNT(DISTINCT fb.id) FILTER (WHERE fb.unbanned_at IS NULL) AS ban_count
       FROM formats f
       LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id
       LEFT JOIN format_bans fb ON fb.format_id = f.id
       GROUP BY f.id`,
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: rows.rows.map((r) => ({
        name: r.name,
        description: r.description,
        has_rotation: r.has_rotation,
        legal_blocks: parseInt(r.legal_blocks, 10),
        ban_count: parseInt(r.ban_count, 10),
      })),
    };
  });

  // GET /v1/formats/:format_name
  app.get("/formats/:format_name", { schema: formatDetailRouteSchema }, async (req, reply) => {
    const { format_name } = req.params as { format_name: string };

    const formatResult = await query<{
      id: string;
      name: string;
      description: string | null;
      has_rotation: boolean;
    }>(
      `SELECT id, name, description, has_rotation
       FROM formats WHERE name ILIKE $1 LIMIT 1`,
      [format_name],
    );

    if (formatResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Format not found" } };
    }

    const format = formatResult.rows[0];

    const blocks = await query<{
      block: string;
      legal: boolean;
      rotated_at: string | null;
    }>(
      `SELECT block, ${formatBlockIsLegalSql("format_legal_blocks")} AS legal, rotated_at
       FROM format_legal_blocks WHERE format_id = $1
       ORDER BY block`,
      [format.id],
    );

    const bans = await query<{
      card_number: string;
      ban_type: string;
      max_copies: number | null;
      paired_card_number: string | null;
      banned_at: string;
      reason: string | null;
    }>(
      `SELECT card_number, ban_type, max_copies, paired_card_number, banned_at, reason
       FROM format_bans WHERE format_id = $1 AND unbanned_at IS NULL
       ORDER BY ban_type, banned_at DESC`,
      [format.id],
    );

    reply.header("Cache-Control", "public, max-age=86400");
    return {
      data: {
        name: format.name,
        description: format.description,
        has_rotation: format.has_rotation,
        blocks: blocks.rows,
        bans: bans.rows.map((b) => ({
          card_number: b.card_number,
          type: b.ban_type,
          ...(b.max_copies != null ? { max_copies: b.max_copies } : {}),
          ...(b.paired_card_number ? { paired_with: b.paired_card_number } : {}),
          banned_at: b.banned_at,
          ...(b.reason ? { reason: b.reason } : {}),
        })),
      },
    };
  });
}
