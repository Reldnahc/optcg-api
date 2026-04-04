import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { cardImageAssetPublicUrlSql } from "../format.js";
import { hasRunningTask, runConfiguredTask } from "./tasks.js";
import {
  adminRunPricesRouteSchema,
  adminScraperLogsRouteSchema,
  adminScraperStatusRouteSchema,
  adminStatsRouteSchema,
  adminWatcherTopicsRouteSchema,
} from "../schemas/admin.js";

export async function adminScraperRoutes(app: FastifyInstance) {
  app.get("/stats", { schema: adminStatsRouteSchema }, async () => {
    const [totalCardsResult, totalVariantsResult, cardsByLanguageResult, recentErrorsResult] = await Promise.all([
      query<{ total: string }>(`SELECT COUNT(*) AS total FROM cards`),
      query<{ total: string }>(`SELECT COUNT(*) AS total FROM card_images`),
      query<{ language: string; count: string }>(
        `SELECT language, COUNT(*) AS count
         FROM cards
         GROUP BY language
         ORDER BY language ASC`,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM scrape_log
         WHERE errors IS NOT NULL
           AND btrim(errors) <> ''
           AND ran_at >= NOW() - INTERVAL '7 days'`,
      ),
    ]);

    return {
      data: {
        total_cards: parseInt(totalCardsResult.rows[0]?.total ?? "0", 10),
        total_variants: parseInt(totalVariantsResult.rows[0]?.total ?? "0", 10),
        cards_by_language: cardsByLanguageResult.rows.map((row) => ({
          language: row.language,
          count: parseInt(row.count, 10),
        })),
        recent_errors: parseInt(recentErrorsResult.rows[0]?.count ?? "0", 10),
      },
    };
  });

  app.get("/scraper/status", { schema: adminScraperStatusRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

    const rows = await query<{
      id: string;
      ran_at: string;
      source: string | null;
      cards_added: number;
      cards_updated: number;
      errors: string | null;
      duration_ms: number | null;
    }>(
      `SELECT id, ran_at, source, cards_added, cards_updated, errors, duration_ms
       FROM scrape_log
       ORDER BY ran_at DESC
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/scraper/logs", { schema: adminScraperLogsRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

    const rows = await query<{
      id: string;
      ran_at: string;
      source: string | null;
      cards_added: number;
      cards_updated: number;
      errors: string | null;
      duration_ms: number | null;
    }>(
      `SELECT id, ran_at, source, cards_added, cards_updated, errors, duration_ms
       FROM scrape_log
       ORDER BY ran_at DESC
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/watcher/topics", { schema: adminWatcherTopicsRouteSchema }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

    const rows = await query<Record<string, unknown>>(
      `SELECT *
       FROM watched_topics
       ORDER BY seen_at DESC
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/ocr/status", async (_req, reply) => {
    const [statusCounts, sourceCounts] = await Promise.all([
      query<{ artist_ocr_status: string; count: string }>(
        `SELECT artist_ocr_status, COUNT(*) AS count
         FROM card_images
         GROUP BY artist_ocr_status
         ORDER BY artist_ocr_status ASC`,
      ),
      query<{ artist_source: string | null; count: string }>(
        `SELECT artist_source, COUNT(*) AS count
         FROM card_images
         GROUP BY artist_source
         ORDER BY artist_source ASC NULLS FIRST`,
      ),
    ]);

    reply.header("Cache-Control", "no-store");
    return {
      data: {
        by_status: statusCounts.rows.map((row) => ({
          status: row.artist_ocr_status,
          count: parseInt(row.count, 10),
        })),
        by_source: sourceCounts.rows.map((row) => ({
          source: row.artist_source,
          count: parseInt(row.count, 10),
        })),
      },
    };
  });

  app.get("/ocr/review", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));
    const status = (qs.status || "needs_review").trim();
    const lang = (qs.lang || "").trim().toLowerCase();
    const setCode = (qs.set || "").trim().toUpperCase();

    const allowedStatuses = new Set(["pending", "processing", "succeeded", "failed", "needs_review", "skipped"]);
    if (!allowedStatuses.has(status)) {
      reply.code(400);
      return { error: { status: 400, message: `Invalid OCR status: ${status}` } };
    }

    const conditions = [`ci.artist_ocr_status = $1`];
    const params: unknown[] = [status];
    let idx = 2;

    if (lang) {
      conditions.push(`c.language = $${idx}`);
      params.push(lang);
      idx++;
    }
    if (setCode) {
      conditions.push(`c.true_set_code = $${idx}`);
      params.push(setCode);
      idx++;
    }

    const rows = await query<{
      image_id: string;
      card_id: string;
      card_number: string;
      language: string;
      true_set_code: string;
      name: string;
      variant_index: number;
      label: string | null;
      image_url: string | null;
      scan_url: string | null;
      artist: string | null;
      artist_source: string | null;
      artist_ocr_status: string;
      artist_ocr_candidate: string | null;
      artist_ocr_confidence: string | null;
      artist_ocr_attempts: number;
      artist_ocr_last_error: string | null;
      artist_ocr_last_run_at: string | null;
      artist_ocr_source_url: string | null;
    }>(
      `SELECT
         ci.id AS image_id,
         ci.card_id,
         c.card_number,
         c.language,
         c.true_set_code,
         c.name,
         ci.variant_index,
         ci.label,
         ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
         ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_url,
         ci.artist,
         ci.artist_source,
         ci.artist_ocr_status,
         ci.artist_ocr_candidate,
         ci.artist_ocr_confidence,
         ci.artist_ocr_attempts,
         ci.artist_ocr_last_error,
         ci.artist_ocr_last_run_at,
         ci.artist_ocr_source_url
       FROM card_images ci
       JOIN cards c ON c.id = ci.card_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         ci.artist_ocr_last_run_at DESC NULLS LAST,
         c.card_number ASC,
         ci.variant_index ASC
       LIMIT $${idx}`,
      [...params, limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.post("/scraper/run", async (req, reply) => {
    const body = (req.body ?? {}) as { language?: unknown; set_code?: unknown; use_http?: unknown };
    const language = typeof body.language === "string" ? body.language.trim() : "";
    const setCode = typeof body.set_code === "string" ? body.set_code.trim().toUpperCase() : "";
    const useHttp = body.use_http === true;

    try {
      if (await hasRunningTask("SCRAPER")) {
        reply.code(409);
        return { error: { status: 409, message: "A scraper task is already running" } };
      }

      const result = await runConfiguredTask("SCRAPER", {
        ...(language || setCode
          ? {
              command: [
                "scrape",
                ...(useHttp ? ["--http"] : []),
                ...(language ? ["--lang", language] : []),
                ...(setCode ? [setCode] : []),
              ],
            }
          : {}),
      });
      return { data: result };
    } catch (error: any) {
      req.log.error({ err: error, language, setCode, useHttp }, "Failed to start scraper task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/prices/run", { schema: adminRunPricesRouteSchema }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      wipe?: unknown;
      wipe_empty_artifacts?: unknown;
      archive_date?: unknown;
      archive_from?: unknown;
      archive_to?: unknown;
      dedupe_links?: unknown;
    };
    const wipe = body.wipe === true;
    const wipeEmptyArtifacts = body.wipe_empty_artifacts === true;
    const dedupeLinks = body.dedupe_links === true;
    const archiveDate = typeof body.archive_date === "string" ? body.archive_date.trim() : "";
    const archiveFrom = typeof body.archive_from === "string" ? body.archive_from.trim() : "";
    const archiveTo = typeof body.archive_to === "string" ? body.archive_to.trim() : "";

    if (wipe && (wipeEmptyArtifacts || archiveDate || archiveFrom || archiveTo || dedupeLinks)) {
      reply.code(400);
      return { error: { status: 400, message: "wipe cannot be combined with archive sync" } };
    }
    if (wipeEmptyArtifacts && (archiveDate || archiveFrom || archiveTo || dedupeLinks || wipe)) {
      reply.code(400);
      return { error: { status: 400, message: "wipe_empty_artifacts must run by itself" } };
    }
    if (dedupeLinks && (archiveDate || archiveFrom || archiveTo)) {
      reply.code(400);
      return { error: { status: 400, message: "dedupe_links cannot be combined with archive sync" } };
    }
    if (dedupeLinks && (wipe || wipeEmptyArtifacts)) {
      reply.code(400);
      return { error: { status: 400, message: "dedupe_links cannot be combined with wipe" } };
    }
    if (archiveDate && (archiveFrom || archiveTo)) {
      reply.code(400);
      return { error: { status: 400, message: "archive_date cannot be combined with archive_from/archive_to" } };
    }
    if ((archiveFrom && !archiveTo) || (!archiveFrom && archiveTo)) {
      reply.code(400);
      return { error: { status: 400, message: "archive_from and archive_to are required together" } };
    }

    const command = ["prices"];
    if (wipe) {
      command.push("--wipe");
    } else if (wipeEmptyArtifacts) {
      command.push("--wipe-empty-artifacts");
    } else if (dedupeLinks) {
      command.push("--cleanup-placeholders");
    } else if (archiveDate) {
      command.push("--archive-date", archiveDate);
    } else if (archiveFrom && archiveTo) {
      command.push("--archive-from", archiveFrom, "--archive-to", archiveTo);
    }

    try {
      const result = await runConfiguredTask("PRICES", { command });
      return { data: result };
    } catch (error: any) {
      req.log.error(
        { err: error, wipe, wipeEmptyArtifacts, dedupeLinks, archiveDate, archiveFrom, archiveTo, command },
        "Failed to start prices task",
      );
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/watcher/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("WATCHER");
      return { data: result };
    } catch (error: any) {
      _req.log.error({ err: error }, "Failed to start watcher task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/formats/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("FORMATS");
      return { data: result };
    } catch (error: any) {
      _req.log.error({ err: error }, "Failed to start formats task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/ocr/run", async (req, reply) => {
    const body = (req.body ?? {}) as { limit?: unknown; dry_run?: unknown };
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : null;
    const dryRun = body.dry_run === true;
    const command = ["ocr"];
    if (limit != null) command.push(String(limit));
    if (dryRun) command.push("--dry-run");

    try {
      const result = await runConfiguredTask("OCR", { command });
      return { data: result };
    } catch (error: any) {
      req.log.error({ err: error, command }, "Failed to start OCR task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/ocr/:image_id/accept", async (req, reply) => {
    const { image_id } = req.params as { image_id: string };

    const updated = await query<{
      id: string;
      artist: string | null;
      artist_source: string | null;
      artist_ocr_status: string;
      artist_ocr_candidate: string | null;
      artist_ocr_confidence: string | null;
    }>(
      `UPDATE card_images
       SET artist = COALESCE(artist, artist_ocr_candidate),
           artist_source = CASE
             WHEN artist_ocr_candidate IS NOT NULL AND artist IS NULL THEN 'ocr'
             ELSE artist_source
           END,
           artist_ocr_status = CASE
             WHEN artist_ocr_candidate IS NOT NULL THEN 'succeeded'
             ELSE artist_ocr_status
           END,
           artist_ocr_last_error = NULL
       WHERE id = $1
       RETURNING id, artist, artist_source, artist_ocr_status, artist_ocr_candidate, artist_ocr_confidence`,
      [image_id],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "OCR image variant not found" } };
    }

    if (!updated.rows[0].artist_ocr_candidate && !updated.rows[0].artist) {
      reply.code(400);
      return { error: { status: 400, message: "No OCR candidate is available to accept" } };
    }

    return { data: updated.rows[0] };
  });

  app.post("/ocr/:image_id/reject", async (req, reply) => {
    const { image_id } = req.params as { image_id: string };

    const updated = await query<{
      id: string;
      artist_ocr_status: string;
    }>(
      `UPDATE card_images
       SET artist_ocr_status = 'failed',
           artist_ocr_candidate = NULL,
           artist_ocr_confidence = NULL,
           artist_ocr_last_error = 'Rejected by admin'
       WHERE id = $1
       RETURNING id, artist_ocr_status`,
      [image_id],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "OCR image variant not found" } };
    }

    return { data: updated.rows[0] };
  });

  app.post("/ocr/:image_id/reset", async (req, reply) => {
    const { image_id } = req.params as { image_id: string };

    const updated = await query<{
      id: string;
      artist_ocr_status: string;
    }>(
      `UPDATE card_images
       SET artist_ocr_status = 'pending',
           artist_ocr_candidate = NULL,
           artist_ocr_confidence = NULL,
           artist_ocr_last_error = NULL
       WHERE id = $1
       RETURNING id, artist_ocr_status`,
      [image_id],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "OCR image variant not found" } };
    }

    return { data: updated.rows[0] };
  });

  app.post("/ocr/:image_id/rerun", async (req, reply) => {
    const { image_id } = req.params as { image_id: string };

    const updated = await query<{
      id: string;
      artist_ocr_status: string;
    }>(
      `UPDATE card_images
       SET artist_ocr_status = 'pending',
           artist_ocr_candidate = NULL,
           artist_ocr_confidence = NULL,
           artist_ocr_last_error = NULL
       WHERE id = $1
       RETURNING id, artist_ocr_status`,
      [image_id],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "OCR image variant not found" } };
    }

    return { data: updated.rows[0] };
  });

  app.post("/thumbs/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("THUMBS");
      return { data: result };
    } catch (error: any) {
      _req.log.error({ err: error }, "Failed to start thumbs task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/wipe/run", async (req, reply) => {
    const body = (req.body ?? {}) as {
      language?: unknown;
      s3?: unknown;
      confirm?: unknown;
    };

    const language = typeof body.language === "string" ? body.language.trim().toLowerCase() : "";
    const wipeS3 = body.s3 === true;
    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";

    if (confirm !== "WIPE") {
      reply.code(400);
      return { error: { status: 400, message: 'confirm must equal "WIPE"' } };
    }

    if (language && !["en", "ja", "fr", "zh"].includes(language)) {
      reply.code(400);
      return { error: { status: 400, message: "language must be en, ja, fr, or zh" } };
    }

    const command = ["wipe"];
    if (language) {
      command.push("--lang", language);
    }
    if (wipeS3) {
      command.push("--s3");
    }

    try {
      const result = await runConfiguredTask("WIPE", { command });
      return { data: result };
    } catch (error: any) {
      req.log.error({ err: error, language, wipeS3, command }, "Failed to start wipe task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/variant-merge/run", async (req, reply) => {
    const body = (req.body ?? {}) as {
      card_number?: unknown;
      from_variant_index?: unknown;
      to_variant_index?: unknown;
      dry_run?: unknown;
    };

    const cardNumber = typeof body.card_number === "string" ? body.card_number.trim().toUpperCase() : "";
    const fromVariantIndex = typeof body.from_variant_index === "number" && Number.isInteger(body.from_variant_index)
      ? body.from_variant_index
      : null;
    const toVariantIndex = typeof body.to_variant_index === "number" && Number.isInteger(body.to_variant_index)
      ? body.to_variant_index
      : null;
    const dryRun = body.dry_run === true;

    if (!cardNumber) {
      reply.code(400);
      return { error: { status: 400, message: "card_number is required" } };
    }
    if (fromVariantIndex == null || fromVariantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "from_variant_index must be a non-negative integer" } };
    }
    if (toVariantIndex == null || toVariantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "to_variant_index must be a non-negative integer" } };
    }
    if (fromVariantIndex === toVariantIndex) {
      reply.code(400);
      return { error: { status: 400, message: "from_variant_index and to_variant_index must differ" } };
    }

    const command = [
      "cli",
      "merge-variant",
      cardNumber,
      String(fromVariantIndex),
      String(toVariantIndex),
      dryRun ? "--dry-run" : "--yes",
    ];

    try {
      const result = await runConfiguredTask("VARIANT_MERGE", { command });
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });
}
