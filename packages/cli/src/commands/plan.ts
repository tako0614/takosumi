import { Command } from "@cliffy/command";
import {
  callInstaller,
  INSTALLATIONS_DRY_RUN_PATH,
  parseSourceRef,
  requireRemoteInstaller,
  resolveSourceArg,
} from "../installer_client.ts";

function createPlanCommand() {
  return new Command()
    .description(
      "Alias for `takosumi install dry-run`: preview a new Installation",
    )
    .arguments("[source:string]")
    .option(
      "--source <source:string>",
      "git:, catalog:, bundle:, prepared:, or local path",
    )
    .option("--space <spaceId:string>", "Target Space id", { required: true })
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
    .action(async ({ source: sourceFlag, space, remote, token }, sourceArg) => {
      try {
        const sourceRef = resolveSourceArg({
          argument: sourceArg,
          flag: sourceFlag,
        });
        const target = await requireRemoteInstaller(remote, token);
        const { status, body } = await callInstaller(target, {
          path: INSTALLATIONS_DRY_RUN_PATH,
          body: { spaceId: space, source: parseSourceRef(sourceRef) },
        });
        if (status >= 400) {
          console.error(`kernel returned ${status}:`, body);
          Deno.exit(1);
        }
        console.log(JSON.stringify(body, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`error: ${message}`);
        Deno.exit(1);
      }
    });
}

export const planCommand: ReturnType<typeof createPlanCommand> =
  createPlanCommand();
