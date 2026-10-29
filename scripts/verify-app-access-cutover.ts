#!/usr/bin/env bun
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { OwnershipBackfillContext } from "../core/domains/app-ownership/backfill.ts";
import { planAppAccessCutoverDiff, type AccessCutoverReport } from "../core/domains/app-ownership/access-cutover-diff.ts";

/**
 * Read-only Phase 6b gate. Uses the same operator adapter module as
 * backfill-app-ownership.ts (`openOwnershipBackfill()`), never writes, never
 * discovers targets or credentials, and needs no mutation freeze.
 */
export async function runAppAccessCutoverVerification(
  context: Pick<OwnershipBackfillContext, "control" | "ownership">,
): Promise<AccessCutoverReport> {
  return await planAppAccessCutoverDiff(context);
}

if (import.meta.main) {
  let adapter: string | undefined;
  let failOnDifference = false;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--adapter=")) adapter = arg.slice(10);
    else if (arg === "--fail-on-difference") failOnDifference = true;
    else throw new Error("Unknown verification argument");
  }
  if (!adapter || !isAbsolute(adapter)) throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  const module = await import(pathToFileURL(adapter).href) as {
    openOwnershipBackfill(): Promise<OwnershipBackfillContext & { close?(): Promise<void> }>;
  };
  const context = await module.openOwnershipBackfill();
  let report: AccessCutoverReport;
  try {
    report = await runAppAccessCutoverVerification(context);
  } finally { await context.close?.(); }
  console.log(JSON.stringify(report, null, 2));
  if (failOnDifference && report.differenceCount > 0) process.exitCode = 1;
}
