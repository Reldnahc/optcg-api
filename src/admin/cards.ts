import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { bestImageSubquery, formatCard, CardRow } from "../format.js";
import { normalizeCardRarity } from "../rarity.js";

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

  const normalized = value
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1).toLowerCase());

  if (allowedValues && normalized.some((item) => !allowedValues.has(item))) {
    throw new Error(`Invalid ${field}`);
  }

  return normalized;
}

async function getCardRecord(cardNumber: string, language: string) {
  const result = await query<CardRow & { image_url: string | null }>(
    `SELECT c.*, p.name AS product_name, p.released_at,
            ${bestImageSubquery("c.id")} AS image_url
     FROM cards c
     JOIN products p ON p.id = c.product_id
     WHERE c.card_number ILIKE $1 AND c.language = $2
     LIMIT 1`,
    [cardNumber, language],
  );

  return result.rows[0] ?? null;
}

export async function adminCardsRoutes(app: FastifyInstance) {
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
         JOIN products p ON p.id = c.product_id
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

      const artist = asOptionalString(body.artist, "artist");
      if (artist !== undefined) fields.push({ column: "artist", value: artist });
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
       JOIN products p ON p.id = updated.product_id`,
      params,
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    return { data: formatCard(updated.rows[0]) };
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

    const existing = await query<{ id: string; is_default: boolean }>(
      `SELECT id, is_default FROM card_images
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

    if (existing.rows.some((row) => row.is_default)) {
      const replacement = await query<{ id: string }>(
        `SELECT id FROM card_images
         WHERE card_id = $1
         ORDER BY variant_index ASC
         LIMIT 1`,
        [card.id],
      );
      if (replacement.rows[0]) {
        await query(`UPDATE card_images SET is_default = true WHERE id = $1`, [replacement.rows[0].id]);
      }
    }

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

    try {
      const label = asOptionalString(body.label, "label");
      if (label !== undefined) fields.push({ column: "label", value: label });

      const imageUrl = asOptionalString(body.image_url, "image_url");
      if (imageUrl !== undefined) {
        if (imageUrl === null) throw new Error("image_url cannot be null");
        fields.push({ column: "image_url", value: imageUrl });
      }

      const scanUrl = asOptionalString(body.scan_url, "scan_url");
      if (scanUrl !== undefined) fields.push({ column: "scan_url", value: scanUrl });

      const sourceUrl = asOptionalString(body.source_url, "source_url");
      if (sourceUrl !== undefined) fields.push({ column: "source_url", value: sourceUrl });

      if (body.classified !== undefined) {
        fields.push({ column: "classified", value: Boolean(body.classified) });
      }

      if (body.is_default !== undefined) {
        fields.push({ column: "is_default", value: Boolean(body.is_default) });
      }
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (fields.length === 0) {
      reply.code(400);
      return { error: { status: 400, message: "No supported fields provided" } };
    }

    if (fields.some((field) => field.column === "is_default" && field.value === true)) {
      await query(`UPDATE card_images SET is_default = false WHERE card_id = $1`, [card.id]);
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
      is_default: boolean;
      label: string | null;
      classified: boolean;
    }>(
      `UPDATE card_images
       SET ${assignments.join(", ")}
       WHERE card_id = $${params.length - 1} AND variant_index = $${params.length}
       RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, is_default, label, classified`,
      params,
    );

    return { data: updated.rows[0] };
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
      const imageUrl = asOptionalString(body.image_url, "image_url");
      if (!imageUrl) throw new Error("image_url is required");

      const sourceUrl = asOptionalString(body.source_url, "source_url") ?? null;
      const scanUrl = asOptionalString(body.scan_url, "scan_url") ?? null;
      const label = asOptionalString(body.label, "label") ?? null;
      const productId = asOptionalString(body.product_id, "product_id") ?? null;
      const classified = body.classified === undefined ? true : Boolean(body.classified);
      const isDefault = body.is_default === undefined ? false : Boolean(body.is_default);

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

      if (isDefault) {
        await query(`UPDATE card_images SET is_default = false WHERE card_id = $1`, [card.id]);
      }

      const inserted = await query<{
        id: string;
        card_id: string;
        product_id: string | null;
        variant_index: number;
        image_url: string;
        source_url: string | null;
        scan_url: string | null;
        is_default: boolean;
        label: string | null;
        classified: boolean;
      }>(
        `INSERT INTO card_images (
           card_id, product_id, variant_index, image_url, source_url, scan_url, is_default, label, classified
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, is_default, label, classified`,
        [card.id, productId, variantIndex, imageUrl, sourceUrl, scanUrl, isDefault, label, classified],
      );

      return { data: inserted.rows[0] };
    } catch (error: any) {
      if (reply.sent) return;
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });
}
