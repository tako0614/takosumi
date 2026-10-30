#!/usr/bin/env bun
/**
 * Operator tool: bake each Workspace policy into the InstallConfig policies of
 * its apps by the strictest merge (TASK-0118 Phase 9, P9.1-g). See
 * docs/operations/workspace-policy-bake.md.
 *
 * The operator module owns the connection (a Cloudflare D1 Control store over
 * the REST transport or a binding, a Postgres store, or a local SQLite copy of
 * an export for rehearsal) and returns a store. This tool never discovers
 * credentials and runs no DDL: a D1 store must be built with
 * `{ schemaMode: "predeployed" }` (a bootstrap store is refused). The default
 * is a read-only dry-run; `--apply` writes only the reviewed plan
 * (`--plan-digest`). The JSON summary is printed even when some apps fail.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyWorkspacePolicyBake,
  planWorkspacePolicyBake,
  type WorkspacePolicyBakeStore,
} from "../core/domains/deploy-control/workspace_policy_bake.ts";
import { CloudflareD1OpenTofuControlStore } from "../worker/src/d1_opentofu_store.ts";

/**
 * A D1 Control store in its default `bootstrap` mode creates and migrates the
 * schema on first access, so even the dry-run would write. The tool accepts
 * only `{ schemaMode: "predeployed" }`, which verifies the deployed schema.
 */
export function assertReadOnlySchemaStore(store: WorkspacePolicyBakeStore): void {
  if (
    store instanceof CloudflareD1OpenTofuControlStore &&
    store.schemaMode !== "predeployed"
  ) {
    throw new Error(
      'Refusing a D1 Control store in bootstrap mode: construct it with { schemaMode: "predeployed" }',
    );
  }
}

export async function runWorkspacePolicyBake(
  store: WorkspacePolicyBakeStore,
  options: { readonly apply?: boolean; readonly expectedDigest?: string },
) {
  assertReadOnlySchemaStore(store);
  if (!options.apply) {
    return { mode: "dry-run" as const, ...await planWorkspacePolicyBake(store) };
  }
  if (!options.expectedDigest) {
    throw new Error("--apply requires --plan-digest from a reviewed dry-run");
  }
  return {
    mode: "apply" as const,
    ...await applyWorkspacePolicyBake(store, options.expectedDigest),
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
    else throw new Error("Unknown workspace policy bake argument");
  }
  if (!adapter || !isAbsolute(adapter)) {
    throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  }
  const module = await import(pathToFileURL(adapter).href) as {
    openWorkspacePolicyBake(): Promise<{
      readonly store: WorkspacePolicyBakeStore;
      close?(): Promise<void>;
    }>;
  };
  const opened = await module.openWorkspacePolicyBake();
  try {
    console.log(JSON.stringify(
      await runWorkspacePolicyBake(opened.store, { apply, expectedDigest }),
      null,
      2,
    ));
  } finally {
    await opened.close?.();
  }
}
