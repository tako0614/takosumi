#!/usr/bin/env bun

import process from "node:process";

import {
  finalizeProviderReleaseApproval,
  verifyProviderReleaseApproval,
} from "./lib/provider-release-approval.ts";

if (import.meta.main) {
  const code = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(code);
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (command === "finalize") {
    requireOnly(options, [
      "candidate",
      "subject",
      "bundle",
      "workflow-run-id",
      "output",
      "verified-at",
    ]);
    const approval = await finalizeProviderReleaseApproval({
      candidateManifestPath: required(options, "candidate"),
      subjectPath: required(options, "subject"),
      bundlePath: required(options, "bundle"),
      workflowRunId: required(options, "workflow-run-id"),
      outputPath: required(options, "output"),
      verifiedAt: options.get("verified-at"),
    });
    console.log(JSON.stringify(approval));
    return 0;
  }
  if (command === "verify") {
    requireOnly(options, ["approval", "candidate", "subject", "bundle"]);
    const approval = await verifyProviderReleaseApproval({
      approvalPath: required(options, "approval"),
      candidateManifestPath: required(options, "candidate"),
      subjectPath: required(options, "subject"),
      bundlePath: required(options, "bundle"),
    });
    console.log(JSON.stringify(approval));
    return 0;
  }
  throw new Error(
    "usage: bun scripts/provider-release-approval.ts <finalize|verify> [options]",
  );
}

function parseOptions(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !option?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        `invalid provider approval option near ${option ?? "<end>"}`,
      );
    }
    const name = option.slice(2);
    if (options.has(name)) throw new Error(`duplicate option --${name}`);
    options.set(name, value);
  }
  return options;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requireOnly(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`unknown option --${name}`);
  }
}
