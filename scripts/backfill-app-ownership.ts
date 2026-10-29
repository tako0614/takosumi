#!/usr/bin/env bun
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { applyAppOwnershipBackfill, planAppOwnershipBackfill, type OwnershipBackfillContext } from "../core/domains/app-ownership/backfill.ts";

/** The operator owns connection composition and verifies its Workspace mutation
 * freeze before returning workspaceMutationsFrozen: true for apply. This tool
 * never discovers credentials, assumes a freeze, or runs DDL. */
export async function runAppOwnershipBackfill(context: OwnershipBackfillContext, options: { readonly apply?: boolean; readonly expectedDigest?: string; readonly batchSize?: number }) {
  if (!options.apply) return { mode: "dry-run", ...await planAppOwnershipBackfill(context) };
  if (!options.expectedDigest) throw new Error("--apply requires --plan-digest from a reviewed dry-run");
  return { mode: "apply", ...await applyAppOwnershipBackfill(context, options.expectedDigest, options.batchSize) };
}

if (import.meta.main) {
  let adapter: string | undefined;
  let apply = false;
  let expectedDigest: string | undefined;
  let batchSize = 100;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--adapter=")) adapter = arg.slice(10);
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg.startsWith("--plan-digest=")) expectedDigest = arg.slice(14);
    else if (arg.startsWith("--batch-size=")) batchSize = Number(arg.slice(13));
    else throw new Error("Unknown backfill argument");
  }
  if (!adapter || !isAbsolute(adapter)) throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  const module = await import(pathToFileURL(adapter).href) as { openOwnershipBackfill(): Promise<OwnershipBackfillContext & { close?(): Promise<void> }> };
  const context = await module.openOwnershipBackfill();
  try {
    console.log(JSON.stringify(await runAppOwnershipBackfill(context, { apply, expectedDigest, batchSize }), null, 2));
  } finally { await context.close?.(); }
}
