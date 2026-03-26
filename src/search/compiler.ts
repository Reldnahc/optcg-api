/**
 * Compiles a search AST into SQL WHERE clauses.
 */

import { SearchNode, Operator } from "./parser.js";
import { requireCardRarity } from "../rarity.js";

export interface CompiledSearch {
  sql: string;
  params: unknown[];
}

const COLOR_MAP: Record<string, string> = {
  red: "Red",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  black: "Black",
  yellow: "Yellow",
};

const RARITY_MAP: Record<string, string> = {
  l: "L",
  c: "C",
  uc: "UC",
  r: "R",
  sr: "SR",
  sec: "SEC",
};

export function compileSearch(
  node: SearchNode,
  startIdx: number,
  unique: string = "cards",
): CompiledSearch {
  const ctx = { idx: startIdx, params: [] as unknown[], unique };
  const sql = compileNode(node, ctx);
  return { sql, params: ctx.params };
}

interface Ctx {
  idx: number;
  params: unknown[];
  unique: string;
}

function param(ctx: Ctx, value: unknown): string {
  ctx.params.push(value);
  return `$${ctx.idx++}`;
}

function normalizedTextSql(expr: string): string {
  return `regexp_replace(lower(COALESCE(${expr}, '')), '[^a-z0-9]+', '', 'g')`;
}

function subsequenceLikePattern(value: string): string | null {
  if (value.length < 5) return null;
  return `%${value.split("").join("%")}%`;
}

function compileNode(node: SearchNode, ctx: Ctx): string {
  switch (node.type) {
    case "name":
      return compileNameSearch(node.value, node.negated, ctx);
    case "filter":
      return compileFilter(node.field, node.operator, node.value, node.negated, ctx);
    case "and":
      return "(" + node.children.map((c) => compileNode(c, ctx)).join(" AND ") + ")";
    case "or":
      return "(" + node.children.map((c) => compileNode(c, ctx)).join(" OR ") + ")";
  }
}

function compileNameSearch(value: string, negated: boolean, ctx: Ctx): string {
  const baseSql = compileFreeText(value, false, ctx);
  const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const subsequencePattern = subsequenceLikePattern(normalizedValue);

  if (!subsequencePattern) {
    return negated ? `NOT ${baseSql}` : baseSql;
  }

  const subsequence = param(ctx, subsequencePattern);
  const fuzzySql = `(
    ${normalizedTextSql("c.name")} LIKE ${subsequence}
    OR ${normalizedTextSql("p.name")} LIKE ${subsequence}
  )`;

  const sql = `(
    ${baseSql}
    OR ${fuzzySql}
  )`;
  return negated ? `NOT ${sql}` : sql;
}

function compileFreeText(value: string, negated: boolean, ctx: Ctx): string {
  const raw = param(ctx, `%${value}%`);
  const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalized = normalizedValue ? param(ctx, `%${normalizedValue}%`) : null;

  const rawSql = `(
    c.name ILIKE ${raw}
    OR c.card_number ILIKE ${raw}
    OR c.card_type ILIKE ${raw}
    OR c.effect ILIKE ${raw}
    OR c.trigger ILIKE ${raw}
    OR c.artist ILIKE ${raw}
    OR c.true_set_code ILIKE ${raw}
    OR p.name ILIKE ${raw}
    OR EXISTS (SELECT 1 FROM unnest(c.types) AS t WHERE t ILIKE ${raw})
    OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.attribute, ARRAY[]::text[])) AS a WHERE a ILIKE ${raw})
  )`;

  const normalizedSql = normalized
    ? `(
    ${normalizedTextSql("c.name")} LIKE ${normalized}
    OR ${normalizedTextSql("c.card_number")} LIKE ${normalized}
    OR ${normalizedTextSql("c.card_type")} LIKE ${normalized}
    OR ${normalizedTextSql("c.effect")} LIKE ${normalized}
    OR ${normalizedTextSql("c.trigger")} LIKE ${normalized}
    OR ${normalizedTextSql("c.artist")} LIKE ${normalized}
    OR ${normalizedTextSql("c.true_set_code")} LIKE ${normalized}
    OR ${normalizedTextSql("p.name")} LIKE ${normalized}
    OR EXISTS (SELECT 1 FROM unnest(c.types) AS t WHERE ${normalizedTextSql("t")} LIKE ${normalized})
    OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.attribute, ARRAY[]::text[])) AS a WHERE ${normalizedTextSql("a")} LIKE ${normalized})
  )`
    : null;

  const sql = normalizedSql
    ? `(
    ${rawSql}
    OR ${normalizedSql}
  )`
    : rawSql;
  return negated ? `NOT ${sql}` : sql;
}

