import assert from "node:assert/strict";
import { createCardRow, withCardsApp } from "./helpers/cardsTestUtils.mjs";

const { app, assertDone } = await withCardsApp([
  {
    match: "SELECT COUNT(*) AS total",
    result: { rows: [{ total: "1" }] },
  },
  {
    match: "SELECT c.*, p.name AS product_name, p.released_at",
    result: {
      rows: [
        {
          ...createCardRow({ card_number: "OP05-091", name: "Rebecca" }),
          image_url: "https://example.com/card.png",
          scan_url: "https://example.com/card-scan.png",
          scan_thumb_url: "https://example.com/card-scan-thumb.webp",
          tcgplayer_url: "https://example.com/tcgplayer/card",
          market_price: "1.23",
          low_price: "1.00",
          mid_price: "1.20",
          high_price: "2.00",
        },
      ],
    },
  },
  {
    match: "SELECT COUNT(*) AS total",
    result: { rows: [{ total: "1" }] },
  },
  {
    match: "JOIN card_images ci ON ci.card_id = c.id AND ci.classified = true",
    result: {
      rows: [
        {
          ...createCardRow({ id: "card-print-1", card_number: "OP05-091", name: "Rebecca" }),
          image_url: "https://example.com/print.png",
          scan_url: "https://example.com/print-scan.png",
          scan_thumb_url: "https://example.com/print-scan-thumb.webp",
          tcgplayer_url: "https://example.com/tcgplayer/print",
          market_price: "4.56",
          low_price: "4.00",
          mid_price: "4.50",
          high_price: "6.00",
          label: "Alternate Art",
          variant_index: 1,
          variant_product_name: "Awakening of the New Era",
        },
      ],
    },
  },
]);

try {
  const cardsResponse = await app.inject({
    method: "GET",
    url: "/v1/cards",
    query: { q: "Rebecca", unique: "cards", limit: "1", lang: "en" },
  });
  assert.equal(cardsResponse.statusCode, 200);
  const cardsBody = cardsResponse.json();
  assert.ok(cardsBody.data.length > 0);
  assert.ok("scan_url" in cardsBody.data[0]);
  assert.ok("scan_thumb_url" in cardsBody.data[0]);
  assert.ok("tcgplayer_url" in cardsBody.data[0]);
  assert.ok("market_price" in cardsBody.data[0]);

  const printsResponse = await app.inject({
    method: "GET",
    url: "/v1/cards",
    query: { q: "Rebecca", unique: "prints", limit: "1", lang: "en" },
  });
  assert.equal(printsResponse.statusCode, 200);
  const printsBody = printsResponse.json();
  assert.ok(printsBody.data.length > 0);
  assert.ok("scan_url" in printsBody.data[0]);
  assert.ok("scan_thumb_url" in printsBody.data[0]);
  assert.ok("tcgplayer_url" in printsBody.data[0]);
  assert.ok("market_price" in printsBody.data[0]);

  assertDone();
  console.log("PASS cards search keeps summary media and market fields");
} finally {
  await app.close();
}
