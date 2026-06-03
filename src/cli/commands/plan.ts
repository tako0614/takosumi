import { Command } from "../command.ts";
import {
  callDeployControl,
  PLAN_RUNS_PATH,
  parseSourceRef,
  readInstallationSource,
  readInstallationSpace,
  requireRemoteDeployControl,
  resolveSourceArg,
} from "../deploy_control_client.ts";
import { exitCli } from "../runtime.ts";

function createPlanCommand(): Command {
  return new Command("plan")
    .description(
      "Create an OpenTofu PlanRun for a module source",
    )
    .argument("[source]", "git:, prepared:, or local path")
    .option("--source <source>", "git:, prepared:, or local path")
    .option("--installation <installationId>", "Existing Installation id")
    .option("--space <spaceId>", "Target Space id")
    .option("--remote <url>", "Remote Takosumi service URL")
    .option("--token <token>", "DeployControl bearer token")
    .option(
      "--provider <source-address>",
      "Required OpenTofu provider source address (repeatable)",
      collect,
      [],
    )
    .action(
      async (
        sourceArg: string | undefined,
        opts: {
          source?: string;
          installation?: string;
          space?: string;
          remote?: string;
          token?: string;
          provider?: string[];
        },
      ) => {
        try {
          const target = await requireRemoteDeployControl(opts.remote, opts.token);
          const sourceRef = resolveOptionalSourceArg({
            argument: sourceArg,
            flag: opts.source,
          });
          const installationId = opts.installation;
          const source = sourceRef
            ? parseSourceRef(sourceRef)
            : installationId
            ? await readInstallationSource(target, installationId)
            : parseSourceRef(resolveSourceArg({}));
          const spaceId = installationId
            ? await readInstallationSpace(target, installationId)
            : requireSpace(opts.space);
          const { status, body } = await callDeployControl(target, {
            path: PLAN_RUNS_PATH,
            body: {
              ...(installationId ? { installationId, operation: "update" } : {}),
              spaceId,
              source,
              requiredProviders: normalizeProviders(opts.provider),
            },
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

function requireSpace(space: string | undefined): string {
  if (!space) {
    throw new Error("required option '--space <spaceId>' not specified");
  }
  return space;
}

function resolveOptionalSourceArg(input: {
  readonly argument?: string;
  readonly flag?: string;
}): string | undefined {
  if (input.argument && input.flag && input.argument !== input.flag) {
    throw new Error(
      "pass the source either as an argument or with --source, not both",
    );
  }
  return input.flag ?? input.argument;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeProviders(values: readonly string[] | undefined): readonly string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}
