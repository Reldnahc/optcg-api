import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import { getEcsTaskConfig, type EcsTaskPrefix } from "./config.js";

function getTaskFamily(taskDefinition: string): string {
  const taskDefinitionPart = taskDefinition.split("/").pop() ?? taskDefinition;
  return taskDefinitionPart.split(":")[0];
}

export async function hasRunningTask(kind: EcsTaskPrefix): Promise<boolean> {
  const config = getEcsTaskConfig(kind);
  if (!config) return false;

  const client = new ECSClient({});
  const family = getTaskFamily(config.taskDefinition);
  const result = await client.send(
    new ListTasksCommand({
      cluster: config.cluster,
      family,
      desiredStatus: "RUNNING",
      maxResults: 1,
    }),
  );

  return (result.taskArns?.length ?? 0) > 0;
}

export async function runConfiguredTask(
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
