import assert from "node:assert/strict";
import { createRetentionAdapter } from "./refresh-retention-adapters.ts";
import { runScheduledAccountsRefreshChainRetention } from "../../../../deploy/platform/worker.ts";
import { readD1RefreshRetentionCheckpoint } from "../../../../accounts/service/src/refresh-chain-retention-d1.ts";
import type { D1Database, D1ExecResult, D1PreparedStatement, D1Result, D1Value } from "../../../../accounts/service/src/d1-store.ts";

class CheckpointGate {
  armed = true;
  loseAckNext = false;
  readonly reached: Promise<void>;
  readonly released: Promise<void>;
  #reach!: () => void;
  #release!: () => void;
  constructor() {
    this.reached = new Promise(resolve => { this.#reach = resolve; });
    this.released = new Promise(resolve => { this.#release = resolve; });
  }
  async pause() {
    if (!this.armed) return;
    this.armed = false;
    this.#reach();
    await this.released;
  }
  release() { this.#release(); }
  complete<T>(result: T): T {
    if (this.loseAckNext) {
      this.loseAckNext = false;
      throw new Error("isolated checkpoint acknowledgement lost");
    }
    return result;
  }
}

class GatedStatement implements D1PreparedStatement {
  constructor(readonly statement: D1PreparedStatement, readonly gate: CheckpointGate) {}
  bind(...values: readonly D1Value[]): D1PreparedStatement { return new GatedStatement(this.statement.bind(...values), this.gate); }
  async run(): Promise<D1Result> { await this.gate.pause(); return this.gate.complete(await this.statement.run()); }
  async first<T>(): Promise<T | null> { await this.gate.pause(); return this.gate.complete(await this.statement.first<T>()); }
  async all<T>(): Promise<D1Result<T>> { await this.gate.pause(); return this.gate.complete(await this.statement.all<T>()); }
}

class PredeployedDatabase implements D1Database {
  ddlAttempts = 0;
  constructor(readonly inner: D1Database, readonly gate?: CheckpointGate) {}
  prepare(sql: string): D1PreparedStatement {
    if (/^\s*(?:CREATE|ALTER|DROP|PRAGMA)\b/iu.test(sql)) { this.ddlAttempts += 1; throw new Error("runtime DDL refused"); }
    const statement = this.inner.prepare(sql);
    return this.gate && /^\s*INSERT\b/iu.test(sql) && sql.includes("'maintenance_cursors'")
      ? new GatedStatement(statement, this.gate) : statement;
  }
  batch<T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> { return this.inner.batch<T>(statements); }
  exec(_sql: string): Promise<D1ExecResult> { this.ddlAttempts += 1; return Promise.reject(new Error("runtime exec refused")); }
}

const scenario = process.argv[2];
assert(["held-progress", "checkpoint-failure", "lost-ack", "overlap"].includes(scenario!));
const fixture = await createRetentionAdapter("d1");
assert(fixture.d1);
const { store, d1: db } = fixture;
const originalNow = Date.now;
let clock = originalNow();
const issuedAt = clock;
const DAY = 24 * 60 * 60 * 1_000;
Date.now = () => clock;
try {
  // One page-budget crossing: 100 tiny live rows, then one expired link.
  // These are disposable local rows; no external user/provider is contacted.
  for (let index = 0; index < 100; index += 1) {
    const parent = `held-parent-${index}`;
    await store.saveRefreshToken(parent, { clientId: "fixture-client", subject: "fixture-subject", scope: "openid", expiresAt: issuedAt + 60 * DAY });
    assert(await store.addRefreshChainLink(parent, `held-child-${index}`));
  }
  clock += 1;
  assert(await store.addRefreshChainLink("expired-parent", "expired-child"));
  clock = issuedAt + 31 * DAY;
  const gate = scenario === "overlap" || scenario === "lost-ack" ? new CheckpointGate() : undefined;
  if (scenario === "lost-ack") gate!.armed = false;
  const runtimeDb = new PredeployedDatabase(db, gate);
  const tick = () => runScheduledAccountsRefreshChainRetention({ TAKOSUMI_ACCOUNTS_DB: runtimeDb, TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed" });
  if (gate && scenario === "overlap") {
    const stale = tick();
    await Promise.race([gate.reached, stale.then(() => { throw new Error("old tick did not reach the checkpoint gate"); })]);
    const second = await tick();
    assert.equal(second.scanned, 100);
    assert.equal(second.chainLinks, 0);
    const third = await tick();
    assert.equal(third.chainLinks, 1);
    assert.equal(third.done, true);
    const advanced = await readD1RefreshRetentionCheckpoint(db);
    assert.deepEqual(advanced, { generation: 2 });
    gate.release();
    assert.equal((await stale).failures, 0);
    assert.deepEqual(await readD1RefreshRetentionCheckpoint(db), advanced);
  } else {
    const first = await tick();
    assert.equal(first.failures, 0);
    assert.equal(first.scanned, 100);
    assert.equal(first.chainLinks, 0);
    assert.equal(first.done, false);
    const checkpoint = await readD1RefreshRetentionCheckpoint(db);
    assert.equal(checkpoint.generation, 1);
    assert(checkpoint.cursor);
    if (scenario === "lost-ack") {
      gate!.loseAckNext = true;
      assert.equal((await tick()).failures, 1);
      // The write really committed even though its acknowledgement was lost.
      assert.deepEqual(await readD1RefreshRetentionCheckpoint(db), { generation: 2 });
      assert.equal(await store.getRefreshChainChild("expired-parent"), undefined);
      const restarted = await tick();
      assert.equal(restarted.failures, 0);
      assert.equal(restarted.scanned, 100);
      assert.equal(restarted.done, false);
      assert.equal((await tick()).done, true);
      assert.deepEqual(await readD1RefreshRetentionCheckpoint(db), { generation: 4 });
    } else {
      if (scenario === "checkpoint-failure") {
        // Fault setup and removal use only the fixture-owned SQLite database;
        // the actual predeployed runtime remains behind the no-DDL wrapper.
        await db.exec(`CREATE TRIGGER isolated_checkpoint_failure BEFORE UPDATE ON takosumi_accounts_documents
          WHEN OLD.bucket = 'maintenance_cursors' AND OLD.key = 'refresh-chain-retention'
          BEGIN SELECT RAISE(ABORT, 'isolated checkpoint failure'); END;`);
        assert.equal((await tick()).failures, 1);
        assert.deepEqual(await readD1RefreshRetentionCheckpoint(db), checkpoint);
        assert.equal(await store.getRefreshChainChild("expired-parent"), undefined);
        await db.exec("DROP TRIGGER isolated_checkpoint_failure;");
      }
      const resumed = await tick();
      assert.equal(resumed.failures, 0);
      assert.equal(resumed.done, true);
      assert.equal(resumed.chainLinks, scenario === "checkpoint-failure" ? 0 : 1);
      assert.deepEqual(await readD1RefreshRetentionCheckpoint(db), { generation: 2 });
    }
  }
  assert.equal(await store.getRefreshChainChild("expired-parent"), undefined);
  assert(await store.getRefreshChainChild("held-parent-0"));
  assert.equal(runtimeDb.ddlAttempts, 0);
  console.log(JSON.stringify({ scenario, pass: true, heldRowRetained: true, expiredRowCollected: true,
    runtimeDdl: 0, checkpointGeneration: (await readD1RefreshRetentionCheckpoint(db)).generation }));
} finally {
  Date.now = originalNow;
  await fixture.close();
}
