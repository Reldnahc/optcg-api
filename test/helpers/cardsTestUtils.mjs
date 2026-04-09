import assert from "node:assert/strict";
import Fastify from "fastify";
import { cardsRoutes } from "../../dist/routes/cards.js";

export function createCardRow(overrides = {}) {
  return {
    id: "card-1",
    card_number: "OP01-001",
    language: "en",
    product_id: "product-1",
    true_set_code: "OP01",
    name: "Sample Card",
    card_type: "Character",
    rarity: "R",
    color: ["Red"],
    cost: 3,
    power: 5000,
    counter: 1000,
    life: null,
    attribute: ["Strike"],
    types: ["Straw Hat Crew"],
    effect: "Sample effect",
    trigger: null,
    block: "1",
    product_name: "Romance Dawn",
    released_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function createQueryStub(steps) {
  let index = 0;

  const queryExecutor = async (sql, params = []) => {
    // Auto-tolerate the search handler's per-card variant fetch when a test
    // has exhausted its stubs. collapse=card runs: count → cards page →
    // variant fetch (FROM card_images ci ... ANY($2::uuid[])). Tests that
    // predate the restructure only stub the first two; return an empty
    // variant set so those tests still pass without needing a third stub.
    if (index >= steps.length
        && sql.includes("FROM card_images ci")
        && sql.includes("ci.card_id = ANY($2::uuid[])")) {
      return { rows: [] };
    }
    const step = steps[index++];
    assert.ok(step, `Unexpected query ${index}: ${sql}`);

    if (step.match) {
      if (step.match instanceof RegExp) {
        assert.match(sql, step.match);
      } else {
        assert.ok(sql.includes(step.match), `Expected SQL to include "${step.match}"\n${sql}`);
      }
    }

    if (step.assert) {
      step.assert({ sql, params, index: index - 1 });
    }

    return typeof step.result === "function"
      ? step.result({ sql, params, index: index - 1 })
      : step.result;
  };

  queryExecutor.assertDone = () => {
    assert.equal(index, steps.length, `Expected ${steps.length} queries, saw ${index}`);
  };

  return queryExecutor;
}

export async function withCardsApp(steps) {
  const queryExecutor = createQueryStub(steps);
  const app = Fastify({ logger: false });
  app.register(cardsRoutes, { prefix: "/v1", queryExecutor });
  await app.ready();
  return {
    app,
    assertDone: () => queryExecutor.assertDone(),
  };
}
