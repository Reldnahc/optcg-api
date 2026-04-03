import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";

let cachedDictionary: string[] | null = null;
let cachedEtag: string | null = null;

async function loadDictionary(): Promise<{ dictionary: string[]; etag: string }> {
  const result = await query<{ index: number; card_number: string }>(
    `SELECT index, card_number FROM card_dictionary ORDER BY index ASC`,
  );

  const dictionary = result.rows.map((row) => row.card_number);
  const etag = `"dict-${dictionary.length}"`;

  cachedDictionary = dictionary;
  cachedEtag = etag;

  return { dictionary, etag };
}

export async function decksRoutes(app: FastifyInstance) {
  // GET /v1/decks/dictionary — stable card number array for deck hash encoding
  app.get("/decks/dictionary", async (req, reply) => {
    const ifNoneMatch = req.headers["if-none-match"];

    if (!cachedDictionary) {
      await loadDictionary();
    }

    if (ifNoneMatch && ifNoneMatch === cachedEtag) {
      reply.code(304);
      return;
    }

    reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    reply.header("ETag", cachedEtag);

    return { data: cachedDictionary };
  });

  // POST /v1/decks/dictionary/refresh — bust the in-memory cache
  app.post("/decks/dictionary/refresh", async (_req, reply) => {
    const { dictionary, etag } = await loadDictionary();
    reply.header("Cache-Control", "no-store");
    return { data: { count: dictionary.length, etag } };
  });
}
