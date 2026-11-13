import { expect, test } from "bun:test";
import { passkeyAdapter } from "../fixtures/passkey-challenge-adapters.ts";
import { passkeyChallengeKey } from "../../../../accounts/service/src/passkey-challenge-store.ts";
import { PASSKEY_CHALLENGE_TTL_MS, passkeyChallengeAdmissionPolicy } from "../../../../accounts/service/src/passkey-challenge-policy.ts";
import { D1AccountsStore, type D1PreparedStatement } from "../../../../accounts/service/src/d1-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
async function challenge(index: number, at = now, maxPerWindow = 2) {
  const value = index.toString(16).padStart(43, "A");
  return {
    key: await passkeyChallengeKey({ subject: "tsub_fixture", sessionId: null,
      intent: "authenticate", challenge: value }),
    challenge: value, now: at, expiresAt: at + PASSKEY_CHALLENGE_TTL_MS, maxPerWindow,
  };
}

for (const backend of ["memory", "d1", "postgres"] as const) {
  test(`${backend} delayed old-window admission cannot recreate a quota reclaimed by newer maintenance`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      const a = await challenge(201); const b = await challenge(202); const delayed = await challenge(203);
      expect(await adapter.store.admitPasskeyChallenge(a)).toBe(true);
      expect(await adapter.store.admitPasskeyChallenge(b)).toBe(true);
      // The request's time was captured before await; newer maintenance has
      // already crossed the window while these challenges remain live.
      await adapter.store.prunePasskeyChallenges({ now: now + 60_000 });
      expect(await adapter.store.admitPasskeyChallenge(delayed)).toBe(false);
      expect(await adapter.store.consumePasskeyChallenge(a.key, now + 60_000)).toBe(a.challenge);
      expect(await adapter.store.admitPasskeyChallenge(await challenge(204, now + 60_000))).toBe(true);
    } finally { await adapter.close(); }
  }, 30_000);

  test(`${backend} repeated windows reclaim abandoned rows within the small fixed cohort`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      for (let window = 0; window < 12; window++) {
        const at = now + window * 60_000;
        expect(await adapter.store.admitPasskeyChallenge(await challenge(100 + window * 3, at))).toBe(true);
        expect(await adapter.store.admitPasskeyChallenge(await challenge(101 + window * 3, at))).toBe(true);
        expect(await adapter.store.admitPasskeyChallenge(await challenge(102 + window * 3, at))).toBe(false);
        if ("d1" in adapter && adapter.d1) {
          const row = await adapter.d1.prepare(`SELECT COUNT(*) AS count FROM takosumi_accounts_documents
            WHERE bucket = 'passkey_challenges'`).first<{ count: number }>();
          expect(row!.count).toBeLessThanOrEqual(13);
        } else if ("postgres" in adapter && adapter.postgres) {
          const result = await adapter.postgres.query<{ count: number }>(
            "SELECT COUNT(*)::integer AS count FROM accounts_v1.passkey_challenges",
          );
          expect(result.rows[0]!.count).toBeLessThanOrEqual(13);
        }
      }
      const result = await adapter.store.prunePasskeyChallenges({ now: now + 17 * 60_000 });
      expect(result.deleted).toBeGreaterThan(0);
      if ("d1" in adapter && adapter.d1) {
        expect((await adapter.d1.prepare(`SELECT COUNT(*) AS count FROM takosumi_accounts_documents
          WHERE bucket = 'passkey_challenges'`).first<{ count: number }>())!.count).toBe(0);
      } else if ("postgres" in adapter && adapter.postgres) {
        expect((await adapter.postgres.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM accounts_v1.passkey_challenges WHERE challenge_key <> 'passkey:window:v1'",
        )).rows[0]!.count).toBe(0);
        expect((await adapter.postgres.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM accounts_v1.passkey_challenges WHERE challenge_key = 'passkey:window:v1'",
        )).rows[0]!.count).toBe(1);
      }
    } finally { await adapter.close(); }
  }, 30_000);

  test(`${backend} malformed quota is held and cannot authorize a new challenge`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      const input = await challenge(91);
      const policy = passkeyChallengeAdmissionPolicy(input);
      await adapter.store.savePasskeyChallenge(policy.key, "unknown-count", policy.expiresAt);
      expect(await adapter.store.admitPasskeyChallenge(input)).toBe(false);
      expect(await adapter.store.consumePasskeyChallenge(input.key, now)).toBeUndefined();
      expect(await adapter.store.admitPasskeyChallenge({ ...input, now: now + 60_000 })).toBe(true);
    } finally { await adapter.close(); }
  }, 30_000);

  test(`${backend} passkey admission bounds writes and resets the window without losing live challenges`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      const a = await challenge(1); const b = await challenge(2); const c = await challenge(3);
      expect(await adapter.store.admitPasskeyChallenge(a)).toBe(true);
      expect(await adapter.store.admitPasskeyChallenge(b)).toBe(true);
      expect(await adapter.store.admitPasskeyChallenge(c)).toBe(false);
      expect(await adapter.store.consumePasskeyChallenge(c.key, now)).toBeUndefined();
      expect(await adapter.store.admitPasskeyChallenge({ ...c, now: now + 60_000 })).toBe(true);
      expect(await adapter.store.consumePasskeyChallenge(a.key, now + 60_000)).toBe(a.challenge);
      expect(await adapter.store.consumePasskeyChallenge(a.key, now + 60_000)).toBeUndefined();
      expect(await adapter.store.consumePasskeyChallenge(b.key, b.expiresAt)).toBeUndefined();
    } finally { await adapter.close(); }
  }, 30_000);

  test(`${backend} passkey duplicate insert does not consume issuance quota`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      const a = await challenge(11); const b = await challenge(12); const c = await challenge(13);
      expect(await adapter.store.admitPasskeyChallenge(a)).toBe(true);
      await expect(Promise.resolve().then(() => adapter.store.admitPasskeyChallenge(a))).rejects.toThrow();
      expect(await adapter.store.admitPasskeyChallenge(b)).toBe(true);
      expect(await adapter.store.admitPasskeyChallenge(c)).toBe(false);
    } finally { await adapter.close(); }
  }, 30_000);

  test(`${backend} bounded passkey sweep advances past held rows and preserves live or unknown expiry`, async () => {
    const adapter = await passkeyAdapter(backend);
    try {
      await adapter.store.savePasskeyChallenge("a-live", "live", now + 1000);
      if ("postgres" in adapter && adapter.postgres) {
        await adapter.postgres.exec(`INSERT INTO accounts_v1.passkey_challenges
          (challenge_key, challenge, expires_at) VALUES ('b-unknown', 'unknown', 'infinity')`);
      } else await adapter.store.savePasskeyChallenge("b-unknown", "unknown", NaN);
      for (let i = 0; i < 5; i++) await adapter.store.savePasskeyChallenge(`z-expired-${i}`, "expired", now);
      let deleted = 0;
      for (let i = 0; i < 6; i++) {
        const result = await adapter.store.prunePasskeyChallenges({ now, maxRows: 2 });
        expect(result.scanned).toBeLessThanOrEqual(2);
        deleted += result.deleted;
      }
      expect(deleted).toBe(5);
      expect(await adapter.store.consumePasskeyChallenge("a-live", now)).toBe("live");
      expect(await adapter.store.consumePasskeyChallenge("b-unknown", now)).toBeUndefined();
    } finally { await adapter.close(); }
  }, 30_000);
}

