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

