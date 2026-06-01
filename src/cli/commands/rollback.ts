import { Command } from "../command.ts";
import {
  callInstaller,
  INSTALLATION_ROLLBACK_PATH,
  requireRemoteInstaller,
} from "../installer_client.ts";
import { exitCli } from "../runtime.ts";

function createRollbackCommand(): Command {
  return new Command("rollback")
    .description("Rollback an Installation to a prior Deployment")
    .argument("<installationId>", "Installation id")
    .argument("<deploymentId>", "Deployment id to roll back to")
    .option("--remote <url>", "Remote kernel URL")
    .option("--token <token>", "Installer bearer token")
    .action(
      async (
        installationId: string,
        deploymentId: string,
        opts: { remote?: string; token?: string },
      ) => {
        try {
          const target = await requireRemoteInstaller(opts.remote, opts.token);
          const { status, body } = await callInstaller(target, {
            path: INSTALLATION_ROLLBACK_PATH(installationId),
            body: { deploymentId },
          });
          if (status >= 400) {
            console.error(`kernel returned ${status}:`, body);
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

export const rollbackCommand: Command = createRollbackCommand();
