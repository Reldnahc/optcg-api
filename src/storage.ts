/**
 * Image storage configuration and key builders for the API.
 * Mirrors optcg-data/src/shared/storage.ts. See ../../image-migration-plan.md
 * for the canonical path layout.
 */

import { S3Client } from "@aws-sdk/client-s3";

export interface StorageConfig {
  bucket: string;
  publicBaseUrl: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}

let cachedConfig: StorageConfig | null = null;
let cachedClient: S3Client | null = null;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultPublicBaseUrl(bucket: string, region: string): string {
  if (region === "us-east-1") return `https://${bucket}.s3.amazonaws.com`;
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

export function getStorageConfig(): StorageConfig {
  if (cachedConfig) return cachedConfig;

  const bucket = process.env.S3_IMAGE_BUCKET;
  if (!bucket) {
    throw new Error("Missing required environment variable: S3_IMAGE_BUCKET");
  }
  const region = process.env.AWS_REGION || "us-east-1";
  const publicBaseUrl = trimTrailingSlashes(
    process.env.S3_PUBLIC_BASE_URL ?? defaultPublicBaseUrl(bucket, region),
  );
  const endpoint = process.env.S3_ENDPOINT?.trim() || null;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim() || null;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim() || null;

  cachedConfig = { bucket, publicBaseUrl, region, endpoint, accessKeyId, secretAccessKey };
  return cachedConfig;
}

export function getS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  const cfg = getStorageConfig();

  if (cfg.endpoint) {
    if (!cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error(
        "S3_ENDPOINT is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing",
      );
    }
    cachedClient = new S3Client({
      region: cfg.region || "auto",
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: false,
    });
  } else {
    cachedClient = new S3Client({ region: cfg.region });
  }

  return cachedClient;
}

export function buildPublicUrl(key: string): string {
  return `${getStorageConfig().publicBaseUrl}/${key}`;
}

// ---------------------------------------------------------------------------
// Path builders — match optcg-data/src/shared/storage.ts
// ---------------------------------------------------------------------------

function normalizeCardNumber(cardNumber: string): string {
  return cardNumber.trim().toUpperCase();
}

function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase();
}

export function stockFullKey(cardNumber: string, lang: string, variantIndex: number): string {
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/stock/${variantIndex}/full.png`;
}

export function stockThumbKey(cardNumber: string, lang: string, variantIndex: number): string {
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/stock/${variantIndex}/thumb.webp`;
}

export function scanSourceKey(
  cardNumber: string,
  lang: string,
  variantIndex: number,
  extension: string = ".png",
): string {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/scans/${variantIndex}/source${ext}`;
}

export function scanFullKey(cardNumber: string, lang: string, variantIndex: number): string {
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/scans/${variantIndex}/full.png`;
}

export function scanDisplayKey(cardNumber: string, lang: string, variantIndex: number): string {
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/scans/${variantIndex}/display.webp`;
}

export function scanThumbKey(cardNumber: string, lang: string, variantIndex: number): string {
  return `images/${normalizeCardNumber(cardNumber)}/${normalizeLang(lang)}/scans/${variantIndex}/thumb.webp`;
}

export const INGEST_RAW_PREFIX = "images/_ingest/raw";
export const INGEST_CROPS_PREFIX = "images/_ingest/crops";

export function ingestRawPrefix(lang: string): string {
  return `${INGEST_RAW_PREFIX}/${normalizeLang(lang)}`;
}

export function ingestCropsPrefix(lang: string): string {
  return `${INGEST_CROPS_PREFIX}/${normalizeLang(lang)}`;
}

export function extractImageExtension(value: string | null | undefined): string {
  const normalized = (value ?? "").split("?")[0].trim().toLowerCase();
  if (normalized.endsWith(".jpg")) return ".jpg";
  if (normalized.endsWith(".jpeg")) return ".jpeg";
  if (normalized.endsWith(".webp")) return ".webp";
  return ".png";
}
