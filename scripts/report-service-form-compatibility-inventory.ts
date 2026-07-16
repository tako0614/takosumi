#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildServiceFormCompatibilityInventory,
  readCompatibilityInventoryInputs,
  stableCompatibilityInventoryJson,
} from "./lib/service-form-compatibility-inventory.ts";

export async function runServiceFormCompatibilityInventoryCli(
  argv: readonly string[],
): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const inputs = await readCompatibilityInventoryInputs({
    statePaths: options.statePaths,
    lockPaths: options.lockPaths,
  });
  const output = stableCompatibilityInventoryJson(
    buildServiceFormCompatibilityInventory(inputs),
  );
  if (options.outputPath) {
    await writeFile(resolve(options.outputPath), output, { flag: "wx" });
    return;
  }
  process.stdout.write(output);
}

interface CliOptions {
  readonly statePaths: readonly string[];
  readonly lockPaths: readonly string[];
  readonly outputPath?: string;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const statePaths: string[] = [];
  const lockPaths: string[] = [];
  let outputPath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      help = true;
      continue;
    }
    if (option === "--state" || option === "--lock" || option === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new TypeError(`${option} requires a path`);
      }
      index += 1;
      if (option === "--state") statePaths.push(value);
      if (option === "--lock") lockPaths.push(value);
      if (option === "--output") {
        if (outputPath)
          throw new TypeError("--output may be specified only once");
        outputPath = value;
      }
      continue;
    }
    throw new TypeError(`unknown option ${String(option)}`);
  }

  if (!help && statePaths.length === 0 && lockPaths.length === 0) {
    throw new TypeError("at least one --state or --lock input is required");
  }
  return {
    statePaths,
    lockPaths,
    ...(outputPath ? { outputPath } : {}),
    help,
  };
}

function helpText(): string {
  return (
    `Usage: bun run service-form:compat-inventory -- [options]\n\n` +
    `Options:\n` +
    `  --state <path>   Terraform/OpenTofu state file (repeatable)\n` +
    `  --lock <path>    .terraform.lock.hcl file (repeatable)\n` +
    `  --output <path>  Create a new redacted JSON report (refuses overwrite)\n` +
    `  --help           Show this help\n`
  );
}

if (import.meta.main) {
  await runServiceFormCompatibilityInventoryCli(process.argv.slice(2));
}
