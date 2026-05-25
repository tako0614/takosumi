import { Command } from "@cliffy/command";
import {
  callInstaller,
  deploymentExpectedGuardFromOptions,
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  parseSourceRef,
  requireRemoteInstaller,
} from "../installer_client.ts";

function createDeployCommand() {
  const dryRun = new Command()
    .description("Dry-run a Deployment for an existing Installation")
    .arguments("<installationId:string>")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
    .option("--source <source:string>", "Optional replacement source")
    .action(
      async ({ remote, token, source }, installationId) => {
        await runDeploy({
          installationId,
          remote,
          token,
          source,
          dryRun: true,
        });
      },
    );

  return new Command()
    .description("Apply a Deployment for an existing Installation")
    .arguments("<installationId:string>")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
    .option("--source <source:string>", "Optional replacement source")
    .option(
      "--expected-commit <commit:string>",
      "Expected source commit pin",
    )
    .option(
      "--expected-manifest-digest <digest:string>",
      "Expected .takosumi.yml digest pin",
    )
    .option(
      "--expected-source-digest <digest:string>",
      "Expected prepared source digest pin",
    )
    .option(
      "--expected-current-deployment-id <deploymentId:string>",
      "Expected current Deployment pointer",
    )
    .option("--dry-run", "Alias for `takosumi deploy dry-run`")
    .action(
      async (
        {
          remote,
          token,
          source,
          expectedCommit,
          expectedManifestDigest,
          expectedSourceDigest,
          expectedCurrentDeploymentId,
          dryRun: dryRunFlag,
        },
        installationId,
      ) => {
        await runDeploy({
          installationId,
          remote,
          token,
          source,
          expectedCommit,
          expectedManifestDigest,
          expectedSourceDigest,
          expectedCurrentDeploymentId,
          dryRun: dryRunFlag === true,
        });
      },
    )
    .command("dry-run", dryRun);
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

export const deployCommand: ReturnType<typeof createDeployCommand> =
  createDeployCommand();
