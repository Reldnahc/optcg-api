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
      rows: [createCardRow({ card_number: "OP05-091", name: "Rebecca" })],
    },
  },
  {
    match: "ci.card_id = ANY($2::uuid[])",
    result: {
      rows: [
        {
          card_id: "card-1",
          card_number: "OP05-091",
          variant_index: 0,
          name: null,
          label: "Standard",
          artist: "Artist A",
          image_url: "https://example.com/card.png",
          image_thumb_url: "https://example.com/card-thumb.webp",
          scan_display_url: "https://example.com/card-scan-display.webp",
          scan_full_url: "https://example.com/card-scan.png",
          scan_thumb_url: "https://example.com/card-scan-thumb.webp",
          product_name: "Awakening of the New Era",
          product_set_code: "OP05",
          product_released_at: null,
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
          v_variant_index: 1,
          v_name: "Manga Panel",
          v_label: "Alternate Art",
          v_artist: "Artist B",
          v_image_url: "https://example.com/print.png",
          v_image_thumb_url: null,
          v_scan_display_url: "https://example.com/print-scan-display.webp",
          v_scan_full_url: "https://example.com/print-scan.png",
          v_scan_thumb_url: "https://example.com/print-scan-thumb.webp",
          v_product_name: "Awakening of the New Era",
          v_product_set_code: "OP05",
          v_product_released_at: null,
          v_tcgplayer_url: "https://example.com/tcgplayer/print",
          v_market_price: "4.56",
          v_low_price: "4.00",
          v_mid_price: "4.50",
          v_high_price: "6.00",
        },
      ],
    },
  },
]);

try {
  const cardsResponse = await app.inject({
    method: "GET",
    url: "/v1/search",
    query: { q: "Rebecca", collapse: "card", limit: "1", lang: "en" },
  });
  assert.equal(cardsResponse.statusCode, 200);
  const cardsBody = cardsResponse.json();
  assert.ok(cardsBody.data.length > 0);
  const cardItem = cardsBody.data[0];
  assert.ok(Array.isArray(cardItem.variants));
  assert.equal(cardItem.variants.length, 1);
  const cardVariant = cardItem.variants[0];
  assert.equal(cardVariant.images.stock.full, "https://example.com/card.png");
  assert.equal(cardVariant.images.scan.display, "https://example.com/card-scan-display.webp");
  assert.equal(cardVariant.images.scan.thumb, "https://example.com/card-scan-thumb.webp");
  assert.equal(cardVariant.market.tcgplayer_url, "https://example.com/tcgplayer/card");
  assert.equal(cardVariant.market.market_price, "1.23");
  assert.equal(cardVariant.name, null);

  const printsResponse = await app.inject({
    method: "GET",
    url: "/v1/search",
    query: { q: "Rebecca", collapse: "variant", limit: "1", lang: "en" },
  });
  assert.equal(printsResponse.statusCode, 200);
  const printsBody = printsResponse.json();
  assert.ok(printsBody.data.length > 0);
  const printItem = printsBody.data[0];
  assert.equal(printItem.variants.length, 1);
  const printVariant = printItem.variants[0];
  assert.equal(printVariant.name, "Manga Panel");
  assert.equal(printVariant.label, "Alternate Art");
  assert.equal(printVariant.images.stock.full, "https://example.com/print.png");
  assert.equal(printVariant.images.scan.display, "https://example.com/print-scan-display.webp");
  assert.equal(printVariant.market.tcgplayer_url, "https://example.com/tcgplayer/print");
  assert.equal(printVariant.market.market_price, "4.56");

  assertDone();
  console.log("PASS cards search keeps summary media and market fields");
} finally {
  await app.close();
}
