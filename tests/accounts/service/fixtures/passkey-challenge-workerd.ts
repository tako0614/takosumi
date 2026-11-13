import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { passkeyChallengeKey } from "../../../../accounts/service/src/passkey-challenge-store.ts";
import { passkeyChallengeAdmissionPolicy, PASSKEY_CHALLENGE_TTL_MS } from "../../../../accounts/service/src/passkey-challenge-policy.ts";

export default {
  async fetch(_request: Request, env: { FIXTURE_DB: D1Database }) {
    const db = env.FIXTURE_DB;
    await new D1AccountsStore(db).initialize(); // Disposable fixture setup only.
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    const input = async (n: number, at = now) => {
      const challenge = n.toString(16).padStart(43, "N");
      return { key: await passkeyChallengeKey({ subject: "tsub_native_fixture",
        sessionId: null, intent: "authenticate", challenge }), challenge,
        now: at, expiresAt: at + PASSKEY_CHALLENGE_TTL_MS, maxPerWindow: 3 };
    };
    let barrierEnabled = true;
    let pending = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let ddlAttempts = 0;
    let loseAck = false;
    const readonlySchemaPort: D1Database = {
      prepare(sql) {
        if (/^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql)) {
          ddlAttempts++;
          throw new Error("runtime DDL forbidden in predeployed fixture");
        }
        return db.prepare(sql);
      },
      async batch<T>(statements) {
        if (barrierEnabled && statements.length === 4) {
          pending++;
          if (pending === 3) release();
          await barrier;
        }
        const result = await db.batch<T>(statements);
        if (loseAck && statements.length === 4) {
          loseAck = false;
          throw new Error("fixture acknowledgement lost after commit");
        }
        return result;
      },
      async exec() { ddlAttempts++; throw new Error("runtime DDL forbidden"); },
    };
    const store = new D1AccountsStore(readonlySchemaPort, { schemaMode: "predeployed" });
    await store.savePasskeyChallenge("legacy-expired", "expired", now);
    await store.savePasskeyChallenge("legacy-live", "live", now + 600_000);
    await store.savePasskeyChallenge("legacy-unknown", "unknown", NaN);
    const inputs = await Promise.all([1, 2, 3].map((n) => input(n)));
    const results = await Promise.all(inputs.map((record) => store.admitPasskeyChallenge(record)));
    barrierEnabled = false;
    const checkpoint = async () => (await db.prepare(`SELECT document FROM takosumi_accounts_documents
      WHERE bucket = 'maintenance_cursors' AND key = 'passkey-challenges-v1'`)
      .first<{ document: string }>())!.document;
    const has = async (key: string) => !!await db.prepare(`SELECT key FROM takosumi_accounts_documents
      WHERE bucket = 'passkey_challenges' AND key = ?`).bind(key).first();
    const quotaKey = passkeyChallengeAdmissionPolicy(inputs[0]!).key;
    const quota = async () => (await db.prepare(`SELECT json_extract(document, '$.count') AS count
      FROM takosumi_accounts_documents WHERE bucket = 'passkey_challenges' AND key = ?`)
      .bind(quotaKey).first<{ count: number }>())!.count;
    const acceptedOne = results.filter(Boolean).length === 1 && await quota() === 1;
    const expiredRemoved = !await has("legacy-expired");

    await store.savePasskeyChallenge("rollback-expired", "expired", now);
    const before = await checkpoint();
    const fourth = await input(4);
    await db.prepare(`CREATE TRIGGER fixture_passkey_rollback BEFORE INSERT ON takosumi_accounts_documents
      WHEN NEW.bucket = 'passkey_challenges' AND NEW.key LIKE 'passkey:v2:%'
      BEGIN SELECT RAISE(ABORT, 'fixture passkey rollback'); END`).run();
    let refused = false;
    try { await store.admitPasskeyChallenge(fourth); }
    catch (error) { refused = error instanceof Error && error.message.includes("fixture passkey rollback"); }
    await db.prepare("DROP TRIGGER fixture_passkey_rollback").run();
    const rollback = refused && await checkpoint() === before && await quota() === 1 &&
      await has("rollback-expired") && !await has(fourth.key);
    const resumed = await store.admitPasskeyChallenge(fourth);
    const fifth = await store.admitPasskeyChallenge(await input(5));
    const over = await store.admitPasskeyChallenge(await input(6));
    const quotaBound = resumed && fifth && !over && await quota() === 3;

    for (let n = 0; n < 65; n++) await store.savePasskeyChallenge(
      `a-held-${String(n).padStart(2, "0")}`, "live", now + 600_000,
    );
    await store.savePasskeyChallenge("z-later-expired", "expired", now);
    const first = await store.prunePasskeyChallenges({ now });
    const restarted = new D1AccountsStore(readonlySchemaPort, { schemaMode: "predeployed" });
    const second = await restarted.prunePasskeyChallenges({ now });
    const lost = { ...await input(21, now + 60_000), maxPerWindow: 2 };
    loseAck = true;
    let unknownAck = false;
    try { await restarted.admitPasskeyChallenge(lost); }
    catch (error) { unknownAck = error instanceof Error && error.message.includes("after commit"); }
    const persistedDespiteAck = await has(lost.key);
    const fresh = await restarted.admitPasskeyChallenge({ ...await input(22, now + 60_000), maxPerWindow: 2 });
    const limited = !await restarted.admitPasskeyChallenge({ ...await input(23, now + 60_000), maxPerWindow: 2 });
    const lostAckPreserved = unknownAck && persistedDespiteAck && fresh && limited &&
      await restarted.consumePasskeyChallenge(lost.key, now + 60_000) === lost.challenge &&
      await restarted.consumePasskeyChallenge(lost.key, now + 60_000) === undefined;
    const delayed = { ...await input(24, now + 60_000), maxPerWindow: 2 };
    await restarted.prunePasskeyChallenges({ now: now + 120_000 });
    const refusedOldWindow = !await restarted.admitPasskeyChallenge(delayed);
    const currentWindowWorks = await restarted.admitPasskeyChallenge({ ...await input(25, now + 120_000), maxPerWindow: 2 });
    const previouslyIssued = await input(22, now + 60_000);
    const staleWindowRefused = refusedOldWindow && currentWindowWorks &&
      await restarted.consumePasskeyChallenge(previouslyIssued.key, now + 120_000) === previouslyIssued.challenge;
    return Response.json({ acceptedOne, expiredRemoved, rollback, quotaBound,
      lostAckPreserved, staleWindowRefused,
      heldPreserved: await has("legacy-live") && await has("legacy-unknown"),
      restartProgress: first.scanned === 64 && !await has("z-later-expired") && await has("a-held-00"),
      maxScanned: Math.max(first.scanned, second.scanned), ddlAttempts });
  },
};
