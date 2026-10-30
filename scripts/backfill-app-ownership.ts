#!/usr/bin/env bun
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { applyAppOwnershipBackfill, planAppOwnershipBackfill, type OwnershipBackfillContext } from "../core/domains/app-ownership/backfill.ts";

/**
 * Optional read for the dry-run: an app's Capsule-owned Interfaces that are
 * not its own records (TASK-0118 9.1). They are never the app's evidence;
 * the dry-run lists them for the new owner's review. Not part of the digest.
 */
export interface OwnershipBackfillInterfaceReview {
  listInterfacesNeedingReview(workspaceId: string, capsuleId: string): Promise<readonly { readonly metadata: { readonly id: string } }[]>;
}

/** The operator owns connection composition and verifies its Workspace mutation
 * freeze before returning workspaceMutationsFrozen: true for apply. This tool
 * never discovers credentials, assumes a freeze, or runs DDL. */
export async function runAppOwnershipBackfill(
  context: OwnershipBackfillContext & { readonly interfaces?: OwnershipBackfillInterfaceReview },
  options: { readonly apply?: boolean; readonly expectedDigest?: string; readonly batchSize?: number },
) {
  if (!options.apply) {
    const plan = await planAppOwnershipBackfill(context);
    if (!context.interfaces) return { mode: "dry-run", ...plan };
    // Apps that get their first owner: Interfaces written for them under
    // Workspace authority (or manually, unrecorded) wait for that owner.
    const interfacesNeedingReview: { capsuleId: string; interfaceIds: string[] }[] = [];
    for (const write of plan.writes) {
      if (write.kind !== "ownership") continue;
      const capsule = await context.control.getCapsule(write.record.capsuleId);
      if (!capsule) continue;
      const needing = await context.interfaces.listInterfacesNeedingReview(capsule.workspaceId, capsule.id);
      if (needing.length > 0) {
        interfacesNeedingReview.push({ capsuleId: capsule.id, interfaceIds: needing.map((iface) => iface.metadata.id) });
      }
    }
    return { mode: "dry-run", ...plan, interfacesNeedingReview };
  }
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
