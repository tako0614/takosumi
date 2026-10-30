#!/usr/bin/env bun
/**
 * Read-only check: every Capsule row, destroyed ones included, resolves to a
 * canonical artifact root (TASK-0118 Phase 9, stage 9.1-f). See
 * docs/operations/app-storage-roots.md.
 *
 * The operator module owns the connection (D1 REST transport, a Worker binding,
 * a Postgres client, or a local SQLite copy of an export for rehearsal) and
 * returns a target built with `d1CapsuleStorageRootCheckTarget` or
 * `sqlCapsuleStorageRootCheckTarget`. This tool never discovers credentials,
 * never writes and runs no DDL. It exits 1 when any row is unresolvable.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkCapsuleStorageRoots,
  type CapsuleStorageRootCheckTarget,
} from "../core/domains/capsules/storage_root_check.ts";

export async function runCapsuleStorageRootCheck(target: CapsuleStorageRootCheckTarget) {
  return await checkCapsuleStorageRoots(target);
}

if (import.meta.main) {
  let adapter: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--adapter=")) adapter = arg.slice(10);
    else throw new Error("Unknown storage root check argument");
  }
  if (!adapter || !isAbsolute(adapter)) {
    throw new Error("Use --adapter=/absolute/path/to/operator-module.ts");
  }
  const module = await import(pathToFileURL(adapter).href) as {
    openCapsuleStorageRootCheck(): Promise<{
      readonly target: CapsuleStorageRootCheckTarget;
      close?(): Promise<void>;
    }>;
  };
  const opened = await module.openCapsuleStorageRootCheck();
  try {
    const report = await runCapsuleStorageRootCheck(opened.target);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await opened.close?.();
  }
}
