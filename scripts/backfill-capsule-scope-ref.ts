#!/usr/bin/env bun
/**
 * Operator backfill: freeze each Capsule's `scopeRef` to its current Workspace
 * id (TASK-0118 Phase 9, stage 9.0). See
 * docs/operations/capsule-scope-ref-backfill.md.
 *
 * The operator module owns the connection (D1 REST transport, a Worker binding,
 * a Postgres client, or a local SQLite copy of an export for rehearsal) and
 * returns a target built with `d1CapsuleScopeRefBackfillTarget` or
 * `sqlCapsuleScopeRefBackfillTarget`. This tool never discovers credentials and
 * runs no DDL. The default is a read-only dry-run; `--apply` writes only the
 * reviewed plan (`--plan-digest`).
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyCapsuleScopeRefBackfill,
  planCapsuleScopeRefBackfill,
  type CapsuleScopeRefBackfillTarget,
} from "../core/domains/capsules/scope_ref_backfill.ts";

export async function runCapsuleScopeRefBackfill(
  target: CapsuleScopeRefBackfillTarget,
  options: { readonly apply?: boolean; readonly expectedDigest?: string },
) {
  if (!options.apply) {
    const plan = await planCapsuleScopeRefBackfill(target);
    return { mode: "dry-run" as const, ...plan, writes: plan.writes.length, writeIds: plan.writes.map((write) => write.capsuleId) };
  }
  if (!options.expectedDigest) {
    throw new Error("--apply requires --plan-digest from a reviewed dry-run");
  }
  return {
    mode: "apply" as const,
    ...await applyCapsuleScopeRefBackfill(target, options.expectedDigest),
  };
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
  if (!adapter || !isAbsolute(adapter)) {
    throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  }
  const module = await import(pathToFileURL(adapter).href) as {
    openCapsuleScopeRefBackfill(): Promise<{
      readonly target: CapsuleScopeRefBackfillTarget;
      close?(): Promise<void>;
    }>;
  };
  const opened = await module.openCapsuleScopeRefBackfill();
  try {
    console.log(JSON.stringify(
      await runCapsuleScopeRefBackfill(opened.target, { apply, expectedDigest }),
      null,
      2,
    ));
  } finally {
    await opened.close?.();
  }
}
