import {
  cardNumberParamSchema,
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
    image_thumb_url: nullable({ type: "string" }),
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

/**
 * Card body fields shared by all endpoints. Excludes legacy top-level
 * media/price fields (those now live under each variant).
 */
const cardBodyRequired = [
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
];

const cardBodyProperties = {
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
};

const scanProgressGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bucket_key",
    "bucket_label",
    "bucket_type",
    "product_count",
    "total_cards",
    "scanned_cards",
    "cards_without_image_or_scan",
    "total_variants",
    "scanned_variants",
    "variants_without_image",
  ],
  properties: {
    bucket_key: { type: "string" },
    bucket_label: { type: "string" },
    bucket_type: { type: "string", enum: ["set_product", "other_products"] },
    product_count: { type: "integer" },
    total_cards: { type: "integer" },
    scanned_cards: { type: "integer" },
    cards_without_image_or_scan: { type: "integer" },
    total_variants: { type: "integer" },
    scanned_variants: { type: "integer" },
    variants_without_image: { type: "integer" },
  },
};

const scanProgressSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "language",
    "total_cards",
    "total_scanned_cards",
    "total_cards_without_image_or_scan",
    "total_variants",
    "total_scanned_variants",
    "total_variants_without_image",
    "groups",
  ],
  properties: {
    language: { type: "string" },
    total_cards: { type: "integer" },
    total_scanned_cards: { type: "integer" },
    total_cards_without_image_or_scan: { type: "integer" },
    total_variants: { type: "integer" },
    total_scanned_variants: { type: "integer" },
    total_variants_without_image: { type: "integer" },
    groups: {
      type: "array",
      items: scanProgressGroupSchema,
    },
  },
};

const scanProgressMissingCardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card_number", "has_any_image_or_scan"],
  properties: {
    card_number: { type: "string" },
    has_any_image_or_scan: { type: "boolean" },
  },
};

const scanProgressMissingVariantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card_number", "variant_index", "label", "product_name", "product_set_code"],
  properties: {
    card_number: { type: "string" },
    variant_index: { type: "integer" },
    label: nullable({ type: "string" }),
    product_name: nullable({ type: "string" }),
    product_set_code: nullable({ type: "string" }),
  },
};

const scanProgressMissingDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bucket_key",
    "bucket_label",
    "bucket_type",
    "product_count",
    "cards_missing_scan",
    "variants_missing_scan",
    "variants_without_image",
  ],
  properties: {
    bucket_key: { type: "string" },
    bucket_label: { type: "string" },
    bucket_type: { type: "string", enum: ["set_product", "other_products"] },
    product_count: { type: "integer" },
    cards_missing_scan: {
      type: "array",
      items: scanProgressMissingCardSchema,
    },
    variants_missing_scan: {
      type: "array",
      items: scanProgressMissingVariantSchema,
    },
    variants_without_image: {
      type: "array",
      items: scanProgressMissingVariantSchema,
    },
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

const setSortEnum = [
  "name",
  "card_count",
  "released",
  "set_code",
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
    collapse: { type: "string", enum: ["card", "variant"] },
    page: { type: "string" },
    limit: { type: "string" },
    lang: { type: "string" },
  },
};

const variantMarketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tcgplayer_url", "market_price", "low_price", "mid_price", "high_price"],
  properties: {
    tcgplayer_url: nullable({ type: "string" }),
    market_price: nullable({ type: "string" }),
    low_price: nullable({ type: "string" }),
    mid_price: nullable({ type: "string" }),
    high_price: nullable({ type: "string" }),
  },
};

const variantImagesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stock", "scan"],
  properties: {
    stock: {
      type: "object",
      additionalProperties: false,
      required: ["full", "thumb"],
      properties: {
        full: nullable({ type: "string" }),
        thumb: nullable({ type: "string" }),
      },
    },
    scan: {
      type: "object",
      additionalProperties: false,
      required: ["display", "full", "thumb"],
      properties: {
        display: nullable({ type: "string" }),
        full: nullable({ type: "string" }),
        thumb: nullable({ type: "string" }),
      },
    },
  },
};

const cardVariantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["index", "name", "label", "artist", "product", "images", "market"],
  properties: {
    index: { type: "integer" },
    name: nullable({ type: "string" }),
    label: nullable({ type: "string" }),
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
    images: variantImagesSchema,
    market: variantMarketSchema,
  },
};

