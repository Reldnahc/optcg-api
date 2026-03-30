import assert from "node:assert/strict";
import Fastify from "fastify";
import { installOpenApi } from "../dist/apiDocs.js";
import { cardsRoutes } from "../dist/routes/cards.js";
import { donRoutes } from "../dist/routes/don.js";
import { formatsRoutes } from "../dist/routes/formats.js";
import { docsRoutes } from "../dist/routes/docs.js";
import { healthRoute } from "../dist/routes/health.js";
import { pricesRoute } from "../dist/routes/prices.js";
import { randomRoute } from "../dist/routes/random.js";
import { setsRoutes } from "../dist/routes/sets.js";

const app = Fastify({ logger: false });
installOpenApi(app);
app.register(healthRoute);
app.register(cardsRoutes, { prefix: "/v1" });
app.register(donRoutes, { prefix: "/v1" });
app.register(formatsRoutes, { prefix: "/v1" });
app.register(pricesRoute, { prefix: "/v1" });
app.register(randomRoute, { prefix: "/v1" });
app.register(setsRoutes, { prefix: "/v1" });
app.register(docsRoutes);
await app.ready();

try {
  const openApiResponse = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(openApiResponse.statusCode, 200);
  const spec = openApiResponse.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/health"]);
  assert.ok(spec.paths["/v1/cards"]);
  assert.ok(spec.paths["/v1/cards/autocomplete"]);
  assert.ok(spec.paths["/v1/cards/{card_number}"]);
  assert.ok(spec.paths["/v1/don"]);
  assert.ok(spec.paths["/v1/don/{id}"]);
  assert.ok(spec.paths["/v1/formats"]);
  assert.ok(spec.paths["/v1/formats/{format_name}"]);
  assert.ok(spec.paths["/v1/prices/{card_number}"]);
  assert.ok(spec.paths["/v1/random"]);
  assert.ok(spec.paths["/v1/sets"]);
  assert.ok(spec.paths["/v1/sets/{set_code}"]);
  assert.ok(!spec.paths["/admin/login"]);
  assert.ok(!spec.paths["/admin/formats"]);
  assert.ok(!spec.paths["/admin/prices/run"]);

  const docsResponse = await app.inject({ method: "GET", url: "/docs" });
  assert.equal(docsResponse.statusCode, 200);
  assert.match(docsResponse.headers["content-type"], /text\/html/);
  assert.match(docsResponse.body, /optcg-api/);
  assert.match(docsResponse.body, /\/openapi\.json/);
  assert.match(docsResponse.body, /\/v1\/cards/);
  assert.match(docsResponse.body, /\/v1\/don/);
  assert.match(docsResponse.body, /\/v1\/formats/);
  assert.match(docsResponse.body, /\/v1\/prices/);
  assert.match(docsResponse.body, /\/v1\/random/);
  assert.match(docsResponse.body, /\/v1\/sets/);
  assert.doesNotMatch(docsResponse.body, /\/admin\/formats/);

  console.log("PASS docs routes serve published API docs");
} finally {
  await app.close();
}
