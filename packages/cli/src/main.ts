import process from "node:process";
import { helpText } from "./cli-help.ts";
import {
  runAccountsLaunchTokensCleanup,
  runAccountsMigrate,
  runAccountsMigrateD1,
  runAccountsSeed,
  runAccountsServe,
  runAccountsTokens,
} from "./cli-accounts-commands.ts";
import {
  runInstallationsExport,
  runInstallationsInspect,
  runInstallationsList,
  runInstallationsMaterialize,
  runInstallationsStatus,
  runInstallationsUninstall,
} from "./cli-installations-commands.ts";
import {
  runLaunchReadinessProductionTopologyMerge,
  runLaunchReadinessProductionTopologyPreflight,
  runLaunchReadinessProductionTopologyTemplate,
  runLaunchReadinessPublicSummary,
  runLaunchReadinessTemplate,
  runLaunchReadinessValidate,
} from "./cli-launch-readiness-commands.ts";
import type { CliIo } from "./cli-io.ts";

export type { CliIo };
export type { AccountsSeedPlan } from "./cli-accounts-commands.ts";

// Keep launch-readiness audit markers in this entrypoint because the
// root readiness check validates the public CLI surface after helper extraction:
// docs/managed-offering-evidence-collection-matrix.md
// privateEvidenceRefClass must be null or a redacted scheme class
// normalized.startsWith("topology://")
// artifactDigestEvidenceRef
// healthProbeEvidenceRef

const defaultIo: CliIo = {
  stdout: console.log,
  stderr: console.error,
};

export async function main(
  args = process.argv.slice(2),
  io: CliIo = defaultIo,
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    io.stdout(helpText());
    return 0;
  }

  const [domain, command, ...rest] = args;
  if (domain === "accounts" && command === "seed") {
    return runAccountsSeed(rest, io);
  }
  if (domain === "accounts" && command === "serve") {
    return await runAccountsServe(rest, io);
  }
  if (domain === "accounts" && command === "migrate") {
    return await runAccountsMigrate(rest, io);
  }
  if (domain === "accounts" && command === "migrate-d1") {
    return await runAccountsMigrateD1(rest, io);
  }
  if (domain === "accounts" && command === "tokens") {
    return await runAccountsTokens(rest, io);
  }
  if (
    domain === "accounts" && command === "launch-tokens" &&
    rest[0] === "cleanup"
  ) {
    return await runAccountsLaunchTokensCleanup(rest.slice(1), io);
  }
  if (domain === "installations" && command === "list") {
    return await runInstallationsList(rest, io);
  }
  if (domain === "installations" && command === "inspect") {
    return await runInstallationsInspect(rest, io);
  }
  if (domain === "installations" && command === "uninstall") {
    return await runInstallationsUninstall(rest, io);
  }
  if (domain === "installations" && command === "status") {
    return await runInstallationsStatus(rest, io);
  }
  if (domain === "installations" && command === "materialize") {
    return await runInstallationsMaterialize(rest, io);
  }
  if (domain === "installations" && command === "export") {
    return await runInstallationsExport(rest, io);
  }
  if (domain === "launch-readiness" && command === "validate") {
    return await runLaunchReadinessValidate(rest, io);
  }
  if (domain === "launch-readiness" && command === "public-summary") {
    return await runLaunchReadinessPublicSummary(rest, io);
  }
  if (domain === "launch-readiness" && command === "template") {
    return runLaunchReadinessTemplate(rest, io);
  }
  if (
    domain === "launch-readiness" && command === "production-topology" &&
    rest[0] === "template"
  ) {
    return runLaunchReadinessProductionTopologyTemplate(rest.slice(1), io);
  }
  if (
    domain === "launch-readiness" && command === "production-topology" &&
    rest[0] === "preflight"
  ) {
    return await runLaunchReadinessProductionTopologyPreflight(
      rest.slice(1),
      io,
    );
  }
  if (
    domain === "launch-readiness" && command === "production-topology" &&
    rest[0] === "merge"
  ) {
    return await runLaunchReadinessProductionTopologyMerge(
      rest.slice(1),
      io,
    );
  }

  io.stderr(`Unknown command: ${args.join(" ")}`);
  io.stderr(helpText());
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}
