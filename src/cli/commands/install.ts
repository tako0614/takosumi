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
  space?: string;
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
    .option("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token");
  dryRun.action(async (
      sourceArg: string | undefined,
      opts: InstallFlags | Command,
      actionCommand?: Command,
    ) => {
      const flags = actionFlags(dryRun, opts, actionCommand);
      await runInstall({
        sourceRef: resolveSourceArg({ argument: sourceArg, flag: flags.source }),
        spaceId: requireSpace(flags.space),
        remote: flags.remote,
        token: flags.token,
        dryRun: true,
      });
    });

  const command = new Command("install")
    .description("Create a new Installation from an AppSpec source")
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .option("--space <spaceId>", "Target Space id")
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
    .option("--dry-run", "Alias for `takosumi install dry-run`");
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
        expectedCommit: flags.expectedCommit,
        expectedManifestDigest: flags.expectedManifestDigest,
        expectedSourceDigest: flags.expectedSourceDigest,
        dryRun: flags.dryRun === true,
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
