import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { getScanIngestS3Config } from "./config.js";
import { hasRunningTask, runConfiguredTask } from "./tasks.js";

type BatchStatus = "uploaded" | "processing" | "processed" | "needs_review" | "failed" | "linked";
type ItemStatus = "pending_review" | "ready_to_link" | "linked" | "failed";

interface ArtistMatch {
  artist: string | null;
  score: number | null;
  matched: boolean;
}

interface PreparedScanItemInput {
  ordinal: number;
  raw_card_number: string | null;
  raw_artist: string | null;
  card_number: string | null;
  artist: string | null;
  artist_present: boolean;
  artist_confidence: string | null;
  card_number_confidence: string | null;
  processed_s3_key: string;
  processed_url: string;
  artist_crop_s3_key: string | null;
  artist_crop_url: string | null;
  footer_crop_s3_key: string | null;
  footer_crop_url: string | null;
  error: string | null;
}

let s3Client: S3Client | null = null;

function getS3Client(region: string): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region });
  }
  return s3Client;
}

function buildPublicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

function normalizeSlugPart(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
  return normalized || fallback;
}

function normalizeArtistForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

async function fetchArtistCatalog(): Promise<string[]> {
  const result = await query<{ artist: string }>(
    `SELECT DISTINCT artist
     FROM card_images
     WHERE artist IS NOT NULL
       AND btrim(artist) <> ''
     ORDER BY artist ASC`,
  );
  return result.rows.map((row) => row.artist);
}

function matchArtistCandidate(candidate: string | null, artists: string[]): ArtistMatch {
  const normalizedCandidate = normalizeArtistForMatch(candidate);
  if (!normalizedCandidate) {
    return { artist: null, score: null, matched: false };
  }

  let bestArtist: string | null = null;
  let bestScore = -1;

  for (const artist of artists) {
    const normalizedArtist = normalizeArtistForMatch(artist);
    if (!normalizedArtist) continue;
    const distance = levenshtein(normalizedCandidate, normalizedArtist);
    const maxLength = Math.max(normalizedCandidate.length, normalizedArtist.length, 1);
    const score = 1 - (distance / maxLength);
    if (score > bestScore) {
      bestScore = score;
      bestArtist = artist;
    }
  }

  if (!bestArtist || bestScore < 0.82) {
    return { artist: bestArtist, score: bestScore >= 0 ? Number(bestScore.toFixed(4)) : null, matched: false };
  }

  return {
    artist: bestArtist,
    score: Number(bestScore.toFixed(4)),
    matched: true,
  };
}

function decodeBase64Payload(value: string): Buffer {
  const normalized = value.includes(",") ? value.split(",").pop() ?? "" : value;
  return Buffer.from(normalized, "base64");
}

async function loadBatchForUpload(batchId: string): Promise<{ id: string; language: string; raw_prefix: string } | null> {
  const batchResult = await query<{ id: string; language: string; raw_prefix: string }>(
    `SELECT id, language, raw_prefix
     FROM scan_ingest_batches
     WHERE id = $1
     LIMIT 1`,
    [batchId],
  );

  return batchResult.rows[0] ?? null;
}

function deriveFileNameFromKey(key: string): string {
  const base = key.split("/").pop() ?? key;
  return base.replace(/^\d+-/, "");
}

function normalizePreparedCardNumber(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
  return /^[A-Z]{2,4}\d{0,2}-\d{2,4}$/.test(normalized) ? normalized : null;
}

