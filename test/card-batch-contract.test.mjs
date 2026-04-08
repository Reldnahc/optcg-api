import assert from "node:assert/strict";
import { createCardRow, withCardsApp } from "./helpers/cardsTestUtils.mjs";

const { app, assertDone } = await withCardsApp([
  {
    match: "WHERE UPPER(c.card_number) = ANY($1::text[]) AND c.language = $2",
    assert: ({ params }) => {
      assert.deepEqual(params, [["OP01-001", "OP02-033", "FAKE-001"], "en"]);
    },
    result: {
      rows: [
        createCardRow({
          id: "card-1",
          card_number: "OP01-001",
          name: "Leader Luffy",
          card_type: "Leader",
          life: 5,
          counter: null,
          block: "1",
          set_product_name: "Romance Dawn",
        }),
        createCardRow({
          id: "card-2",
          card_number: "OP02-033",
          name: "Searcher Nami",
          card_type: "Character",
          block: "2",
          set_product_name: "Paramount War",
        }),
      ],
    },
  },
  {
    match: "WHERE ci.card_id = ANY($1::uuid[])",
    assert: ({ params }) => {
      assert.deepEqual(params, [["card-1", "card-2"]]);
    },
    result: {
      rows: [
        {
          card_id: "card-1",
          card_number: "OP01-001",
          variant_index: 0,
          name: null,
          label: "Standard",
          artist: "Artist A",
          image_url: "https://example.com/op01-001.png",
          image_thumb_url: "https://example.com/thumbs/op01-001.webp",
          scan_display_url: "https://example.com/op01-001-scan-display.webp",
          scan_full_url: "https://example.com/op01-001-scan.png",
          scan_thumb_url: "https://example.com/op01-001-scan-thumb.webp",
          product_name: "Romance Dawn",
          product_set_code: "OP01",
          product_released_at: "2025-01-01T00:00:00.000Z",
          tcgplayer_url: "https://example.com/tcgplayer/op01-001",
          market_price: "2.00",
          low_price: "1.50",
          mid_price: "2.00",
          high_price: "2.50",
        },
        {
          card_id: "card-2",
          card_number: "OP02-033",
          variant_index: 0,
          name: "Textless",
          label: "Manga Art",
          artist: "Artist B",
          image_url: "https://example.com/op02-033-manga.png",
          image_thumb_url: null,
          scan_display_url: null,
          scan_full_url: null,
          scan_thumb_url: null,
          product_name: "Manga Promo",
          product_set_code: "OP02",
          product_released_at: "2025-02-01T00:00:00.000Z",
          tcgplayer_url: null,
          market_price: null,
          low_price: null,
          mid_price: null,
          high_price: null,
        },
      ],
    },
  },
  {
    match: "WITH requested_blocks AS",
    assert: ({ params }) => {
      assert.deepEqual(params, [["1", "2"]]);
    },
    result: {
      rows: [
        { block: "1", format_name: "Standard", legal: true },
        { block: "1", format_name: "Extra Regulation", legal: true },
        { block: "2", format_name: "Standard", legal: false },
        { block: "2", format_name: "Extra Regulation", legal: false },
      ],
    },
  },
  {
    match: "WHERE UPPER(fb.card_number) = ANY($1::text[]) AND fb.unbanned_at IS NULL",
    assert: ({ params }) => {
      assert.deepEqual(params, [["OP01-001", "OP02-033"]]);
    },
    result: {
      rows: [
        {
          card_number: "OP01-001",
          format_name: "Standard",
          ban_type: "restricted",
          max_copies: 1,
          banned_at: "2025-03-01T00:00:00.000Z",
          reason: "Test restriction",
          paired_card_number: null,
        },
      ],
    },
  },
  {
    match: "SELECT DISTINCT card_number, language",
    assert: ({ params }) => {
      assert.deepEqual(params, [["OP01-001", "OP02-033"]]);
    },
    result: {
      rows: [
        { card_number: "OP01-001", language: "en" },
        { card_number: "OP01-001", language: "ja" },
        { card_number: "OP02-033", language: "en" },
      ],
    },
  },
]);

try {
  const response = await app.inject({
    method: "POST",
    url: "/v1/cards/batch",
    payload: {
      card_numbers: ["op01-001", "OP02-033", "FAKE-001"],
      lang: "en",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.deepEqual(body.missing, ["FAKE-001"]);
  assert.deepEqual(Object.keys(body.data), ["OP01-001", "OP02-033"]);

  assert.equal(body.data["OP01-001"].name, "Leader Luffy");
  assert.equal(body.data["OP01-001"].variants.length, 1);
  assert.equal(body.data["OP01-001"].variants[0].name, null);
  assert.equal(body.data["OP01-001"].variants[0].images.stock.full, "https://example.com/op01-001.png");
  assert.equal(body.data["OP01-001"].variants[0].images.stock.thumb, "https://example.com/thumbs/op01-001.webp");
  assert.equal(body.data["OP01-001"].variants[0].images.scan.display, "https://example.com/op01-001-scan-display.webp");
  assert.equal(body.data["OP01-001"].variants[0].market.market_price, "2.00");
  assert.equal(body.data["OP01-001"].legality.Standard.status, "restricted");
  assert.equal(body.data["OP01-001"].legality.Standard.max_copies, 1);
  assert.deepEqual(body.data["OP01-001"].available_languages, ["en", "ja"]);

  // OP02-033 has a Manga Art variant — mangaExempt flags the card legal
  // even though its block is not legal in the format.
  assert.equal(body.data["OP02-033"].variants.length, 1);
  assert.equal(body.data["OP02-033"].variants[0].name, "Textless");
  assert.equal(body.data["OP02-033"].variants[0].label, "Manga Art");
  assert.equal(body.data["OP02-033"].legality.Standard.status, "legal");
  assert.deepEqual(body.data["OP02-033"].available_languages, ["en"]);

  assertDone();
  console.log("PASS card batch returns keyed card details and missing card numbers");
} finally {
  await app.close();
}
