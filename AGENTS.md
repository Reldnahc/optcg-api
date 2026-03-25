# optcg-api — Fastify REST API

Public REST API for the OPTCG card database. Serves card data, sets, formats, prices, and DON cards. Will also host admin routes (JWT-protected) for the admin panel.

## Tech Stack
- **Runtime:** Node 20, TypeScript 5, ESM
- **Framework:** Fastify v5
- **Database:** PostgreSQL via `optcg-db` (shared npm package) — raw SQL, no ORM
- **Deployment:** ECS Fargate behind CloudFront at `api.poneglyph.one`

## Project Structure
```
src/
├── index.ts               # Fastify setup, rate limiter, CORS, route registration
├── format.ts              # Utility for formatting card data
├── rarity.ts              # Rarity sorting helpers
├── routes/
│   ├── cards.ts           # GET /v1/cards, /v1/cards/:card_number, /v1/cards/autocomplete
│   ├── sets.ts            # GET /v1/sets, /v1/sets/:set_code
│   ├── formats.ts         # GET /v1/formats, /v1/formats/:format_name
│   ├── prices.ts          # GET /v1/prices/:card_number
│   ├── don.ts             # GET /v1/don, /v1/don/:id
│   ├── random.ts          # GET /v1/random
│   └── health.ts          # GET /health
└── search/
    ├── parser.ts          # Tokenizer + AST builder for search syntax
    └── compiler.ts        # AST → SQL WHERE clause
```

## Environment Variables
```
DB_HOST=       # required (from optcg-db)
DB_USER=       # required
DB_PASSWORD=   # required
DB_PORT=5432
DB_NAME=optcg
DB_SSL=true
PORT=3000      # optional, defaults to 3000
```

## Key Patterns

### Route Registration
Routes are Fastify plugins registered with a `/v1` prefix in `index.ts`:
```typescript
app.register(cardsRoutes, { prefix: "/v1" });
```

Each route file exports an `async function xxxRoutes(app: FastifyInstance)` that defines endpoints.

### Database Queries
All queries use `query<T>(sql, params)` from `optcg-db/db/client.js`. Parameterized SQL, no ORM. Example:
```typescript
import { query } from "optcg-db/db/client.js";
const result = await query<{ id: string; name: string }>(
  `SELECT id, name FROM cards WHERE card_number = $1`,
  [cardNumber]
);
```

### Response Format
All endpoints return `{ data: T }` or `{ data: T[], pagination: {...} }`. Errors return `{ error: { status: number, message: string } }`.

### Rate Limiting
In-memory, 60 req/min per IP. Implemented as a Fastify `onRequest` hook in `index.ts`.

### CORS
Open (`*`), GET and OPTIONS only. Set via `onSend` hook.

