import { Command } from "../command.ts";
import {
  callInstaller,
  expectedPinFromOptions,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
  parseSourceRef,
  requireRemoteInstaller,
  resolveSourceArg,
} from "../installer_client.ts";

interface InstallFlags {
  source?: string;
  space: string;
  remote?: string;
  token?: string;
  expectedCommit?: string;
  expectedManifestDigest?: string;
  expectedSourceDigest?: string;
  dryRun?: boolean;
}

function createInstallCommand(): Command {
  const dryRun = new Command("dry-run")
    .description("Dry-run a new Installation from a source")
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .requiredOption("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token")
    .action(async (sourceArg: string | undefined, opts: InstallFlags) => {
      await runInstall({
        sourceRef: resolveSourceArg({ argument: sourceArg, flag: opts.source }),
        spaceId: opts.space,
        remote: opts.remote,
        token: opts.token,
        dryRun: true,
      });
    });

  const command = new Command("install")
    .description("Create a new Installation from an AppSpec source")
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .requiredOption("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token")
    .option("--expected-commit <commit>", "Expected source commit pin")
    .option(
      "--expected-manifest-digest <digest>",
      "Expected .takosumi.yml digest pin",
    )
    .option(
      "--expected-source-digest <digest>",
      "Expected prepared source digest pin",
    )
    .option("--dry-run", "Alias for `takosumi install dry-run`")
    .action(async (sourceArg: string | undefined, opts: InstallFlags) => {
      await runInstall({
        sourceRef: resolveSourceArg({ argument: sourceArg, flag: opts.source }),
        spaceId: opts.space,
        remote: opts.remote,
        token: opts.token,
        expectedCommit: opts.expectedCommit,
        expectedManifestDigest: opts.expectedManifestDigest,
        expectedSourceDigest: opts.expectedSourceDigest,
        dryRun: opts.dryRun === true,
      });
    });

  command.addCommand(dryRun);
  return command;
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

export const installCommand: Command = createInstallCommand();
