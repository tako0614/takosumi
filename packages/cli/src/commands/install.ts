import { Command } from "@cliffy/command";
import {
  callInstaller,
  expectedPinFromOptions,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
  parseSourceRef,
  requireRemoteInstaller,
  resolveSourceArg,
} from "../installer_client.ts";

function createInstallCommand() {
  const dryRun = new Command()
    .description("Dry-run a new Installation from a source")
    .arguments("[source:string]")
    .option(
      "--source <source:string>",
      "git:, catalog:, bundle:, prepared:, or local path",
    )
    .option("--space <spaceId:string>", "Target Space id", { required: true })
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
    .action(async ({ source: sourceFlag, space, remote, token }, sourceArg) => {
      await runInstall({
        sourceRef: resolveSourceArg({ argument: sourceArg, flag: sourceFlag }),
        spaceId: space,
        remote,
        token,
        dryRun: true,
      });
    });

  return new Command()
    .description("Create a new Installation from an AppSpec source")
    .arguments("[source:string]")
    .option(
      "--source <source:string>",
      "git:, catalog:, bundle:, prepared:, or local path",
    )
    .option("--space <spaceId:string>", "Target Space id", { required: true })
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
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
    .option("--dry-run", "Alias for `takosumi install dry-run`")
    .action(
      async (
        {
          source: sourceFlag,
          space,
          remote,
          token,
          expectedCommit,
          expectedManifestDigest,
          expectedSourceDigest,
          dryRun: dryRunFlag,
        },
        sourceArg,
      ) => {
        await runInstall({
          sourceRef: resolveSourceArg({
            argument: sourceArg,
            flag: sourceFlag,
          }),
          spaceId: space,
          remote,
          token,
          expectedCommit,
          expectedManifestDigest,
          expectedSourceDigest,
          dryRun: dryRunFlag === true,
        });
      },
    )
    .command("dry-run", dryRun);
}

async function runInstall(input: {
  readonly sourceRef: string;
  readonly spaceId: string;
  readonly remote?: string;
  readonly token?: string;
  readonly expectedCommit?: string;
  readonly expectedManifestDigest?: string;
  readonly expectedSourceDigest?: string;
  readonly dryRun: boolean;
}): Promise<void> {
  try {
    const target = await requireRemoteInstaller(input.remote, input.token);
    const source = parseSourceRef(input.sourceRef);
    const body = input.dryRun ? { spaceId: input.spaceId, source } : {
      spaceId: input.spaceId,
      source,
      expected: expectedPinFromOptions({
        expectedCommit: input.expectedCommit,
        expectedManifestDigest: input.expectedManifestDigest,
        expectedSourceDigest: input.expectedSourceDigest,
      }),
    };
    const { status, body: responseBody } = await callInstaller(target, {
      path: input.dryRun ? INSTALLATIONS_DRY_RUN_PATH : INSTALLATIONS_PATH,
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

export const installCommand: ReturnType<typeof createInstallCommand> =
  createInstallCommand();
