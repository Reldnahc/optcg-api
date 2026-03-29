import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import {
  bestImageSubquery,
  formatCard,
  CardRow,
  labelOrder,
  setName,
  thumbnailUrl,
} from "../format.js";
import { formatBlockIsLegalSql } from "../formatLegality.js";
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

async function getCardImageRecord(cardId: string, variantIndex: number) {
  const result = await query<{
    id: string;
    variant_index: number;
    label: string | null;
  }>(
    `SELECT id, variant_index, label
     FROM card_images
     WHERE card_id = $1 AND variant_index = $2
     LIMIT 1`,
    [cardId, variantIndex],
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
       JOIN products p ON p.id = c.product_id
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
        variant_index: number;
        image_url: string | null;
        scan_url: string | null;
        scan_thumb_url: string | null;
        artist: string | null;
        label: string | null;
        classified: boolean;
        is_default: boolean;
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
        `SELECT ci.variant_index, ci.image_url, ci.scan_url, ci.scan_thumb_url,
                ci.artist,
                ci.label, ci.classified, ci.is_default,
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
                COALESCE(BOOL_AND(${formatBlockIsLegalSql("flb")}), false) AS legal
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
      variant_index: number;
      image_url: string | null;
      scan_url: string | null;
      scan_thumb_url: string | null;
      artist: string | null;
      label: string | null;
      is_default: boolean;
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
          variant_index: img.variant_index,
          image_url: img.image_url,
          scan_url: img.scan_url,
          scan_thumb_url: img.scan_thumb_url,
          artist: img.artist,
          label: img.label,
          is_default: img.is_default,
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
          .sort((a, b) => {
            const labelDiff = labelOrder(a.label) - labelOrder(b.label);
            if (labelDiff !== 0) return labelDiff;
            const dateA = a.product_released_at ?? "";
            const dateB = b.product_released_at ?? "";
            if (dateA !== dateB) return dateA < dateB ? -1 : 1;
            return a.variant_index - b.variant_index;
          })
          .map(({ is_default: _, product_released_at: __, scan_url, scan_thumb_url, ...rest }) => ({
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
       JOIN products p ON p.id = updated.product_id`,
      params,
    );

    if (updated.rows.length === 0) {
      reply.code(404);
      return { error: { status: 404, message: "Card not found" } };
    }

    return { data: formatCard(updated.rows[0]) };
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

      const artist = asOptionalString(body.artist, "artist");
      if (artist !== undefined) fields.push({ column: "artist", value: artist });

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
      artist: string | null;
      is_default: boolean;
      label: string | null;
      classified: boolean;
    }>(
      `UPDATE card_images
       SET ${assignments.join(", ")}
       WHERE card_id = $${params.length - 1} AND variant_index = $${params.length}
       RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, artist, is_default, label, classified`,
      params,
    );

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
      const imageUrl = asOptionalString(body.image_url, "image_url");
      if (!imageUrl) throw new Error("image_url is required");

      const sourceUrl = asOptionalString(body.source_url, "source_url") ?? null;
      const scanUrl = asOptionalString(body.scan_url, "scan_url") ?? null;
      const label = asOptionalString(body.label, "label") ?? null;
      const artist = asOptionalString(body.artist, "artist") ?? null;
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
        artist: string | null;
        is_default: boolean;
        label: string | null;
        classified: boolean;
      }>(
        `INSERT INTO card_images (
           card_id, product_id, variant_index, image_url, source_url, scan_url, artist, is_default, label, classified
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, card_id, product_id, variant_index, image_url, source_url, scan_url, artist, is_default, label, classified`,
        [card.id, productId, variantIndex, imageUrl, sourceUrl, scanUrl, artist, isDefault, label, classified],
      );

      return { data: inserted.rows[0] };
    } catch (error: any) {
      if (reply.sent) return;
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }
  });
}
