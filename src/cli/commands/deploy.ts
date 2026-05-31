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
    .option("--source <source>", "Optional replacement source")
    .action(async (installationId: string, opts: DeployFlags) => {
      await runDeploy({
        installationId,
        remote: opts.remote,
        token: opts.token,
        source: opts.source,
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
    .option("--dry-run", "Alias for `takosumi deploy dry-run`")
    .action(async (installationId: string, opts: DeployFlags) => {
      await runDeploy({
        installationId,
        remote: opts.remote,
        token: opts.token,
        source: opts.source,
        expectedCommit: opts.expectedCommit,
        expectedManifestDigest: opts.expectedManifestDigest,
        expectedSourceDigest: opts.expectedSourceDigest,
        expectedCurrentDeploymentId: opts.expectedCurrentDeploymentId,
        dryRun: opts.dryRun === true,
      });
    });

  command.addCommand(dryRun);
  return command;
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
