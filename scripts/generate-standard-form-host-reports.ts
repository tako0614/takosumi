#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  closeSignedStandardFormHostCandidate,
  generateStandardFormHostReports,
  loadExactStandardFormHostEntries,
} from "./lib/standard-form-host-report-candidate.ts";

const [command = "generate", ...values] = process.argv.slice(2);
const args = parseArgs(values);

if (command === "generate") {
  const takosumiRoot = resolve(import.meta.dir, "..");
  const takoformRoot = resolve(required(args, "takoform-root"));
  const takosumiCommit = required(args, "takosumi-commit");
  const takoformCommit = required(args, "takoform-commit");
  await assertExactCheckout(takosumiRoot, takosumiCommit, "Takosumi");
  await assertExactCheckout(takoformRoot, takoformCommit, "Takoform");
  const entries = await loadExactStandardFormHostEntries({ takoformRoot });
  await generateStandardFormHostReports({
    entries,
    outputDir: required(args, "output-dir"),
    takosumiRoot,
    takoformRoot,
    takosumiCommit,
    takoformCommit,
  });
  process.stdout.write("generated 10 source-conformance host reports\n");
} else if (command === "close-signed") {
  await closeSignedStandardFormHostCandidate({
    candidateDir: required(args, "candidate-dir"),
    workflowRunId: required(args, "workflow-run-id"),
    workflowRunAttempt: required(args, "workflow-run-attempt"),
  });
  process.stdout.write("closed signed host-report candidate\n");
} else {
  throw new TypeError(
    "usage: generate --takoform-root DIR --takosumi-commit SHA --takoform-commit SHA --output-dir DIR | close-signed --candidate-dir DIR --workflow-run-id ID --workflow-run-attempt 1",
  );
}

function parseArgs(input: readonly string[]): Record<string, string> {
  if (input.length % 2 !== 0)
    throw new TypeError("arguments must be key/value pairs");
  const result: Record<string, string> = {};
  for (let index = 0; index < input.length; index += 2) {
    const key = input[index];
    const value = input[index + 1];
    if (!key?.startsWith("--") || !value || result[key.slice(2)]) {
      throw new TypeError("arguments must be unique --key value pairs");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function required(args: Readonly<Record<string, string>>, key: string): string {
  const value = args[key];
  if (!value) throw new TypeError(`--${key} is required`);
  return value;
}

async function assertExactCheckout(
  root: string,
  expectedCommit: string,
  label: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new TypeError(`${label} commit must be lowercase 40-hex`);
  }
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  if (head !== expectedCommit) {
    throw new Error(`${label} checkout is ${head}, want ${expectedCommit}`);
  }
  const dirty = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]).trim();
  if (dirty !== "") throw new Error(`${label} tracked checkout is dirty`);
}

function runGit(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout);
}
