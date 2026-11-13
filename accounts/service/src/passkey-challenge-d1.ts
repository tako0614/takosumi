import type { D1Database, D1PreparedStatement, D1Result } from "./d1-store.ts";
import {
  passkeyChallengeAdmissionPolicy,
  passkeyChallengeSweepLimit,
  passkeyChallengeWindowStart,
  type PasskeyChallengeAdmissionInput,
  type PasskeyChallengeSweepInput,
  type PasskeyChallengeSweepResult,
} from "./passkey-challenge-policy.ts";

const DOCUMENTS = "takosumi_accounts_documents";
const BUCKET = "passkey_challenges";
const CHECKPOINT = "passkey-challenges-v1";

function affected(result: D1Result, maximum: number): number {
  const returned = Array.isArray(result.results) ? result.results.length : undefined;
  const changes = result.meta?.changes;
  const count = returned ?? changes;
  if (!result.success || typeof count !== "number" ||
    !Number.isInteger(count) || count < 0 || count > maximum ||
    (returned !== undefined && changes !== undefined && returned !== changes)) {
    throw new Error("unreliable D1 passkey affected-row count");
  }
  return count;
}

export async function admitD1PasskeyChallenge(
  db: D1Database,
  input: PasskeyChallengeAdmissionInput,
): Promise<boolean> {
  const policy = passkeyChallengeAdmissionPolicy(input);
  const quota = JSON.stringify({ count: 1, lastKey: input.key, expiresAt: policy.expiresAt });
  const document = JSON.stringify({ challenge: input.challenge, expiresAt: input.expiresAt });
  const plan = await maintenancePlan(db, { now: input.now }, input.key);
  if (policy.windowStart < plan.windowStart) return false;
  const results = await db.batch([
    ...plan.statements,
    db.prepare(`INSERT INTO ${DOCUMENTS}(bucket, key, document, updated_at)
      SELECT '${BUCKET}', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM ${DOCUMENTS} WHERE bucket = 'maintenance_cursors'
          AND key = '${CHECKPOINT}' AND json_extract(document, '$.admissionKey') = ?
          AND json_extract(document, '$.generation') = ?
      )
      ON CONFLICT(bucket, key) DO UPDATE SET
        document = json_set(${DOCUMENTS}.document,
          '$.count', json_extract(${DOCUMENTS}.document, '$.count') + 1,
          '$.lastKey', ?), updated_at = excluded.updated_at
      WHERE CASE WHEN json_valid(${DOCUMENTS}.document)
        THEN json_type(${DOCUMENTS}.document, '$.count') = 'integer'
          AND json_extract(${DOCUMENTS}.document, '$.count') >= 1
          AND json_extract(${DOCUMENTS}.document, '$.count') < ?
          AND json_extract(${DOCUMENTS}.document, '$.expiresAt') = ?
        ELSE 0 END
      RETURNING key`).bind(policy.key, quota, input.now, input.key, plan.generation,
        input.key, policy.limit, policy.expiresAt),
    db.prepare(`INSERT INTO ${DOCUMENTS}(bucket, key, document, updated_at)
      SELECT '${BUCKET}', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM ${DOCUMENTS} WHERE bucket = '${BUCKET}' AND key = ?
          AND json_extract(document, '$.lastKey') = ?
          AND json_extract(document, '$.count') <= ?
          AND json_extract(document, '$.expiresAt') = ?
      ) AND EXISTS (SELECT 1 FROM ${DOCUMENTS}
        WHERE bucket = 'maintenance_cursors' AND key = '${CHECKPOINT}'
          AND json_extract(document, '$.admissionKey') = ?
          AND json_extract(document, '$.generation') = ?)
      RETURNING key`).bind(input.key, document, input.now, policy.key,
        input.key, policy.limit, policy.expiresAt, input.key, plan.generation),
  ]);
  if (results.length !== 4) throw new Error("invalid D1 passkey admission batch");
  affected(results[0], plan.scanned);
  const reserved = affected(results[1], 1);
  const quotaChanged = affected(results[2], 1);
  const inserted = affected(results[3], 1);
  if (inserted > reserved) throw new Error("unreserved D1 passkey admission");
  if (quotaChanged !== inserted) throw new Error("inconsistent D1 passkey admission");
  return inserted === 1;
}

