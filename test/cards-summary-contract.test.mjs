import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "optcg-db/db/client.js";
import { cardsRoutes } from "../dist/routes/cards.js";

const app = Fastify({ logger: false });
app.register(cardsRoutes, { prefix: "/v1" });
await app.ready();

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

  console.log("PASS cards search keeps summary media and market fields");
} finally {
  await app.close();
  await closePool();
}
