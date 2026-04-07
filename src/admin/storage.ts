import { FastifyInstance } from "fastify";
import { hasRunningTask, runConfiguredTask } from "./tasks.js";
import { adminRunDbMigrateRouteSchema } from "../schemas/admin.js";

export async function adminStorageRoutes(app: FastifyInstance) {
  app.post("/storage/db-migrate/run", { schema: adminRunDbMigrateRouteSchema }, async (req, reply) => {
    const body = (req.body ?? {}) as { confirm?: unknown };
    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";

    if (confirm !== "MIGRATE") {
      reply.code(400);
      return { error: { status: 400, message: 'confirm must equal "MIGRATE"' } };
    }

    try {
      if (await hasRunningTask("DB_MIGRATE")) {
        reply.code(409);
        return { error: { status: 409, message: "A DB migration task is already running" } };
      }

      const result = await runConfiguredTask("DB_MIGRATE");
      return { data: result };
    } catch (error: any) {
      req.log.error({ err: error }, "Failed to start DB migration task");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });
}
