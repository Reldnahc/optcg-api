import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { formatBlockAllowedSql, resolveFormatBlockRotationInput } from "../formatLegality.js";
import {
  adminCreateFormatBanRouteSchema,
  adminDeleteFormatBanRouteSchema,
  adminFormatsListRouteSchema,
  adminUpdateFormatBanRouteSchema,
  adminUpsertFormatBlockRouteSchema,
} from "../schemas/admin.js";

type BanType = "banned" | "restricted" | "pair";

const STANDARD_ROTATION_BASE_BLOCK = 1;
const STANDARD_ROTATION_BASE_YEAR = 2026;

function deriveDefaultRotationDateForBlock(block: string): string | null {
  const parsedBlock = Number.parseInt(block.trim(), 10);
  if (!Number.isInteger(parsedBlock) || parsedBlock < STANDARD_ROTATION_BASE_BLOCK) {
    return null;
  }

  return new Date(Date.UTC(STANDARD_ROTATION_BASE_YEAR + parsedBlock - 1, 3, 1)).toISOString();
}

interface FormatRow {
  id: string;
  name: string;
  description: string | null;
  has_rotation: boolean;
}

interface FormatBanRow {
  id: string;
  format_id: string;
  card_number: string;
  ban_type: BanType;
  max_copies: number | null;
  paired_card_number: string | null;
  banned_at: string;
  reason: string | null;
  unbanned_at: string | null;
}

function serializeBan(row: FormatBanRow) {
  return {
    id: row.id,
    card_number: row.card_number,
    ban_type: row.ban_type,
    ...(row.max_copies != null ? { max_copies: row.max_copies } : {}),
    ...(row.paired_card_number ? { paired_card_number: row.paired_card_number } : {}),
    banned_at: row.banned_at,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.unbanned_at ? { unbanned_at: row.unbanned_at } : {}),
  };
}

async function getFormat(formatName: string): Promise<FormatRow | null> {
  const result = await query<FormatRow>(
    `SELECT id, name, description, has_rotation
     FROM formats
     WHERE name ILIKE $1
     LIMIT 1`,
    [formatName],
  );
  return result.rows[0] ?? null;
}

function parseBanInput(body: Record<string, unknown>) {
  const cardNumber = typeof body.card_number === "string" ? body.card_number.trim() : "";
  const banType = body.ban_type;
  const bannedAt = typeof body.banned_at === "string" ? body.banned_at.trim() : "";
  const reason = body.reason == null ? null : String(body.reason);
  const pairedCardNumber = body.paired_card_number == null ? null : String(body.paired_card_number).trim();
  const maxCopies = body.max_copies == null ? null : Number(body.max_copies);

  if (!cardNumber) throw new Error("card_number is required");
  if (banType !== "banned" && banType !== "restricted" && banType !== "pair") {
    throw new Error("ban_type must be banned, restricted, or pair");
  }
  if (!bannedAt) throw new Error("banned_at is required");
  if (Number.isNaN(Date.parse(bannedAt))) throw new Error("banned_at must be a valid date");
  if (banType === "restricted" && (!Number.isInteger(maxCopies) || (maxCopies ?? 0) < 1)) {
    throw new Error("restricted bans require a positive integer max_copies");
  }
  if (banType === "pair") {
    if (!pairedCardNumber) throw new Error("pair bans require paired_card_number");
    if (pairedCardNumber.toUpperCase() === cardNumber.toUpperCase()) {
      throw new Error("paired_card_number must differ from card_number");
    }
  }

  return {
    cardNumber,
    banType,
    bannedAt,
    reason,
    pairedCardNumber: banType === "pair" ? pairedCardNumber : null,
    maxCopies: banType === "restricted" ? maxCopies : null,
  };
}

