import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { scanProgressRouteSchema } from "../schemas/public.js";

export async function scansRoutes(app: FastifyInstance) {
  // GET /v1/scans/progress — per-set scan progress + overall totals
  app.get("/scans/progress", { schema: scanProgressRouteSchema }, async (req, reply) => {
    const qs = (req.query ?? {}) as { lang?: string };
    const language = (qs.lang || "en").trim().toLowerCase();

    if (!["en", "ja", "fr", "zh"].includes(language)) {
      reply.code(400);
      return { error: { status: 400, message: "language must be en, ja, fr, or zh" } };
    }

    const result = await query(`
      WITH card_scan_summary AS (
        SELECT
          c.id,
          c.true_set_code AS set_code,
          COUNT(ci.id)::int AS total_variants,
          COUNT(*) FILTER (
            WHERE ci.scan_url IS NOT NULL
              OR ci.scan_source_s3_key IS NOT NULL
          )::int AS scanned_variants,
          COALESCE(BOOL_OR(
            ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          ), false) AS has_any_scan,
          COALESCE(BOOL_OR(
            ci.image_url IS NOT NULL
            OR ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          ), false) AS has_any_image_or_scan
        FROM cards c
        LEFT JOIN card_images ci ON ci.card_id = c.id
        WHERE c.language = $1
        GROUP BY c.id, c.true_set_code
      )
      SELECT
        set_code,
        COUNT(*)::int AS total_cards,
        COUNT(*) FILTER (WHERE has_any_scan)::int AS scanned_cards,
        COUNT(*) FILTER (WHERE NOT has_any_image_or_scan)::int AS missing_image_cards,
        COALESCE(SUM(total_variants), 0)::int AS total_variants,
        COALESCE(SUM(scanned_variants), 0)::int AS scanned_variants
      FROM card_scan_summary
      GROUP BY set_code
      ORDER BY set_code ASC
    `, [language]);

    interface SetRow {
      set_code: string;
      total_cards: number;
      scanned_cards: number;
      missing_image_cards: number;
      total_variants: number;
      scanned_variants: number;
    }
    const sets = (result.rows as SetRow[]).map((r) => ({
      set_code: r.set_code,
      total_cards: r.total_cards,
      scanned_cards: r.scanned_cards,
      missing_image_cards: r.missing_image_cards,
      total_variants: r.total_variants,
      scanned_variants: r.scanned_variants,
    }));

    return {
      data: {
        language,
        total_cards: sets.reduce((sum, s) => sum + s.total_cards, 0),
        total_scanned_cards: sets.reduce((sum, s) => sum + s.scanned_cards, 0),
        total_missing_image_cards: sets.reduce((sum, s) => sum + s.missing_image_cards, 0),
        total_variants: sets.reduce((sum, s) => sum + s.total_variants, 0),
        total_scanned_variants: sets.reduce((sum, s) => sum + s.scanned_variants, 0),
        sets,
      },
    };
  });
}