test("D1 concurrent admissions cannot share one cleanup reservation", async () => {
  class BarrierD1 extends SqliteFakeD1 {
    pending = 0;
    barrierEnabled = false;
    release!: () => void;
    barrier = new Promise<void>((resolve) => { this.release = resolve; });
    tail = Promise.resolve();
    override async batch<T = unknown>(statements: readonly D1PreparedStatement[]) {
      if (this.barrierEnabled && statements.length === 4) {
        this.pending++;
        if (this.pending === 3) this.release();
        await this.barrier;
      }
      // Model one SQLite/D1 transaction at a time, while retaining the stale
      // pre-batch page/checkpoint reads forced by the barrier above.
      const previous = this.tail;
      let done!: () => void;
      this.tail = new Promise<void>((resolve) => { done = resolve; });
      await previous;
      try { return await super.batch<T>(statements); }
      finally { done(); }
    }
  }
  const db = new BarrierD1();
  const store = new D1AccountsStore(db);
  await store.initialize();
  await store.savePasskeyChallenge("legacy-expired", "expired", now);
  const inputs = await Promise.all([31, 32, 33].map((n) => challenge(n, now, 3)));
  db.barrierEnabled = true;
  const admitted = await Promise.all(inputs.map((input) => store.admitPasskeyChallenge(input)));
  expect(admitted.filter(Boolean)).toHaveLength(1);
  const rows = await db.prepare(`SELECT key FROM takosumi_accounts_documents
    WHERE bucket = 'passkey_challenges' AND key LIKE 'passkey:v2:%'`).all();
  expect(rows.results).toHaveLength(1);
  expect(await store.consumePasskeyChallenge("legacy-expired", now)).toBeUndefined();
  db.barrierEnabled = false;
  expect(await store.admitPasskeyChallenge(await challenge(34, now, 3))).toBe(true);
});

test("passkey admission refuses a private ceiling increase before storage effects", async () => {
  const adapter = await passkeyAdapter("memory");
  const input = await challenge(51, now, 121);
  expect(() => adapter.store.admitPasskeyChallenge(input)).toThrow("invalid passkey challenge admission");
  expect(await adapter.store.consumePasskeyChallenge(input.key, now)).toBeUndefined();
});