/**
 * Unified card item used by search. Card body + array of matching variants.
 * In search (collapse=card) variants[] contains only the prints that matched
 * the query filters; in collapse=variant it contains exactly one entry.
 */
const cardItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [...cardBodyRequired, "variants"],
  properties: {
    ...cardBodyProperties,
    variants: {
      type: "array",
      items: cardVariantSchema,
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

const officialFaqEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["question", "answer", "updated_on"],
  properties: {
    question: { type: "string" },
    answer: { type: "string" },
    updated_on: { type: "string", format: "date" },
  },
};

/**
 * Card item plus legality + available_languages. Used by the detail and
 * batch endpoints where per-card format legality is relevant.
 */
const cardDetailItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [...cardBodyRequired, "variants", "legality", "available_languages", "official_faq"],
  properties: {
    ...cardBodyProperties,
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
    official_faq: {
      type: "array",
      items: officialFaqEntrySchema,
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
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      sort: { type: "string", enum: setSortEnum },
      order: { type: "string", enum: ["asc", "desc"] },
    },
  },
  response: {
    200: okEnvelopeSchema({ type: "array", items: setSummarySchema }),
    400: errorEnvelopeSchema,
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
    200: okEnvelopeSchema(cardItemSchema),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
};

export const cardsSearchRouteSchema = {
  tags: ["Cards"],
  summary: "Search cards",
  description: "Returns card items carrying an array of matching variants. `collapse=card` (default) returns one item per matching card, with `variants[]` filtered to only the prints that matched the query's variant-level predicates (is:sp, label:, artist:, etc.). `collapse=variant` returns one item per matching print — the same card appears multiple times if multiple variants match, each with a single-element `variants[]`. The `meta` object reports the requested sort and the sort that was actually applied after any relevance fallback.",
  querystring: cardSearchQuerySchema,
  response: {
    200: cardSearchEnvelopeSchema(cardItemSchema),
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
    200: okEnvelopeSchema(cardDetailItemSchema),
    404: errorEnvelopeSchema,
  },
};

export const cardBatchRouteSchema = {
  tags: ["Cards"],
  summary: "Get batch card detail",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["card_numbers"],
    properties: {
      card_numbers: {
        type: "array",
        minItems: 1,
        maxItems: 60,
        items: { type: "string" },
      },
      lang: { type: "string" },
    },
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["data", "missing"],
      properties: {
        data: {
          type: "object",
          additionalProperties: cardDetailItemSchema,
        },
        missing: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    400: errorEnvelopeSchema,
  },
};

export const cardPlainTextRouteSchema = {
  tags: ["Cards"],
  summary: "Get plain-text card text",
  params: cardNumberParamSchema,
  querystring: languageQuerySchema,
  response: {
    200: { type: "string" },
    404: errorEnvelopeSchema,
  },
};

export const scanProgressRouteSchema = {
  tags: ["Scans"],
  summary: "Get scan progress by language",
  querystring: languageQuerySchema,
  response: {
    200: okEnvelopeSchema(scanProgressSchema),
    400: errorEnvelopeSchema,
  },
};

export const scanProgressMissingRouteSchema = {
  tags: ["Scans"],
  summary: "Get missing scan details for a product bucket",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["bucket_key"],
    properties: {
      bucket_key: { type: "string" },
    },
  },
  querystring: languageQuerySchema,
  response: {
    200: okEnvelopeSchema(scanProgressMissingDetailSchema),
    400: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
};

const prerenderManifestRouteEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["route", "render_group", "data_hash"],
  properties: {
    route: { type: "string" },
    render_group: {
      type: "string",
      enum: ["cards", "sets_index", "set_detail", "formats_index", "format_detail", "don", "scan_progress"],
    },
    data_hash: { type: "string" },
  },
};

export const prerenderManifestRouteSchema = {
  tags: ["System"],
  summary: "Get prerender route fingerprints",
  response: {
    200: okEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["generated_at", "routes"],
      properties: {
        generated_at: { type: "string", format: "date-time" },
        routes: {
          type: "array",
          items: prerenderManifestRouteEntrySchema,
        },
      },
    }),
  },
};
