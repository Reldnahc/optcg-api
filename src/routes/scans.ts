import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { scanProgressMissingRouteSchema, scanProgressRouteSchema } from "../schemas/public.js";

interface ScanProgressGroupRow {
  bucket_key: string;
  bucket_label: string;
  bucket_type: "set_product" | "other_products";
  product_count: number;
  total_cards: number;
  scanned_cards: number;
  cards_without_image_or_scan: number;
  total_variants: number;
  scanned_variants: number;
  variants_without_image: number;
}

interface ScanProgressOverallRow {
  total_cards: number;
  total_scanned_cards: number;
  total_cards_without_image_or_scan: number;
  total_variants: number;
  total_scanned_variants: number;
  total_variants_without_image: number;
}

interface ScanProgressBucketMetaRow {
  bucket_key: string;
  bucket_label: string;
  bucket_type: "set_product" | "other_products";
  product_count: number;
}

interface MissingScanCardRow {
  card_number: string;
  has_any_image_or_scan: boolean;
}

interface MissingScanVariantRow {
  card_number: string;
  variant_index: number;
  label: string | null;
  product_name: string | null;
  product_set_code: string | null;
}

const PROGRESS_BUCKET_CTES = `
  WITH known_set_codes AS (
    SELECT DISTINCT true_set_code AS set_code
    FROM cards
    WHERE language = $1
  ),
  product_bucket_map AS (
    SELECT
      p.id,
      CASE
        WHEN p.product_set_code IS NOT NULL
          AND EXISTS (SELECT 1 FROM known_set_codes ks WHERE ks.set_code = p.product_set_code)
        THEN p.product_set_code
        ELSE '__other_products__'
      END AS bucket_key,
      CASE
        WHEN p.product_set_code IS NOT NULL
          AND EXISTS (SELECT 1 FROM known_set_codes ks WHERE ks.set_code = p.product_set_code)
        THEN p.product_set_code
        ELSE 'Other Products'
      END AS bucket_label,
      CASE
        WHEN p.product_set_code IS NOT NULL
          AND EXISTS (SELECT 1 FROM known_set_codes ks WHERE ks.set_code = p.product_set_code)
        THEN 'set_product'
        ELSE 'other_products'
      END AS bucket_type
    FROM products p
    WHERE p.language = $1
  ),
  bucket_product_counts AS (
    SELECT
      bucket_key,
      MIN(bucket_label) AS bucket_label,
      MIN(bucket_type) AS bucket_type,
      COUNT(*)::int AS product_count
    FROM product_bucket_map
    GROUP BY bucket_key
  ),
  card_bucket_summary AS (
    SELECT
      COALESCE(pbm.bucket_key, '__other_products__') AS bucket_key,
      c.card_number,
      COUNT(ci.id)::int AS total_variants,
      COUNT(*) FILTER (
        WHERE ci.id IS NOT NULL
          AND (
            ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          )
      )::int AS scanned_variants,
      COUNT(*) FILTER (
        WHERE ci.id IS NOT NULL
          AND ci.image_url IS NULL
      )::int AS variants_without_image,
      COALESCE(BOOL_OR(
        CASE
          WHEN ci.id IS NOT NULL
          THEN ci.scan_url IS NOT NULL OR ci.scan_source_s3_key IS NOT NULL
          ELSE false
        END
      ), false) AS has_any_scan,
      COALESCE(BOOL_OR(
        CASE
          WHEN ci.id IS NOT NULL
          THEN ci.image_url IS NOT NULL OR ci.scan_url IS NOT NULL OR ci.scan_source_s3_key IS NOT NULL
          ELSE false
        END
      ), false) AS has_any_image_or_scan
    FROM cards c
    LEFT JOIN card_images ci ON ci.card_id = c.id
    LEFT JOIN product_bucket_map pbm ON pbm.id = COALESCE(ci.product_id, c.product_id)
    WHERE c.language = $1
    GROUP BY COALESCE(pbm.bucket_key, '__other_products__'), c.card_number
  ),
  overall_card_summary AS (
    SELECT
      c.card_number,
      COUNT(ci.id)::int AS total_variants,
      COUNT(*) FILTER (
        WHERE ci.id IS NOT NULL
          AND (
            ci.scan_url IS NOT NULL
            OR ci.scan_source_s3_key IS NOT NULL
          )
      )::int AS scanned_variants,
      COUNT(*) FILTER (
        WHERE ci.id IS NOT NULL
          AND ci.image_url IS NULL
      )::int AS variants_without_image,
      COALESCE(BOOL_OR(
        CASE
          WHEN ci.id IS NOT NULL
          THEN ci.scan_url IS NOT NULL OR ci.scan_source_s3_key IS NOT NULL
          ELSE false
        END
      ), false) AS has_any_scan,
      COALESCE(BOOL_OR(
        CASE
          WHEN ci.id IS NOT NULL
          THEN ci.image_url IS NOT NULL OR ci.scan_url IS NOT NULL OR ci.scan_source_s3_key IS NOT NULL
          ELSE false
        END
      ), false) AS has_any_image_or_scan
    FROM cards c
    LEFT JOIN card_images ci ON ci.card_id = c.id
    WHERE c.language = $1
    GROUP BY c.card_number
  )
`;

