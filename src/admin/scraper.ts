import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { getEcsTaskConfig, type EcsTaskPrefix } from "./config.js";

async function runConfiguredTask(
  kind: EcsTaskPrefix,
  options: {
    command?: string[];
    environment?: Record<string, string>;
  } = {},
): Promise<{ tasks: unknown[]; failures: unknown[] }> {
  const config = getEcsTaskConfig(kind);
  if (!config) {
    throw new Error(`${kind.toLowerCase()} ECS task is not configured`);
  }

  const client = new ECSClient({});
  const environment = Object.entries(options.environment ?? {}).map(([name, value]) => ({ name, value }));
  const hasOverrides = environment.length > 0 || (options.command?.length ?? 0) > 0;

  const command = new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: "FARGATE",
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        assignPublicIp: config.assignPublicIp ? "ENABLED" : "DISABLED",
      },
    },
    ...(config.containerName && hasOverrides
      ? {
          overrides: {
            containerOverrides: [
              {
                name: config.containerName,
                ...(options.command?.length ? { command: options.command } : {}),
                environment,
              },
            ],
          },
        }
      : {}),
  });

  const result = await client.send(command);
  return {
    tasks: result.tasks ?? [],
    failures: result.failures ?? [],
  };
}

export async function adminScraperRoutes(app: FastifyInstance) {
  app.get("/scraper/status", async (_req, reply) => {
    const rows = await query<{
      id: string;
      ran_at: string;
      source: string | null;
      cards_added: number;
      cards_updated: number;
      errors: string | null;
      duration_ms: number | null;
    }>(
      `SELECT id, ran_at, source, cards_added, cards_updated, errors, duration_ms
       FROM scrape_log
       ORDER BY ran_at DESC
       LIMIT 50`,
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/watcher/topics", async (_req, reply) => {
    const rows = await query<Record<string, unknown>>(
      `SELECT *
       FROM watched_topics`,
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.post("/scraper/run", async (req, reply) => {
    const body = (req.body ?? {}) as { language?: unknown };
    const language = typeof body.language === "string" ? body.language.trim() : "";

    try {
      const result = await runConfiguredTask("SCRAPER", {
        ...(language ? { command: ["scrape", "--lang", language] } : {}),
      });
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/prices/run", async (req, reply) => {
    const body = (req.body ?? {}) as { wipe?: unknown };
    const wipe = body.wipe === true;

    try {
      const result = await runConfiguredTask("PRICES", {
        ...(wipe ? { command: ["prices", "--wipe"] } : {}),
      });
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/watcher/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("WATCHER");
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/formats/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("FORMATS");
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/ocr/run", async (req, reply) => {
    const body = (req.body ?? {}) as { limit?: unknown; dry_run?: unknown };
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : null;
    const dryRun = body.dry_run === true;
    const command = ["ocr"];
    if (limit != null) command.push(String(limit));
    if (dryRun) command.push("--dry-run");

    try {
      const result = await runConfiguredTask("OCR", { command });
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/thumbs/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("THUMBS");
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });
}
