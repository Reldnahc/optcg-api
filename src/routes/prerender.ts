import { createHash } from "crypto";
import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { labelOrder, thumbnailUrl, setName } from "../format.js";
import { formatBlockIsLegalSql } from "../formatLegality.js";
import { prerenderManifestRouteSchema } from "../schemas/public.js";

type RenderGroup =
  | "cards"
  | "sets_index"
  | "set_detail"
  | "formats_index"
  | "format_detail"
  | "don"
  | "scan_progress";

interface RouteFingerprint {
  route: string;
  render_group: RenderGroup;
  data_hash: string;
}

interface CardBaseRow {
  id: string;
  card_number: string;
  language: string;
  true_set_code: string;
  name: string;
  card_type: string;
  rarity: string | null;
  color: string[];
  cost: number | null;
  power: number | null;
  counter: number | null;
  life: number | null;
  attribute: string[] | null;
  types: string[];
  effect: string | null;
  trigger: string | null;
  block: string | null;
  product_name: string;
  released_at: string | null;
  set_product_name: string | null;
}

interface CardVariantRow {
  card_id: string;
  variant_index: number;
  label: string | null;
  artist: string | null;
  image_url: string | null;
  scan_url: string | null;
  scan_thumb_url: string | null;
  classified: boolean;
  product_name: string | null;
  product_set_code: string | null;
  product_released_at: string | null;
  canonical_tcgplayer_url: string | null;
  prices: Array<{
    sub_type: string | null;
    market_price: string | null;
    low_price: string | null;
    mid_price: string | null;
    high_price: string | null;
    tcgplayer_url: string | null;
  }> | null;
}

interface CardLegalityRow {
  card_id: string;
  format_name: string;
  legal: boolean;
}

interface CardBanRow {
  card_number: string;
  format_name: string;
  ban_type: string;
  max_copies: number | null;
  banned_at: string;
  reason: string | null;
  paired_card_number: string | null;
}

interface CardLanguagesRow {
  card_number: string;
  languages: string[];
}

interface SetSummaryRow {
  true_set_code: string;
  product_name: string | null;
  released_at: string | null;
  card_count: string;
}

interface SetCardRow {
  true_set_code: string;
  card_number: string;
  name: string;
  card_type: string;
  rarity: string | null;
  color: string[];
  cost: number | null;
  power: number | null;
  image_url: string | null;
}

interface SetProductRow {
  set_code: string;
  name: string;
  set_codes: string[] | null;
  released_at: string | null;
}

interface FormatSummaryRow {
  id: string;
  name: string;
  description: string | null;
  has_rotation: boolean;
  legal_blocks: string;
  ban_count: string;
}

interface FormatBlockRow {
  format_id: string;
  block: string;
  legal: boolean;
  rotated_at: string | null;
}

interface FormatBanRow {
  format_id: string;
  card_number: string;
  ban_type: string;
  max_copies: number | null;
  paired_card_number: string | null;
  banned_at: string;
  reason: string | null;
}

interface DonRow {
  id: string;
  character: string;
  finish: string;
  image_url: string | null;
  product_name: string;
}

