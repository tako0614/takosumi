/** Negative subprocess fixture: a missing approval must precede any PG access. */
import { mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(homedir(), ".takosumi-unapproved-recovery-test-"));
const approvals = join(root, "approvals");
await mkdir(approvals, { mode: 0o700 });
const observed = { pools: 0, queries: 0, closes: 0 };
class NeverOpenedPool {
  constructor() { observed.pools++; }
  async query() { observed.queries++; throw Error("unexpected fixture SQL access"); }
  async connect() { observed.queries++; throw Error("unexpected fixture SQL connection"); }
  async end() { observed.closes++; }
}
mock.module("pg", () => ({ default: { Pool: NeverOpenedPool }, Pool: NeverOpenedPool }));
process.env.TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR = approvals;
process.env.TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID = "fixture-target";
process.env.TAKOSUMI_ACCOUNTS_DATABASE_URL = "postgres://fixture-user:fixture-password@127.0.0.1:1/not-connected";
process.env.TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR = join(root, "not-created-state");
process.env.TAKOSUMI_SECRET_STORE_PASSPHRASE = "synthetic-operator-recovery-test-key-at-least-32-bytes";
try {
  const { operatorStateRecoveryCommand } = await import("../../scripts/operator-state-recovery.ts");
  try { await operatorStateRecoveryCommand(["--case", "missing"]); }
  catch { console.error("local_state_recovery_refused"); process.exitCode = 1; }
  await writeFile(process.env.FIXTURE_TERMINAL_PATH!, JSON.stringify(observed) + "\n", { mode: 0o600 });
} finally { await rm(root, { recursive: true, force: true }); }
