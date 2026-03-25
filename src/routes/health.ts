import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    try {
      await query("SELECT 1");
      return { status: "ok" };
    } catch {
      reply.code(503);
      return { status: "error", message: "Database unreachable" };
    }
  });
}
