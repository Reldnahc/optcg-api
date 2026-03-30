import assert from "node:assert/strict";
import Fastify from "fastify";
import { setsRoutes } from "../dist/routes/sets.js";
import { createQueryStub } from "./helpers/cardsTestUtils.mjs";

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

async function withSetsApp(steps) {
  const queryExecutor = createQueryStub(steps);
  const app = Fastify({ logger: false });
  app.register(setsRoutes, { prefix: "/v1", queryExecutor });
  await app.ready();
  return {
    app,
    assertDone: () => queryExecutor.assertDone(),
  };
}

await runTest("route supports set sorting by card_count desc", async () => {
  const { app, assertDone } = await withSetsApp([
    {
      match: "SELECT c.true_set_code",
      assert: ({ sql }) => {
        assert.match(sql, /ORDER BY card_count DESC, c\.true_set_code ASC/);
      },
      result: {
        rows: [
          {
            true_set_code: "OP01",
            product_name: "Romance Dawn",
            name_sort: "Romance Dawn",
            released_at: "2022-12-02T00:00:00.000Z",
            card_count: "121",
          },
        ],
      },
    },
  ]);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sets",
      query: {
        sort: "card_count",
        order: "desc",
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data[0].code, "OP01");
    assert.equal(body.data[0].card_count, 121);
    assertDone();
  } finally {
    await app.close();
  }
});

await runTest("route rejects invalid set sort", async () => {
  const { app, assertDone } = await withSetsApp([]);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sets",
      query: {
        sort: "rarity",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.message, "Invalid sort: rarity");
    assertDone();
  } finally {
    await app.close();
  }
});

await runTest("route defaults sets to released desc sorting", async () => {
  const { app, assertDone } = await withSetsApp([
    {
      match: "SELECT c.true_set_code",
      assert: ({ sql }) => {
        assert.match(sql, /ORDER BY released_at DESC NULLS LAST, c\.true_set_code ASC/);
      },
      result: {
        rows: [],
      },
    },
  ]);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sets",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, []);
    assertDone();
  } finally {
    await app.close();
  }
});

if (failures > 0) {
  process.exitCode = 1;
}
