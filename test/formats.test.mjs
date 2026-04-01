import assert from "node:assert/strict";
import Fastify from "fastify";
import { formatsRoutes } from "../dist/routes/formats.js";
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

async function withFormatsApp(steps) {
  const queryExecutor = createQueryStub(steps);
  const app = Fastify({ logger: false });
  app.register(formatsRoutes, { prefix: "/v1", queryExecutor });
  await app.ready();
  return {
    app,
    assertDone: () => queryExecutor.assertDone(),
  };
}

await runTest("formats list counts non-rotating blocks without applying rotation dates", async () => {
  const { app, assertDone } = await withFormatsApp([
    {
      match: "COUNT(DISTINCT flb.id)",
      assert: ({ sql }) => {
        assert.match(sql, /COALESCE\(f\.has_rotation, true\) = false OR/);
      },
      result: {
        rows: [
          {
            id: "format-standard",
            name: "Standard",
            description: "Rotating format",
            has_rotation: true,
            legal_blocks: "3",
            ban_count: "0",
          },
          {
            id: "format-extra",
            name: "Extra Regulation",
            description: "Non-rotating format",
            has_rotation: false,
            legal_blocks: "4",
            ban_count: "0",
          },
        ],
      },
    },
  ]);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/formats",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, [
      {
        name: "Standard",
        description: "Rotating format",
        has_rotation: true,
        legal_blocks: 3,
        ban_count: 0,
      },
      {
        name: "Extra Regulation",
        description: "Non-rotating format",
        has_rotation: false,
        legal_blocks: 4,
        ban_count: 0,
      },
    ]);
    assertDone();
  } finally {
    await app.close();
  }
});

await runTest("format detail marks rotated blocks legal when the format is non-rotating", async () => {
  const { app, assertDone } = await withFormatsApp([
    {
      match: "FROM formats WHERE name ILIKE",
      result: {
        rows: [
          {
            id: "format-extra",
            name: "Extra Regulation",
            description: "Non-rotating format",
            has_rotation: false,
          },
        ],
      },
    },
    {
      match: "FROM format_legal_blocks flb",
      assert: ({ sql }) => {
        assert.match(sql, /COALESCE\(f\.has_rotation, true\) = false OR/);
      },
      result: {
        rows: [
          {
            block: "1",
            legal: true,
            rotated_at: "2026-01-01T00:00:00.000Z",
          },
          {
            block: "4",
            legal: true,
            rotated_at: null,
          },
        ],
      },
    },
    {
      match: "FROM format_bans WHERE format_id",
      result: { rows: [] },
    },
  ]);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/formats/Extra Regulation",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.blocks, [
      {
        block: "1",
        legal: true,
        rotated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        block: "4",
        legal: true,
        rotated_at: null,
      },
    ]);
    assertDone();
  } finally {
    await app.close();
  }
});

if (failures > 0) {
  process.exitCode = 1;
}
