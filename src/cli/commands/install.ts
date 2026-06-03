import { Command } from "../command.ts";
import {
  APPLY_RUNS_PATH,
  callDeployControl,
  expectedGuardFromPlanRun,
  PLAN_RUNS_PATH,
  parseSourceRef,
  requireRemoteDeployControl,
  resolveSourceArg,
} from "../deploy_control_client.ts";
import { exitCli } from "../runtime.ts";

interface InstallFlags {
  source?: string;
  space?: string;
  remote?: string;
  token?: string;
  provider?: string[];
  expectedPlanDigest?: string;
  expectedPlanArtifactDigest?: string;
  expectedSourceCommit?: string;
  expectedProviderLockDigest?: string;
}

function createInstallCommand(): Command {
  const command = new Command("install")
    .description("Create a new Installation from a source")
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .option("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote Takosumi service URL")
    .option("--token <token>", "DeployControl bearer token")
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
      sourceArg: string | undefined,
      opts: InstallFlags | Command,
      actionCommand?: Command,
    ) => {
      const flags = actionFlags(command, opts, actionCommand);
      await runInstall({
        sourceRef: resolveSourceArg({ argument: sourceArg, flag: flags.source }),
        spaceId: requireSpace(flags.space),
        remote: flags.remote,
        token: flags.token,
        providers: normalizeProviders(flags.provider),
        expectedPlanDigest: flags.expectedPlanDigest,
        expectedPlanArtifactDigest: flags.expectedPlanArtifactDigest,
        expectedSourceCommit: flags.expectedSourceCommit,
        expectedProviderLockDigest: flags.expectedProviderLockDigest,
      });
    });

  return command;
}

async function runInstall(input: {
  readonly sourceRef: string;
  readonly spaceId: string;
  readonly remote?: string;
  readonly token?: string;
  readonly providers: readonly string[];
  readonly expectedPlanDigest?: string;
  readonly expectedPlanArtifactDigest?: string;
  readonly expectedSourceCommit?: string;
  readonly expectedProviderLockDigest?: string;
}): Promise<void> {
  try {
    const target = await requireRemoteDeployControl(input.remote, input.token);
    const source = parseSourceRef(input.sourceRef);
    const plan = await callDeployControl(target, {
      path: PLAN_RUNS_PATH,
      body: {
        spaceId: input.spaceId,
        source,
        requiredProviders: input.providers,
      },
    });
    if (plan.status >= 400) {
      if (plan.status >= 400) {
        console.error(`Takosumi service returned ${plan.status}:`, plan.body);
        exitCli(1);
      }
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
          expectedPlanDigest: input.expectedPlanDigest,
          expectedPlanArtifactDigest: input.expectedPlanArtifactDigest,
          expectedSourceCommit: input.expectedSourceCommit,
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

function commandFlags(command: Command, opts: InstallFlags): InstallFlags {
  const parent = (command as unknown as { readonly parent?: Command }).parent;
  return {
    ...((parent?.opts<Record<string, unknown>>() ?? {}) as InstallFlags),
    ...(command.opts<Record<string, unknown>>() as InstallFlags),
    ...definedOptions(opts),
  };
}

function actionFlags(
  fallbackCommand: Command,
  opts: InstallFlags | Command | undefined,
  actionCommand?: Command,
): InstallFlags {
  const command = actionCommand ??
    (opts instanceof Command ? opts : fallbackCommand);
  const values = opts instanceof Command || opts === undefined ? {} : opts;
  return commandFlags(command, values);
}

function requireSpace(space: string | undefined): string {
  if (!space) {
    throw new Error("required option '--space <spaceId>' not specified");
  }
  return space;
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

export const installCommand: Command = createInstallCommand();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeProviders(values: readonly string[] | undefined): readonly string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  const result = readNested(value, path);
  return typeof result === "string" ? result : undefined;
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