export async function scansRoutes(app: FastifyInstance) {
  // GET /v1/scans/progress — product-bucket scan progress + overall totals
  app.get("/scans/progress", { schema: scanProgressRouteSchema }, async (req, reply) => {
    const qs = (req.query ?? {}) as { lang?: string };
    const language = (qs.lang || "en").trim().toLowerCase();

    if (!["en", "ja", "fr", "zh"].includes(language)) {
      reply.code(400);
      return { error: { status: 400, message: "language must be en, ja, fr, or zh" } };
    }

    const [groupsResult, overallResult] = await Promise.all([
      query<ScanProgressGroupRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          cbs.bucket_key,
          COALESCE(bpc.bucket_label, 'Other Products') AS bucket_label,
          COALESCE(bpc.bucket_type, 'other_products')::text AS bucket_type,
          COALESCE(bpc.product_count, 0)::int AS product_count,
          COUNT(*)::int AS total_cards,
          COUNT(*) FILTER (WHERE cbs.has_any_scan)::int AS scanned_cards,
          COUNT(*) FILTER (WHERE NOT cbs.has_any_image_or_scan)::int AS cards_without_image_or_scan,
          COALESCE(SUM(cbs.total_variants), 0)::int AS total_variants,
          COALESCE(SUM(cbs.scanned_variants), 0)::int AS scanned_variants,
          COALESCE(SUM(cbs.variants_without_image), 0)::int AS variants_without_image
        FROM card_bucket_summary cbs
        LEFT JOIN bucket_product_counts bpc ON bpc.bucket_key = cbs.bucket_key
        GROUP BY cbs.bucket_key, bpc.bucket_label, bpc.bucket_type, bpc.product_count
        ORDER BY
          CASE WHEN cbs.bucket_key = '__other_products__' THEN 1 ELSE 0 END,
          cbs.bucket_key ASC
      `, [language]),
      query<ScanProgressOverallRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          COUNT(*)::int AS total_cards,
          COUNT(*) FILTER (WHERE has_any_scan)::int AS total_scanned_cards,
          COUNT(*) FILTER (WHERE NOT has_any_image_or_scan)::int AS total_cards_without_image_or_scan,
          COALESCE(SUM(total_variants), 0)::int AS total_variants,
          COALESCE(SUM(scanned_variants), 0)::int AS total_scanned_variants,
          COALESCE(SUM(variants_without_image), 0)::int AS total_variants_without_image
        FROM overall_card_summary
      `, [language]),
    ]);

    const overall = overallResult.rows[0] ?? {
      total_cards: 0,
      total_scanned_cards: 0,
      total_cards_without_image_or_scan: 0,
      total_variants: 0,
      total_scanned_variants: 0,
      total_variants_without_image: 0,
    };

    return {
      data: {
        language,
        total_cards: overall.total_cards,
        total_scanned_cards: overall.total_scanned_cards,
        total_cards_without_image_or_scan: overall.total_cards_without_image_or_scan,
        total_variants: overall.total_variants,
        total_scanned_variants: overall.total_scanned_variants,
        total_variants_without_image: overall.total_variants_without_image,
        groups: groupsResult.rows.map((row) => ({
          bucket_key: row.bucket_key,
          bucket_label: row.bucket_label,
          bucket_type: row.bucket_type,
          product_count: row.product_count,
          total_cards: row.total_cards,
          scanned_cards: row.scanned_cards,
          cards_without_image_or_scan: row.cards_without_image_or_scan,
          total_variants: row.total_variants,
          scanned_variants: row.scanned_variants,
          variants_without_image: row.variants_without_image,
        })),
      },
    };
  });

  app.get("/scans/progress/missing/:bucket_key", { schema: scanProgressMissingRouteSchema }, async (req, reply) => {
    const { bucket_key } = req.params as { bucket_key: string };
    const qs = (req.query ?? {}) as { lang?: string };
    const language = (qs.lang || "en").trim().toLowerCase();

    if (!["en", "ja", "fr", "zh"].includes(language)) {
      reply.code(400);
      return { error: { status: 400, message: "language must be en, ja, fr, or zh" } };
    }

    const [bucketMetaResult, cardsMissingScanResult, variantsMissingScanResult, variantsWithoutImageResult] = await Promise.all([
      query<ScanProgressBucketMetaRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          bucket_key,
          bucket_label,
          bucket_type::text AS bucket_type,
          product_count
        FROM bucket_product_counts
        WHERE bucket_key = $2
        LIMIT 1
      `, [language, bucket_key]),
      query<MissingScanCardRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          card_number,
          has_any_image_or_scan
        FROM card_bucket_summary
        WHERE bucket_key = $2
          AND NOT has_any_scan
        ORDER BY card_number ASC
      `, [language, bucket_key]),
      query<MissingScanVariantRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          c.card_number,
          ci.variant_index,
          ci.label,
          p.name AS product_name,
          p.product_set_code
        FROM cards c
        JOIN card_images ci ON ci.card_id = c.id
        LEFT JOIN products p ON p.id = ci.product_id
        LEFT JOIN product_bucket_map pbm ON pbm.id = COALESCE(ci.product_id, c.product_id)
        WHERE c.language = $1
          AND COALESCE(pbm.bucket_key, '__other_products__') = $2
          AND ci.scan_url IS NULL
          AND ci.scan_source_s3_key IS NULL
        ORDER BY c.card_number ASC, ci.variant_index ASC
      `, [language, bucket_key]),
      query<MissingScanVariantRow>(`
        ${PROGRESS_BUCKET_CTES}
        SELECT
          c.card_number,
          ci.variant_index,
          ci.label,
          p.name AS product_name,
          p.product_set_code
        FROM cards c
        JOIN card_images ci ON ci.card_id = c.id
        LEFT JOIN products p ON p.id = ci.product_id
        LEFT JOIN product_bucket_map pbm ON pbm.id = COALESCE(ci.product_id, c.product_id)
        WHERE c.language = $1
          AND COALESCE(pbm.bucket_key, '__other_products__') = $2
          AND ci.image_url IS NULL
        ORDER BY c.card_number ASC, ci.variant_index ASC
      `, [language, bucket_key]),
    ]);

    const bucketMeta = bucketMetaResult.rows[0];
    if (!bucketMeta) {
      reply.code(404);
      return { error: { status: 404, message: "Scan progress bucket not found" } };
    }

    return {
      data: {
        bucket_key: bucketMeta.bucket_key,
        bucket_label: bucketMeta.bucket_label,
        bucket_type: bucketMeta.bucket_type,
        product_count: bucketMeta.product_count,
        cards_missing_scan: cardsMissingScanResult.rows,
        variants_missing_scan: variantsMissingScanResult.rows,
        variants_without_image: variantsWithoutImageResult.rows,
      },
    };
  });
}