### Cache Headers
Routes set `Cache-Control: public, max-age=86400` on responses that rarely change (formats, sets).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/cards` | Search cards. Query params: `q`, `name`, `set`, `color`, `sort`, `order`, `page`, `limit`, `lang` |
| GET | `/v1/cards/:card_number` | Card detail with images, prices, legality. Query: `lang` |
| GET | `/v1/cards/autocomplete` | Autocomplete. Query: `q` |
| GET | `/v1/sets` | List all sets |
| GET | `/v1/sets/:set_code` | Set detail with cards |
| GET | `/v1/formats` | List formats with legal block count and ban count |
| GET | `/v1/formats/:format_name` | Format detail with blocks and bans |
| GET | `/v1/prices/:card_number` | Price data for a card |
| GET | `/v1/don` | List DON cards |
| GET | `/v1/random` | Random card |
| GET | `/health` | Health check |

## Scripts
```bash
npm run dev      # tsx --watch src/index.ts
npm run build    # tsc
npm start        # node dist/index.js
```

## Planned: Admin Routes

Admin routes will live under `/admin/*` and require JWT authentication. They are consumed by the admin panel (`optcg-admin` repo) at `admin.poneglyph.one`. See `optcg-admin/AGENTS.md` for the frontend spec and full API contract.

### Architecture
- **Middleware:** `src/middleware/adminAuth.ts` — validates JWT on all `/admin/*` requests
- **Routes directory:** `src/admin/`
- **Two-layer security:** Cloudflare Access (email whitelist + 2FA) protects the admin SPA at the edge. JWT auth on the API is the second layer.

### Planned Admin Routes

#### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/login` | Authenticate, returns JWT |

#### Cards Management
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/cards` | List cards with filters (paginated) |
| PUT | `/admin/cards/:card_number` | Update card fields (name, rarity, types, etc.) |
| DELETE | `/admin/cards/:card_number/images/:variant_index` | Delete a card image variant |
| POST | `/admin/cards/:card_number/images` | Add a new image variant |
| PUT | `/admin/cards/:card_number/images/:variant_index` | Update image variant fields |

#### Formats Management
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/formats` | List formats with full ban/block data |
| POST | `/admin/formats/:name/bans` | Add a ban (banned/restricted/pair) |
| PUT | `/admin/formats/:name/bans/:id` | Update a ban |
| DELETE | `/admin/formats/:name/bans/:id` | Remove a ban (sets unbanned_at) |
| POST | `/admin/formats/:name/blocks` | Add/update a legal block |
| DELETE | `/admin/formats/:name/blocks/:block` | Remove a legal block |

#### Scraper Controls
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/scraper/logs` | Recent scrape_log entries |
| POST | `/admin/scraper/run` | Trigger a scrape for a specific language |
| GET | `/admin/watcher/topics` | List watched_topics entries |
| POST | `/admin/prices/run` | Trigger price fetch |

### Implementation Notes

1. **JWT middleware pattern:**
```typescript
// src/middleware/adminAuth.ts
import { FastifyInstance } from "fastify";

export async function adminAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: { status: 401, message: "Missing token" } });
      return;
    }
    const token = authHeader.slice(7);
    // Verify JWT (use jsonwebtoken or jose library)
    // Attach user to request
  });
}
```

2. **Route registration:**
```typescript
// In index.ts, add:
import { adminAuth } from "./middleware/adminAuth.js";
import { adminCardsRoutes } from "./admin/cards.js";
import { adminFormatsRoutes } from "./admin/formats.js";
import { adminScraperRoutes } from "./admin/scraper.js";
import { adminAuthRoutes } from "./admin/auth.js";

// Auth route is public (no JWT needed to get a token)
app.register(adminAuthRoutes, { prefix: "/admin" });

// Protected admin routes
app.register(async (adminApp) => {
  adminApp.register(adminAuth);
  adminApp.register(adminCardsRoutes);
  adminApp.register(adminFormatsRoutes);
  adminApp.register(adminScraperRoutes);
}, { prefix: "/admin" });
```

3. **CORS update needed:** Admin panel is on a different domain (`admin.poneglyph.one`), so CORS must allow that origin and POST/PUT/DELETE methods + Authorization header. Update the `onSend` hook in `index.ts`:
```typescript
app.addHook("onSend", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin === "https://admin.poneglyph.one" || !origin) {
    reply.header("Access-Control-Allow-Origin", origin || "*");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  } else {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  }
});
```
Also add an OPTIONS handler or Fastify CORS plugin for preflight requests.

4. **New env vars:**
```
JWT_SECRET=          # required for admin auth
ADMIN_EMAIL=         # the whitelisted admin email
ADMIN_PASSWORD_HASH= # bcrypt hash of admin password
```

5. **New dependencies:**
```bash
npm install jsonwebtoken bcrypt
npm install -D @types/jsonwebtoken @types/bcrypt
```

6. **Ban management example (formats admin route):**
```typescript
// POST /admin/formats/:name/bans
// Body: { card_number, ban_type, banned_at, reason?, max_copies?, paired_card_number? }
// For pair bans: insert TWO rows (bidirectional)
app.post("/formats/:name/bans", async (req, reply) => {
  const { name } = req.params as { name: string };
  const body = req.body as {
    card_number: string;
    ban_type: "banned" | "restricted" | "pair";
    banned_at: string;
    reason?: string;
    max_copies?: number;
    paired_card_number?: string;
  };

  const format = await query(`SELECT id FROM formats WHERE name ILIKE $1`, [name]);
  if (format.rows.length === 0) {
    return reply.code(404).send({ error: { status: 404, message: "Format not found" } });
  }
  const formatId = format.rows[0].id;

  if (body.ban_type === "pair" && body.paired_card_number) {
    // Insert both directions
    await query(
      `INSERT INTO format_bans (format_id, card_number, ban_type, paired_card_number, banned_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (format_id, card_number, COALESCE(paired_card_number, '')) DO NOTHING`,
      [formatId, body.card_number, "pair", body.paired_card_number, body.banned_at, body.reason ?? null]
    );
    await query(
      `INSERT INTO format_bans (format_id, card_number, ban_type, paired_card_number, banned_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (format_id, card_number, COALESCE(paired_card_number, '')) DO NOTHING`,
      [formatId, body.paired_card_number, "pair", body.card_number, body.banned_at, body.reason ?? null]
    );
  } else {
    await query(
      `INSERT INTO format_bans (format_id, card_number, ban_type, max_copies, banned_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (format_id, card_number, COALESCE(paired_card_number, '')) DO NOTHING`,
      [formatId, body.card_number, body.ban_type, body.max_copies ?? null, body.banned_at, body.reason ?? null]
    );
  }

  return { ok: true };
});
```

7. **Scraper trigger example:** The admin panel needs to trigger ECS tasks. Add `@aws-sdk/client-ecs` as a dependency and use `RunTaskCommand` to start scraper/price tasks, similar to how `optcg-data` chains tasks.
