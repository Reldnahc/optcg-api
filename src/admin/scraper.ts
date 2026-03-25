import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { getEcsTaskConfig } from "./config.js";

async function runConfiguredTask(
  kind: "SCRAPER" | "PRICES",
  overrides: Record<string, string> = {},
): Promise<{ tasks: unknown[]; failures: unknown[] }> {
  const config = getEcsTaskConfig(kind);
  if (!config) {
    throw new Error(`${kind.toLowerCase()} ECS task is not configured`);
  }

  const client = new ECSClient({});
  const environment = Object.entries(overrides).map(([name, value]) => ({ name, value }));

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
    ...(config.containerName && environment.length > 0
      ? {
          overrides: {
            containerOverrides: [
              {
                name: config.containerName,
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
      const result = await runConfiguredTask("SCRAPER", language ? { LANGUAGE: language } : {});
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });

  app.post("/prices/run", async (_req, reply) => {
    try {
      const result = await runConfiguredTask("PRICES");
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });
}
