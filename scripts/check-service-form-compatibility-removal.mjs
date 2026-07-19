#!/usr/bin/env bun

import {
  loadAndValidateRemovalEvidencePack,
  serviceFormRemovalRepoStatus,
} from "./lib/service-form-compatibility-removal.mjs";

export async function runServiceFormCompatibilityRemovalCheck(argv) {
  const [command = "repo", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (command === "repo") {
    if (rest.length !== 0) throw new Error("repo accepts no options");
    process.stdout.write(
      `${JSON.stringify(await serviceFormRemovalRepoStatus(), null, 2)}\n`,
    );
    return;
  }
  if (command !== "eligible") {
    throw new Error(`unknown command ${String(command)}`);
  }
  const options = parseEligibleArgs(rest);
  const result = await loadAndValidateRemovalEvidencePack(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseEligibleArgs(argv) {
  const inventoryPaths = [];
  let evidencePath;
  let takosumiProviderProofPath;
  let takoformMigrationEvidencePath;
  let rollbackArtifactManifestPath;
  const assignments = {
    "--evidence": (value) => {
      evidencePath = once(evidencePath, value, "--evidence");
    },
    "--inventory": (value) => inventoryPaths.push(value),
    "--takosumi-provider-proof": (value) => {
      takosumiProviderProofPath = once(
        takosumiProviderProofPath,
        value,
        "--takosumi-provider-proof",
      );
    },
    "--takoform-migration-evidence": (value) => {
      takoformMigrationEvidencePath = once(
        takoformMigrationEvidencePath,
        value,
        "--takoform-migration-evidence",
      );
    },
    "--rollback-artifacts": (value) => {
      rollbackArtifactManifestPath = once(
        rollbackArtifactManifestPath,
        value,
        "--rollback-artifacts",
      );
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const assign = assignments[option];
    if (!assign) throw new Error(`unknown option ${String(option)}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a path`);
    }
    assign(value);
    index += 1;
  }
  for (const [name, value] of [
    ["--evidence", evidencePath],
    ["--takosumi-provider-proof", takosumiProviderProofPath],
    ["--takoform-migration-evidence", takoformMigrationEvidencePath],
    ["--rollback-artifacts", rollbackArtifactManifestPath],
  ]) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (inventoryPaths.length === 0) {
    throw new Error("at least one --inventory report is required");
  }
  return {
    evidencePath,
    inventoryPaths,
    takosumiProviderProofPath,
    takoformMigrationEvidencePath,
    rollbackArtifactManifestPath,
  };
}

function once(current, value, option) {
  if (current) throw new Error(`${option} may be specified only once`);
  return value;
}

function helpText() {
  return `Usage:
  bun run service-form:compat-removal:check
  bun run service-form:compat-removal:eligible -- [options]

The repo check validates the public support policy and digest-pinned fixture
authority. It never claims that removal is eligible. The eligible command
fails closed unless every operator-private evidence input is complete.

Options for eligible:
  --evidence <path>                     Removal evidence closure
  --inventory <path>                    Redacted inventory report (repeatable)
  --takosumi-provider-proof <path>      Digest-sidecar provider proof
  --takoform-migration-evidence <path>  Complete migration lifecycle evidence
  --rollback-artifacts <path>           Digest-only rollback artifact manifest
`;
}

if (import.meta.main) {
  await runServiceFormCompatibilityRemovalCheck(process.argv.slice(2));
}
