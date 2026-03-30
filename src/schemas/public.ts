import {
  cardNumberParamSchema,
  cardSummarySchema,
  donIdParamSchema,
  errorEnvelopeSchema,
  formatNameParamSchema,
  languageQuerySchema,
  nullable,
  okEnvelopeSchema,
  paginatedEnvelopeSchema,
  paginationSchema,
  setCodeParamSchema,
} from "./common.js";

const formatSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "has_rotation", "legal_blocks", "ban_count"],
  properties: {
    name: { type: "string" },
    description: nullable({ type: "string" }),
    has_rotation: { type: "boolean" },
    legal_blocks: { type: "integer" },
    ban_count: { type: "integer" },
  },
};

const formatBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["block", "legal", "rotated_at"],
  properties: {
    block: { type: "string" },
    legal: { type: "boolean" },
    rotated_at: nullable({ type: "string", format: "date-time" }),
  },
};

const formatBanSchema = {
  type: "object",
  additionalProperties: true,
  required: ["card_number", "type", "banned_at"],
  properties: {
    card_number: { type: "string" },
    type: { type: "string" },
    max_copies: { type: "integer" },
    paired_with: { type: "string" },
    banned_at: { type: "string", format: "date-time" },
    reason: { type: "string" },
  },
};

const formatDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "has_rotation", "blocks", "bans"],
  properties: {
    name: { type: "string" },
    description: nullable({ type: "string" }),
    has_rotation: { type: "boolean" },
    blocks: { type: "array", items: formatBlockSchema },
    bans: { type: "array", items: formatBanSchema },
  },
};

const setSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "name", "released_at", "card_count"],
  properties: {
    code: { type: "string" },
    name: { type: "string" },
    released_at: nullable({ type: "string", format: "date-time" }),
    card_count: { type: "integer" },
  },
};

const setProductSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "set_codes", "released_at"],
  properties: {
    name: { type: "string" },
    set_codes: nullable({ type: "array", items: { type: "string" } }),
    released_at: nullable({ type: "string", format: "date-time" }),
  },
};

const setCardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card_number", "name", "card_type", "rarity", "color", "cost", "power", "image_url", "thumbnail_url"],
  properties: {
    card_number: { type: "string" },
    name: { type: "string" },
    card_type: { type: "string" },
    rarity: nullable({ type: "string" }),
    color: { type: "array", items: { type: "string" } },
    cost: nullable({ type: "integer" }),
    power: nullable({ type: "integer" }),
    image_url: nullable({ type: "string" }),
    thumbnail_url: nullable({ type: "string" }),
  },
};

const setDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "name", "released_at", "card_count", "products", "cards"],
  properties: {
    code: { type: "string" },
    name: { type: "string" },
    released_at: nullable({ type: "string", format: "date-time" }),
    card_count: { type: "integer" },
    products: { type: "array", items: setProductSchema },
    cards: { type: "array", items: setCardSchema },
  },
};

const priceRowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["variant_index", "label", "sub_type", "tcgplayer_url", "market_price", "low_price", "mid_price", "high_price", "fetched_at"],
  properties: {
    variant_index: { type: "integer" },
    label: nullable({ type: "string" }),
    sub_type: nullable({ type: "string" }),
    tcgplayer_url: nullable({ type: "string" }),
    market_price: nullable({ type: "string" }),
    low_price: nullable({ type: "string" }),
    mid_price: nullable({ type: "string" }),
    high_price: nullable({ type: "string" }),
    fetched_at: { type: "string", format: "date-time" },
  },
};

const donCardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "character", "finish", "image_url", "product_name", "thumbnail_url"],
  properties: {
    id: { type: "string" },
    character: { type: "string" },
    finish: { type: "string" },
    image_url: nullable({ type: "string" }),
    product_name: { type: "string" },
    thumbnail_url: nullable({ type: "string" }),
  },
};

const cardSummaryRequired = [...
  (((cardSummarySchema as unknown) as { required?: string[] }).required ?? []),
];

