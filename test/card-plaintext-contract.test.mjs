import assert from "node:assert/strict";
import { createCardRow, withCardsApp } from "./helpers/cardsTestUtils.mjs";

const { app, assertDone } = await withCardsApp([
  {
    match: "SELECT c.*, p.name AS product_name, p.released_at",
    result: {
      rows: [
        createCardRow({
          card_number: "OP16-102",
          name: "Avalo Pizarro",
          true_set_code: "OP16",
          rarity: "UC",
          color: ["Yellow"],
          cost: 1,
          power: 2000,
          counter: 2000,
          attribute: ["Special"],
          types: ["Impel Down", "Blackbeard Pirates"],
          effect: "[On K.O] Draw one card. Then play up to 1 [Fullalead] from your hand or trash.",
          trigger: "Activate this cards [On K.O.] effect",
        }),
      ],
    },
  },
]);

try {
  const response = await app.inject({
    method: "GET",
    url: "/v1/cards/OP16-102/text",
    query: { lang: "en" },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] || "", /^text\/plain\b/i);
  assert.equal(
    response.body,
    [
      "Avalo Pizarro",
      "Yellow Character OP16-102 UC",
      "1 Cost / 2000 Power (Special)",
      "Impel Down / Blackbeard Pirates",
      "Counter +2000",
      "",
      "[On K.O] Draw one card. Then play up to 1 [Fullalead] from your hand or trash.",
      "",
      "[Trigger] Activate this cards [On K.O.] effect",
    ].join("\n"),
  );

  assertDone();
  console.log("PASS card plain-text route returns the expected text block");
} finally {
  await app.close();
}
