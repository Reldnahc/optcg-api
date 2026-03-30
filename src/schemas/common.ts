export function nullable(schema: Record<string, unknown>) {
  return { anyOf: [schema, { type: "null" }] };
}

export const errorEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["status", "message"],
      properties: {
        status: { type: "integer" },
        message: { type: "string" },
      },
    },
  },
};

export const paginationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page", "limit", "total", "has_more"],
  properties: {
    page: { type: "integer" },
    limit: { type: "integer" },
    total: { type: "integer" },
    has_more: { type: "boolean" },
  },
};

export function okEnvelopeSchema(dataSchema: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: dataSchema,
    },
  };
}

export function paginatedEnvelopeSchema(itemSchema: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data", "pagination"],
    properties: {
      data: {
        type: "array",
        items: itemSchema,
      },
      pagination: paginationSchema,
    },
  };
}

export const cardNumberParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card_number"],
  properties: {
    card_number: { type: "string" },
  },
};

export const setCodeParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["set_code"],
  properties: {
    set_code: { type: "string" },
  },
};

export const formatNameParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format_name"],
  properties: {
    format_name: { type: "string" },
  },
};

export const donIdParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" },
  },
};

export const languageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lang: { type: "string" },
  },
};

export const cardSummarySchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "card_number",
    "name",
    "language",
    "set",
    "set_name",
    "released_at",
    "released",
    "card_type",
    "rarity",
    "color",
    "cost",
    "power",
    "counter",
    "life",
    "attribute",
    "types",
    "effect",
    "trigger",
    "block",
  ],
  properties: {
    card_number: { type: "string" },
    name: { type: "string" },
    language: { type: "string" },
    set: { type: "string" },
    set_name: { type: "string" },
    released_at: nullable({ type: "string", format: "date-time" }),
    released: { type: "boolean" },
    card_type: { type: "string" },
    rarity: nullable({ type: "string" }),
    color: { type: "array", items: { type: "string" } },
    cost: nullable({ type: "integer" }),
    power: nullable({ type: "integer" }),
    counter: nullable({ type: "integer" }),
    life: nullable({ type: "integer" }),
    attribute: nullable({ type: "array", items: { type: "string" } }),
    types: { type: "array", items: { type: "string" } },
    effect: nullable({ type: "string" }),
    trigger: nullable({ type: "string" }),
    block: nullable({ type: "string" }),
    image_url: nullable({ type: "string" }),
    thumbnail_url: nullable({ type: "string" }),
    scan_url: nullable({ type: "string" }),
    scan_thumb_url: nullable({ type: "string" }),
    tcgplayer_url: nullable({ type: "string" }),
    market_price: nullable({ type: "string" }),
    low_price: nullable({ type: "string" }),
    mid_price: nullable({ type: "string" }),
    high_price: nullable({ type: "string" }),
  },
};
