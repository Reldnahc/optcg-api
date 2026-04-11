import { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { getPool, query } from "optcg-db/db/client.js";
import {
  bestImageSubquery,
  cardImageAssetPublicUrlSql,
  compareVariantDisplayOrder,
  formatCard,
  CardRow,
  setName,
  thumbnailUrl,
} from "../format.js";
import { formatCardBlockLegalSql } from "../formatLegality.js";
import { normalizeCardRarity } from "../rarity.js";
import { syncCardImageAsset } from "../cardImageAssets.js";

const CARD_TYPES = new Set(["Leader", "Character", "Event", "Stage"]);
const COLORS = new Set(["Red", "Green", "Blue", "Purple", "Black", "Yellow"]);
const ATTRIBUTES = new Set(["Strike", "Slash", "Special", "Wisdom", "Ranged"]);

function asOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asOptionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function asOptionalDateString(value: unknown, field: string): string | null | undefined {
  const parsed = asOptionalString(value, field);
  if (parsed === undefined || parsed === null) return parsed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new Error(`${field} must be in YYYY-MM-DD format`);
  }

  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== parsed) {
    throw new Error(`${field} must be a valid calendar date`);
  }

  return parsed;
}

function asOptionalStringArray(
  value: unknown,
  field: string,
  allowedValues?: Set<string>,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }

  const trimmed = value
    .map((item) => item.trim())
    .filter(Boolean);

  const normalized = allowedValues
    ? trimmed.map((item) => item.charAt(0).toUpperCase() + item.slice(1).toLowerCase())
    : trimmed;

  if (allowedValues && normalized.some((item) => !allowedValues.has(item))) {
    throw new Error(`Invalid ${field}`);
  }

  return normalized;
}

function deriveSetCodeFromCardNumber(cardNumber: string): string | null {
  const match = cardNumber.match(/^([A-Z0-9]+)-/);
  return match ? match[1] : null;
}

function normalizeProductSetCode(value: unknown, field: string): string | null | undefined {
  const parsed = asOptionalString(value, field);
  if (parsed === undefined || parsed === null) return parsed;
  const normalized = parsed.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(normalized)) {
    throw new Error(`${field} must contain only letters, numbers, or hyphens`);
  }
  return normalized;
}

function normalizeProductSetCodes(value: unknown, field: string): string[] | null | undefined {
  const parsed = asOptionalStringArray(value, field);
  if (parsed === undefined || parsed === null) return parsed;
  const normalized = parsed.map((item) => {
    const code = item.toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(code)) {
      throw new Error(`${field} contains an invalid set code: ${item}`);
    }
    return code;
  });
  return [...new Set(normalized)];
}

function mergeProductSetCodes(
  targetSetCodes: string[] | null | undefined,
  sourceSetCodes: string[] | null | undefined,
): string[] | null {
  const merged: string[] = [];
  for (const code of [...(targetSetCodes ?? []), ...(sourceSetCodes ?? [])]) {
    if (!merged.includes(code)) merged.push(code);
  }
  return merged.length > 0 ? merged : null;
}

async function syncManualVariantAssets(image: {
  id: string;
  image_url: string | null;
  source_url: string | null;
  scan_url: string | null;
}, options?: { resetDerivedScanAssets?: boolean }) {
  const writes = [
    syncCardImageAsset({
      cardImageId: image.id,
      role: "image_url",
      publicUrl: image.image_url,
      sourceUrl: image.image_url ? image.source_url : null,
    }),
    syncCardImageAsset({
      cardImageId: image.id,
      role: "scan_url",
      publicUrl: image.scan_url,
    }),
  ];

  if (options?.resetDerivedScanAssets) {
    writes.push(
      syncCardImageAsset({
        cardImageId: image.id,
        role: "scan_display",
        publicUrl: null,
      }),
      syncCardImageAsset({
        cardImageId: image.id,
        role: "scan_thumb",
        storageKey: null,
        publicUrl: null,
      }),
    );
  }

  await Promise.all(writes);
}

async function getCardRecord(cardNumber: string, language: string) {
  const result = await query<CardRow & { image_url: string | null }>(
    `SELECT c.*, p.name AS product_name, p.released_at,
            ${bestImageSubquery("c.id")} AS image_url
     FROM cards c
     LEFT JOIN products p ON p.id = c.product_id
     WHERE c.card_number ILIKE $1 AND c.language = $2
     LIMIT 1`,
    [cardNumber, language],
  );

  return result.rows[0] ?? null;
}

async function getCardImageRecord(cardId: string, variantIndex: number) {
  const result = await query<{
    id: string;
    card_id: string;
    product_id: string | null;
    variant_index: number;
    label: string | null;
  }>(
    `SELECT id, card_id, product_id, variant_index, label
     FROM card_images
     WHERE card_id = $1 AND variant_index = $2
     LIMIT 1`,
    [cardId, variantIndex],
  );

  return result.rows[0] ?? null;
}

type AdminProductRow = {
  id: string;
  language: string;
  name: string;
  source: string;
  product_set_code: string | null;
  set_codes: string[] | null;
  released_at: string | null;
  primary_card_count: number;
  variant_count: number;
  card_source_count: number;
  don_count: number;
};

type AdminProductLinkedCardRow = {
  card_id: string;
  card_number: string;
  name: string;
  true_set_code: string;
  card_type: string;
  rarity: string | null;
  image_url: string | null;
  primary_reference: boolean;
  variant_reference: boolean;
  source_reference: boolean;
  variant_match_count: number;
};

async function getAdminProductRecord(
  productId: string,
  client: PoolClient | null = null,
): Promise<AdminProductRow | null> {
  const executor = client ?? getPool();
  const result = await executor.query<AdminProductRow>(
    `SELECT p.id,
            p.language,
            p.name,
            p.source,
            p.product_set_code,
            p.set_codes,
            p.released_at::text AS released_at,
            COALESCE(card_counts.primary_card_count, 0)::int AS primary_card_count,
            COALESCE(variant_counts.variant_count, 0)::int AS variant_count,
            COALESCE(card_source_counts.card_source_count, 0)::int AS card_source_count,
            COALESCE(don_counts.don_count, 0)::int AS don_count
     FROM products p
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS primary_card_count
       FROM cards c
       WHERE c.product_id = p.id
     ) AS card_counts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS variant_count
       FROM card_images ci
       WHERE ci.product_id = p.id
     ) AS variant_counts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT cs.card_id)::int AS card_source_count
       FROM card_sources cs
       WHERE cs.product_id = p.id
     ) AS card_source_counts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS don_count
       FROM don_cards d
       WHERE d.product_id = p.id
     ) AS don_counts ON true
     WHERE p.id = $1`,
    [productId],
  );
  return result.rows[0] ?? null;
}

