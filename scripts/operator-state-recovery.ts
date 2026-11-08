#!/usr/bin/env bun
/** Explicit local operator action; never starts the service or a runner. */
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PartitionedSecretBoundaryCrypto, selectSecretBoundaryCrypto } from "../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../core/adapters/storage/artifact-references.ts";
import { SqlOpenTofuControlStore } from "../core/domains/deploy-control/store_sql.ts";
import type { CommitRecoveredStateResult } from "../core/domains/deploy-control/operator_state_recovery.ts";
import { createFileOpenTofuStateArtifactStore } from "../deploy/node-postgres/src/local-opentofu-runner.ts";
import { LocalOpenTofuStateRecoveryArtifactStore } from "../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import { createPostgresPool, wrapServiceSqlClient } from "../deploy/node-postgres/src/postgres-runtime.ts";
import {
  checkLocalStateRecoveryApproval,
  commitApprovedLocalStateRecovery,
  LocalStateRecoveryRefusal,
} from "./lib/local-operator-state-recovery.ts";

const USAGE = "bun --no-env-file scripts/operator-state-recovery.ts --case <approved-case-id>";

export async function operatorStateRecoveryCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { console.log(USAGE); return; }
  if (args.length !== 2 || args[0] !== "--case") throw new LocalStateRecoveryRefusal();
  const env = { ...process.env };
  const approvalDirectory = env.TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR;
  const selectedTargetId = env.TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID;
  const databaseUrl = env.TAKOSUMI_ACCOUNTS_DATABASE_URL;
  const stateRoot = env.TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR;
  if (!approvalDirectory || !selectedTargetId || !databaseUrl || !stateRoot || !isAbsolute(stateRoot)) {
    throw new LocalStateRecoveryRefusal();
  }
  const selection = { approvalDirectory, selectedTargetId, caseId: args[1]!,
    sourceRoots: [resolve(dirname(fileURLToPath(import.meta.url)), "..")] };
  // No SQL pool, key readback or artifact access before explicit case approval.
  await checkLocalStateRecoveryApproval(selection);
  const crypto = selectSecretBoundaryCrypto({ env });
  if (!(crypto instanceof PartitionedSecretBoundaryCrypto)) throw new LocalStateRecoveryRefusal();
  const pool = createPostgresPool({ databaseUrl }, env);
  let result: CommitRecoveredStateResult;
  let closeFailed = false;
  try {
    const store = new SqlOpenTofuControlStore({ client: wrapServiceSqlClient(pool) });
    const verifier = new LocalOpenTofuStateRecoveryArtifactStore({ store: createFileOpenTofuStateArtifactStore(stateRoot, crypto),
      allocator: new ObjectKeyArtifactReferenceAllocator(), capsules: store });
    result = await commitApprovedLocalStateRecovery({ ...selection, store, verifier });
  } finally {
    try { await pool.end(); } catch {
      closeFailed = true;
      console.error("local_state_recovery_connection_close_failed");
      process.exitCode = 1;
    }
  }
  const recovery = result.status === "conflict" ? { status: "conflict" } : {
    status: result.status, recoveryRunId: result.run.id,
    stateVersionId: result.stateVersion.id, capsuleId: result.capsule.id,
  };
  // Publish only after the close attempt. A known commit survives cleanup
  // failure; command completion and the database outcome are separate facts.
  console.log(JSON.stringify({ status: closeFailed ? "connection_close_failed" :
    result.status === "conflict" ? "conflict" : "completed", recovery }));
  if (result.status === "conflict") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  operatorStateRecoveryCommand(process.argv.slice(2)).catch(() => {
    // The caller retains private diagnostics; never print a DSN, key, handle,
    // profile contents, state bytes or an unfiltered database exception.
    console.error("local_state_recovery_refused");
    process.exitCode = 1;
  });
}