export async function adminFormatsRoutes(app: FastifyInstance) {
  app.get("/formats", { schema: adminFormatsListRouteSchema }, async (_req, reply) => {
    const [formats, blocks, bans] = await Promise.all([
      query<FormatRow>(
        `SELECT id, name, description, has_rotation
         FROM formats
         ORDER BY name`,
      ),
      query<{
        id: string;
        format_id: string;
        block: string;
        legal: boolean;
        rotated_at: string | null;
      }>(
        `SELECT flb.id, flb.format_id, flb.block, ${formatBlockAllowedSql("flb", "f")} AS legal, flb.rotated_at
         FROM format_legal_blocks flb
         JOIN formats f ON f.id = flb.format_id
         ORDER BY block`,
      ),
      query<FormatBanRow>(
        `SELECT id, format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason, unbanned_at
         FROM format_bans
         ORDER BY banned_at DESC, card_number ASC`,
      ),
    ]);

    const blocksByFormat = new Map<string, typeof blocks.rows>();
    for (const block of blocks.rows) {
      const current = blocksByFormat.get(block.format_id) ?? [];
      current.push(block);
      blocksByFormat.set(block.format_id, current);
    }

    const bansByFormat = new Map<string, typeof bans.rows>();
    for (const ban of bans.rows) {
      const current = bansByFormat.get(ban.format_id) ?? [];
      current.push(ban);
      bansByFormat.set(ban.format_id, current);
    }

    reply.header("Cache-Control", "no-store");
    return {
      data: formats.rows.map((format) => ({
        name: format.name,
        description: format.description,
        has_rotation: format.has_rotation,
        blocks: (blocksByFormat.get(format.id) ?? []).map((block) => ({
          id: block.id,
          block: block.block,
          legal: block.legal,
          rotated_at: block.rotated_at,
        })),
        bans: (bansByFormat.get(format.id) ?? []).map(serializeBan),
      })),
    };
  });

  app.post("/formats/:name/bans", { schema: adminCreateFormatBanRouteSchema }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const format = await getFormat(name);
    if (!format) {
      reply.code(404);
      return { error: { status: 404, message: "Format not found" } };
    }

    let parsed;
    try {
      parsed = parseBanInput((req.body ?? {}) as Record<string, unknown>);
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (parsed.banType === "pair") {
      const existing = await query<{ id: string }>(
        `SELECT id
         FROM format_bans
         WHERE format_id = $1
           AND (
             (card_number = $2 AND paired_card_number = $3)
             OR (card_number = $3 AND paired_card_number = $2)
           )
           AND unbanned_at IS NULL
         LIMIT 1`,
        [format.id, parsed.cardNumber, parsed.pairedCardNumber],
      );

      if (existing.rows.length > 0) {
        reply.code(409);
        return { error: { status: 409, message: "Pair ban already exists" } };
      }

      await query(
        `INSERT INTO format_bans (format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [format.id, parsed.cardNumber, parsed.banType, parsed.pairedCardNumber, parsed.bannedAt, parsed.reason],
      );
      await query(
        `INSERT INTO format_bans (format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [format.id, parsed.pairedCardNumber, parsed.banType, parsed.cardNumber, parsed.bannedAt, parsed.reason],
      );
    } else {
      const existing = await query<{ id: string }>(
        `SELECT id
         FROM format_bans
         WHERE format_id = $1
           AND card_number = $2
           AND paired_card_number IS NULL
           AND unbanned_at IS NULL
         LIMIT 1`,
        [format.id, parsed.cardNumber],
      );

      if (existing.rows.length > 0) {
        reply.code(409);
        return { error: { status: 409, message: "Ban already exists for this card" } };
      }

      await query(
        `INSERT INTO format_bans (format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [format.id, parsed.cardNumber, parsed.banType, parsed.maxCopies, parsed.bannedAt, parsed.reason],
      );
    }

    return { data: { ok: true } };
  });

  app.put("/formats/:name/bans/:id", { schema: adminUpdateFormatBanRouteSchema }, async (req, reply) => {
    const { name, id } = req.params as { name: string; id: string };
    const format = await getFormat(name);
    if (!format) {
      reply.code(404);
      return { error: { status: 404, message: "Format not found" } };
    }

    const existing = await query<FormatBanRow>(
      `SELECT id, format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason, unbanned_at
       FROM format_bans
       WHERE id = $1 AND format_id = $2
       LIMIT 1`,
      [id, format.id],
    );

    const current = existing.rows[0];
    if (!current) {
      reply.code(404);
      return { error: { status: 404, message: "Ban not found" } };
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const mergedBody: Record<string, unknown> = {
      card_number: body.card_number ?? current.card_number,
      ban_type: body.ban_type ?? current.ban_type,
      max_copies: body.max_copies ?? current.max_copies,
      paired_card_number: body.paired_card_number ?? current.paired_card_number,
      banned_at: body.banned_at ?? current.banned_at,
      reason: body.reason ?? current.reason,
    };

    let parsed;
    try {
      parsed = parseBanInput(mergedBody);
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    if (
      current.ban_type === "pair" &&
      (parsed.banType !== "pair" ||
        parsed.cardNumber !== current.card_number ||
        parsed.pairedCardNumber !== current.paired_card_number)
    ) {
      await query(
        `UPDATE format_bans
         SET unbanned_at = COALESCE(unbanned_at, NOW())
         WHERE format_id = $1
           AND card_number = $2
           AND paired_card_number = $3
           AND id <> $4
           AND unbanned_at IS NULL`,
        [format.id, current.paired_card_number, current.card_number, current.id],
      );
    }

    await query(
      `UPDATE format_bans
       SET card_number = $1,
           ban_type = $2,
           max_copies = $3,
           paired_card_number = $4,
           banned_at = $5,
           reason = $6
       WHERE id = $7`,
      [parsed.cardNumber, parsed.banType, parsed.maxCopies, parsed.pairedCardNumber, parsed.bannedAt, parsed.reason, current.id],
    );

    if (parsed.banType === "pair" && parsed.pairedCardNumber) {
      const counterpart = await query<{ id: string }>(
        `SELECT id
         FROM format_bans
         WHERE format_id = $1
           AND card_number = $2
           AND paired_card_number = $3
           AND id <> $4
           AND unbanned_at IS NULL
         LIMIT 1`,
        [format.id, parsed.pairedCardNumber, parsed.cardNumber, current.id],
      );

      if (counterpart.rows[0]) {
        await query(
          `UPDATE format_bans
           SET card_number = $1,
               ban_type = 'pair',
               max_copies = NULL,
               paired_card_number = $2,
               banned_at = $3,
               reason = $4,
               unbanned_at = NULL
           WHERE id = $5`,
          [parsed.pairedCardNumber, parsed.cardNumber, parsed.bannedAt, parsed.reason, counterpart.rows[0].id],
        );
      } else {
        await query(
          `INSERT INTO format_bans (format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason)
           VALUES ($1, $2, 'pair', NULL, $3, $4, $5)`,
          [format.id, parsed.pairedCardNumber, parsed.cardNumber, parsed.bannedAt, parsed.reason],
        );
      }
    }

    return { data: { ok: true } };
  });

  app.delete("/formats/:name/bans/:id", { schema: adminDeleteFormatBanRouteSchema }, async (req, reply) => {
    const { name, id } = req.params as { name: string; id: string };
    const format = await getFormat(name);
    if (!format) {
      reply.code(404);
      return { error: { status: 404, message: "Format not found" } };
    }

    const banResult = await query<FormatBanRow>(
      `SELECT id, format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason, unbanned_at
       FROM format_bans
       WHERE id = $1 AND format_id = $2
       LIMIT 1`,
      [id, format.id],
    );
    const ban = banResult.rows[0];

    if (!ban) {
      reply.code(404);
      return { error: { status: 404, message: "Ban not found" } };
    }

    await query(`UPDATE format_bans SET unbanned_at = COALESCE(unbanned_at, NOW()) WHERE id = $1`, [ban.id]);

    if (ban.ban_type === "pair" && ban.paired_card_number) {
      await query(
        `UPDATE format_bans
         SET unbanned_at = COALESCE(unbanned_at, NOW())
         WHERE format_id = $1
           AND card_number = $2
           AND paired_card_number = $3
           AND id <> $4
           AND unbanned_at IS NULL`,
        [format.id, ban.paired_card_number, ban.card_number, ban.id],
      );
    }

    return { data: { ok: true } };
  });

  app.post("/formats/:name/blocks", { schema: adminUpsertFormatBlockRouteSchema }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const format = await getFormat(name);
    if (!format) {
      reply.code(404);
      return { error: { status: 404, message: "Format not found" } };
    }

    const body = (req.body ?? {}) as { block?: unknown; legal?: unknown; rotated_at?: unknown };
    if (typeof body.block !== "string" || body.block.trim() === "") {
      reply.code(400);
      return { error: { status: 400, message: "block is required" } };
    }

    let rotationState;
    try {
      rotationState = resolveFormatBlockRotationInput({
        ...body,
        rotated_at: body.rotated_at ?? (body.legal === false ? deriveDefaultRotationDateForBlock(body.block) : null),
      });
    } catch (error: any) {
      reply.code(400);
      return { error: { status: 400, message: error.message } };
    }

    const existing = await query<{ id: string }>(
      `SELECT id
       FROM format_legal_blocks
       WHERE format_id = $1 AND block = $2
       LIMIT 1`,
      [format.id, body.block],
    );

    if (existing.rows[0]) {
      await query(
        `UPDATE format_legal_blocks
         SET legal = $1, rotated_at = $2
         WHERE id = $3`,
        [rotationState.legal, rotationState.rotatedAt, existing.rows[0].id],
      );
    } else {
      await query(
        `INSERT INTO format_legal_blocks (format_id, block, legal, rotated_at)
         VALUES ($1, $2, $3, $4)`,
        [format.id, body.block, rotationState.legal, rotationState.rotatedAt],
      );
    }

    return { data: { ok: true } };
  });
}
