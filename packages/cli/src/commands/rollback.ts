import { Command } from "@cliffy/command";
import {
  callInstaller,
  INSTALLATION_ROLLBACK_PATH,
  requireRemoteInstaller,
} from "../installer_client.ts";

function createRollbackCommand() {
  return new Command()
    .description("Rollback an Installation to a prior Deployment")
    .arguments("<installationId:string> <deploymentId:string>")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Installer bearer token")
    .action(async ({ remote, token }, installationId, deploymentId) => {
      try {
        const target = await requireRemoteInstaller(remote, token);
        const { status, body } = await callInstaller(target, {
          path: INSTALLATION_ROLLBACK_PATH(installationId),
          body: { deploymentId },
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

export const rollbackCommand: ReturnType<typeof createRollbackCommand> =
  createRollbackCommand();
