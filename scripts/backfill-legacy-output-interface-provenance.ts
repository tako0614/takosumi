#!/usr/bin/env bun
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyLegacyOutputInterfaceProvenance,
  planLegacyOutputInterfaceProvenance,
  type LegacyOutputProvenanceContext,
} from "../core/domains/interfaces/legacy_output_provenance.ts";

/**
 * One-time, operator-run backfill (TASK-0118 9.1): records `createdUnder:
 * "operator"` on Interfaces the legacy Output migration created before writes
 * were recorded. Dry-run by default; apply needs the reviewed plan digest. The
 * operator adapter composes the Control store and the Interface store (memory,
 * Postgres or D1) without running DDL or migrations (a D1 Control store opened
 * in `bootstrap` mode is refused); this tool never discovers credentials.
 */
export async function runLegacyOutputInterfaceProvenance(
  context: LegacyOutputProvenanceContext,
  options: { readonly apply?: boolean; readonly expectedDigest?: string },
) {
  // The adapter must open the Control store without running DDL: a D1 store
  // reports its schema mode, and only `predeployed` is accepted.
  const schemaMode = (context.control as { readonly schemaMode?: unknown }).schemaMode;
  if (schemaMode !== undefined && schemaMode !== "predeployed") {
    throw new Error('Open the D1 Control store with { schemaMode: "predeployed" }: this backfill never runs DDL');
  }
  if (!options.apply) return { mode: "dry-run", ...await planLegacyOutputInterfaceProvenance(context) };
  if (!options.expectedDigest) throw new Error("--apply requires --plan-digest from a reviewed dry-run");
  return { mode: "apply", ...await applyLegacyOutputInterfaceProvenance(context, options.expectedDigest) };
}

if (import.meta.main) {
  let adapter: string | undefined;
  let apply = false;
  let expectedDigest: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--adapter=")) adapter = arg.slice(10);
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg.startsWith("--plan-digest=")) expectedDigest = arg.slice(14);
    else throw new Error("Unknown backfill argument");
  }
  if (!adapter || !isAbsolute(adapter)) throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  const module = await import(pathToFileURL(adapter).href) as {
    openLegacyOutputInterfaceProvenance(): Promise<LegacyOutputProvenanceContext & { close?(): Promise<void> }>;
  };
  const context = await module.openLegacyOutputInterfaceProvenance();
  try {
    console.log(JSON.stringify(await runLegacyOutputInterfaceProvenance(context, { apply, expectedDigest }), null, 2));
  } finally { await context.close?.(); }
}
