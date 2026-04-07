import { FastifyInstance } from "fastify";
import { CreateDBSnapshotCommand, RDSClient } from "@aws-sdk/client-rds";
import { hasRunningTask, runConfiguredTask } from "./tasks.js";
import { getDbInstanceIdentifier } from "./config.js";
import { adminCreateDbSnapshotRouteSchema, adminRunDbMigrateRouteSchema } from "../schemas/admin.js";

function buildSnapshotId() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear().toString(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ];
  return `pre-r2-cutover-${parts.join("")}`;
}

export async function adminStorageRoutes(app: FastifyInstance) {
  app.post("/storage/db-snapshot/run", { schema: adminCreateDbSnapshotRouteSchema }, async (req, reply) => {
    const body = (req.body ?? {}) as { confirm?: unknown };
    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";

    if (confirm !== "SNAPSHOT") {
      reply.code(400);
      return { error: { status: 400, message: 'confirm must equal "SNAPSHOT"' } };
    }

    try {
      const dbInstanceIdentifier = getDbInstanceIdentifier();
      const snapshotId = buildSnapshotId();
      const client = new RDSClient({});
      const result = await client.send(
        new CreateDBSnapshotCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBSnapshotIdentifier: snapshotId,
          Tags: [
            { Key: "Name", Value: snapshotId },
            { Key: "CreatedBy", Value: "admin-storage-page" },
          ],
        }),
      );

      return {
        data: {
          snapshot_id: result.DBSnapshot?.DBSnapshotIdentifier ?? snapshotId,
          db_instance_identifier: result.DBSnapshot?.DBInstanceIdentifier ?? dbInstanceIdentifier,
          status: result.DBSnapshot?.Status ?? "creating",
          arn: result.DBSnapshot?.DBSnapshotArn ?? null,
        },
      };
    } catch (error: any) {
      req.log.error({ err: error }, "Failed to create DB snapshot");
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

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