const cardSummaryProperties = {
  ...((((cardSummarySchema as unknown) as { properties?: Record<string, unknown> }).properties) ?? {}),
};

const cardPrintSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [...cardSummaryRequired, "label", "variant_index", "variant_product_name"],
  properties: {
    ...cardSummaryProperties,
    label: nullable({ type: "string" }),
    variant_index: { type: "integer" },
    variant_product_name: nullable({ type: "string" }),
  },
};

const cardSearchSortEnum = [
  "relevance",
  "name",
  "cost",
  "power",
  "card_number",
  "released",
  "rarity",
  "color",
  "market_price",
  "artist",
];

const cardSearchMetaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sort_requested", "sort_applied", "order_requested", "order_applied", "relevance_active"],
  properties: {
    sort_requested: { type: "string", enum: cardSearchSortEnum },
    sort_applied: { type: "string", enum: cardSearchSortEnum },
    order_requested: { type: "string", enum: ["asc", "desc"] },
    order_applied: { type: "string", enum: ["asc", "desc"] },
    relevance_active: { type: "boolean" },
  },
};

function cardSearchEnvelopeSchema(itemSchema: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data", "pagination", "meta"],
    properties: {
      data: {
        type: "array",
        items: itemSchema,
      },
      pagination: paginationSchema,
      meta: cardSearchMetaSchema,
    },
  };
}

const cardSearchQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string" },
    name: { type: "string" },
    set: { type: "string" },
    color: { type: "string" },
    type: { type: "string" },
    cost: { type: "string" },
    power: { type: "string" },
    counter: { type: "string" },
    rarity: { type: "string" },
    artist: { type: "string" },
    sort: {
      type: "string",
      enum: [
        "name",
        "cost",
        "power",
        "card_number",
        "released",
        "rarity",
        "color",
        "market_price",
        "artist",
        "number",
        "set",
        "usd",
        "relevance",
      ],
    },
    order: { type: "string", enum: ["asc", "desc"] },
    unique: { type: "string", enum: ["cards", "prints"] },
    page: { type: "string" },
    limit: { type: "string" },
    lang: { type: "string" },
  },
};

const variantMarketPriceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["market_price", "low_price", "mid_price", "high_price", "tcgplayer_url"],
  properties: {
    market_price: nullable({ type: "string" }),
    low_price: nullable({ type: "string" }),
    mid_price: nullable({ type: "string" }),
    high_price: nullable({ type: "string" }),
    tcgplayer_url: nullable({ type: "string" }),
  },
};

const cardVariantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["variant_index", "label", "is_default", "artist", "product", "media", "market"],
  properties: {
    variant_index: { type: "integer" },
    label: nullable({ type: "string" }),
    is_default: { type: "boolean" },
    artist: nullable({ type: "string" }),
    product: {
      type: "object",
      additionalProperties: false,
      required: ["name", "set_code", "released_at"],
      properties: {
        name: nullable({ type: "string" }),
        set_code: nullable({ type: "string" }),
        released_at: nullable({ type: "string", format: "date-time" }),
      },
    },
    media: {
      type: "object",
      additionalProperties: false,
      required: ["image_url", "thumbnail_url", "scan_url", "scan_thumbnail_url"],
      properties: {
        image_url: nullable({ type: "string" }),
        thumbnail_url: nullable({ type: "string" }),
        scan_url: nullable({ type: "string" }),
        scan_thumbnail_url: nullable({ type: "string" }),
      },
    },
    market: {
      type: "object",
      additionalProperties: false,
      required: ["tcgplayer_url", "prices"],
      properties: {
        tcgplayer_url: nullable({ type: "string" }),
        prices: {
          type: "object",
          additionalProperties: variantMarketPriceSchema,
        },
      },
    },
  },
};

const cardLegalitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string" },
    banned_at: { type: "string", format: "date-time" },
    reason: { type: "string" },
    max_copies: { type: "integer" },
    paired_with: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const cardDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: [...cardSummaryRequired, "variants", "legality", "available_languages"],
  properties: {
    ...cardSummaryProperties,
    variants: {
      type: "array",
      items: cardVariantSchema,
    },
    legality: {
      type: "object",
      additionalProperties: cardLegalitySchema,
    },
    available_languages: {
      type: "array",
      items: { type: "string" },
    },
  },
};

export const healthRouteSchema = {
  tags: ["System"],
  summary: "Health check",
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", const: "ok" },
      },
    },
    503: {
      type: "object",
      additionalProperties: false,
      required: ["status", "message"],
      properties: {
        status: { type: "string", const: "error" },
        message: { type: "string" },
      },
    },
  },
};

export const formatsListRouteSchema = {
  tags: ["Formats"],
  summary: "List formats",
  response: {
    200: okEnvelopeSchema({ type: "array", items: formatSummarySchema }),
  },
};

export const formatDetailRouteSchema = {
  tags: ["Formats"],
  summary: "Get format detail",
  params: formatNameParamSchema,
  response: {
    200: okEnvelopeSchema(formatDetailSchema),
    404: errorEnvelopeSchema,
  },
};

export const setsListRouteSchema = {
  tags: ["Sets"],
  summary: "List sets",
  response: {
    200: okEnvelopeSchema({ type: "array", items: setSummarySchema }),
  },
};

export const setDetailRouteSchema = {
  tags: ["Sets"],
  summary: "Get set detail",
  params: setCodeParamSchema,
  response: {
    200: okEnvelopeSchema(setDetailSchema),
    404: errorEnvelopeSchema,
  },
};

export const pricesRouteSchema = {
  tags: ["Prices"],
  summary: "Get price history",
  params: cardNumberParamSchema,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: { type: "integer", minimum: 1, maximum: 365 },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "array", items: priceRowSchema }),
    404: errorEnvelopeSchema,
  },
};

export const donListRouteSchema = {
  tags: ["DON"],
  summary: "List DON cards",
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      set: { type: "string" },
      character: { type: "string" },
      finish: { type: "string" },
      sort: { type: "string", enum: ["character", "set"] },
      order: { type: "string", enum: ["asc", "desc"] },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "array", items: donCardSchema }),
  },
};

export const donDetailRouteSchema = {
  tags: ["DON"],
  summary: "Get DON card detail",
  params: donIdParamSchema,
  response: {
    200: okEnvelopeSchema(donCardSchema),
    404: errorEnvelopeSchema,
  },
};

export const randomRouteSchema = {
  tags: ["Cards"],
  summary: "Get a random card",
  querystring: {
    ...languageQuerySchema,
    properties: {
      ...languageQuerySchema.properties,
      set: { type: "string" },
      color: { type: "string" },
      type: { type: "string" },
      rarity: { type: "string" },
    },
  },
  response: {
    200: okEnvelopeSchema(cardSummarySchema),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
};

export const cardsSearchRouteSchema = {
  tags: ["Cards"],
  summary: "Search cards",
  description: "Supports two result modes. `unique=cards` returns card-level rows. `unique=prints` returns classified variant rows. The `meta` object reports the requested sort and the sort that was actually applied after any relevance fallback.",
  querystring: cardSearchQuerySchema,
  response: {
    200: {
      oneOf: [
        cardSearchEnvelopeSchema(cardSummarySchema),
        cardSearchEnvelopeSchema(cardPrintSummarySchema),
      ],
    },
    400: errorEnvelopeSchema,
  },
};

export const cardAutocompleteRouteSchema = {
  tags: ["Cards"],
  summary: "Autocomplete card names",
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string" },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "array", items: { type: "string" } }),
    400: errorEnvelopeSchema,
  },
};

export const cardDetailRouteSchema = {
  tags: ["Cards"],
  summary: "Get card detail",
  params: cardNumberParamSchema,
  querystring: languageQuerySchema,
  response: {
    200: okEnvelopeSchema(cardDetailSchema),
    404: errorEnvelopeSchema,
  },
};
