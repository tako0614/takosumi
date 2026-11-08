/** Subprocess-only fixture: actual CLI/Core/crypto with an in-process PG dialect. */
import { mock } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlParameters } from "../../core/adapters/storage/sql.ts";
import { SqlOpenTofuControlStore } from "../../core/domains/deploy-control/store_sql.ts";
import { PGliteSqlClient } from "../helpers/deploy-control/pglite_sql_client.ts";
import { createLocalOperatorRecoveryFixture } from "../helpers/deploy-control/local_operator_recovery_fixture.ts";

const phase = async (name: string) => {
  if (!process.env.FIXTURE_PHASE_PATH) return;
  const birth = await readFile("/proc/self/stat", "utf8");
  await writeFile(process.env.FIXTURE_PHASE_PATH, JSON.stringify({ phase: name, at: new Date().toISOString(),
    pid: process.pid, birthTicks: birth.split(") ")[1]!.split(" ")[19] }) + "\n", { mode: 0o600 });
};
await phase("pglite-bootstrap");
const client = await PGliteSqlClient.create();
await phase("pglite-ready");
const store = new SqlOpenTofuControlStore({ client });
const f = await createLocalOperatorRecoveryFixture(store);
await phase("fixture-staged");
let closeCalls = 0;
class FixturePool {
  query(sql: string, values?: readonly unknown[]) { return client.query(sql, values as SqlParameters); }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async end() { closeCalls++; throw Error("synthetic close failure"); }
}
mock.module("pg", () => ({ default: { Pool: FixturePool }, Pool: FixturePool }));
process.env.TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR = f.input.approvalDirectory;
process.env.TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID = f.input.selectedTargetId;
process.env.TAKOSUMI_ACCOUNTS_DATABASE_URL = "postgres://fixture-only/not-a-network-connection";
process.env.TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR = join(f.root, "state");
process.env.TAKOSUMI_SECRET_STORE_PASSPHRASE = "synthetic-operator-recovery-test-key-at-least-32-bytes";
let commandExit = 0;
try {
  const { operatorStateRecoveryCommand } = await import("../../scripts/operator-state-recovery.ts");
  await phase("command-entry");
  try { await operatorStateRecoveryCommand(["--case", f.input.caseId]); }
  catch { console.error("local_state_recovery_refused"); process.exitCode = 1; }
  commandExit = process.exitCode ?? 0;
  await phase("command-returned");
  await writeFile(process.env.FIXTURE_TERMINAL_PATH!, JSON.stringify({ closeCalls,
    generation: (await store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration,
    failedStatus: (await store.getApplyRun(f.failed.id))?.status }) + "\n", { mode: 0o600 });
} finally {
  await phase("closing-fixture-pglite");
  await client.close();
  await phase("fixture-pglite-closed");
  await rm(f.root, { recursive: true, force: true });
  // WASM fixture disposal is not the command's terminal status authority.
  process.exitCode = commandExit;
}
