import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";

export async function scansRoutes(app: FastifyInstance) {
  // GET /v1/scans/progress — per-set scan progress + overall totals
  app.get("/scans/progress", async () => {
    const result = await query(`
      SELECT
        c.true_set_code AS set_code,
        COUNT(DISTINCT c.id)::int AS total_cards,
        COUNT(DISTINCT CASE
          WHEN ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          THEN c.id
        END)::int AS scanned_cards,
        COUNT(DISTINCT CASE
          WHEN ci.image_url IS NULL
            AND ci.scan_url IS NULL
            AND ci.scan_source_s3_key IS NULL
          THEN c.id
        END)::int AS missing_image_cards,
        COUNT(ci.id)::int AS total_variants,
        COUNT(CASE
          WHEN ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          THEN 1
        END)::int AS scanned_variants
      FROM cards c
      LEFT JOIN card_images ci ON ci.card_id = c.id
      WHERE c.language = 'en'
      GROUP BY c.true_set_code
      ORDER BY c.true_set_code ASC
    `);

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
