import { FastifyInstance } from "fastify";
import { query } from "optcg-db/db/client.js";
import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import { getEcsTaskConfig, type EcsTaskPrefix } from "./config.js";

function getTaskFamily(taskDefinition: string): string {
  const taskDefinitionPart = taskDefinition.split("/").pop() ?? taskDefinition;
  return taskDefinitionPart.split(":")[0];
}

async function hasRunningTask(kind: EcsTaskPrefix): Promise<boolean> {
  const config = getEcsTaskConfig(kind);
  if (!config) return false;

  const client = new ECSClient({});
  const family = getTaskFamily(config.taskDefinition);
  const result = await client.send(
    new ListTasksCommand({
      cluster: config.cluster,
      family,
      desiredStatus: "RUNNING",
      launchType: "FARGATE",
      maxResults: 1,
    }),
  );

  return (result.taskArns?.length ?? 0) > 0;
}

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
  app.get("/stats", async () => {
    const [totalCardsResult, cardsByLanguageResult, recentErrorsResult] = await Promise.all([
      query<{ total: string }>(`SELECT COUNT(*) AS total FROM cards`),
      query<{ language: string; count: string }>(
        `SELECT language, COUNT(*) AS count
         FROM cards
         GROUP BY language
         ORDER BY language ASC`,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM scrape_log
         WHERE errors IS NOT NULL
           AND btrim(errors) <> ''
           AND ran_at >= NOW() - INTERVAL '7 days'`,
      ),
    ]);

    return {
      data: {
        total_cards: parseInt(totalCardsResult.rows[0]?.total ?? "0", 10),
        cards_by_language: cardsByLanguageResult.rows.map((row) => ({
          language: row.language,
          count: parseInt(row.count, 10),
        })),
        recent_errors: parseInt(recentErrorsResult.rows[0]?.count ?? "0", 10),
      },
    };
  });

  app.get("/scraper/status", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

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
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/scraper/logs", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

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
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.get("/watcher/topics", async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(qs.limit || "50", 10)));

    const rows = await query<Record<string, unknown>>(
      `SELECT *
       FROM watched_topics
       ORDER BY seen_at DESC
       LIMIT $1`,
      [limit],
    );

    reply.header("Cache-Control", "no-store");
    return { data: rows.rows };
  });

  app.post("/scraper/run", async (req, reply) => {
    const body = (req.body ?? {}) as { language?: unknown };
    const language = typeof body.language === "string" ? body.language.trim() : "";

    try {
      if (await hasRunningTask("SCRAPER")) {
        reply.code(409);
        return { error: { status: 409, message: "A scraper task is already running" } };
      }

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

  app.post("/variant-merge/run", async (req, reply) => {
    const body = (req.body ?? {}) as {
      card_number?: unknown;
      from_variant_index?: unknown;
      to_variant_index?: unknown;
      dry_run?: unknown;
    };

    const cardNumber = typeof body.card_number === "string" ? body.card_number.trim().toUpperCase() : "";
    const fromVariantIndex = typeof body.from_variant_index === "number" && Number.isInteger(body.from_variant_index)
      ? body.from_variant_index
      : null;
    const toVariantIndex = typeof body.to_variant_index === "number" && Number.isInteger(body.to_variant_index)
      ? body.to_variant_index
      : null;
    const dryRun = body.dry_run === true;

    if (!cardNumber) {
      reply.code(400);
      return { error: { status: 400, message: "card_number is required" } };
    }
    if (fromVariantIndex == null || fromVariantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "from_variant_index must be a non-negative integer" } };
    }
    if (toVariantIndex == null || toVariantIndex < 0) {
      reply.code(400);
      return { error: { status: 400, message: "to_variant_index must be a non-negative integer" } };
    }
    if (fromVariantIndex === toVariantIndex) {
      reply.code(400);
      return { error: { status: 400, message: "from_variant_index and to_variant_index must differ" } };
    }

    const command = [
      "cli",
      "merge-variant",
      cardNumber,
      String(fromVariantIndex),
      String(toVariantIndex),
      dryRun ? "--dry-run" : "--yes",
    ];

    try {
      const result = await runConfiguredTask("VARIANT_MERGE", { command });
      return { data: result };
    } catch (error: any) {
      reply.code(501);
      return { error: { status: 501, message: error.message } };
    }
  });
}