interface Checkpoint {
  readonly generation: number;
  readonly after: string;
  readonly windowStart?: number;
}

async function maintenancePlan(
  db: D1Database,
  input: PasskeyChallengeSweepInput,
  admissionKey?: string,
): Promise<{ statements: D1PreparedStatement[]; scanned: number; generation: number; windowStart: number }> {
  const limit = passkeyChallengeSweepLimit(input);
  const saved = await db.prepare(`SELECT document FROM ${DOCUMENTS}
    WHERE bucket = 'maintenance_cursors' AND key = '${CHECKPOINT}'`)
    .first<{ document: string }>();
  const previous: Checkpoint = saved ? JSON.parse(saved.document) : { generation: 0, after: "" };
  if (!previous || !Number.isSafeInteger(previous.generation) || previous.generation < 0 ||
    previous.generation >= Number.MAX_SAFE_INTEGER || typeof previous.after !== "string" ||
    (previous.windowStart !== undefined &&
      (!Number.isSafeInteger(previous.windowStart) || previous.windowStart < 0 ||
        passkeyChallengeWindowStart(previous.windowStart) !== previous.windowStart))) {
    throw new TypeError("invalid D1 passkey maintenance checkpoint");
  }
  const page = await db.prepare(`SELECT key FROM ${DOCUMENTS}
    WHERE bucket = '${BUCKET}' AND key > ? ORDER BY key LIMIT ?`)
    .bind(previous.after, limit).all<{ key: string }>();
  if (!page.success || !Array.isArray(page.results) || page.results.length > limit ||
    page.results.some((row) => typeof row.key !== "string")) {
    throw new Error("invalid D1 passkey maintenance page");
  }
  const keys = page.results.map((row) => row.key);
  const after = keys.length < limit ? "" : keys[keys.length - 1]!;
  const generation = previous.generation + 1;
  const windowStart = Math.max(previous.windowStart ?? -1, passkeyChallengeWindowStart(input.now));
  const next = JSON.stringify({ generation, after, windowStart, ...(admissionKey ? { admissionKey } : {}) });
  const placeholders = keys.map(() => "?").join(",");
  const statements = [
    db.prepare(`DELETE FROM ${DOCUMENTS} WHERE bucket = '${BUCKET}'
      AND ${keys.length ? `key IN (${placeholders})` : "0"}
      AND CASE WHEN json_valid(document)
        THEN json_type(document, '$.expiresAt') IN ('integer', 'real')
          AND json_extract(document, '$.expiresAt') <= ?
        ELSE 0 END
      RETURNING key`).bind(...keys, input.now),
    db.prepare(`INSERT INTO ${DOCUMENTS}(bucket, key, document, updated_at)
      SELECT 'maintenance_cursors', '${CHECKPOINT}', ?, ?
      WHERE ? = 0 OR EXISTS (
        SELECT 1 FROM ${DOCUMENTS} WHERE bucket = 'maintenance_cursors'
          AND key = '${CHECKPOINT}' AND json_extract(document, '$.generation') = ?
      )
      ON CONFLICT(bucket, key) DO UPDATE
        SET document = excluded.document, updated_at = excluded.updated_at
      WHERE json_extract(${DOCUMENTS}.document, '$.generation') = ?
      RETURNING key`).bind(next, input.now, previous.generation, previous.generation, previous.generation),
  ];
  return { statements, scanned: keys.length, generation, windowStart };
}

export async function pruneD1PasskeyChallenges(
  db: D1Database,
  input: PasskeyChallengeSweepInput,
): Promise<PasskeyChallengeSweepResult> {
  const plan = await maintenancePlan(db, input);
  const results = await db.batch(plan.statements);
  if (results.length !== 2) throw new Error("invalid D1 passkey maintenance batch");
  const deleted = affected(results[0], plan.scanned);
  affected(results[1], 1); // A CAS loser keeps the newer durable checkpoint.
  return { scanned: plan.scanned, deleted };
}
