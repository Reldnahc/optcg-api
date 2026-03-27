import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "optcg-db/db/client.js";
import { cardsRoutes } from "../dist/routes/cards.js";
import { compileSearch } from "../dist/search/compiler.js";
import { parseSearch } from "../dist/search/parser.js";

let app = null;
let failures = 0;

async function withApp() {
  if (app) return app;
  app = Fastify({ logger: false });
  app.register(cardsRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

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
    name: "route matches card names containing literal Not",
    fn: async () => {
      const testApp = await withApp();
      const response = await testApp.inject({
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
    name: "route supports filter-only product searches with relevance sort",
    fn: async () => {
      const testApp = await withApp();
      const response = await testApp.inject({
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
    },
  },
  {
    name: "route defaults q searches to relevance ordering",
    fn: async () => {
      const testApp = await withApp();
      const response = await testApp.inject({
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
    },
  },
  {
    name: "route preserves explicit non-relevance sorts",
    fn: async () => {
      const testApp = await withApp();
      const response = await testApp.inject({
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
    },
  },
  {
    name: "autocomplete keeps normalized phrase matches visible",
    fn: async () => {
      const testApp = await withApp();
      const response = await testApp.inject({
        method: "GET",
        url: "/v1/cards/autocomplete",
        query: { q: "youre th" },
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data[0], "You're the One Who Should Disappear.");
    },
  },
];

try {
  for (const { name, fn } of tests) {
    await runTest(name, fn);
  }
} finally {
  if (app) await app.close();
  await closePool();
}

if (failures > 0) {
  process.exitCode = 1;
}
