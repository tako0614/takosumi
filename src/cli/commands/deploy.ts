import { Command } from "../command.ts";
import {
  APPLY_RUNS_PATH,
  callDeployControl,
  collect,
  expectedGuardFromPlanRun,
  normalizeProviders,
  PLAN_RUNS_PATH,
  parseSourceRef,
  readInstallationSource,
  readInstallationSpace,
  requireRemoteDeployControl,
} from "../deploy_control_client.ts";
import { readNestedRecord, readNestedString } from "../json.ts";
import { exitCli } from "../runtime.ts";

interface DeployFlags {
  remote?: string;
  token?: string;
  source?: string;
  provider?: string[];
  expectedSourceCommit?: string;
  expectedPlanDigest?: string;
  expectedPlanArtifactDigest?: string;
  expectedProviderLockDigest?: string;
}

function createDeployCommand(): Command {
  const command = new Command("deploy")
    .description("Create an OpenTofu PlanRun and ApplyRun for an Installation")
    .argument("<installationId>", "Installation id")
    .option("--remote <url>", "Remote Takosumi service URL")
    .option("--token <token>", "DeployControl bearer token")
    .option("--source <source>", "Optional replacement source")
    .option(
      "--provider <source-address>",
      "Required OpenTofu provider source address (repeatable)",
      collect,
      [],
    )
    .option("--expected-source-commit <commit>", "Expected source commit pin")
    .option("--expected-plan-digest <digest>", "Expected OpenTofu plan digest")
    .option(
      "--expected-plan-artifact-digest <digest>",
      "Expected immutable OpenTofu plan artifact digest",
    )
    .option(
      "--expected-provider-lock-digest <digest>",
      "Expected OpenTofu provider lock digest",
    );
  command.action(async (
      installationId: string,
      opts: DeployFlags | Command,
      actionCommand?: Command,
    ) => {
      const flags = actionFlags(command, opts, actionCommand);
      await runDeploy({
        installationId,
        remote: flags.remote,
        token: flags.token,
        source: flags.source,
        providers: normalizeProviders(flags.provider),
        expectedSourceCommit: flags.expectedSourceCommit,
        expectedPlanDigest: flags.expectedPlanDigest,
        expectedPlanArtifactDigest: flags.expectedPlanArtifactDigest,
        expectedProviderLockDigest: flags.expectedProviderLockDigest,
      });
    });

  return command;
}

function commandFlags(command: Command, opts: DeployFlags): DeployFlags {
  const parent = (command as unknown as { readonly parent?: Command }).parent;
  return {
    ...((parent?.opts<Record<string, unknown>>() ?? {}) as DeployFlags),
    ...(command.opts<Record<string, unknown>>() as DeployFlags),
    ...definedOptions(opts),
  };
}

function actionFlags(
  fallbackCommand: Command,
  opts: DeployFlags | Command | undefined,
  actionCommand?: Command,
): DeployFlags {
  const command = actionCommand ??
    (opts instanceof Command ? opts : fallbackCommand);
  const values = opts instanceof Command || opts === undefined ? {} : opts;
  return commandFlags(command, values);
}

function definedOptions<T extends object>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, option]) =>
      option !== undefined
    ),
  ) as Partial<T>;
}

async function runDeploy(input: {
  readonly installationId: string;
  readonly remote?: string;
  readonly token?: string;
  readonly source?: string;
  readonly providers: readonly string[];
  readonly expectedSourceCommit?: string;
  readonly expectedPlanDigest?: string;
  readonly expectedPlanArtifactDigest?: string;
  readonly expectedProviderLockDigest?: string;
}): Promise<void> {
  try {
    const target = await requireRemoteDeployControl(input.remote, input.token);
    const source = input.source
      ? parseSourceRef(input.source)
      : await readInstallationSource(target, input.installationId);
    const plan = await callDeployControl(target, {
      path: PLAN_RUNS_PATH,
      body: {
        installationId: input.installationId,
        operation: "update",
        spaceId: await readInstallationSpace(target, input.installationId),
        source,
        requiredProviders: input.providers,
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
    const { status, body: responseBody } = await callDeployControl(target, {
      path: APPLY_RUNS_PATH,
      body: {
        planRunId,
        expected: expectedGuardFromPlanRun(planRun, {
          expectedSourceCommit: input.expectedSourceCommit,
          expectedPlanDigest: input.expectedPlanDigest,
          expectedPlanArtifactDigest: input.expectedPlanArtifactDigest,
          expectedProviderLockDigest: input.expectedProviderLockDigest,
        }),
      },
    });
    if (status >= 400) {
      console.error(`Takosumi service returned ${status}:`, responseBody);
      exitCli(1);
    }
    console.log(JSON.stringify(responseBody, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    exitCli(1);
  }
}

export const deployCommand: Command = createDeployCommand();
