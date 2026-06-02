import { Command } from "../command.ts";
import {
  callInstaller,
  INSTALLATIONS_DRY_RUN_PATH,
  parseSourceRef,
  requireRemoteInstaller,
  resolveSourceArg,
} from "../installer_client.ts";
import { exitCli } from "../runtime.ts";

function createPlanCommand(): Command {
  return new Command("plan")
    .description(
      "Alias for `takosumi install dry-run`: preview a new Installation",
    )
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .requiredOption("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote Takosumi service URL")
    .option("--token <token>", "Installer bearer token")
    .action(
      async (
        sourceArg: string | undefined,
        opts: {
          source?: string;
          space: string;
          remote?: string;
          token?: string;
        },
      ) => {
        try {
          const sourceRef = resolveSourceArg({
            argument: sourceArg,
            flag: opts.source,
          });
          const target = await requireRemoteInstaller(opts.remote, opts.token);
          const { status, body } = await callInstaller(target, {
            path: INSTALLATIONS_DRY_RUN_PATH,
            body: { spaceId: opts.space, source: parseSourceRef(sourceRef) },
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

export const planCommand: Command = createPlanCommand();
