import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "optcg-db/db/client.js";
import { labelOrder } from "../dist/format.js";
import { cardsRoutes } from "../dist/routes/cards.js";

function compareVariants(a, b) {
  const dateA = a.product.released_at;
  const dateB = b.product.released_at;
  if (dateA && dateB && dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (dateA && !dateB) return -1;
  if (!dateA && dateB) return 1;

  const labelDiff = labelOrder(a.label) - labelOrder(b.label);
  if (labelDiff !== 0) return labelDiff;

  return a.variant_index - b.variant_index;
}

const app = Fastify({ logger: false });
app.register(cardsRoutes, { prefix: "/v1" });
await app.ready();

try {
  const searchResponse = await app.inject({
    method: "GET",
    url: "/v1/cards",
    query: { q: "Rebecca", unique: "cards", limit: "1", lang: "en" },
  });
  assert.equal(searchResponse.statusCode, 200);
  const searchBody = searchResponse.json();
  assert.ok(searchBody.data.length > 0);

  const cardNumber = searchBody.data[0].card_number;
  const detailResponse = await app.inject({
    method: "GET",
    url: `/v1/cards/${cardNumber}`,
    query: { lang: "en" },
  });
  assert.equal(detailResponse.statusCode, 200);

  const detailBody = detailResponse.json();
  assert.ok(!("images" in detailBody.data));
  assert.ok(Array.isArray(detailBody.data.variants));
  assert.ok(Array.isArray(detailBody.data.available_languages));
  assert.ok(typeof detailBody.data.legality === "object");

  if (detailBody.data.variants.length > 0) {
    const firstVariant = detailBody.data.variants[0];
    assert.ok("variant_index" in firstVariant);
    assert.ok("is_default" in firstVariant);
    assert.ok("product" in firstVariant);
    assert.ok("media" in firstVariant);
    assert.ok("market" in firstVariant);
    assert.ok("scan_thumbnail_url" in firstVariant.media);
    assert.ok(!("scan_thumb_url" in firstVariant));

    const sortedVariants = [...detailBody.data.variants].sort(compareVariants);
    assert.deepEqual(detailBody.data.variants, sortedVariants);
  }

  console.log("PASS card detail exposes structured variants in release-first order");
} finally {
  await app.close();
  await closePool();
}
