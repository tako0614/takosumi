import { Command } from "../command.ts";
import {
  callInstaller,
  deploymentExpectedGuardFromOptions,
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  parseSourceRef,
  requireRemoteInstaller,
} from "../installer_client.ts";

interface DeployFlags {
  remote?: string;
  token?: string;
  source?: string;
  expectedCommit?: string;
  expectedManifestDigest?: string;
  expectedSourceDigest?: string;
  expectedCurrentDeploymentId?: string;
  dryRun?: boolean;
}

function createDeployCommand(): Command {
  const dryRun = new Command("dry-run")
    .description("Dry-run a Deployment for an existing Installation")
    .argument("<installationId>", "Installation id")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token")
    .option("--source <source>", "Optional replacement source");
  dryRun.action(async (
      installationId: string,
      opts: DeployFlags | Command,
      actionCommand?: Command,
    ) => {
      const flags = actionFlags(dryRun, opts, actionCommand);
      await runDeploy({
        installationId,
        remote: flags.remote,
        token: flags.token,
        source: flags.source,
        dryRun: true,
      });
    });

  const command = new Command("deploy")
    .description("Apply a Deployment for an existing Installation")
    .argument("<installationId>", "Installation id")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token")
    .option("--source <source>", "Optional replacement source")
    .option("--expected-commit <commit>", "Expected source commit pin")
    .option(
      "--expected-manifest-digest <digest>",
      "Expected .takosumi.yml digest pin",
    )
    .option(
      "--expected-source-digest <digest>",
      "Expected prepared source digest pin",
    )
    .option(
      "--expected-current-deployment-id <deploymentId>",
      "Expected current Deployment pointer",
    )
    .option("--dry-run", "Alias for `takosumi deploy dry-run`");
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
        expectedCommit: flags.expectedCommit,
        expectedManifestDigest: flags.expectedManifestDigest,
        expectedSourceDigest: flags.expectedSourceDigest,
        expectedCurrentDeploymentId: flags.expectedCurrentDeploymentId,
        dryRun: flags.dryRun === true,
      });
    });

  command.addCommand(dryRun);
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
  readonly expectedCommit?: string;
  readonly expectedManifestDigest?: string;
  readonly expectedSourceDigest?: string;
  readonly expectedCurrentDeploymentId?: string;
  readonly dryRun: boolean;
}): Promise<void> {
  try {
    const target = await requireRemoteInstaller(input.remote, input.token);
    const body = {
      ...(input.source ? { source: parseSourceRef(input.source) } : {}),
      ...(input.dryRun ? {} : {
        expected: deploymentExpectedGuardFromOptions({
          expectedCommit: input.expectedCommit,
          expectedManifestDigest: input.expectedManifestDigest,
          expectedSourceDigest: input.expectedSourceDigest,
          expectedCurrentDeploymentId: input.expectedCurrentDeploymentId,
        }),
      }),
    };
    const { status, body: responseBody } = await callInstaller(target, {
      path: input.dryRun
        ? INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH(input.installationId)
        : INSTALLATION_DEPLOYMENTS_PATH(input.installationId),
      body,
    });
    if (status >= 400) {
      console.error(`kernel returned ${status}:`, responseBody);
      Deno.exit(1);
    }
    console.log(JSON.stringify(responseBody, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    Deno.exit(1);
  }
}

export const deployCommand: Command = createDeployCommand();
