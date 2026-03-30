import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { healthRouteSchema } from "../schemas/public.js";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", { schema: healthRouteSchema }, async (_req, reply) => {
    try {
      await query("SELECT 1");
      return { status: "ok" };
    } catch {
      reply.code(503);
      return { status: "error", message: "Database unreachable" };
    }
  });
}
