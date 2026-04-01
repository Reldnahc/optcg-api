import assert from "node:assert/strict";
import { deriveFormatBlockLegal, resolveFormatBlockRotationInput } from "../dist/formatLegality.js";
import { compileSearch } from "../dist/search/compiler.js";
import { parseSearch } from "../dist/search/parser.js";
import { createCardRow, withCardsApp } from "./helpers/cardsTestUtils.mjs";

let failures = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const tests = [
  {
    name: "parser treats mixed-case not as literal text",
    fn: () => {
      const ast = parseSearch("I Do Not");
      assert.equal(ast.type, "and");
      assert.deepEqual(
        ast.children.map((child) => child.type === "name" ? { value: child.value, negated: child.negated } : child),
        [
          { value: "I", negated: false },
          { value: "Do", negated: false },
          { value: "Not", negated: false },
        ],
      );
    },
  },
  {
    name: "parser keeps lowercase or literal but preserves uppercase OR",
    fn: () => {
      const lowercase = parseSearch("A or B");
      assert.equal(lowercase.type, "and");
      assert.deepEqual(
        lowercase.children.map((child) => child.type === "name" ? child.value : child.type),
        ["A", "or", "B"],
      );

      const uppercase = parseSearch("A OR B");
      assert.equal(uppercase.type, "or");
    },
  },
  {
    name: "parser handles quoted product filters",
    fn: () => {
      const ast = parseSearch('product="Anime 25th Collection"');
      assert.deepEqual(ast, {
        type: "filter",
        field: "product",
        operator: "=",
        value: "Anime 25th Collection",
        negated: false,
      });
    },
  },
  {
    name: "parser handles exact card name filters",
    fn: () => {
      const ast = parseSearch('name="Monkey D. Luffy"');
      assert.deepEqual(ast, {
        type: "filter",
        field: "name",
        operator: "=",
        value: "Monkey D. Luffy",
        negated: false,
      });
    },
  },
  {
    name: "parser rewrites standalone type words in multi-term searches",
    fn: () => {
      const ast = parseSearch("luffy leader");
      assert.equal(ast.type, "and");
      assert.deepEqual(ast.children, [
        { type: "name", value: "luffy", negated: false },
        {
          type: "or",
          children: [
            { type: "name", value: "leader", negated: false },
            { type: "filter", field: "type", operator: ":", value: "Leader", negated: false },
          ],
        },
      ]);
    },
  },
  {
    name: "parser keeps standalone type words literal when searched alone",
    fn: () => {
      const ast = parseSearch("leader");
      assert.deepEqual(ast, { type: "name", value: "leader", negated: false });
    },
  },
  {
    name: "parser rewrites standalone rarity acronyms in multi-term searches",
    fn: () => {
      const ast = parseSearch("sec luffy");
      assert.equal(ast.type, "and");
      assert.deepEqual(ast.children, [
        {
          type: "or",
          children: [
            { type: "name", value: "sec", negated: false },
            { type: "filter", field: "rarity", operator: ":", value: "SEC", negated: false },
          ],
        },
        { type: "name", value: "luffy", negated: false },
      ]);
    },
  },
  {
    name: "parser rewrites standalone variant words in multi-term searches",
    fn: () => {
      const ast = parseSearch("luffy manga");
      assert.equal(ast.type, "and");
      assert.deepEqual(ast.children, [
        { type: "name", value: "luffy", negated: false },
        {
          type: "or",
          children: [
            { type: "name", value: "manga", negated: false },
            { type: "filter", field: "is", operator: ":", value: "manga", negated: false },
          ],
        },
      ]);
    },
  },
  {
    name: "route matches card names containing literal Not",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql }) => {
            assert.match(sql, /ORDER BY CASE/);
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP10-078",
                name: "I Do Not Forgive Those Who Laugh at My Family",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "I Do Not Forgive Those Who Laugh at My Family",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP10-078");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route treats standalone type words as type filters in multi-term searches",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.card_type ILIKE \$8/);
            assert.equal(params[7], "Leader");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.card_type ILIKE \$8/);
            assert.match(sql, /CASE WHEN c\.card_type ILIKE \$16 THEN 120 ELSE 0 END/);
            assert.match(sql, /ORDER BY CASE/);
            assert.equal(params[7], "Leader");
            assert.equal(params[15], "Leader");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP09-001",
                name: "Monkey D. Luffy",
                card_type: "Leader",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "luffy leader",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_type, "Leader");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route treats rarity acronyms as rarity boosts without dropping name matches",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.rarity = \$5/);
            assert.equal(params[4], "SEC");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.rarity = \$5/);
            assert.match(sql, /CASE WHEN c\.rarity = \$16 THEN 100 ELSE 0 END/);
            assert.equal(params[4], "SEC");
            assert.equal(params[15], "SEC");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP10-119",
                name: "Monkey D. Luffy",
                rarity: "SEC",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "sec luffy",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].rarity, "SEC");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route supports explicit variant label filters",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /ci\.label = \$2/);
            assert.equal(params[1], "Alternate Art");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /ci\.label = \$2/);
            assert.equal(params[1], "Alternate Art");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP11-118",
                name: "Monkey D. Luffy",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "is:alternate",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP11-118");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route treats variant words as variant boosts without dropping name matches",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /ci\.label = \$8/);
            assert.equal(params[7], "SP");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /ci\.label = \$8/);
            assert.match(sql, /ci_variant_boost\.label = \$16/);
            assert.equal(params[7], "SP");
            assert.equal(params[15], "SP");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP12-001",
                name: "Monkey D. Luffy",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "luffy sp",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP12-001");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "compiler supports exact card name search",
    fn: () => {
      const compiled = compileSearch(parseSearch('name="Monkey D. Luffy"'), 1, "cards");
      assert.match(compiled.sql, /lower\(COALESCE\(c\.name, ''\)\) = lower\(\$1\)/);
      assert.match(compiled.sql, /regexp_replace\(lower\(COALESCE\(c\.name, ''\)\), '\[\^a-z0-9\]\+', '', 'g'\) = \$2/);
      assert.deepEqual(compiled.params, ["Monkey D. Luffy", "monkeydluffy"]);
    },
  },
  {
    name: "compiler treats comma-separated color filters as OR matches",
    fn: () => {
      const compiled = compileSearch(parseSearch("c:red,yellow"), 1, "cards");
      assert.match(compiled.sql, /c\.color && \$1::text\[\]/);
      assert.deepEqual(compiled.params, ["{Red,Yellow}"]);
    },
  },
  {
    name: "compiler treats exact multicolor filters as order-insensitive",
    fn: () => {
      const compiled = compileSearch(parseSearch("c=yellow,red"), 1, "cards");
      assert.match(compiled.sql, /\(c\.color @> \$1::text\[\] AND \$1::text\[\] @> c\.color\)/);
      assert.deepEqual(compiled.params, ["{Yellow,Red}"]);
    },
  },
  {
    name: "compiler derives legal format filtering from rotated_at",
    fn: () => {
      const compiled = compileSearch(parseSearch("legal:standard"), 1, "cards");
      assert.match(compiled.sql, /flb\.rotated_at IS NULL OR flb\.rotated_at > CURRENT_TIMESTAMP/);
      assert.doesNotMatch(compiled.sql, /flb\.legal = true/);
      assert.deepEqual(compiled.params, ["standard"]);
    },
  },
  {
    name: "compiler supports explicit variant label filters",
    fn: () => {
      const sp = compileSearch(parseSearch("is:sp"), 1, "cards");
      assert.match(sp.sql, /ci\.label = \$1/);
      assert.deepEqual(sp.params, ["SP"]);

      const manga = compileSearch(parseSearch("is:manga"), 1, "cards");
      assert.match(manga.sql, /ci\.label = \$1/);
      assert.deepEqual(manga.params, ["Manga Art"]);

      const fullArt = compileSearch(parseSearch("is:full_art"), 1, "cards");
      assert.match(fullArt.sql, /ci\.label = \$1/);
      assert.deepEqual(fullArt.params, ["Full Art"]);

      const alternate = compileSearch(parseSearch("is:alternate"), 1, "cards");
      assert.match(alternate.sql, /ci\.label = \$1/);
      assert.deepEqual(alternate.params, ["Alternate Art"]);
    },
  },
  {
    name: "format block legality helper uses server time",
    fn: () => {
      const now = new Date("2026-03-29T12:00:00.000Z");

      assert.equal(deriveFormatBlockLegal(null, now), true);
      assert.equal(deriveFormatBlockLegal("2026-03-29T12:00:01.000Z", now), true);
      assert.equal(deriveFormatBlockLegal("2026-03-29T12:00:00.000Z", now), false);
      assert.equal(deriveFormatBlockLegal("2026-03-29T11:59:59.000Z", now), false);

      assert.deepEqual(
        resolveFormatBlockRotationInput({ legal: false }, now),
        { legal: false, rotatedAt: now.toISOString() },
      );
    },
  },
  {
    name: "route supports filter-only product searches with relevance sort",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true",
          assert: ({ sql }) => {
            assert.doesNotMatch(sql, /WHEN lower\(COALESCE\(c\.name, ''\)\)/);
            assert.match(sql, /ORDER BY c\.card_number ASC NULLS LAST, c\.card_number ASC, ci\.variant_index ASC/);
          },
          result: {
            rows: [
              {
                ...createCardRow({ id: "card-print-1", card_number: "PRB01-001", name: "Luffy" }),
                image_url: "https://example.com/print.png",
                scan_url: "https://example.com/print-scan.png",
                scan_thumb_url: "https://example.com/print-scan-thumb.webp",
                tcgplayer_url: "https://example.com/tcgplayer/1",
                market_price: "12.34",
                low_price: "10.00",
                mid_price: "12.00",
                high_price: "15.00",
                label: "Standard",
                variant_index: 0,
                variant_product_name: "Anime 25th Collection",
              },
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: 'product="Anime 25th Collection"',
            limit: "5",
            unique: "prints",
            sort: "relevance",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.ok(body.data.length > 0);
        assert.equal(body.data[0].variant_product_name, "Anime 25th Collection");
        assert.deepEqual(body.meta, {
          sort_requested: "relevance",
          sort_applied: "card_number",
          order_requested: "asc",
          order_applied: "asc",
          relevance_active: false,
        });
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route treats comma-separated color query params as OR matches",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.color && \$2::text\[\]/);
            assert.equal(params[1], "{Red,Yellow}");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /c\.color && \$2::text\[\]/);
            assert.equal(params[1], "{Red,Yellow}");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP07-999",
                name: "Dual Threat",
                color: ["Red", "Yellow"],
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            color: "red,yellow",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP07-999");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route treats exact multicolor filters as order-insensitive",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          assert: ({ sql, params }) => {
            assert.match(sql, /\(c\.color @> \$2::text\[\] AND \$2::text\[\] @> c\.color\)/);
            assert.equal(params[1], "{Yellow,Red}");
          },
          result: { rows: [{ total: "1" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql, params }) => {
            assert.match(sql, /\(c\.color @> \$2::text\[\] AND \$2::text\[\] @> c\.color\)/);
            assert.equal(params[1], "{Yellow,Red}");
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP08-888",
                name: "Same Colors Either Way",
                color: ["Red", "Yellow"],
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "c=yellow,red",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP08-888");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route defaults q searches to relevance ordering",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          result: { rows: [{ total: "3" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql }) => {
            assert.match(sql, /WHEN lower\(COALESCE\(c\.name, ''\)\) = lower\(/);
            assert.match(sql, /ORDER BY CASE/);
          },
          result: {
            rows: [
              createCardRow({
                card_number: "OP06-115",
                name: "You're the One Who Should Disappear.",
              }),
              createCardRow({ id: "card-2", card_number: "OP15-074", name: "Varie" }),
              createCardRow({ id: "card-3", card_number: "OP15-075", name: "El Thor" }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "youre the one",
            limit: "5",
            unique: "cards",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0].card_number, "OP06-115");
        assert.deepEqual(body.meta, {
          sort_requested: "relevance",
          sort_applied: "relevance",
          order_requested: "asc",
          order_applied: "desc",
          relevance_active: true,
        });
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "route preserves explicit non-relevance sorts",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT COUNT(*) AS total",
          result: { rows: [{ total: "3" }] },
        },
        {
          match: "SELECT c.*, p.name AS product_name, p.released_at",
          assert: ({ sql }) => {
            assert.doesNotMatch(sql, /WHEN lower\(COALESCE\(c\.name, ''\)\) = lower\(/);
            assert.match(sql, /ORDER BY c\.card_number ASC NULLS LAST, c\.card_number ASC/);
          },
          result: {
            rows: [
              createCardRow({ id: "card-2", card_number: "OP01-002", name: "Another Card" }),
              createCardRow({
                card_number: "OP06-115",
                name: "You're the One Who Should Disappear.",
              }),
            ],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards",
          query: {
            q: "youre the one",
            limit: "5",
            unique: "cards",
            sort: "card_number",
          },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.notEqual(body.data[0].card_number, "OP06-115");
        assert.deepEqual(body.meta, {
          sort_requested: "card_number",
          sort_applied: "card_number",
          order_requested: "asc",
          order_applied: "asc",
          relevance_active: false,
        });
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "autocomplete keeps normalized phrase matches visible",
    fn: async () => {
      const { app, assertDone } = await withCardsApp([
        {
          match: "SELECT name",
          assert: ({ sql }) => {
            assert.match(sql, /regexp_replace\(lower\(name\), '\[\^a-z0-9\]\+', '', 'g'\)/);
          },
          result: {
            rows: [{ name: "You're the One Who Should Disappear." }],
          },
        },
      ]);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/cards/autocomplete",
          query: { q: "youre th" },
        });

        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.data[0], "You're the One Who Should Disappear.");
        assertDone();
      } finally {
        await app.close();
      }
    },
  },
];

for (const { name, fn } of tests) {
  await runTest(name, fn);
}

if (failures > 0) {
  process.exitCode = 1;
}
