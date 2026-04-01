import assert from "node:assert/strict";
import { labelOrder } from "../dist/format.js";
import { createCardRow, withCardsApp } from "./helpers/cardsTestUtils.mjs";

function compareVariants(a, b) {
  const hasImageA = !!a.media.image_url;
  const hasImageB = !!b.media.image_url;
  if (hasImageA !== hasImageB) return hasImageA ? -1 : 1;

  const dateA = a.product.released_at;
  const dateB = b.product.released_at;
  if (dateA && dateB && dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (dateA && !dateB) return -1;
  if (!dateA && dateB) return 1;

  const labelDiff = labelOrder(a.label) - labelOrder(b.label);
  if (labelDiff !== 0) return labelDiff;

  return a.variant_index - b.variant_index;
}

const { app, assertDone } = await withCardsApp([
  {
    match: "SELECT c.*, p.name AS product_name, p.released_at",
    result: {
      rows: [
        createCardRow({
          id: "card-1",
          card_number: "OP05-091",
          name: "Rebecca",
          true_set_code: "OP05",
          set_product_name: "Awakening of the New Era",
        }),
      ],
    },
  },
  {
    match: "SELECT ci.card_id, c.card_number, ci.variant_index, ci.image_url, ci.scan_url, ci.scan_thumb_url",
    result: {
      rows: [
        {
          card_id: "card-1",
          card_number: "OP05-091",
          variant_index: 1,
          image_url: "https://example.com/variant-1.png",
          scan_url: "https://example.com/variant-1-scan.png",
          scan_thumb_url: "https://example.com/variant-1-scan-thumb.webp",
          artist: "Artist B",
          label: "Standard",
          classified: true,
          product_name: "Later Product",
          product_set_code: "OP06",
          product_released_at: "2025-03-01T00:00:00.000Z",
          canonical_tcgplayer_url: "https://example.com/tcgplayer/variant-1",
          tcgplayer_url: "https://example.com/tcgplayer/variant-1/normal",
          market_price: "4.00",
          low_price: "3.50",
          mid_price: "4.00",
          high_price: "5.00",
          sub_type: "Normal",
        },
        {
          card_id: "card-1",
          card_number: "OP05-091",
          variant_index: 0,
          image_url: null,
          scan_url: "https://example.com/variant-0-scan.png",
          scan_thumb_url: "https://example.com/variant-0-scan-thumb.webp",
          artist: "Artist A",
          label: "Alternate Art",
          classified: true,
          product_name: "Earlier Product",
          product_set_code: "OP05",
          product_released_at: "2025-01-01T00:00:00.000Z",
          canonical_tcgplayer_url: "https://example.com/tcgplayer/variant-0",
          tcgplayer_url: "https://example.com/tcgplayer/variant-0/foil",
          market_price: "10.00",
          low_price: "9.00",
          mid_price: "10.00",
          high_price: "12.00",
          sub_type: "Foil",
        },
      ],
    },
  },
  {
    match: "COALESCE(BOOL_AND(",
    result: {
      rows: [
        { format_name: "Standard", legal: true },
      ],
    },
  },
  {
    match: "SELECT fb.card_number, f.name AS format_name, fb.ban_type",
    result: { rows: [] },
  },
  {
    match: "SELECT DISTINCT card_number, language FROM cards",
    result: {
      rows: [{ card_number: "OP05-091", language: "en" }, { card_number: "OP05-091", language: "ja" }],
    },
  },
]);

try {
  const detailResponse = await app.inject({
    method: "GET",
    url: "/v1/cards/OP05-091",
    query: { lang: "en" },
  });
  assert.equal(detailResponse.statusCode, 200);

  const detailBody = detailResponse.json();
  assert.ok(!("images" in detailBody.data));
  assert.ok(Array.isArray(detailBody.data.variants));
  assert.ok(Array.isArray(detailBody.data.available_languages));
  assert.ok(typeof detailBody.data.legality === "object");

  assert.equal(detailBody.data.variants[0].product.name, "Later Product");
  assert.equal(detailBody.data.variants[0].label, "Standard");

  if (detailBody.data.variants.length > 0) {
    const firstVariant = detailBody.data.variants[0];
    assert.ok("variant_index" in firstVariant);
    assert.ok(!("is_default" in firstVariant));
    assert.ok("product" in firstVariant);
    assert.ok("media" in firstVariant);
    assert.ok("market" in firstVariant);
    assert.ok("scan_thumbnail_url" in firstVariant.media);
    assert.ok(!("scan_thumb_url" in firstVariant));

    const sortedVariants = [...detailBody.data.variants].sort(compareVariants);
    assert.deepEqual(detailBody.data.variants, sortedVariants);
  }

  assertDone();
  console.log("PASS card detail exposes structured variants in release-first order");
} finally {
  await app.close();
}
