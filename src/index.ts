import "dotenv/config";
import Fastify from "fastify";
import { closePool } from "optcg-db/db/client.js";
import { healthRoute } from "./routes/health.js";
import { cardsRoutes } from "./routes/cards.js";
import { setsRoutes } from "./routes/sets.js";
import { randomRoute } from "./routes/random.js";
import { formatsRoutes } from "./routes/formats.js";
import { pricesRoute } from "./routes/prices.js";
import { donRoutes } from "./routes/don.js";
import { getAdminOrigin } from "./admin/config.js";
import { adminAuthRoutes } from "./admin/auth.js";
import { adminCardsRoutes } from "./admin/cards.js";
import { adminFormatsRoutes } from "./admin/formats.js";
import { adminScraperRoutes } from "./admin/scraper.js";
import { adminAuth } from "./middleware/adminAuth.js";

const app = Fastify({ logger: true });
const adminOrigin = getAdminOrigin();
const SLOW_REQUEST_MS = 1000;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "10000", 10);
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "120", 10);

// Rate limiting — 60 req/min per IP
const ipHits = new Map<string, { count: number; resetAt: number }>();

app.addHook("onRequest", async (req, reply) => {
  req.requestStartNs = process.hrtime.bigint();

  if (req.method === "OPTIONS") {
    reply.code(204).send();
    return;
  }

  const ip = req.ip;
  const now = Date.now();
  let entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipHits.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    reply.header("Retry-After", retryAfter);
    reply.code(429).send({
      error: { status: 429, message: "Rate limit exceeded" },
    });
    return;
  }
});

app.addHook("onResponse", async (req, reply) => {
  if (!req.requestStartNs) return;

  const durationMs = Number(process.hrtime.bigint() - req.requestStartNs) / 1_000_000;
  const payload = {
    method: req.method,
    url: req.url,
    statusCode: reply.statusCode,
    duration_ms: Number(durationMs.toFixed(1)),
  };

  if (durationMs >= SLOW_REQUEST_MS) {
    req.log.warn(payload, "Slow request");
    return;
  }

  req.log.info(payload, "Request timing");
});

// CORS — open
app.addHook("onSend", async (req, reply) => {
  const origin = req.headers.origin;
  const allowAdminMethods = !origin || origin === adminOrigin;

  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Origin", allowAdminMethods ? origin || "*" : "*");
  reply.header("Access-Control-Allow-Methods", allowAdminMethods ? "GET, POST, PUT, DELETE, OPTIONS" : "GET, OPTIONS");
  reply.header("Access-Control-Allow-Headers", allowAdminMethods ? "Content-Type, Authorization" : "Content-Type");
});

// Routes
app.register(healthRoute);
app.register(cardsRoutes, { prefix: "/v1" });
app.register(setsRoutes, { prefix: "/v1" });
app.register(randomRoute, { prefix: "/v1" });
app.register(formatsRoutes, { prefix: "/v1" });
app.register(pricesRoute, { prefix: "/v1" });
app.register(donRoutes, { prefix: "/v1" });
app.register(adminAuthRoutes, { prefix: "/admin" });
app.register(async (adminApp) => {
  adminApp.register(async (protectedAdminApp) => {
    await adminAuth(protectedAdminApp);
    protectedAdminApp.register(adminCardsRoutes);
    protectedAdminApp.register(adminFormatsRoutes);
    protectedAdminApp.register(adminScraperRoutes);
  });
}, { prefix: "/admin" });

const port = parseInt(process.env.PORT || "3000", 10);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  await closePool();
  process.exit(1);
}

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await closePool();
    process.exit(0);
  });
}