function normalizePreparedArtist(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(/^illust\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

async function buildPreparedItemInsert(
  batchId: string,
  fileId: string,
  input: PreparedScanItemInput,
  artists: string[],
): Promise<{
  ordinal: number;
  status: ItemStatus;
  raw_card_number: string | null;
  raw_artist: string | null;
  card_number: string | null;
  artist: string | null;
  artist_present: boolean;
  artist_confidence: string | null;
  card_number_confidence: string | null;
  fuzzy_artist: string | null;
  fuzzy_artist_score: number | null;
  fuzzy_artist_matched: boolean;
  suggested_filename: string | null;
  filename_slug: string | null;
  duplicate_index: number;
  processed_s3_key: string;
  processed_url: string;
  artist_crop_s3_key: string | null;
  artist_crop_url: string | null;
  footer_crop_s3_key: string | null;
  footer_crop_url: string | null;
  error: string | null;
}> {
  const rawCardNumber = normalizePreparedCardNumber(input.raw_card_number ?? input.card_number);
  const rawArtist = input.artist_present
    ? normalizePreparedArtist(input.raw_artist ?? input.artist)
    : null;
  const cardNumber = normalizePreparedCardNumber(input.card_number ?? rawCardNumber);
  const artist = normalizePreparedArtist(input.artist ?? rawArtist);
  const matchedArtist = matchArtistCandidate(artist, artists);
  const acceptedArtist = matchedArtist.matched ? matchedArtist.artist : artist;
  const baseStem = `${cardNumber ?? "unknown_card"}_${normalizeSlugPart(acceptedArtist, "unknown_artist")}`;
  const duplicateResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM scan_ingest_items
     WHERE batch_id = $1
       AND (
         filename_slug = $2
         OR filename_slug LIKE $3
       )`,
    [batchId, baseStem, `${baseStem}__%`],
  );
  const duplicateIndex = parseInt(duplicateResult.rows[0]?.count ?? "0", 10);
  const filenameStem = duplicateIndex > 0 ? `${baseStem}__${duplicateIndex + 1}` : baseStem;
  const suggestedFilename = `${filenameStem}.png`;

  return {
    ordinal: input.ordinal,
    status: cardNumber && input.processed_url ? "ready_to_link" : "pending_review",
    raw_card_number: rawCardNumber,
    raw_artist: rawArtist,
    card_number: cardNumber,
    artist: acceptedArtist,
    artist_present: Boolean(input.artist_present),
    artist_confidence: input.artist_confidence,
    card_number_confidence: input.card_number_confidence,
    fuzzy_artist: matchedArtist.artist,
    fuzzy_artist_score: matchedArtist.score,
    fuzzy_artist_matched: matchedArtist.matched,
    suggested_filename: suggestedFilename,
    filename_slug: filenameStem,
    duplicate_index: duplicateIndex,
    processed_s3_key: input.processed_s3_key,
    processed_url: input.processed_url,
    artist_crop_s3_key: input.artist_crop_s3_key,
    artist_crop_url: input.artist_crop_url,
    footer_crop_s3_key: input.footer_crop_s3_key,
    footer_crop_url: input.footer_crop_url,
    error: input.error,
  };
}

async function syncBatchFilesFromS3(batchId: string): Promise<void> {
  const batch = await loadBatchForUpload(batchId);
  if (!batch) return;

  const s3 = getScanIngestS3Config();
  const client = getS3Client(s3.region);
  const prefix = `${batch.raw_prefix}/${batch.id}/`;
  const listed = await client.send(new ListObjectsV2Command({
    Bucket: s3.bucket,
    Prefix: prefix,
  }));

  const keys = (listed.Contents ?? [])
    .map((item) => item.Key ?? "")
    .filter(Boolean);

  if (keys.length === 0) return;

  const existing = await query<{ s3_key: string | null }>(
    `SELECT s3_key
     FROM scan_ingest_files
     WHERE batch_id = $1`,
    [batch.id],
  );
  const existingKeys = new Set(existing.rows.map((row) => row.s3_key).filter((value): value is string => Boolean(value)));

  for (const key of keys) {
    if (existingKeys.has(key)) continue;
    await query(
      `INSERT INTO scan_ingest_files (batch_id, file_name, s3_key, public_url, content_type, status)
       VALUES ($1, $2, $3, $4, NULL, 'uploaded')`,
      [batch.id, deriveFileNameFromKey(key), key, buildPublicUrl(s3.publicBaseUrl, key)],
    );
  }

  await query(
    `UPDATE scan_ingest_batches
     SET total_files = (
         SELECT COUNT(*) FROM scan_ingest_files WHERE batch_id = $1
       ),
       updated_at = NOW()
     WHERE id = $1`,
    [batch.id],
  );
}

async function refreshBatchStatus(batchId: string): Promise<void> {
  await query(
    `WITH item_counts AS (
       SELECT
         batch_id,
         COUNT(*) AS total_items,
         COUNT(*) FILTER (WHERE status = 'linked') AS linked_items,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_items,
         COUNT(*) FILTER (WHERE status IN ('pending_review', 'ready_to_link')) AS review_items
       FROM scan_ingest_items
       WHERE batch_id = $1
       GROUP BY batch_id
     ),
     file_counts AS (
       SELECT
         batch_id,
         COUNT(*) AS total_files,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_files
       FROM scan_ingest_files
       WHERE batch_id = $1
       GROUP BY batch_id
     )
     UPDATE scan_ingest_batches b
     SET total_files = COALESCE(f.total_files, 0),
         total_items = COALESCE(i.total_items, 0),
         status = CASE
           WHEN COALESCE(f.failed_files, 0) > 0 AND COALESCE(i.total_items, 0) = 0 THEN 'failed'
           WHEN COALESCE(i.total_items, 0) = 0 THEN b.status
           WHEN COALESCE(i.review_items, 0) > 0 THEN 'needs_review'
           WHEN COALESCE(i.linked_items, 0) = COALESCE(i.total_items, 0) THEN 'linked'
           ELSE 'processed'
         END,
         processed_at = CASE
           WHEN COALESCE(i.total_items, 0) > 0 THEN NOW()
           ELSE b.processed_at
         END,
         updated_at = NOW()
     FROM item_counts i
     FULL JOIN file_counts f ON f.batch_id = i.batch_id
     WHERE b.id = COALESCE(i.batch_id, f.batch_id)
       AND b.id = $1`,
    [batchId],
  );
}

export async function adminScansRoutes(app: FastifyInstance) {
  app.get("/scan-batches", async (_req, reply) => {
    const rows = await query<{
      id: string;
      language: string;
      label: string | null;
      source: string;
      status: BatchStatus;
      raw_prefix: string;
      processed_prefix: string;
      total_files: number;
      total_items: number;
      processed_at: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
      linked_items: string;
      review_items: string;
    }>(
      `SELECT
         b.*,
         COUNT(i.*) FILTER (WHERE i.status = 'linked')::text AS linked_items,
         COUNT(i.*) FILTER (WHERE i.status IN ('pending_review', 'ready_to_link'))::text AS review_items
       FROM scan_ingest_batches b
       LEFT JOIN scan_ingest_items i ON i.batch_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 50`,
    );

    reply.header("Cache-Control", "no-store");
    return {
      data: rows.rows.map((row) => ({
        ...row,
        linked_items: parseInt(row.linked_items, 10),
        review_items: parseInt(row.review_items, 10),
      })),
    };
  });

  app.post("/scan-batches", async (req, reply) => {
    const body = (req.body ?? {}) as { label?: unknown; language?: unknown };
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const language = typeof body.language === "string" ? body.language.trim().toLowerCase() : "en";

    if (!["en", "ja", "fr", "zh"].includes(language)) {
      reply.code(400);
      return { error: { status: 400, message: "language must be en, ja, fr, or zh" } };
    }

    const s3 = getScanIngestS3Config();
    const inserted = await query<{
      id: string;
      language: string;
      label: string | null;
      source: string;
      status: BatchStatus;
      raw_prefix: string;
      processed_prefix: string;
      total_files: number;
      total_items: number;
      processed_at: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `INSERT INTO scan_ingest_batches (language, label, source, status, raw_prefix, processed_prefix)
       VALUES ($1, $2, 'admin', 'uploaded', $3, $4)
       RETURNING *`,
      [
        language,
        label || null,
        `${s3.rawPrefix}/${language}`,
        `${s3.processedPrefix}/${language}`,
      ],
    );

    return { data: inserted.rows[0] };
  });

  app.post<{ Body: { file_name?: unknown; content_type?: unknown } }>(
    "/scan-batches/:batch_id/files/presign",
    async (req, reply) => {
      const { batch_id } = req.params as { batch_id: string };
      const body = req.body ?? {};
      const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";
      const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "image/png";

      if (!fileName) {
        reply.code(400);
        return { error: { status: 400, message: "file_name is required" } };
      }

      const batch = await loadBatchForUpload(batch_id);
      if (!batch) {
        reply.code(404);
        return { error: { status: 404, message: "Scan batch not found" } };
      }

      const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_");
      const key = `${batch.raw_prefix}/${batch.id}/${Date.now()}-${safeName}`;
      const s3 = getScanIngestS3Config();
      const client = getS3Client(s3.region);
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: key,
          ContentType: contentType || "image/png",
        }),
        { expiresIn: 900 },
      );

      return {
        data: {
          upload_url: uploadUrl,
          s3_key: key,
          public_url: buildPublicUrl(s3.publicBaseUrl, key),
          content_type: contentType || "image/png",
        },
      };
    },
  );

  app.post<{ Body: { file_name?: unknown; content_type?: unknown; folder?: unknown } }>(
    "/scan-batches/:batch_id/assets/presign",
    async (req, reply) => {
      const { batch_id } = req.params as { batch_id: string };
      const body = req.body ?? {};
      const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";
      const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "image/png";
      const folder = typeof body.folder === "string" ? body.folder.trim() : "";

      if (!fileName) {
        reply.code(400);
        return { error: { status: 400, message: "file_name is required" } };
      }

      const batch = await query<{ id: string; processed_prefix: string }>(
        `SELECT id, processed_prefix
         FROM scan_ingest_batches
         WHERE id = $1
         LIMIT 1`,
        [batch_id],
      );
      if (batch.rows.length === 0) {
        reply.code(404);
        return { error: { status: 404, message: "Scan batch not found" } };
      }

      const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_");
      const safeFolder = folder
        .split("/")
        .map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, "_"))
        .filter(Boolean)
        .join("/");
      const key = safeFolder
        ? `${batch.rows[0].processed_prefix}/${batch_id}/${safeFolder}/${safeName}`
        : `${batch.rows[0].processed_prefix}/${batch_id}/${safeName}`;
      const s3 = getScanIngestS3Config();
      const client = getS3Client(s3.region);
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: key,
          ContentType: contentType || "image/png",
        }),
        { expiresIn: 900 },
      );

      return {
        data: {
          upload_url: uploadUrl,
          s3_key: key,
          public_url: buildPublicUrl(s3.publicBaseUrl, key),
          content_type: contentType || "image/png",
        },
      };
    },
  );

  app.post<{ Body: { file_name?: unknown; content_type?: unknown; data_base64?: unknown; s3_key?: unknown; public_url?: unknown; local_only?: unknown } }>(
    "/scan-batches/:batch_id/files",
    { bodyLimit: 40 * 1024 * 1024 },
    async (req, reply) => {
      const { batch_id } = req.params as { batch_id: string };
      const body = req.body ?? {};
      const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";
      const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "image/png";
      const dataBase64 = typeof body.data_base64 === "string" ? body.data_base64.trim() : "";
      const providedS3Key = typeof body.s3_key === "string" ? body.s3_key.trim() : "";
      const providedPublicUrl = typeof body.public_url === "string" ? body.public_url.trim() : "";
      const localOnly = body.local_only === true;

      if (!fileName) {
        reply.code(400);
        return { error: { status: 400, message: "file_name is required" } };
      }

      const batch = await loadBatchForUpload(batch_id);
      if (!batch) {
        reply.code(404);
        return { error: { status: 404, message: "Scan batch not found" } };
      }

      let key: string | null = providedS3Key || null;
      let publicUrl: string | null = providedPublicUrl || null;
      if (dataBase64) {
        const buffer = decodeBase64Payload(dataBase64);
        const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_");
        key = `${batch.raw_prefix}/${batch.id}/${Date.now()}-${safeName}`;
        const s3 = getScanIngestS3Config();
        const client = getS3Client(s3.region);

        await client.send(
          new PutObjectCommand({
            Bucket: s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType || "image/png",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );

        publicUrl = buildPublicUrl(s3.publicBaseUrl, key);
      } else if (!localOnly && (!key || !publicUrl)) {
        reply.code(400);
        return { error: { status: 400, message: "Either data_base64, s3_key/public_url, or local_only=true is required" } };
      }

      const inserted = await query<{
        id: string;
        batch_id: string;
        file_name: string;
        s3_key: string | null;
        public_url: string | null;
        content_type: string | null;
        status: string;
        detected_cards: number | null;
        processed_at: string | null;
        error: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO scan_ingest_files (batch_id, file_name, s3_key, public_url, content_type, status)
         VALUES ($1, $2, $3, $4, $5, 'uploaded')
         RETURNING *`,
        [batch.id, fileName, key, publicUrl, contentType || null],
      );

      await query(
        `UPDATE scan_ingest_batches
         SET total_files = (
             SELECT COUNT(*) FROM scan_ingest_files WHERE batch_id = $1
           ),
           updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );

      return { data: inserted.rows[0] };
    },
  );

  app.post<{ Body: { file_id?: unknown; detected_cards?: unknown; items?: unknown[] } }>(
    "/scan-batches/:batch_id/import-prepared",
    async (req, reply) => {
      const { batch_id } = req.params as { batch_id: string };
      const body = req.body ?? {};
      const fileId = typeof body.file_id === "string" ? body.file_id.trim() : "";
      const detectedCards = typeof body.detected_cards === "number" && Number.isInteger(body.detected_cards)
        ? body.detected_cards
        : Number.NaN;
      const items = Array.isArray(body.items) ? body.items : null;

      if (!fileId) {
        reply.code(400);
        return { error: { status: 400, message: "file_id is required" } };
      }
      if (!Number.isInteger(detectedCards) || detectedCards < 0) {
        reply.code(400);
        return { error: { status: 400, message: "detected_cards must be a non-negative integer" } };
      }
      if (!items) {
        reply.code(400);
        return { error: { status: 400, message: "items must be an array" } };
      }

      const fileResult = await query<{ id: string; batch_id: string }>(
        `SELECT id, batch_id
         FROM scan_ingest_files
         WHERE id = $1
           AND batch_id = $2
         LIMIT 1`,
        [fileId, batch_id],
      );
      if (fileResult.rows.length === 0) {
        reply.code(404);
        return { error: { status: 404, message: "Scan batch file not found" } };
      }

      const artists = await fetchArtistCatalog();
      await query(`DELETE FROM scan_ingest_items WHERE file_id = $1`, [fileId]);

      for (const item of items) {
        const input = (item ?? {}) as Record<string, unknown>;
        const prepared = await buildPreparedItemInsert(batch_id, fileId, {
          ordinal: typeof input.ordinal === "number" && Number.isInteger(input.ordinal) ? input.ordinal : 0,
          raw_card_number: typeof input.raw_card_number === "string" ? input.raw_card_number : null,
          raw_artist: typeof input.raw_artist === "string" ? input.raw_artist : null,
          card_number: typeof input.card_number === "string" ? input.card_number : null,
          artist: typeof input.artist === "string" ? input.artist : null,
          artist_present: Boolean(input.artist_present),
          artist_confidence: typeof input.artist_confidence === "string" ? input.artist_confidence : null,
          card_number_confidence: typeof input.card_number_confidence === "string" ? input.card_number_confidence : null,
          processed_s3_key: typeof input.processed_s3_key === "string" ? input.processed_s3_key : "",
          processed_url: typeof input.processed_url === "string" ? input.processed_url : "",
          artist_crop_s3_key: typeof input.artist_crop_s3_key === "string" ? input.artist_crop_s3_key : null,
          artist_crop_url: typeof input.artist_crop_url === "string" ? input.artist_crop_url : null,
          footer_crop_s3_key: typeof input.footer_crop_s3_key === "string" ? input.footer_crop_s3_key : null,
          footer_crop_url: typeof input.footer_crop_url === "string" ? input.footer_crop_url : null,
          error: typeof input.error === "string" ? input.error : null,
        }, artists);

        if (!prepared.processed_s3_key || !prepared.processed_url) {
          reply.code(400);
          return { error: { status: 400, message: "Each prepared item must include processed_s3_key and processed_url" } };
        }

        await query(
          `INSERT INTO scan_ingest_items (
             batch_id,
             file_id,
             ordinal,
             status,
             raw_card_number,
             raw_artist,
             card_number,
             artist,
             artist_present,
             artist_confidence,
             card_number_confidence,
             fuzzy_artist,
             fuzzy_artist_score,
             fuzzy_artist_matched,
             suggested_filename,
             filename_slug,
             duplicate_index,
             processed_s3_key,
             processed_url,
             artist_crop_s3_key,
             artist_crop_url,
             footer_crop_s3_key,
             footer_crop_url,
             error
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22, $23, $24
           )`,
          [
            batch_id,
            fileId,
            prepared.ordinal,
            prepared.status,
            prepared.raw_card_number,
            prepared.raw_artist,
            prepared.card_number,
            prepared.artist,
            prepared.artist_present,
            prepared.artist_confidence,
            prepared.card_number_confidence,
            prepared.fuzzy_artist,
            prepared.fuzzy_artist_score,
            prepared.fuzzy_artist_matched,
            prepared.suggested_filename,
            prepared.filename_slug,
            prepared.duplicate_index,
            prepared.processed_s3_key,
            prepared.processed_url,
            prepared.artist_crop_s3_key,
            prepared.artist_crop_url,
            prepared.footer_crop_s3_key,
            prepared.footer_crop_url,
            prepared.error,
          ],
        );
      }

      await query(
        `UPDATE scan_ingest_files
         SET status = 'processed',
             detected_cards = $2,
             processed_at = NOW(),
             error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [fileId, detectedCards],
      );

      await refreshBatchStatus(batch_id);
      return { data: { file_id: fileId, detected_cards: detectedCards, imported_items: items.length } };
    },
  );

  app.get("/scan-batches/:batch_id", async (req, reply) => {
    const { batch_id } = req.params as { batch_id: string };
    await syncBatchFilesFromS3(batch_id);
    const [batchResult, filesResult, itemsResult] = await Promise.all([
      query<{
        id: string;
        language: string;
        label: string | null;
        source: string;
        status: BatchStatus;
        raw_prefix: string;
        processed_prefix: string;
        total_files: number;
        total_items: number;
        processed_at: string | null;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT *
         FROM scan_ingest_batches
         WHERE id = $1
         LIMIT 1`,
        [batch_id],
      ),
      query<{
        id: string;
        batch_id: string;
        file_name: string;
        s3_key: string | null;
        public_url: string | null;
        content_type: string | null;
        status: string;
        detected_cards: number | null;
        processed_at: string | null;
        error: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT *
         FROM scan_ingest_files
         WHERE batch_id = $1
         ORDER BY created_at ASC`,
        [batch_id],
      ),
      query<{
        id: string;
        batch_id: string;
        file_id: string;
        ordinal: number;
        status: ItemStatus;
        raw_card_number: string | null;
        raw_artist: string | null;
        card_number: string | null;
        artist: string | null;
        artist_present: boolean;
        artist_confidence: string | null;
        card_number_confidence: string | null;
        fuzzy_artist: string | null;
        fuzzy_artist_score: string | null;
        fuzzy_artist_matched: boolean;
        suggested_filename: string | null;
        filename_slug: string | null;
        duplicate_index: number;
        processed_s3_key: string | null;
        processed_url: string | null;
        artist_crop_s3_key: string | null;
        artist_crop_url: string | null;
        footer_crop_s3_key: string | null;
        footer_crop_url: string | null;
        linked_card_id: string | null;
        linked_card_image_id: string | null;
        review_notes: string | null;
        error: string | null;
        created_at: string;
        updated_at: string;
        source_file_name: string;
      }>(
        `SELECT i.*, f.file_name AS source_file_name
         FROM scan_ingest_items i
         JOIN scan_ingest_files f ON f.id = i.file_id
         WHERE i.batch_id = $1
         ORDER BY f.created_at ASC, i.ordinal ASC`,
        [batch_id],
      ),
    ]);

    if (batchResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Scan batch not found" } };
    }

    reply.header("Cache-Control", "no-store");
    return {
      data: {
        ...batchResult.rows[0],
        files: filesResult.rows,
        items: itemsResult.rows.map((row) => ({
          ...row,
          fuzzy_artist_score: row.fuzzy_artist_score == null ? null : Number(row.fuzzy_artist_score),
        })),
      },
    };
  });

  app.post("/scan-batches/:batch_id/process", async (req, reply) => {
    const { batch_id } = req.params as { batch_id: string };
    await syncBatchFilesFromS3(batch_id);
    const batchResult = await query<{ id: string; total_files: number }>(
      `SELECT id, total_files
       FROM scan_ingest_batches
       WHERE id = $1
       LIMIT 1`,
      [batch_id],
    );

    if (batchResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Scan batch not found" } };
    }

    const fileCountResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM scan_ingest_files
       WHERE batch_id = $1`,
      [batch_id],
    );
    const fileCount = parseInt(fileCountResult.rows[0]?.count ?? "0", 10);
    if (fileCount === 0) {
      reply.code(400);
      return { error: { status: 400, message: "Upload at least one raw scan before processing" } };
    }

    const rawFileCountResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM scan_ingest_files
       WHERE batch_id = $1
         AND s3_key IS NOT NULL
         AND public_url IS NOT NULL`,
      [batch_id],
    );
    const rawFileCount = parseInt(rawFileCountResult.rows[0]?.count ?? "0", 10);
    if (rawFileCount === 0) {
      reply.code(400);
      return { error: { status: 400, message: "This batch has no raw scan uploads to process" } };
    }

    try {
      if (await hasRunningTask("SCANS")) {
        reply.code(409);
        return { error: { status: 409, message: "A scan processing task is already running" } };
      }

      await query(
        `UPDATE scan_ingest_batches
         SET status = 'processing',
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [batch_id],
      );

      const result = await runConfiguredTask("SCANS", {
        command: ["cli", "process-scan-batch", batch_id],
      });
      return { data: result };
    } catch (error: any) {
      req.log.error({ err: error, batch_id }, "Failed to start scan ingest task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/scan-batches/:batch_id/reject", async (req, reply) => {
    const { batch_id } = req.params as { batch_id: string };

    const batchResult = await query<{ id: string; status: BatchStatus }>(
      `SELECT id, status
       FROM scan_ingest_batches
       WHERE id = $1
       LIMIT 1`,
      [batch_id],
    );

    if (batchResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Scan batch not found" } };
    }

    if (batchResult.rows[0].status === "linked") {
      reply.code(400);
      return { error: { status: 400, message: "Cannot reject a batch that has already been linked" } };
    }

    // Collect all S3 keys to delete
    const [itemKeys, fileKeys] = await Promise.all([
      query<{ key: string }>(
        `SELECT unnest(ARRAY[processed_s3_key, artist_crop_s3_key, footer_crop_s3_key]) AS key
         FROM scan_ingest_items
         WHERE batch_id = $1`,
        [batch_id],
      ),
      query<{ key: string }>(
        `SELECT s3_key AS key
         FROM scan_ingest_files
         WHERE batch_id = $1
           AND s3_key IS NOT NULL`,
        [batch_id],
      ),
    ]);

    const allKeys = [...itemKeys.rows, ...fileKeys.rows]
      .map((row) => row.key)
      .filter((key): key is string => Boolean(key));

    // Delete from S3 in batches of 1000 (S3 limit)
    if (allKeys.length > 0) {
      const s3 = getScanIngestS3Config();
      const client = getS3Client(s3.region);

      for (let i = 0; i < allKeys.length; i += 1000) {
        const batch = allKeys.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: s3.bucket,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
      }
    }

    // Delete items, mark files as failed, mark batch as failed
    await query(`DELETE FROM scan_ingest_items WHERE batch_id = $1`, [batch_id]);
    await query(
      `UPDATE scan_ingest_files
       SET status = 'failed',
           error = 'Batch rejected',
           updated_at = NOW()
       WHERE batch_id = $1`,
      [batch_id],
    );
    await query(
      `UPDATE scan_ingest_batches
       SET status = 'failed',
           total_items = 0,
           last_error = 'Batch rejected',
           updated_at = NOW()
       WHERE id = $1`,
      [batch_id],
    );

    return {
      data: {
        batch_id,
        deleted_s3_keys: allKeys.length,
      },
    };
  });

  app.put("/scan-items/:item_id", async (req, reply) => {
    const { item_id } = req.params as { item_id: string };
    const body = (req.body ?? {}) as {
      card_number?: unknown;
      artist?: unknown;
      review_notes?: unknown;
    };

    const existingResult = await query<{
      id: string;
      batch_id: string;
      processed_url: string | null;
      status: ItemStatus;
      card_number: string | null;
      artist: string | null;
      review_notes: string | null;
    }>(
      `SELECT id, batch_id, processed_url, status, card_number, artist, review_notes
       FROM scan_ingest_items
       WHERE id = $1
       LIMIT 1`,
      [item_id],
    );

    if (existingResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Scan item not found" } };
    }

    const existing = existingResult.rows[0];
    const cardNumber = body.card_number === null
      ? null
      : typeof body.card_number === "string"
        ? (body.card_number.trim().toUpperCase() || null)
        : undefined;
    const artist = body.artist === null
      ? null
      : typeof body.artist === "string"
        ? (body.artist.trim() || null)
        : undefined;
    const reviewNotes = body.review_notes === null
      ? null
      : typeof body.review_notes === "string"
        ? (body.review_notes.trim() || null)
        : undefined;
    const nextCardNumber = cardNumber !== undefined ? cardNumber : existing.card_number;
    const nextArtist = artist !== undefined ? artist : existing.artist;
    const nextReviewNotes = reviewNotes !== undefined ? reviewNotes : existing.review_notes;

    const artists = await fetchArtistCatalog();
    const matchedArtist = matchArtistCandidate(nextArtist, artists);
    const nextStatus: ItemStatus = existing.status === "linked"
      ? "linked"
      : nextCardNumber && existing.processed_url
        ? "ready_to_link"
        : "pending_review";

    const updated = await query<{
      id: string;
      batch_id: string;
      card_number: string | null;
      artist: string | null;
      review_notes: string | null;
      fuzzy_artist: string | null;
      fuzzy_artist_score: string | null;
      fuzzy_artist_matched: boolean;
      suggested_filename: string | null;
      status: ItemStatus;
    }>(
      `UPDATE scan_ingest_items
       SET card_number = $2::text,
           artist = $3::text,
           review_notes = $4::text,
           fuzzy_artist = $5::text,
           fuzzy_artist_score = $6::numeric,
           fuzzy_artist_matched = $7,
           suggested_filename = CASE
             WHEN $2::text IS NULL THEN suggested_filename
             ELSE CONCAT(
               $2::text,
               '_',
               $8::text,
               CASE
                 WHEN duplicate_index > 0 THEN CONCAT('__', duplicate_index + 1)
                 ELSE ''
               END,
               '.png'
             )
           END,
           status = $9,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, batch_id, card_number, artist, review_notes, fuzzy_artist, fuzzy_artist_score, fuzzy_artist_matched, suggested_filename, status`,
      [
        item_id,
        nextCardNumber,
        nextArtist,
        nextReviewNotes,
        matchedArtist.artist,
        matchedArtist.score,
        matchedArtist.matched,
        normalizeSlugPart(nextArtist, "unknown_artist"),
        nextStatus,
      ],
    );

    await refreshBatchStatus(updated.rows[0].batch_id);
    return {
      data: {
        ...updated.rows[0],
        fuzzy_artist_score: updated.rows[0].fuzzy_artist_score == null ? null : Number(updated.rows[0].fuzzy_artist_score),
      },
    };
  });

  app.post("/scan-items/:item_id/link", async (req, reply) => {
    const { item_id } = req.params as { item_id: string };
    const body = (req.body ?? {}) as {
      card_number?: unknown;
      variant_index?: unknown;
      language?: unknown;
    };
    const cardNumberInput = typeof body.card_number === "string" ? body.card_number.trim().toUpperCase() : "";
    const variantIndex = typeof body.variant_index === "number" && Number.isInteger(body.variant_index)
      ? body.variant_index
      : Number.NaN;
    const language = typeof body.language === "string" ? body.language.trim().toLowerCase() : "en";

    if (!cardNumberInput) {
      reply.code(400);
      return { error: { status: 400, message: "card_number is required" } };
    }
    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }

    const itemResult = await query<{
      id: string;
      batch_id: string;
      processed_s3_key: string | null;
      processed_url: string | null;
      artist: string | null;
    }>(
      `SELECT id, batch_id, processed_s3_key, processed_url, artist
       FROM scan_ingest_items
       WHERE id = $1
       LIMIT 1`,
      [item_id],
    );
    if (itemResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Scan item not found" } };
    }

    const item = itemResult.rows[0];
    if (!item.processed_url || !item.processed_s3_key) {
      reply.code(400);
      return { error: { status: 400, message: "Scan item has no processed image source yet" } };
    }

    const imageResult = await query<{
      card_id: string;
      card_image_id: string;
      existing_artist: string | null;
    }>(
      `SELECT c.id AS card_id, ci.id AS card_image_id, ci.artist AS existing_artist
       FROM cards c
       JOIN card_images ci ON ci.card_id = c.id
       WHERE c.card_number ILIKE $1
         AND c.language = $2
         AND ci.variant_index = $3
       LIMIT 1`,
      [cardNumberInput, language, variantIndex],
    );

    if (imageResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Target card variant not found" } };
    }

    const image = imageResult.rows[0];
    await query(
      `UPDATE card_images
       SET scan_url = NULL,
           scan_thumb_s3_key = NULL,
           scan_thumb_url = NULL,
           scan_source_s3_key = $2,
           scan_source_url = $3,
           scan_derivative_status = 'pending',
           scan_derivative_error = NULL,
           scan_derivative_requested_at = NOW(),
           scan_derivative_processed_at = NULL,
           artist = CASE
             WHEN (artist IS NULL OR btrim(artist) = '')
               AND $4::text IS NOT NULL
               AND btrim($4::text) <> ''
             THEN $4::text
             ELSE artist
           END,
           artist_source = CASE
             WHEN (artist IS NULL OR btrim(artist) = '')
               AND $4::text IS NOT NULL
               AND btrim($4::text) <> ''
             THEN 'manual'
             ELSE artist_source
           END
       WHERE id = $1`,
      [image.card_image_id, item.processed_s3_key, item.processed_url, item.artist],
    );

    const updated = await query<{
      id: string;
      batch_id: string;
      linked_card_id: string | null;
      linked_card_image_id: string | null;
      status: ItemStatus;
      card_number: string | null;
    }>(
      `UPDATE scan_ingest_items
       SET card_number = $2,
           linked_card_id = $3,
           linked_card_image_id = $4,
           status = 'linked',
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, batch_id, linked_card_id, linked_card_image_id, status, card_number`,
      [item_id, cardNumberInput, image.card_id, image.card_image_id],
    );

    await refreshBatchStatus(updated.rows[0].batch_id);
    return {
      data: {
        ...updated.rows[0],
        derivative_status: "pending",
      },
    };
  });

  app.post("/scan-derivatives/process", async (req, reply) => {
    if (await hasRunningTask("SCANS")) {
      reply.code(409);
      return { error: { status: 409, message: "A scan processing task is already running" } };
    }

    const result = await runConfiguredTask("SCANS", {
      command: ["cli", "process-scan-derivatives"],
    });

    return { data: result };
  });

  app.get("/scan-derivatives/status", async () => {
    const counts = await query<{ status: string; count: string }>(
      `SELECT scan_derivative_status AS status, COUNT(*)::text AS count
       FROM card_images
       WHERE scan_source_s3_key IS NOT NULL
       GROUP BY scan_derivative_status`,
    );

    const byStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));

    return {
      data: {
        pending: byStatus.get("pending") ?? 0,
        processing: byStatus.get("processing") ?? 0,
        failed: byStatus.get("failed") ?? 0,
        succeeded: byStatus.get("succeeded") ?? 0,
      },
    };
  });
}