async function ensureCardSource(client: PoolClient, cardId: string, productId: string) {
  await client.query(
    `INSERT INTO card_sources (card_id, product_id)
     VALUES ($1, $2)
     ON CONFLICT (card_id, product_id) DO NOTHING`,
    [cardId, productId],
  );
}

async function cleanupCardSource(client: PoolClient, cardId: string, productId: string) {
  await client.query(
    `DELETE FROM card_sources
     WHERE card_id = $1
       AND product_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM cards
         WHERE id = $1
           AND product_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM card_images
         WHERE card_id = $1
           AND product_id = $2
       )`,
    [cardId, productId],
  );
}

export async function adminCardsRoutes(app: FastifyInstance) {
  app.get("/products", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const limit = Math.min(500, Math.max(1, parseInt(qs.limit || "200", 10)));
    const search = qs.q?.trim() ?? "";

    const params: unknown[] = [language];
    const conditions = ["p.language = $1"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        p.name ILIKE $${params.length}
        OR p.product_set_code ILIKE $${params.length}
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(p.set_codes, ARRAY[]::text[])) AS set_code(code)
          WHERE code ILIKE $${params.length}
        )
      )`);
    }

    params.push(limit);
    const products = await query<AdminProductRow>(
      `WITH filtered_products AS (
         SELECT p.id,
                p.language,
                p.name,
                p.source,
                p.product_set_code,
                p.set_codes,
                p.released_at
         FROM products p
         WHERE ${conditions.join(" AND ")}
         ORDER BY p.released_at DESC NULLS LAST, p.name ASC, p.id ASC
         LIMIT $${params.length}
       )
       SELECT fp.id,
              fp.language,
              fp.name,
              fp.source,
              fp.product_set_code,
              fp.set_codes,
              fp.released_at::text AS released_at,
              COALESCE(card_counts.primary_card_count, 0)::int AS primary_card_count,
              COALESCE(variant_counts.variant_count, 0)::int AS variant_count,
              COALESCE(card_source_counts.card_source_count, 0)::int AS card_source_count,
              COALESCE(don_counts.don_count, 0)::int AS don_count
       FROM filtered_products fp
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS primary_card_count
         FROM cards c
         WHERE c.product_id = fp.id
       ) AS card_counts ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS variant_count
         FROM card_images ci
         WHERE ci.product_id = fp.id
       ) AS variant_counts ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT cs.card_id)::int AS card_source_count
         FROM card_sources cs
         WHERE cs.product_id = fp.id
       ) AS card_source_counts ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS don_count
         FROM don_cards d
         WHERE d.product_id = fp.id
       ) AS don_counts ON true
       ORDER BY fp.released_at DESC NULLS LAST, fp.name ASC, fp.id ASC`,
      params,
    );

    return { data: products.rows };
  });

  app.get("/products/:product_id/cards", async (req, reply) => {
    const { product_id } = req.params as { product_id: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";

    const product = await getAdminProductRecord(product_id);
    if (!product) {
      reply.code(404);
      return { error: { status: 404, message: "Product not found" } };
    }

    const cards = await query<AdminProductLinkedCardRow>(
      `WITH linked_cards AS (
         SELECT c.id AS card_id,
                true AS primary_reference,
                false AS variant_reference,
                false AS source_reference
         FROM cards c
         WHERE c.product_id = $1
           AND c.language = $2

         UNION ALL

         SELECT ci.card_id,
                false AS primary_reference,
                true AS variant_reference,
                false AS source_reference
         FROM card_images ci
         JOIN cards c ON c.id = ci.card_id
         WHERE ci.product_id = $1
           AND c.language = $2

         UNION ALL

         SELECT cs.card_id,
                false AS primary_reference,
                false AS variant_reference,
                true AS source_reference
         FROM card_sources cs
         JOIN cards c ON c.id = cs.card_id
         WHERE cs.product_id = $1
           AND c.language = $2
       )
       SELECT c.id AS card_id,
              c.card_number,
              c.name,
              c.true_set_code,
              c.card_type,
              c.rarity,
              ${bestImageSubquery("c.id")} AS image_url,
              BOOL_OR(linked_cards.primary_reference) AS primary_reference,
              BOOL_OR(linked_cards.variant_reference) AS variant_reference,
              BOOL_OR(linked_cards.source_reference) AS source_reference,
              COUNT(DISTINCT ci.id) FILTER (WHERE ci.product_id = $1)::int AS variant_match_count
       FROM linked_cards
       JOIN cards c ON c.id = linked_cards.card_id
       LEFT JOIN card_images ci ON ci.card_id = c.id
       GROUP BY c.id, c.card_number, c.name, c.true_set_code, c.card_type, c.rarity
       ORDER BY c.card_number ASC`,
      [product_id, language],
    );

    return {
      data: {
        product,
        cards: cards.rows,
      },
    };
  });

  app.post("/products", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const name = asOptionalString(body.name, "name");
      if (!name) throw new Error("name is required");

      const language = asOptionalString(body.language, "language") ?? "en";
      const source = asOptionalString(body.source, "source") ?? "bandai";
      if (source !== "bandai" && source !== "tcgplayer") {
        throw new Error("source must be either 'bandai' or 'tcgplayer'");
      }

      const productSetCode = normalizeProductSetCode(body.product_set_code, "product_set_code");
      const setCodesInput = normalizeProductSetCodes(body.set_codes, "set_codes");
      const setCodes = setCodesInput === undefined
        ? (productSetCode ? [productSetCode] : null)
        : setCodesInput;
      const releasedAt = asOptionalDateString(body.released_at, "released_at") ?? null;
      const finalProductSetCode = productSetCode ?? setCodes?.[0] ?? null;

      const inserted = await query<{ id: string }>(
        `INSERT INTO products (language, name, source, set_codes, released_at, product_set_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [language, name, source, setCodes, releasedAt, finalProductSetCode],
      );

      const product = await getAdminProductRecord(inserted.rows[0].id);
      return { data: product };
    } catch (error: any) {
      if (error?.code === "23505") {
        reply.code(409);
        return { error: { status: 409, message: "A product with that name and language already exists" } };
      }
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });

  app.post("/cards", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const cardNumber = asOptionalString(body.card_number, "card_number");
      if (!cardNumber) throw new Error("card_number is required");
      const normalizedCardNumber = cardNumber.toUpperCase();

      const existing = await getCardRecord(normalizedCardNumber, language);
      if (existing) {
        reply.code(409);
        return { error: { status: 409, message: "Card already exists" } };
      }

      const name = asOptionalString(body.name, "name");
      if (!name) throw new Error("name is required");

      const productName = asOptionalString(body.product_name, "product_name") ?? null;

      const trueSetCodeInput = asOptionalString(body.true_set_code, "true_set_code");
      const derivedSetCode = deriveSetCodeFromCardNumber(normalizedCardNumber);
      const trueSetCode = (trueSetCodeInput || derivedSetCode)?.toUpperCase() ?? null;
      if (!trueSetCode) throw new Error("true_set_code is required");

      const productSetCode = (asOptionalString(body.product_set_code, "product_set_code") || trueSetCode).toUpperCase();

      const cardType = asOptionalString(body.card_type, "card_type");
      if (!cardType) throw new Error("card_type is required");
      if (!CARD_TYPES.has(cardType)) throw new Error("Invalid card_type");

      const color = asOptionalStringArray(body.color, "color", COLORS);
      if (!color || color.length === 0) throw new Error("color must include at least one value");

      const types = asOptionalStringArray(body.types, "types");
      if (!types || types.length === 0) throw new Error("types must include at least one value");

      const rarityValue = body.rarity;
      let rarity: string | null = null;
      if (rarityValue !== undefined && rarityValue !== null && rarityValue !== "") {
        if (typeof rarityValue !== "string") throw new Error("rarity must be a string");
        rarity = normalizeCardRarity(rarityValue);
        if (!rarity) throw new Error(`Invalid rarity: ${rarityValue}`);
      }

      const cost = asOptionalNumber(body.cost, "cost") ?? null;
      const power = asOptionalNumber(body.power, "power") ?? null;
      const counter = asOptionalNumber(body.counter, "counter") ?? null;
      const life = asOptionalNumber(body.life, "life") ?? null;
      const attribute = asOptionalStringArray(body.attribute, "attribute", ATTRIBUTES) ?? null;
      const effect = asOptionalString(body.effect, "effect") ?? null;
      const trigger = asOptionalString(body.trigger, "trigger") ?? null;
      const block = asOptionalString(body.block, "block") ?? "5";
      const artist = asOptionalString(body.artist, "artist") ?? null;
      const productReleasedAt = asOptionalDateString(body.product_released_at, "product_released_at") ?? null;

      const inserted = await query<CardRow & { image_url: string | null }>(
        `WITH upserted_product AS (
           INSERT INTO products (language, name, source, set_codes, released_at, product_set_code)
           SELECT $1, $2::text, 'bandai', $3::text[], $4, $5
           WHERE $2::text IS NOT NULL
           ON CONFLICT (name, language) DO UPDATE SET
             set_codes = CASE
               WHEN products.set_codes IS NULL OR array_length(products.set_codes, 1) IS NULL OR array_length(products.set_codes, 1) = 0
                 THEN EXCLUDED.set_codes
               ELSE products.set_codes
             END,
             released_at = COALESCE(products.released_at, EXCLUDED.released_at),
             product_set_code = COALESCE(products.product_set_code, EXCLUDED.product_set_code)
           RETURNING id, name, released_at
         ),
         inserted_card AS (
           INSERT INTO cards (
             card_number, language, product_id, true_set_code, name, card_type, rarity, color,
             cost, power, counter, life, attribute, types, effect, trigger, block, artist, manually_added, needs_product_resolution
           )
           VALUES (
             $6, $1, (SELECT id FROM upserted_product LIMIT 1), $7, $8, $9, $10, $11::text[],
             $12, $13, $14, $15, $16::text[], $17::text[], $18, $19, $20, $21, true, ($2::text IS NULL)
           )
           RETURNING *
         ),
         inserted_source AS (
           INSERT INTO card_sources (card_id, product_id)
           SELECT inserted_card.id, upserted_product.id
           FROM inserted_card
           JOIN upserted_product ON true
           ON CONFLICT (card_id, product_id) DO NOTHING
         )
         SELECT inserted_card.*, upserted_product.name AS product_name, upserted_product.released_at, NULL::text AS image_url
         FROM inserted_card
         LEFT JOIN upserted_product ON upserted_product.id = inserted_card.product_id`,
        [
          language,
          productName,
          [trueSetCode],
          productReleasedAt,
          productSetCode,
          normalizedCardNumber,
          trueSetCode,
          name,
          cardType,
          rarity,
          color,
          cost,
          power,
          counter,
          life,
          attribute,
          types,
          effect,
          trigger,
          block,
          artist,
        ],
      );

      return {
        data: {
          card_number: inserted.rows[0].card_number,
          language: inserted.rows[0].language,
        },
      };
    } catch (error: any) {
      if (reply.sent) return;
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });

  app.get("/cards", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const page = Math.max(1, parseInt(qs.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "20", 10)));
    const offset = (page - 1) * limit;
    const language = qs.lang || "en";

    const conditions: string[] = ["c.language = $1"];
    const params: unknown[] = [language];
    let idx = 2;

    if (qs.name) {
      conditions.push(`c.name ILIKE $${idx}`);
      params.push(`%${qs.name}%`);
      idx++;
    }
    if (qs.set) {
      conditions.push(`c.true_set_code = $${idx}`);
      params.push(qs.set.toUpperCase());
      idx++;
    }
    if (qs.type) {
      conditions.push(`c.card_type ILIKE $${idx}`);
      params.push(qs.type);
      idx++;
    }
    if (qs.rarity) {
      const rarity = normalizeCardRarity(qs.rarity);
      if (!rarity) {
        reply.code(400);
        return { error: { status: 400, message: `Invalid rarity: ${qs.rarity}` } };
      }
      conditions.push(`c.rarity = $${idx}`);
      params.push(rarity);
      idx++;
    }

    const where = conditions.join(" AND ");

    const [countResult, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM cards c
         WHERE ${where}`,
        params,
      ),
      query<CardRow & { image_url: string | null; image_count: string }>(
        `SELECT c.*, p.name AS product_name, p.released_at,
                ${bestImageSubquery("c.id")} AS image_url,
                (SELECT COUNT(*) FROM card_images ci WHERE ci.card_id = c.id) AS image_count
         FROM cards c
         LEFT JOIN products p ON p.id = c.product_id
         WHERE ${where}
         ORDER BY p.released_at DESC NULLS LAST, c.card_number ASC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    return {
      data: rows.rows.map((row) => ({
        ...formatCard(row),
        id: row.id,
        image_count: parseInt(row.image_count, 10),
      })),
      pagination: { page, limit, total, has_more: offset + limit < total },
    };
  });

  app.get("/cards/:card_number", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";

    const cardResult = await query<CardRow & { set_product_name: string | null }>(
      `SELECT c.*, p.name AS product_name, p.released_at,
              (SELECT p2.name FROM products p2
               WHERE p2.language = c.language AND p2.set_codes[1] = c.true_set_code
               LIMIT 1) AS set_product_name
       FROM cards c
       LEFT JOIN products p ON p.id = c.product_id
       WHERE c.card_number ILIKE $1 AND c.language = $2
       LIMIT 1`,
      [card_number, language],
    );

    if (cardResult.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const card = cardResult.rows[0];

    const [images, legality, cardBans, languages] = await Promise.all([
      query<{
        product_id: string | null;
        variant_index: number;
        image_url: string | null;
        scan_url: string | null;
        scan_thumb_url: string | null;
        artist: string | null;
        label: string | null;
        classified: boolean;
        product_name: string | null;
        product_set_code: string | null;
        product_released_at: string | null;
        canonical_tcgplayer_url: string | null;
        tcgplayer_url: string | null;
        market_price: string | null;
        low_price: string | null;
        mid_price: string | null;
        high_price: string | null;
        sub_type: string | null;
      }>(
        `SELECT ci.product_id, ci.variant_index,
                ${cardImageAssetPublicUrlSql("ci.id", "image_url", "ci.image_url")} AS image_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_url", "ci.scan_url")} AS scan_url,
                ${cardImageAssetPublicUrlSql("ci.id", "scan_thumb", "ci.scan_thumb_url")} AS scan_thumb_url,
                ci.artist,
                ci.label, ci.classified,
                ip.name AS product_name, ip.product_set_code, ip.released_at AS product_released_at,
                canonical_tp.tcgplayer_url AS canonical_tcgplayer_url,
                tp.tcgplayer_url, tp.sub_type,
                pr.market_price, pr.low_price, pr.mid_price, pr.high_price
         FROM card_images ci
         JOIN cards c ON c.id = ci.card_id
         LEFT JOIN products ip ON ip.id = ci.product_id
         LEFT JOIN LATERAL (
           SELECT tp2.tcgplayer_url
           FROM tcgplayer_products tp2
           WHERE tp2.card_image_id = ci.id
           ORDER BY CASE
             WHEN NULLIF(tp2.tcgplayer_url, '') IS NULL THEN 1
             ELSE 0
           END,
           CASE
             WHEN NULLIF(tp2.sub_type, '') IS NULL OR tp2.sub_type = 'Normal' THEN 0
             ELSE 1
           END,
           COALESCE(NULLIF(tp2.sub_type, ''), ''),
           tp2.tcgplayer_product_id
           LIMIT 1
         ) canonical_tp ON true
         LEFT JOIN tcgplayer_products tp ON tp.card_image_id = ci.id
         LEFT JOIN LATERAL (
           SELECT market_price, low_price, mid_price, high_price
           FROM tcgplayer_prices
           WHERE tcgplayer_product_id = tp.tcgplayer_product_id
             AND sub_type IS NOT DISTINCT FROM tp.sub_type
           ORDER BY fetched_at DESC LIMIT 1
         ) pr ON true
         WHERE ci.card_id = $1
         ORDER BY ci.variant_index,
           CASE
             WHEN NULLIF(tp.tcgplayer_url, '') IS NULL THEN 1
             ELSE 0
           END,
           CASE
             WHEN NULLIF(tp.sub_type, '') IS NULL OR tp.sub_type = 'Normal' THEN 0
             ELSE 1
           END,
           COALESCE(NULLIF(tp.sub_type, ''), ''),
           tp.tcgplayer_product_id`,
        [card.id],
      ),
      query<{
        format_name: string;
        legal: boolean;
      }>(
        `SELECT f.name AS format_name,
                COALESCE(BOOL_OR(${formatCardBlockLegalSql("$1", "flb", "f")}), false) AS legal
         FROM formats f
         LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id AND flb.block = $1
         GROUP BY f.id, f.name`,
        [card.block],
      ),
      query<{
        format_name: string;
        ban_type: string;
        max_copies: number | null;
        banned_at: string;
        reason: string | null;
        paired_card_number: string | null;
      }>(
        `SELECT f.name AS format_name, fb.ban_type, fb.max_copies, fb.banned_at, fb.reason, fb.paired_card_number
         FROM format_bans fb
         JOIN formats f ON f.id = fb.format_id
         WHERE fb.card_number = $1 AND fb.unbanned_at IS NULL`,
        [card.card_number],
      ),
      query<{ language: string }>(
        `SELECT DISTINCT language FROM cards WHERE card_number ILIKE $1 ORDER BY language`,
        [card_number],
      ),
    ]);

    const now = new Date();
    const isReleased = card.released_at ? new Date(card.released_at) <= now : false;

    const imageMap = new Map<number, {
      product_id: string | null;
      variant_index: number;
      image_url: string | null;
      scan_url: string | null;
      scan_thumb_url: string | null;
      artist: string | null;
      label: string | null;
      product_name: string | null;
      product_set_code: string | null;
      product_released_at: string | null;
      tcgplayer_url: string | null;
      prices: Record<string, {
        market_price: string | null;
        low_price: string | null;
        mid_price: string | null;
        high_price: string | null;
        tcgplayer_url: string | null;
      }>;
    }>();

    for (const img of images.rows) {
      let entry = imageMap.get(img.variant_index);
      if (!entry) {
        entry = {
          product_id: img.product_id,
          variant_index: img.variant_index,
          image_url: img.image_url,
          scan_url: img.scan_url,
          scan_thumb_url: img.scan_thumb_url,
          artist: img.artist,
          label: img.label,
          product_name: img.product_name,
          product_set_code: img.product_set_code,
          product_released_at: img.product_released_at,
          tcgplayer_url: img.canonical_tcgplayer_url,
          prices: {},
        };
        imageMap.set(img.variant_index, entry);
      }
      if (!entry.tcgplayer_url && img.canonical_tcgplayer_url) {
        entry.tcgplayer_url = img.canonical_tcgplayer_url;
      }
      if (img.market_price !== null) {
        const key = img.sub_type || "Normal";
        entry.prices[key] = {
          market_price: img.market_price,
          low_price: img.low_price,
          mid_price: img.mid_price,
          high_price: img.high_price,
          tcgplayer_url: img.tcgplayer_url,
        };
      }
    }

    const bansByFormat = new Map<string, typeof cardBans.rows>();
    for (const ban of cardBans.rows) {
      const arr = bansByFormat.get(ban.format_name) ?? [];
      arr.push(ban);
      bansByFormat.set(ban.format_name, arr);
    }

    const legalityObj: Record<string, {
      status: string;
      banned_at?: string;
      reason?: string;
      max_copies?: number;
      paired_with?: string[];
    }> = {};
    for (const row of legality.rows) {
      const bans = bansByFormat.get(row.format_name) ?? [];

      if (!isReleased) {
        const releaseDate = card.released_at ? new Date(card.released_at) : null;
        const status = releaseDate
          ? `Releases ${releaseDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
          : "unreleased";
        legalityObj[row.format_name] = { status };
      } else if (bans.length > 0) {
        const ban = bans[0];
        const entry: typeof legalityObj[string] = { status: ban.ban_type };
        if (ban.banned_at) entry.banned_at = ban.banned_at;
        if (ban.reason) entry.reason = ban.reason;
        if (ban.ban_type === "restricted" && ban.max_copies != null) {
          entry.max_copies = ban.max_copies;
        }
        if (ban.ban_type === "pair") {
          entry.paired_with = bans
            .filter((b) => b.paired_card_number)
            .map((b) => b.paired_card_number!);
        }
        legalityObj[row.format_name] = entry;
      } else if (row.legal) {
        legalityObj[row.format_name] = { status: "legal" };
      } else {
        legalityObj[row.format_name] = { status: "not_legal" };
      }
    }

    return {
      data: {
        ...formatCard(card),
        set_name: card.set_product_name ?? setName(card.true_set_code),
        images: [...imageMap.values()]
          .sort((a, b) => compareVariantDisplayOrder(
            {
              image_url: a.image_url,
              label: a.label,
              variant_index: a.variant_index,
              released_at: a.product_released_at,
            },
            {
              image_url: b.image_url,
              label: b.label,
              variant_index: b.variant_index,
              released_at: b.product_released_at,
            },
          ))
          .map(({ scan_url, scan_thumb_url, ...rest }) => ({
            ...rest,
            thumbnail_url: thumbnailUrl(rest.image_url),
            ...(scan_url ? { scan_url } : {}),
            ...(scan_thumb_url ? { scan_thumb_url } : {}),
          })),
        legality: legalityObj,
        available_languages: languages.rows.map((r) => r.language),
      },
    };
  });

  app.put("/cards/:card_number", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;

    const fields: Array<{ column: string; value: unknown }> = [];

    try {
      const name = asOptionalString(body.name, "name");
      if (name !== undefined) {
        if (name === null) throw new Error("name cannot be null");
        fields.push({ column: "name", value: name });
      }

      const rarityValue = body.rarity;
      if (rarityValue !== undefined) {
        if (rarityValue === null) {
          fields.push({ column: "rarity", value: null });
        } else if (typeof rarityValue === "string") {
          const rarity = normalizeCardRarity(rarityValue);
          if (!rarity) throw new Error(`Invalid rarity: ${rarityValue}`);
          fields.push({ column: "rarity", value: rarity });
        } else {
          throw new Error("rarity must be a string");
        }
      }

      const trueSetCode = asOptionalString(body.true_set_code, "true_set_code");
      if (trueSetCode !== undefined) {
        if (trueSetCode === null) throw new Error("true_set_code cannot be null");
        fields.push({ column: "true_set_code", value: trueSetCode.toUpperCase() });
      }

      const cardType = asOptionalString(body.card_type, "card_type");
      if (cardType !== undefined) {
        if (cardType === null) throw new Error("card_type cannot be null");
        if (!CARD_TYPES.has(cardType)) throw new Error("Invalid card_type");
        fields.push({ column: "card_type", value: cardType });
      }

      const color = asOptionalStringArray(body.color, "color", COLORS);
      if (color !== undefined) {
        if (color === null || color.length === 0) throw new Error("color must include at least one value");
        fields.push({ column: "color", value: color });
      }

      const cost = asOptionalNumber(body.cost, "cost");
      if (cost !== undefined) fields.push({ column: "cost", value: cost });

      const power = asOptionalNumber(body.power, "power");
      if (power !== undefined) fields.push({ column: "power", value: power });

      const counter = asOptionalNumber(body.counter, "counter");
      if (counter !== undefined) fields.push({ column: "counter", value: counter });

      const life = asOptionalNumber(body.life, "life");
      if (life !== undefined) fields.push({ column: "life", value: life });

      const attribute = asOptionalStringArray(body.attribute, "attribute", ATTRIBUTES);
      if (attribute !== undefined) fields.push({ column: "attribute", value: attribute });

      const types = asOptionalStringArray(body.types, "types");
      if (types !== undefined) {
        if (types === null || types.length === 0) throw new Error("types must include at least one value");
        fields.push({ column: "types", value: types });
      }

      const effect = asOptionalString(body.effect, "effect");
      if (effect !== undefined) fields.push({ column: "effect", value: effect });

      const trigger = asOptionalString(body.trigger, "trigger");
      if (trigger !== undefined) fields.push({ column: "trigger", value: trigger });

      const block = asOptionalString(body.block, "block");
      if (block !== undefined) fields.push({ column: "block", value: block });

    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (fields.length === 0) {
      reply.code(400);
      return { error: { status: 400, message: "No supported fields provided" } };
    }

    const assignments = fields.map((field, index) => `${field.column} = $${index + 1}`);
    const params = fields.map((field) => field.value);
    params.push(card_number, language);

    const updated = await query<CardRow & { image_url: string | null }>(
      `WITH updated AS (
         UPDATE cards
         SET ${assignments.join(", ")}, updated_at = NOW()
         WHERE card_number ILIKE $${params.length - 1} AND language = $${params.length}
         RETURNING *
       )
       SELECT updated.*, p.name AS product_name, p.released_at,
              ${bestImageSubquery("updated.id")} AS image_url
       FROM updated
       LEFT JOIN products p ON p.id = updated.product_id`,
      params,
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    return { data: formatCard(updated.rows[0]) };
  });

  app.put("/products/:product_id", async (req, reply) => {
    const { product_id } = req.params as { product_id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    const fields: Array<{ column: string; value: unknown }> = [];
    try {
      const name = asOptionalString(body.name, "name");
      if (name !== undefined) fields.push({ column: "name", value: name });

      const releasedAt = asOptionalDateString(body.released_at, "released_at");
      if (releasedAt !== undefined) fields.push({ column: "released_at", value: releasedAt });

      const setCodes = normalizeProductSetCodes(body.set_codes, "set_codes");
      if (setCodes !== undefined) {
        fields.push({ column: "set_codes", value: setCodes });
        if (body.product_set_code === undefined) {
          fields.push({ column: "product_set_code", value: setCodes?.[0] ?? null });
        }
      }

      const productSetCode = normalizeProductSetCode(body.product_set_code, "product_set_code");
      if (productSetCode !== undefined) {
        fields.push({ column: "product_set_code", value: productSetCode });
      }
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (fields.length === 0) {
      reply.code(400);
      return { error: { status: 400, message: "No supported fields provided" } };
    }

    try {
      const assignments = fields.map((field, index) => `${field.column} = $${index + 1}`);
      const params = fields.map((field) => field.value);
      params.push(product_id);

      const updated = await query<{ id: string }>(
        `UPDATE products
         SET ${assignments.join(", ")}
         WHERE id = $${params.length}
         RETURNING id`,
        params,
      );

      if (updated.rows.length === 0) {
        reply.code(404);
        return { error: { status: 404, message: "Product not found" } };
      }

      const product = await getAdminProductRecord(product_id);
      return { data: product };
    } catch (error: any) {
      if (error?.code === "23505") {
        reply.code(409);
        return { error: { status: 409, message: "A product with that name and language already exists" } };
      }
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });

  app.post("/products/:product_id/merge", async (req, reply) => {
    const { product_id } = req.params as { product_id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    let targetProductId: string | null | undefined;
    try {
      targetProductId = asOptionalString(body.target_product_id, "target_product_id");
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (!targetProductId) {
      reply.code(400);
      return { error: { status: 400, message: "target_product_id is required" } };
    }
    if (targetProductId === product_id) {
      reply.code(400);
      return { error: { status: 400, message: "Cannot merge a product into itself" } };
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");

      const source = await getAdminProductRecord(product_id, client);
      const target = await getAdminProductRecord(targetProductId, client);

      if (!source || !target) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: { status: 404, message: "Source or target product not found" } };
      }
      if (source.language !== target.language) {
        await client.query("ROLLBACK");
        reply.code(400);
        return { error: { status: 400, message: "Products must share the same language to merge" } };
      }

      const donConflict = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM don_cards source_don
         JOIN don_cards target_don
           ON target_don.product_id = $2
          AND target_don.character = source_don.character
          AND target_don.finish = source_don.finish
         WHERE source_don.product_id = $1`,
        [product_id, targetProductId],
      );
      if (parseInt(donConflict.rows[0]?.count ?? "0", 10) > 0) {
        await client.query("ROLLBACK");
        reply.code(409);
        return {
          error: { status: 409, message: "Cannot merge products because DON!! entries would conflict" },
        };
      }

      const mergedSetCodes = mergeProductSetCodes(target.set_codes, source.set_codes);
      const mergedReleasedAt = target.released_at ?? source.released_at;
      const mergedSetCode = target.product_set_code ?? source.product_set_code ?? mergedSetCodes?.[0] ?? null;

      await client.query(
        `UPDATE products
         SET set_codes = $1,
             released_at = $2,
             product_set_code = $3
         WHERE id = $4`,
        [mergedSetCodes, mergedReleasedAt, mergedSetCode, targetProductId],
      );

      await client.query(
        `INSERT INTO card_sources (card_id, product_id)
         SELECT DISTINCT refs.card_id, $2
         FROM (
           SELECT card_id FROM card_sources WHERE product_id = $1
           UNION
           SELECT id AS card_id FROM cards WHERE product_id = $1
           UNION
           SELECT card_id FROM card_images WHERE product_id = $1
         ) refs
         ON CONFLICT (card_id, product_id) DO NOTHING`,
        [product_id, targetProductId],
      );

      const cardsUpdated = await client.query(
        `UPDATE cards
         SET product_id = $2
         WHERE product_id = $1`,
        [product_id, targetProductId],
      );
      const variantsUpdated = await client.query(
        `UPDATE card_images
         SET product_id = $2
         WHERE product_id = $1`,
        [product_id, targetProductId],
      );
      const donUpdated = await client.query(
        `UPDATE don_cards
         SET product_id = $2
         WHERE product_id = $1`,
        [product_id, targetProductId],
      );

      await client.query(
        `DELETE FROM card_sources
         WHERE product_id = $1`,
        [product_id],
      );

      const deleted = await client.query(
        `DELETE FROM products
         WHERE id = $1`,
        [product_id],
      );
      if ((deleted.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: { status: 404, message: "Source product disappeared during merge" } };
      }

      await client.query("COMMIT");

      return {
        data: {
          product: null,
          source_product_id: product_id,
          target_product_id: targetProductId,
          cards_updated: cardsUpdated.rowCount ?? 0,
          variants_updated: variantsUpdated.rowCount ?? 0,
          don_updated: donUpdated.rowCount ?? 0,
        },
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      req.log.error(
        {
          source_product_id: product_id,
          target_product_id: targetProductId,
          error_code: error?.code,
          error_message: error?.message,
        },
        "Admin product merge failed",
      );

      if (error?.code === "23503") {
        reply.code(409);
        return { error: { status: 409, message: "Source product still has references after merge" } };
      }
      if (error?.code === "55P03") {
        reply.code(409);
        return { error: { status: 409, message: "Product merge is blocked by another database lock. Try again." } };
      }
      if (error?.code === "57014") {
        reply.code(503);
        return { error: { status: 503, message: "Product merge timed out before completion. Try again." } };
      }

      reply.code(400);
      return { error: { status: 400, message: error.message } };
    } finally {
      client.release();
    }
  });

  app.delete("/products/:product_id", async (req, reply) => {
    const { product_id } = req.params as { product_id: string };
    const product = await getAdminProductRecord(product_id);

    if (!product) {
      reply.code(404);
      return { error: { status: 404, message: "Product not found" } };
    }

    if (
      product.primary_card_count > 0
      || product.variant_count > 0
      || product.card_source_count > 0
      || product.don_count > 0
    ) {
      reply.code(409);
      return {
        error: {
          status: 409,
          message: "Product is still referenced. Reassign or merge it before deleting.",
        },
      };
    }

    await query(
      `DELETE FROM products
       WHERE id = $1`,
      [product_id],
    );

    return { ok: true };
  });

  app.get("/cards/:card_number/tcgplayer-products", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const variantsResult = await query<{
      id: string;
      variant_index: number;
      label: string | null;
      artist: string | null;
    }>(
      `SELECT id, variant_index, label, artist
       FROM card_images
       WHERE card_id = $1
       ORDER BY variant_index ASC`,
      [card.id],
    );

    const variantIds = variantsResult.rows.map((row) => row.id);

    const candidateResult = await query<{
      id: string;
      tcgplayer_product_id: number;
      name: string;
      sub_type: string | null;
      tcgplayer_url: string | null;
      image_url: string | null;
      card_image_id: string | null;
      linked_variant_index: number | null;
      linked_card_number: string | null;
      linked_language: string | null;
    }>(
      `SELECT tp.id,
              tp.tcgplayer_product_id,
              tp.name,
              tp.sub_type,
              tp.tcgplayer_url,
              tp.image_url,
              tp.card_image_id,
              linked_ci.variant_index AS linked_variant_index,
              linked_card.card_number AS linked_card_number,
              linked_card.language AS linked_language
       FROM tcgplayer_products tp
       LEFT JOIN card_images linked_ci ON linked_ci.id = tp.card_image_id
       LEFT JOIN cards linked_card ON linked_card.id = linked_ci.card_id
       WHERE tp.product_type = 'card'
         AND (
           tp.ext_number ILIKE $1
           OR tp.card_image_id IN (
             SELECT id FROM card_images WHERE card_id = $2
           )
         )
       ORDER BY
         CASE
           WHEN tp.card_image_id IN (
             SELECT id FROM card_images WHERE card_id = $2
           ) THEN 0
           ELSE 1
         END,
         tp.tcgplayer_product_id ASC,
         COALESCE(tp.sub_type, '') ASC`,
      [card.card_number, card.id],
    );

    const linkedByVariantId = new Map<string, typeof candidateResult.rows>();
    for (const candidate of candidateResult.rows) {
      if (!candidate.card_image_id || !variantIds.includes(candidate.card_image_id)) continue;
      const current = linkedByVariantId.get(candidate.card_image_id) ?? [];
      current.push(candidate);
      linkedByVariantId.set(candidate.card_image_id, current);
    }

    return {
      data: {
        variants: variantsResult.rows.map((variant) => ({
          variant_index: variant.variant_index,
          label: variant.label,
          artist: variant.artist,
          linked_products: linkedByVariantId.get(variant.id) ?? [],
        })),
        candidates: candidateResult.rows,
      },
    };
  });

  app.delete("/cards/:card_number", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const imageIds = await query<{ id: string }>(
      `SELECT id
       FROM card_images
       WHERE card_id = $1`,
      [card.id],
    );

    const ids = imageIds.rows.map((row) => row.id);

    if (ids.length > 0) {
      await query(
        `UPDATE tcgplayer_products
         SET card_image_id = NULL
         WHERE card_image_id = ANY($1::uuid[])`,
        [ids],
      );

      await query(
        `UPDATE scan_ingest_items
         SET linked_card_image_id = NULL
         WHERE linked_card_image_id = ANY($1::uuid[])`,
        [ids],
      );
    }

    await query(
      `UPDATE scan_ingest_items
       SET linked_card_id = NULL
       WHERE linked_card_id = $1`,
      [card.id],
    );

    await query(
      `DELETE FROM card_images
       WHERE card_id = $1`,
      [card.id],
    );

    await query(
      `DELETE FROM card_sources
       WHERE card_id = $1`,
      [card.id],
    );

    await query(
      `DELETE FROM cards
       WHERE id = $1`,
      [card.id],
    );

    return { ok: true };
  });

  app.delete("/cards/:card_number/images/:variant_index", async (req, reply) => {
    const { card_number, variant_index } = req.params as { card_number: string; variant_index: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const variantIndex = parseInt(variant_index, 10);

    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const existing = await query<{ id: string }>(
      `SELECT id FROM card_images
       WHERE card_id = $1 AND variant_index = $2`,
      [card.id, variantIndex],
    );

    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Image variant not found" } };
    }

    await query(
      `UPDATE tcgplayer_products
       SET card_image_id = NULL
       WHERE card_image_id IN (
         SELECT id FROM card_images WHERE card_id = $1 AND variant_index = $2
       )`,
      [card.id, variantIndex],
    );

    await query(
      `DELETE FROM card_images
       WHERE card_id = $1 AND variant_index = $2`,
      [card.id, variantIndex],
    );

    return { data: { deleted: existing.rows.length } };
  });

  app.put("/cards/:card_number/images/:variant_index", async (req, reply) => {
    const { card_number, variant_index } = req.params as { card_number: string; variant_index: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const variantIndex = parseInt(variant_index, 10);

    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const existing = await query<{ id: string }>(
      `SELECT id FROM card_images
       WHERE card_id = $1 AND variant_index = $2
       LIMIT 1`,
      [card.id, variantIndex],
    );

    if (existing.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Image variant not found" } };
    }

    const fields: Array<{ column: string; value: unknown }> = [];
    let resetDerivedScanAssets = false;

    try {
      const label = asOptionalString(body.label, "label");
      if (label !== undefined) fields.push({ column: "label", value: label });

      const imageUrl = asOptionalString(body.image_url, "image_url");
      if (imageUrl !== undefined) {
        if (imageUrl === null) throw new Error("image_url cannot be null");
        fields.push({ column: "image_url", value: imageUrl });
      }

      const scanUrl = asOptionalString(body.scan_url, "scan_url");
      if (scanUrl !== undefined) {
        fields.push({ column: "scan_url", value: scanUrl });
        resetDerivedScanAssets = true;
      }

      const sourceUrl = asOptionalString(body.source_url, "source_url");
      if (sourceUrl !== undefined) fields.push({ column: "source_url", value: sourceUrl });

      const artist = asOptionalString(body.artist, "artist");
      if (artist !== undefined) fields.push({ column: "artist", value: artist });

      if (body.classified !== undefined) {
        fields.push({ column: "classified", value: Boolean(body.classified) });
      }
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (fields.length === 0) {
      reply.code(400);
      return { error: { status: 400, message: "No supported fields provided" } };
    }

    const assignments = fields.map((field, index) => `${field.column} = $${index + 1}`);
    const params = fields.map((field) => field.value);
    params.push(card.id, variantIndex);

    const updated = await query<{
      id: string;
      card_id: string;
      product_id: string | null;
      variant_index: number;
      image_url: string | null;
      source_url: string | null;
      scan_url: string | null;
      artist: string | null;
      label: string | null;
      classified: boolean;
    }>(
      `UPDATE card_images
       SET ${assignments.join(", ")}
       WHERE card_id = $${params.length - 1} AND variant_index = $${params.length}
       RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, artist, label, classified`,
      params,
    );

    await syncManualVariantAssets(updated.rows[0], {
      resetDerivedScanAssets,
    });
    return { data: updated.rows[0] };
  });

  app.put("/cards/:card_number/images/:variant_index/tcgplayer-products", async (req, reply) => {
    const { card_number, variant_index } = req.params as { card_number: string; variant_index: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const variantIndex = parseInt(variant_index, 10);
    const tcgplayerProductRowId = asOptionalString(body.tcgplayer_product_row_id, "tcgplayer_product_row_id");

    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }
    if (!tcgplayerProductRowId) {
      reply.code(400);
      return { error: { status: 400, message: "tcgplayer_product_row_id is required" } };
    }

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const image = await getCardImageRecord(card.id, variantIndex);
    if (!image) {
      reply.code(404);
      return { error: { status: 404, message: "Image variant not found" } };
    }

    const updated = await query<{
      id: string;
      tcgplayer_product_id: number;
      name: string;
      sub_type: string | null;
      tcgplayer_url: string | null;
      card_image_id: string | null;
    }>(
      `UPDATE tcgplayer_products
       SET card_image_id = $1, updated_at = NOW()
       WHERE id = $2
         AND product_type = 'card'
       RETURNING id, tcgplayer_product_id, name, sub_type, tcgplayer_url, card_image_id`,
      [image.id, tcgplayerProductRowId],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "TCGplayer product not found" } };
    }

    return { data: updated.rows[0] };
  });

  app.put("/cards/:card_number/images/:variant_index/product", async (req, reply) => {
    const { card_number, variant_index } = req.params as { card_number: string; variant_index: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const variantIndex = parseInt(variant_index, 10);

    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }

    let nextProductId: string | null | undefined;
    try {
      nextProductId = asOptionalString(body.product_id, "product_id");
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (nextProductId === undefined) {
      reply.code(400);
      return { error: { status: 400, message: "product_id is required" } };
    }

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const image = await getCardImageRecord(card.id, variantIndex);
    if (!image) {
      reply.code(404);
      return { error: { status: 404, message: "Image variant not found" } };
    }

    if (nextProductId === image.product_id) {
      return { data: { product_id: image.product_id } };
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      if (nextProductId) {
        const nextProduct = await getAdminProductRecord(nextProductId, client);
        if (!nextProduct) {
          await client.query("ROLLBACK");
          reply.code(404);
          return { error: { status: 404, message: "Product not found" } };
        }
        if (nextProduct.language !== language) {
          await client.query("ROLLBACK");
          reply.code(400);
          return { error: { status: 400, message: "Variant product must match the card language" } };
        }
      }

      await client.query(
        `UPDATE card_images
         SET product_id = $1
         WHERE id = $2`,
        [nextProductId, image.id],
      );

      if (nextProductId) {
        await ensureCardSource(client, card.id, nextProductId);
      }
      if (image.product_id && image.product_id !== nextProductId) {
        await cleanupCardSource(client, card.id, image.product_id);
      }

      await client.query("COMMIT");
      return { data: { product_id: nextProductId } };
    } catch (error: any) {
      await client.query("ROLLBACK");
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    } finally {
      client.release();
    }
  });

  app.delete("/cards/:card_number/images/:variant_index/tcgplayer-products/:mapping_id", async (req, reply) => {
    const { card_number, variant_index, mapping_id } = req.params as {
      card_number: string;
      variant_index: string;
      mapping_id: string;
    };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const variantIndex = parseInt(variant_index, 10);

    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "variant_index must be a non-negative integer" } };
    }

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    const image = await getCardImageRecord(card.id, variantIndex);
    if (!image) {
      reply.code(404);
      return { error: { status: 404, message: "Image variant not found" } };
    }

    const updated = await query<{ id: string }>(
      `UPDATE tcgplayer_products
       SET card_image_id = NULL, updated_at = NOW()
       WHERE id = $1
         AND card_image_id = $2
       RETURNING id`,
      [mapping_id, image.id],
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Mapped TCGplayer product not found" } };
    }

    return { data: { unmapped: 1 } };
  });

  app.post("/cards/:card_number/images", async (req, reply) => {
    const { card_number } = req.params as { card_number: string };
    const qs = req.query as Record<string, string>;
    const language = qs.lang || "en";
    const body = (req.body ?? {}) as Record<string, unknown>;

    const card = await getCardRecord(card_number, language);
    if (!card) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    try {
      const imageUrl = asOptionalString(body.image_url, "image_url") ?? null;

      const sourceUrl = asOptionalString(body.source_url, "source_url") ?? null;
      const scanUrl = asOptionalString(body.scan_url, "scan_url") ?? null;
      const label = asOptionalString(body.label, "label") ?? null;
      const artist = asOptionalString(body.artist, "artist") ?? null;
      const productId = asOptionalString(body.product_id, "product_id") ?? null;
      const classified = body.classified === undefined ? true : Boolean(body.classified);

      let variantIndex: number;
      if (body.variant_index === undefined) {
        const nextVariant = await query<{ next_variant_index: number | null }>(
          `SELECT COALESCE(MAX(variant_index) + 1, 0) AS next_variant_index
           FROM card_images
           WHERE card_id = $1`,
          [card.id],
        );
        variantIndex = nextVariant.rows[0].next_variant_index ?? 0;
      } else {
        if (typeof body.variant_index !== "number" || !Number.isInteger(body.variant_index) || body.variant_index < 0) {
          throw new Error("variant_index must be a non-negative integer");
        }
        variantIndex = body.variant_index;
        const existing = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM card_images
           WHERE card_id = $1 AND variant_index = $2`,
          [card.id, variantIndex],
        );
        if (parseInt(existing.rows[0].count, 10) > 0) {
          reply.code(409);
          return { error: { status: 409, message: "variant_index already exists" } };
        }
      }

      const inserted = await query<{
        id: string;
        card_id: string;
        product_id: string | null;
        variant_index: number;
        image_url: string | null;
        source_url: string | null;
        scan_url: string | null;
        artist: string | null;
        label: string | null;
        classified: boolean;
        manually_added: boolean;
      }>(
        `INSERT INTO card_images (
           card_id, product_id, variant_index, image_url, source_url, scan_url, artist, label, classified, manually_added
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, artist, label, classified, manually_added`,
        [card.id, productId, variantIndex, imageUrl, sourceUrl, scanUrl, artist, label, classified],
      );

      await syncManualVariantAssets(inserted.rows[0], {
        resetDerivedScanAssets: scanUrl !== null,
      });
      return { data: inserted.rows[0] };
    } catch (error: any) {
      if (reply.sent) return;
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });
}