function numericOp(col: string, op: Operator, value: string, negated: boolean, ctx: Ctx): string {
  const num = parseInt(value, 10);
  if (isNaN(num)) throw new Error(`Invalid numeric value: ${value}`);
  const p = param(ctx, num);

  let sql: string;
  switch (op) {
    case ":":
    case "=":
      sql = `${col} = ${p}`;
      break;
    case ">=":
      sql = `${col} >= ${p}`;
      break;
    case "<=":
      sql = `${col} <= ${p}`;
      break;
    case ">":
      sql = `${col} > ${p}`;
      break;
    case "<":
      sql = `${col} < ${p}`;
      break;
    case "!=":
      sql = `${col} != ${p}`;
      break;
    default:
      throw new Error(`Unsupported operator: ${op}`);
  }

  return negated ? `NOT (${sql})` : sql;
}

function compileFilter(
  field: string,
  op: Operator,
  value: string,
  negated: boolean,
  ctx: Ctx,
): string {
  switch (field) {
    case "color": {
      const colors = value
        .split(",")
        .map((c) => COLOR_MAP[c.trim().toLowerCase()])
        .filter(Boolean);
      if (colors.length === 0) throw new Error(`Unknown color: ${value}`);
      const p = param(ctx, `{${colors.join(",")}}`);

      let sql: string;
      if (op === "=" || op === ":") {
        // c:red = has red; c=red = exactly red
        sql = op === "=" ? `c.color = ${p}::text[]` : `c.color @> ${p}::text[]`;
      } else if (op === ">=") {
        sql = `c.color @> ${p}::text[]`;
      } else if (op === "<=") {
        sql = `${p}::text[] @> c.color`;
      } else {
        throw new Error(`Unsupported color operator: ${op}`);
      }
      return negated ? `NOT (${sql})` : sql;
    }

    case "type": {
      const p = param(ctx, value);
      const sql = `c.card_type ILIKE ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "cost":
      return numericOp("c.cost", op, value, negated, ctx);
    case "power":
      return numericOp("c.power", op, value, negated, ctx);
    case "life":
      return numericOp("c.life", op, value, negated, ctx);
    case "counter":
      return numericOp("c.counter", op, value, negated, ctx);

    case "rarity": {
      const r = requireCardRarity(RARITY_MAP[value.toLowerCase()] || value);
      const p = param(ctx, r);
      const sql = `c.rarity = ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "artist": {
      const p = param(ctx, `%${value}%`);
      const sql = `c.artist ILIKE ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "text": {
      if (!["=", ":"].includes(op)) {
        throw new Error(`Unsupported text operator: ${op}`);
      }
      return compileFreeText(value, negated, ctx);
    }

    case "effect": {
      const p = param(ctx, `%${value}%`);
      const sql = `c.effect ILIKE ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "trigger": {
      const p = param(ctx, `%${value}%`);
      const sql = `c.trigger ILIKE ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "trait": {
      const p = param(ctx, `%${value}%`);
      // Search across the types array using ANY
      const sql = `EXISTS (SELECT 1 FROM unnest(c.types) AS t WHERE t ILIKE ${p})`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "attribute": {
      const normalized = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
      const p = param(ctx, `{${normalized}}`);
      const sql = `c.attribute @> ${p}::text[]`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "block": {
      const p = param(ctx, value);
      const sql = `c.block = ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "card_number": {
      const p = param(ctx, value.toUpperCase());
      const sql = `c.card_number ILIKE ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "set": {
      const p = param(ctx, value.toUpperCase());
      const sql = `c.true_set_code = ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "product": {
      // Exact match with = operator, fuzzy with :
      const isExact = op === "=";
      if (ctx.unique === "prints") {
        // In prints mode, filter on the variant's product (ip table already joined)
        const p = isExact ? param(ctx, value) : param(ctx, `%${value}%`);
        const sql = isExact ? `ip.name = ${p}` : `ip.name ILIKE ${p}`;
        return negated ? `NOT (${sql})` : sql;
      }
      const p = isExact ? param(ctx, value) : param(ctx, `%${value}%`);
      const cmp = isExact ? `pr.name = ${p}` : `pr.name ILIKE ${p}`;
      const sql = `EXISTS (
        SELECT 1 FROM card_sources cs
        JOIN products pr ON pr.id = cs.product_id
        WHERE cs.card_id = c.id AND ${cmp}
      )`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "legal": {
      const p = param(ctx, value);
      // A card is legal if:
      // 1. It's released (product has released_at <= now)
      // 2. Its block is legal in the format, OR it has a Manga Art printing (exempt from rotation)
      // 3. AND it's not banned
      const sql = `p.released_at IS NOT NULL AND p.released_at <= CURRENT_DATE AND (
        EXISTS (
          SELECT 1 FROM format_legal_blocks flb
          JOIN formats f ON f.id = flb.format_id
          WHERE f.name ILIKE ${p} AND flb.block = c.block AND flb.legal = true
        ) OR EXISTS (
          SELECT 1 FROM card_images ci
          WHERE ci.card_id = c.id AND ci.label = 'Manga Art'
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM format_bans fb
        JOIN formats f ON f.id = fb.format_id
        WHERE f.name ILIKE ${p} AND fb.card_number = c.card_number AND fb.unbanned_at IS NULL
      )`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "banned": {
      const p = param(ctx, value);
      const sql = `EXISTS (
        SELECT 1 FROM format_bans fb
        JOIN formats f ON f.id = fb.format_id
        WHERE f.name ILIKE ${p} AND fb.card_number = c.card_number AND fb.unbanned_at IS NULL
      )`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "is": {
      switch (value.toLowerCase()) {
        case "reprint":
          return negated
            ? `NOT EXISTS (SELECT 1 FROM cards c2 WHERE c2.card_number = c.card_number AND c2.language = c.language AND c2.id != c.id AND c2.created_at < c.created_at)`
            : `EXISTS (SELECT 1 FROM cards c2 WHERE c2.card_number = c.card_number AND c2.language = c.language AND c2.id != c.id AND c2.created_at < c.created_at)`;
        case "multicolor": {
          const sql = `array_length(c.color, 1) > 1`;
          return negated ? `NOT (${sql})` : sql;
        }
        case "vanilla": {
          const sql = `c.effect IS NULL`;
          return negated ? `c.effect IS NOT NULL` : sql;
        }
        default:
          throw new Error(`Unknown is: value: ${value}`);
      }
    }

    case "not": {
      // not:reprint is sugar for -is:reprint
      return compileFilter("is", op, value, !negated, ctx);
    }

    case "has": {
      switch (value.toLowerCase()) {
        case "price":
          return negated
            ? `NOT EXISTS (SELECT 1 FROM card_images ci JOIN tcgplayer_products tp ON tp.card_image_id = ci.id WHERE ci.card_id = c.id)`
            : `EXISTS (SELECT 1 FROM card_images ci JOIN tcgplayer_products tp ON tp.card_image_id = ci.id WHERE ci.card_id = c.id)`;
        case "trigger": {
          const sql = `c.trigger IS NOT NULL`;
          return negated ? `c.trigger IS NULL` : sql;
        }
        case "effect": {
          const sql = `c.effect IS NOT NULL`;
          return negated ? `c.effect IS NULL` : sql;
        }
        default:
          throw new Error(`Unknown has: value: ${value}`);
      }
    }

    case "usd": {
      const num = parseFloat(value);
      if (isNaN(num)) throw new Error(`Invalid price value: ${value}`);
      const p = param(ctx, num);

      let cmp: string;
      switch (op) {
        case ":":
        case "=":
          cmp = "=";
          break;
        case ">=":
          cmp = ">=";
          break;
        case "<=":
          cmp = "<=";
          break;
        case ">":
          cmp = ">";
          break;
        case "<":
          cmp = "<";
          break;
        case "!=":
          cmp = "!=";
          break;
        default:
          throw new Error(`Unsupported price operator: ${op}`);
      }

      const sql = `EXISTS (
        SELECT 1 FROM card_images ci
        JOIN tcgplayer_products tp ON tp.card_image_id = ci.id
        JOIN LATERAL (
          SELECT market_price FROM tcgplayer_prices
          WHERE tcgplayer_product_id = tp.tcgplayer_product_id
            AND sub_type IS NOT DISTINCT FROM tp.sub_type
          ORDER BY fetched_at DESC LIMIT 1
        ) lp ON true
        WHERE ci.card_id = c.id AND ci.is_default = true
          AND lp.market_price ${cmp} ${p}
      )`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "year": {
      return numericOp("EXTRACT(YEAR FROM p.released_at)", op, value, negated, ctx);
    }

    case "date": {
      const p = param(ctx, value);
      let cmp: string;
      switch (op) {
        case ":":
        case "=":
          cmp = "=";
          break;
        case ">=":
          cmp = ">=";
          break;
        case "<=":
          cmp = "<=";
          break;
        case ">":
          cmp = ">";
          break;
        case "<":
          cmp = "<";
          break;
        default:
          throw new Error(`Unsupported date operator: ${op}`);
      }
      const sql = `p.released_at ${cmp} ${p}::date`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "new": {
      // Cards first appearing in the specified set
      const p = param(ctx, value.toUpperCase());
      const sql = `c.true_set_code = ${p}`;
      return negated ? `NOT (${sql})` : sql;
    }

    case "prints": {
      return numericOp(
        `(SELECT COUNT(*) FROM card_sources cs WHERE cs.card_id = c.id)`,
        op, value, negated, ctx,
      );
    }

    case "order":
    case "direction":
      // These are handled by the route, not as SQL filters
      return "TRUE";

    default:
      throw new Error(`Unknown search field: ${field}`);
  }
}
