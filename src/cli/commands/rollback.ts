import { Command } from "../command.ts";
import {
  APPLY_RUNS_PATH,
  callDeployControl,
  expectedGuardFromPlanRun,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  PLAN_RUNS_PATH,
  requireRemoteDeployControl,
} from "../deploy_control_client.ts";
import { exitCli } from "../runtime.ts";

function createRollbackCommand(): Command {
  return new Command("rollback")
    .description(
      "Redeploy an Installation from a prior Deployment's OpenTofu source",
    )
    .argument("<installationId>", "Installation id")
    .argument("<deploymentId>", "Deployment id to redeploy from")
    .option("--remote <url>", "Remote Takosumi service URL")
    .option("--token <token>", "DeployControl bearer token")
    .option(
      "--provider <source-address>",
      "Required OpenTofu provider source address (repeatable)",
      collect,
      [],
    )
    .action(
      async (
        installationId: string,
        deploymentId: string,
        opts: { remote?: string; token?: string; provider?: string[] },
      ) => {
        try {
          const target = await requireRemoteDeployControl(opts.remote, opts.token);
          const installation = await readInstallation(target, installationId);
          const deployment = await readDeployment(
            target,
            installationId,
            deploymentId,
          );
          const plan = await callDeployControl(target, {
            path: PLAN_RUNS_PATH,
            body: {
              installationId,
              operation: "update",
              spaceId: readRequiredString(installation, ["installation", "spaceId"]),
              source: readRequiredRecord(deployment, ["source"]),
              requiredProviders: normalizeProviders(opts.provider),
            },
          });
          if (plan.status >= 400) {
            console.error(`Takosumi service returned ${plan.status}:`, plan.body);
            exitCli(1);
          }
          const planRunId = readNestedString(plan.body, ["planRun", "id"]);
          const planStatus = readNestedString(plan.body, ["planRun", "status"]);
          const planRun = readNestedRecord(plan.body, ["planRun"]);
          if (!planRunId || planStatus !== "succeeded" || !planRun) {
            console.log(JSON.stringify(plan.body, null, 2));
            return;
          }
          const { status, body } = await callDeployControl(target, {
            path: APPLY_RUNS_PATH,
            body: {
              planRunId,
              expected: expectedGuardFromPlanRun(planRun),
            },
          });
          if (status >= 400) {
            console.error(`Takosumi service returned ${status}:`, body);
            exitCli(1);
          }
          console.log(JSON.stringify(body, null, 2));
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          console.error(`error: ${message}`);
          exitCli(1);
        }
      },
    ) as Command;
}

async function readInstallation(
  target: Parameters<typeof callDeployControl>[0],
  installationId: string,
): Promise<unknown> {
  const { status, body } = await callDeployControl(target, {
    path: INSTALLATION_PATH(installationId),
    method: "GET",
    body: undefined,
  });
  if (status >= 400) {
    throw new Error(`Takosumi service returned ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function readDeployment(
  target: Parameters<typeof callDeployControl>[0],
  installationId: string,
  deploymentId: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await callDeployControl(target, {
    path: INSTALLATION_DEPLOYMENTS_PATH(installationId),
    method: "GET",
    body: undefined,
  });
  if (status >= 400) {
    throw new Error(`Takosumi service returned ${status}: ${JSON.stringify(body)}`);
  }
  const deployments = readNestedArray(body, ["deployments"]);
  const deployment = deployments.find((item) =>
    readNestedString(item, ["id"]) === deploymentId
  );
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    throw new Error(`deployment ${deploymentId} not found`);
  }
  return deployment as Record<string, unknown>;
}

function readRequiredString(value: unknown, path: readonly string[]): string {
  const result = readNestedString(value, path);
  if (!result) throw new Error(`${path.join(".")} is required`);
  return result;
}

function readRequiredRecord(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> {
  const result = readNested(value, path);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`${path.join(".")} is required`);
  }
  return result as Record<string, unknown>;
}

function readNestedRecord(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> | undefined {
  const result = readNested(value, path);
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
}

function readNestedArray(value: unknown, path: readonly string[]): readonly unknown[] {
  const result = readNested(value, path);
  return Array.isArray(result) ? result : [];
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  const result = readNested(value, path);
  return typeof result === "string" ? result : undefined;
}

function readNested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export const rollbackCommand: Command = createRollbackCommand();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeProviders(values: readonly string[] | undefined): readonly string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}
