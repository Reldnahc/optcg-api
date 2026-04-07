function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseCsvEnv(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function getDiscordWebhookUrl(): string | null {
  return process.env.DISCORD_WEBHOOK_URL || null;
}

export function getAdminOrigin(): string {
  return process.env.ADMIN_ORIGIN || "https://admin.poneglyph.one";
}

export function getJwtSecret(): string {
  return requireEnv("JWT_SECRET");
}

export function getAdminEmail(): string {
  return requireEnv("ADMIN_EMAIL");
}

export function getAdminPasswordHash(): string {
  return requireEnv("ADMIN_PASSWORD_HASH");
}

export function getAdminTokenTtlSeconds(): number {
  const raw = process.env.ADMIN_TOKEN_TTL_SECONDS;
  const parsed = raw ? parseInt(raw, 10) : 43_200;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 43_200;
}

export interface EcsTaskConfig {
  cluster: string;
  taskDefinition: string;
  containerName: string | null;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: boolean;
}

export type EcsTaskPrefix =
  | "DB_MIGRATE"
  | "SCRAPER"
  | "PRICES"
  | "WATCHER"
  | "FORMATS"
  | "OCR"
  | "SCANS"
  | "THUMBS"
  | "WIPE"
  | "VARIANT_MERGE";

import {
  INGEST_CROPS_PREFIX,
  INGEST_RAW_PREFIX,
  getStorageConfig,
} from "../storage.js";

/**
 * Image storage view used by the admin scan-ingest routes.
 * Single bucket, single base URL — see ../storage.ts for the source of truth.
 *
 * `rawPrefix` and `processedPrefix` are the temporary holding areas under
 * `images/_ingest/...` (subject to daily GC, see optcg-data/src/cli/gc-ingest.ts).
 */
export function getImageStorageConfig(): {
  bucket: string;
  region: string;
  publicBaseUrl: string;
  rawPrefix: string;
  processedPrefix: string;
} {
  const cfg = getStorageConfig();
  return {
    bucket: cfg.bucket,
    region: cfg.region,
    publicBaseUrl: cfg.publicBaseUrl,
    rawPrefix: INGEST_RAW_PREFIX,
    processedPrefix: INGEST_CROPS_PREFIX,
  };
}

export function getEcsTaskConfig(prefix: EcsTaskPrefix): EcsTaskConfig | null {
  const cluster = process.env[`${prefix}_ECS_CLUSTER`];
  const taskDefinition = process.env[`${prefix}_ECS_TASK_DEFINITION`];
  const subnets = parseCsvEnv(`${prefix}_ECS_SUBNETS`);
  const securityGroups = parseCsvEnv(`${prefix}_ECS_SECURITY_GROUPS`);

  if (!cluster || !taskDefinition || subnets.length === 0 || securityGroups.length === 0) {
    return null;
  }

  return {
    cluster,
    taskDefinition,
    containerName: process.env[`${prefix}_ECS_CONTAINER`] || null,
    subnets,
    securityGroups,
    assignPublicIp: process.env[`${prefix}_ECS_ASSIGN_PUBLIC_IP`] === "true",
  };
}