interface ScanProgressRow {
  set_code: string;
  total_cards: number;
  scanned_cards: number;
  missing_image_cards: number;
  total_variants: number;
  scanned_variants: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function groupBy<T, K extends string>(rows: T[], getKey: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();

  for (const row of rows) {
    const key = getKey(row);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  return grouped;
}

function cardRoutePayload(
  card: CardBaseRow,
  variants: CardVariantRow[],
  legalityRows: CardLegalityRow[],
  banRows: CardBanRow[],
  languages: string[],
  now: Date,
) {
  const released = card.released_at ? new Date(card.released_at) <= now : false;

  const classifiedVariants = variants
    .filter((variant) => variant.classified)
    .sort((a, b) => {
      const dateA = a.product_released_at;
      const dateB = b.product_released_at;
      if (dateA && dateB && dateA !== dateB) return dateA < dateB ? -1 : 1;
      if (dateA && !dateB) return -1;
      if (!dateA && dateB) return 1;

      const labelDiff = labelOrder(a.label) - labelOrder(b.label);
      if (labelDiff !== 0) return labelDiff;

      return a.variant_index - b.variant_index;
    })
    .map((variant) => {
      const prices = Object.fromEntries(
        (variant.prices ?? []).map((price) => [
          price.sub_type || "Normal",
          {
            market_price: price.market_price,
            low_price: price.low_price,
            mid_price: price.mid_price,
            high_price: price.high_price,
            tcgplayer_url: price.tcgplayer_url,
          },
        ]),
      );

      return {
        variant_index: variant.variant_index,
        label: variant.label,
        artist: variant.artist,
        product: {
          name: variant.product_name,
          set_code: variant.product_set_code,
          released_at: variant.product_released_at,
        },
        media: {
          image_url: variant.image_url,
          thumbnail_url: thumbnailUrl(variant.image_url),
          scan_url: variant.scan_url,
          scan_thumbnail_url: variant.scan_thumb_url,
        },
        market: {
          tcgplayer_url: variant.canonical_tcgplayer_url,
          prices,
        },
      };
    });

  const mangaExempt = variants.some((variant) => variant.label === "Manga Art");
  const bansByFormat = groupBy(banRows, (row) => row.format_name);
  const legality = Object.fromEntries(
    legalityRows
      .sort((a, b) => a.format_name.localeCompare(b.format_name))
      .map((row) => {
        const bans = bansByFormat.get(row.format_name) ?? [];

        if (!released) {
          return [row.format_name, { status: "unreleased", released_at: card.released_at }];
        }

        if (bans.length > 0) {
          const primaryBan = bans[0];
          return [row.format_name, {
            status: primaryBan.ban_type,
            banned_at: primaryBan.banned_at,
            reason: primaryBan.reason,
            max_copies: primaryBan.max_copies,
            paired_with: bans
              .map((ban) => ban.paired_card_number)
              .filter((value): value is string => Boolean(value))
              .sort(),
          }];
        }

        return [row.format_name, { status: row.legal || mangaExempt ? "legal" : "not_legal" }];
      }),
  );

  return {
    card_number: card.card_number,
    name: card.name,
    language: card.language,
    set: card.true_set_code,
    set_name: card.set_product_name ?? setName(card.true_set_code),
    product: card.product_name,
    released_at: card.released_at,
    released,
    card_type: card.card_type,
    rarity: card.rarity,
    color: card.color,
    cost: card.cost,
    power: card.power,
    counter: card.counter,
    life: card.life,
    attribute: card.attribute,
    types: card.types,
    effect: card.effect,
    trigger: card.trigger,
    block: card.block,
    variants: classifiedVariants,
    legality,
    available_languages: [...languages].sort(),
  };
}

export async function prerenderRoutes(app: FastifyInstance) {
  app.get("/prerender-manifest", { schema: prerenderManifestRouteSchema }, async (_req, reply) => {
    const now = new Date();

    const [
      cardsResult,
      cardVariantsResult,
      cardLegalityResult,
      cardBansResult,
      cardLanguagesResult,
      setsSummaryResult,
      setCardsResult,
      setProductsResult,
      formatsSummaryResult,
      formatBlocksResult,
      formatBansResult,
      donResult,
      scansResult,
    ] = await Promise.all([
      query<CardBaseRow>(
        `SELECT c.id, c.card_number, c.language, c.true_set_code, c.name, c.card_type, c.rarity, c.color,
                c.cost, c.power, c.counter, c.life, c.attribute, c.types, c.effect, c.trigger, c.block,
                p.name AS product_name, p.released_at,
                (SELECT p2.name FROM products p2
                 WHERE p2.language = c.language AND p2.set_codes[1] = c.true_set_code
                 LIMIT 1) AS set_product_name
         FROM cards c
         JOIN products p ON p.id = c.product_id
         WHERE c.language = 'en'
         ORDER BY c.card_number ASC`,
      ),
      query<CardVariantRow>(
        `SELECT ci.card_id, ci.variant_index, ci.label, ci.artist, ci.image_url, ci.scan_url, ci.scan_thumb_url,
                ci.classified, ip.name AS product_name, ip.product_set_code, ip.released_at AS product_released_at,
                canonical_tp.tcgplayer_url AS canonical_tcgplayer_url,
                COALESCE(price_rows.prices, '[]'::json) AS prices
         FROM card_images ci
         JOIN cards c ON c.id = ci.card_id AND c.language = 'en'
         LEFT JOIN products ip ON ip.id = ci.product_id
         LEFT JOIN LATERAL (
           SELECT tp2.tcgplayer_url
           FROM tcgplayer_products tp2
           WHERE tp2.card_image_id = ci.id
           ORDER BY
             CASE
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
         LEFT JOIN LATERAL (
           SELECT json_agg(
             json_build_object(
               'sub_type', tp.sub_type,
               'market_price', pr.market_price,
               'low_price', pr.low_price,
               'mid_price', pr.mid_price,
               'high_price', pr.high_price,
               'tcgplayer_url', tp.tcgplayer_url
             )
             ORDER BY COALESCE(NULLIF(tp.sub_type, ''), 'Normal'), tp.tcgplayer_product_id
           ) AS prices
           FROM tcgplayer_products tp
           LEFT JOIN LATERAL (
             SELECT market_price, low_price, mid_price, high_price
             FROM tcgplayer_prices
             WHERE tcgplayer_product_id = tp.tcgplayer_product_id
               AND sub_type IS NOT DISTINCT FROM tp.sub_type
             ORDER BY fetched_at DESC
             LIMIT 1
           ) pr ON true
           WHERE tp.card_image_id = ci.id
         ) price_rows ON true
         ORDER BY ci.card_id ASC, ci.variant_index ASC`,
      ),
      query<CardLegalityRow>(
        `SELECT c.id AS card_id,
                f.name AS format_name,
                COALESCE(BOOL_AND(${formatBlockIsLegalSql("flb")}), false) AS legal
         FROM cards c
         CROSS JOIN formats f
         LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id AND flb.block = c.block
         WHERE c.language = 'en'
         GROUP BY c.id, f.name`,
      ),
      query<CardBanRow>(
        `SELECT c.card_number, f.name AS format_name, fb.ban_type, fb.max_copies, fb.banned_at, fb.reason, fb.paired_card_number
         FROM cards c
         JOIN format_bans fb ON fb.card_number = c.card_number AND fb.unbanned_at IS NULL
         JOIN formats f ON f.id = fb.format_id
         WHERE c.language = 'en'`,
      ),
      query<CardLanguagesRow>(
        `SELECT card_number, ARRAY_AGG(language ORDER BY language) AS languages
         FROM cards
         GROUP BY card_number`,
      ),
      query<SetSummaryRow>(
        `SELECT c.true_set_code,
                (SELECT p2.name FROM products p2
                 WHERE p2.language = 'en' AND p2.set_codes[1] = c.true_set_code
                 LIMIT 1) AS product_name,
                MIN(p.released_at) AS released_at,
                COUNT(*) AS card_count
         FROM cards c
         JOIN products p ON p.id = c.product_id
         WHERE c.language = 'en'
         GROUP BY c.true_set_code
         ORDER BY c.true_set_code ASC`,
      ),
      query<SetCardRow>(
        `SELECT c.true_set_code, c.card_number, c.name, c.card_type, c.rarity, c.color, c.cost, c.power,
                (SELECT ci.image_url
                 FROM card_images ci
                 LEFT JOIN products ip ON ip.id = ci.product_id
                 WHERE ci.card_id = c.id AND ci.classified = true
                 ORDER BY
                   CASE WHEN ip.released_at IS NULL THEN 1 ELSE 0 END,
                   ip.released_at ASC,
                   CASE ci.label
                     WHEN 'Standard' THEN 0
                     WHEN 'Reprint' THEN 1
                     WHEN 'Jolly Roger Foil' THEN 2
                     WHEN 'Textured Foil' THEN 3
                     WHEN 'Full Art' THEN 4
                     WHEN 'Winner' THEN 5
                     WHEN 'Alternate Art' THEN 6
                     WHEN 'SP' THEN 7
                     WHEN 'TR' THEN 7
                     WHEN 'Manga Art' THEN 8
                     WHEN 'Promo' THEN 9
                     ELSE 99
                   END,
                   ci.variant_index
                 LIMIT 1) AS image_url
         FROM cards c
         WHERE c.language = 'en'
         ORDER BY c.true_set_code ASC, c.card_number ASC`,
      ),
      query<SetProductRow>(
        `SELECT DISTINCT set_codes.set_code, p.name, p.set_codes, p.released_at
         FROM products p
         JOIN LATERAL unnest(p.set_codes) WITH ORDINALITY AS set_codes(set_code, position) ON true
         WHERE p.language = 'en'
         ORDER BY set_codes.set_code ASC, COALESCE(array_length(p.set_codes, 1), 0) ASC, p.released_at ASC NULLS LAST, p.name ASC`,
      ),
      query<FormatSummaryRow>(
        `SELECT f.id, f.name, f.description, f.has_rotation,
                COUNT(DISTINCT flb.id) FILTER (WHERE ${formatBlockIsLegalSql("flb")}) AS legal_blocks,
                COUNT(DISTINCT fb.id) FILTER (WHERE fb.unbanned_at IS NULL) AS ban_count
         FROM formats f
         LEFT JOIN format_legal_blocks flb ON flb.format_id = f.id
         LEFT JOIN format_bans fb ON fb.format_id = f.id
         GROUP BY f.id
         ORDER BY f.name ASC`,
      ),
      query<FormatBlockRow>(
        `SELECT format_id, block, ${formatBlockIsLegalSql("format_legal_blocks")} AS legal, rotated_at
         FROM format_legal_blocks
         ORDER BY format_id ASC, block ASC`,
      ),
      query<FormatBanRow>(
        `SELECT format_id, card_number, ban_type, max_copies, paired_card_number, banned_at, reason
         FROM format_bans
         WHERE unbanned_at IS NULL
         ORDER BY format_id ASC, ban_type ASC, banned_at DESC, card_number ASC`,
      ),
      query<DonRow>(
        `SELECT d.id, d.character, d.finish, d.image_url, p.name AS product_name
         FROM don_cards d
         JOIN products p ON p.id = d.product_id
         ORDER BY d.character ASC, p.name ASC, d.id ASC`,
      ),
      query<ScanProgressRow>(
        `SELECT
           c.true_set_code AS set_code,
           COUNT(DISTINCT c.id)::int AS total_cards,
           COUNT(DISTINCT CASE
             WHEN ci.scan_url IS NOT NULL
               OR ci.scan_source_s3_key IS NOT NULL
             THEN c.id
           END)::int AS scanned_cards,
           COUNT(DISTINCT CASE
             WHEN ci.image_url IS NULL
               AND ci.scan_url IS NULL
               AND ci.scan_source_s3_key IS NULL
             THEN c.id
           END)::int AS missing_image_cards,
           COUNT(ci.id)::int AS total_variants,
           COUNT(CASE
             WHEN ci.scan_url IS NOT NULL
               OR ci.scan_source_s3_key IS NOT NULL
             THEN 1
           END)::int AS scanned_variants
         FROM cards c
         LEFT JOIN card_images ci ON ci.card_id = c.id
         WHERE c.language = 'en'
         GROUP BY c.true_set_code
         ORDER BY c.true_set_code ASC`,
      ),
    ]);

    const routes: RouteFingerprint[] = [];

    const variantsByCardId = groupBy(cardVariantsResult.rows, (row) => row.card_id);
    const legalityByCardId = groupBy(cardLegalityResult.rows, (row) => row.card_id);
    const bansByCardNumber = groupBy(cardBansResult.rows, (row) => row.card_number);
    const languagesByCardNumber = new Map(
      cardLanguagesResult.rows.map((row) => [row.card_number, row.languages]),
    );

    for (const card of cardsResult.rows) {
      const payload = cardRoutePayload(
        card,
        variantsByCardId.get(card.id) ?? [],
        legalityByCardId.get(card.id) ?? [],
        bansByCardNumber.get(card.card_number) ?? [],
        languagesByCardNumber.get(card.card_number) ?? [],
        now,
      );

      routes.push({
        route: `/cards/${encodeURIComponent(card.card_number)}`,
        render_group: "cards",
        data_hash: hashJson(payload),
      });
    }

    const setSummaryPayload = setsSummaryResult.rows.map((row) => ({
      code: row.true_set_code,
      name: row.product_name ?? setName(row.true_set_code),
      released_at: row.released_at,
      card_count: parseInt(row.card_count, 10),
    }));

    routes.push({
      route: "/sets",
      render_group: "sets_index",
      data_hash: hashJson(setSummaryPayload),
    });

    const cardsBySet = groupBy(setCardsResult.rows, (row) => row.true_set_code);
    const productsBySet = groupBy(setProductsResult.rows, (row) => row.set_code);

    for (const setRow of setsSummaryResult.rows) {
      const code = setRow.true_set_code;
      const products = (productsBySet.get(code) ?? []).map((product) => ({
        name: product.name,
        set_codes: product.set_codes,
        released_at: product.released_at,
      }));
      const primaryProduct = products.find((product) => product.set_codes?.[0] === code);
      const payload = {
        code,
        name: primaryProduct?.name ?? setRow.product_name ?? setName(code),
        released_at: primaryProduct?.released_at ?? setRow.released_at,
        card_count: parseInt(setRow.card_count, 10),
        products,
        cards: (cardsBySet.get(code) ?? []).map((card) => ({
          card_number: card.card_number,
          name: card.name,
          card_type: card.card_type,
          rarity: card.rarity,
          color: card.color,
          cost: card.cost,
          power: card.power,
          image_url: card.image_url,
          thumbnail_url: thumbnailUrl(card.image_url),
        })),
      };

      routes.push({
        route: `/sets/${encodeURIComponent(code)}`,
        render_group: "set_detail",
        data_hash: hashJson(payload),
      });
    }

    const formatSummaryPayload = formatsSummaryResult.rows.map((row) => ({
      name: row.name,
      description: row.description,
      has_rotation: row.has_rotation,
      legal_blocks: parseInt(row.legal_blocks, 10),
      ban_count: parseInt(row.ban_count, 10),
    }));

    routes.push({
      route: "/formats",
      render_group: "formats_index",
      data_hash: hashJson(formatSummaryPayload),
    });

    const blocksByFormatId = groupBy(formatBlocksResult.rows, (row) => row.format_id);
    const bansByFormatId = groupBy(formatBansResult.rows, (row) => row.format_id);

    for (const formatRow of formatsSummaryResult.rows) {
      const payload = {
        name: formatRow.name,
        description: formatRow.description,
        has_rotation: formatRow.has_rotation,
        blocks: (blocksByFormatId.get(formatRow.id) ?? []).map((block) => ({
          block: block.block,
          legal: block.legal,
          rotated_at: block.rotated_at,
        })),
        bans: (bansByFormatId.get(formatRow.id) ?? []).map((ban) => ({
          card_number: ban.card_number,
          type: ban.ban_type,
          max_copies: ban.max_copies,
          paired_with: ban.paired_card_number,
          banned_at: ban.banned_at,
          reason: ban.reason,
          is_upcoming: new Date(ban.banned_at) > now,
        })),
      };

      routes.push({
        route: `/formats/${encodeURIComponent(formatRow.name)}`,
        render_group: "format_detail",
        data_hash: hashJson(payload),
      });
    }

    routes.push({
      route: "/don",
      render_group: "don",
      data_hash: hashJson(donResult.rows.map((row) => ({
        ...row,
        thumbnail_url: thumbnailUrl(row.image_url),
      }))),
    });

    const scansPayload = {
      total_cards: scansResult.rows.reduce((sum, row) => sum + row.total_cards, 0),
      total_scanned_cards: scansResult.rows.reduce((sum, row) => sum + row.scanned_cards, 0),
      total_missing_image_cards: scansResult.rows.reduce((sum, row) => sum + row.missing_image_cards, 0),
      total_variants: scansResult.rows.reduce((sum, row) => sum + row.total_variants, 0),
      total_scanned_variants: scansResult.rows.reduce((sum, row) => sum + row.scanned_variants, 0),
      sets: scansResult.rows.map((row) => ({
        set_code: row.set_code,
        total_cards: row.total_cards,
        scanned_cards: row.scanned_cards,
        missing_image_cards: row.missing_image_cards,
        total_variants: row.total_variants,
        scanned_variants: row.scanned_variants,
      })),
    };

    routes.push({
      route: "/scans",
      render_group: "scan_progress",
      data_hash: hashJson(scansPayload),
    });

    reply.header("Cache-Control", "public, max-age=60");
    return {
      data: {
        generated_at: now.toISOString(),
        routes: routes.sort((a, b) => a.route.localeCompare(b.route)),
      },
    };
  });
}
