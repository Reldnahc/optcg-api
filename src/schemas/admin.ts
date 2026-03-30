import { errorEnvelopeSchema, nullable, okEnvelopeSchema } from "./common.js";

const adminSecurity = [{ bearerAuth: [] }];

const taskResultSchema = {
  type: "object",
  additionalProperties: true,
};

const adminFormatBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "block", "legal", "rotated_at"],
  properties: {
    id: { type: "string" },
    block: { type: "string" },
    legal: { type: "boolean" },
    rotated_at: nullable({ type: "string", format: "date-time" }),
  },
};

const adminFormatBanSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "card_number", "type", "banned_at"],
  properties: {
    id: { type: "string" },
    card_number: { type: "string" },
    type: { type: "string" },
    max_copies: { type: "integer" },
    paired_with: { type: "string" },
    banned_at: { type: "string", format: "date-time" },
    reason: { type: "string" },
    unbanned_at: { type: "string", format: "date-time" },
  },
};

const adminFormatSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "has_rotation", "blocks", "bans"],
  properties: {
    name: { type: "string" },
    description: nullable({ type: "string" }),
    has_rotation: { type: "boolean" },
    blocks: { type: "array", items: adminFormatBlockSchema },
    bans: { type: "array", items: adminFormatBanSchema },
  },
};

const adminStatsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total_cards", "total_variants", "cards_by_language", "recent_errors"],
  properties: {
    total_cards: { type: "integer" },
    total_variants: { type: "integer" },
    cards_by_language: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["language", "count"],
        properties: {
          language: { type: "string" },
          count: { type: "integer" },
        },
      },
    },
    recent_errors: { type: "integer" },
  },
};

const scraperLogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "ran_at", "source", "cards_added", "cards_updated", "errors", "duration_ms"],
  properties: {
    id: { type: "string" },
    ran_at: { type: "string", format: "date-time" },
    source: nullable({ type: "string" }),
    cards_added: { type: "integer" },
    cards_updated: { type: "integer" },
    errors: nullable({ type: "string" }),
    duration_ms: nullable({ type: "integer" }),
  },
};

const limitQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
};

const adminFormatNameParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string" },
  },
};

const adminFormatBanParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "id"],
  properties: {
    name: { type: "string" },
    id: { type: "string" },
  },
};

export const adminLoginRouteSchema = {
  tags: ["Admin Auth"],
  summary: "Admin login",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: {
      email: { type: "string" },
      password: { type: "string" },
    },
  },
  response: {
    200: okEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["email", "token", "token_type", "expires_at"],
      properties: {
        email: { type: "string" },
        token: { type: "string" },
        token_type: { type: "string" },
        expires_at: { type: "string", format: "date-time" },
      },
    }),
    400: errorEnvelopeSchema,
    401: errorEnvelopeSchema,
    500: errorEnvelopeSchema,
  },
};

export const adminFormatsListRouteSchema = {
  tags: ["Admin Formats"],
  summary: "List admin formats",
  security: adminSecurity,
  response: {
    200: okEnvelopeSchema({ type: "array", items: adminFormatSchema }),
  },
};

export const adminCreateFormatBanRouteSchema = {
  tags: ["Admin Formats"],
  summary: "Create format ban",
  security: adminSecurity,
  params: adminFormatNameParamSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["card_number", "ban_type", "banned_at"],
    properties: {
      card_number: { type: "string" },
      ban_type: { type: "string", enum: ["banned", "restricted", "pair"] },
      banned_at: { type: "string", format: "date-time" },
      reason: { type: "string" },
      max_copies: { type: "integer", minimum: 1 },
      paired_card_number: { type: "string" },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
    409: errorEnvelopeSchema,
  },
};

export const adminUpdateFormatBanRouteSchema = {
  tags: ["Admin Formats"],
  summary: "Update format ban",
  security: adminSecurity,
  params: adminFormatBanParamSchema,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      card_number: { type: "string" },
      ban_type: { type: "string", enum: ["banned", "restricted", "pair"] },
      banned_at: { type: "string", format: "date-time" },
      reason: { type: "string" },
      max_copies: { type: "integer", minimum: 1 },
      paired_card_number: { type: "string" },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
};

export const adminDeleteFormatBanRouteSchema = {
  tags: ["Admin Formats"],
  summary: "Delete format ban",
  security: adminSecurity,
  params: adminFormatBanParamSchema,
  response: {
    200: okEnvelopeSchema({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }),
    404: errorEnvelopeSchema,
  },
};

export const adminUpsertFormatBlockRouteSchema = {
  tags: ["Admin Formats"],
  summary: "Create or update format block",
  security: adminSecurity,
  params: adminFormatNameParamSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["block"],
    properties: {
      block: { type: "string" },
      rotated_at: nullable({ type: "string", format: "date-time" }),
      legal: { type: "boolean" },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
};

export const adminStatsRouteSchema = {
  tags: ["Admin Tasks"],
  summary: "Admin ingest stats",
  security: adminSecurity,
  response: {
    200: okEnvelopeSchema(adminStatsSchema),
  },
};

export const adminScraperStatusRouteSchema = {
  tags: ["Admin Tasks"],
  summary: "Recent scraper runs",
  security: adminSecurity,
  querystring: limitQuerySchema,
  response: {
    200: okEnvelopeSchema({ type: "array", items: scraperLogSchema }),
  },
};

export const adminScraperLogsRouteSchema = {
  tags: ["Admin Tasks"],
  summary: "Recent scraper logs",
  security: adminSecurity,
  querystring: limitQuerySchema,
  response: {
    200: okEnvelopeSchema({ type: "array", items: scraperLogSchema }),
  },
};

export const adminWatcherTopicsRouteSchema = {
  tags: ["Admin Tasks"],
  summary: "Recent watcher topics",
  security: adminSecurity,
  querystring: limitQuerySchema,
  response: {
    200: okEnvelopeSchema({ type: "array", items: { type: "object", additionalProperties: true } }),
  },
};

export const adminRunPricesRouteSchema = {
  tags: ["Admin Tasks"],
  summary: "Start prices task",
  security: adminSecurity,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      wipe: { type: "boolean" },
      archive_date: { type: "string" },
      archive_from: { type: "string" },
      archive_to: { type: "string" },
      dedupe_links: { type: "boolean" },
    },
  },
  response: {
    200: okEnvelopeSchema(taskResultSchema),
    400: errorEnvelopeSchema,
    501: errorEnvelopeSchema,
  },
};
