import type { D1Database } from "./d1-store.ts";
import {
  isRefreshChainRetentionPhase,
  MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES,
  type RefreshChainRetentionCursor,
  type RefreshChainRetentionPhase,
} from "./refresh-chain-retention.ts";

const DOCUMENTS = "takosumi_accounts_documents";
const INDEXES = "takosumi_accounts_indexes";
const PROBE_LIMIT = MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES + 1;

// Internal SQL fragments only: every name/expression comes from this module or
// the store's closed phase map. The evaluation time is a bound CTE parameter.
function liveToken(bucket: string, key: string): string {
  return `EXISTS (
    SELECT 1 FROM ${DOCUMENTS} AS token
     WHERE token.bucket = '${bucket}' AND token.key = ${key}
       AND CASE WHEN json_type(token.document, '$.expiresAt') IN ('integer', 'real')
         THEN CAST(json_extract(token.document, '$.expiresAt') AS REAL) > (SELECT now FROM retention_bounds)
         ELSE 1 END
  )`;
}

function liveRoot(root: string): string {
  const links = (name: string, bucket: string) =>
    `SELECT document_key FROM ${INDEXES}
      WHERE index_name = '${name}' AND index_key = ${root} AND bucket = '${bucket}'
      LIMIT ${PROBE_LIMIT}`;
  const refresh = links("refresh_chain_links_by_root", "refresh_chain_links");
  const access = links("refresh_chain_access_tokens_by_root", "refresh_chain_access_tokens");
  return `(
    ${liveToken("refresh_tokens", root)}
    OR (SELECT COUNT(*) FROM (${refresh})) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR (SELECT COUNT(*) FROM (${access})) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR EXISTS (
      SELECT 1 FROM (${refresh}) AS family
      LEFT JOIN ${DOCUMENTS} AS link ON link.bucket = 'refresh_chain_links' AND link.key = family.document_key
      WHERE link.key IS NULL OR json_type(link.document, '$.parentHash') IS NOT 'text'
         OR json_type(link.document, '$.childHash') IS NOT 'text'
         OR json_type(link.document, '$.rootHash') IS NOT 'text'
         OR json_extract(link.document, '$.rootHash') != ${root}
         OR ${liveToken("refresh_tokens", "json_extract(link.document, '$.parentHash')")}
         OR ${liveToken("refresh_tokens", "json_extract(link.document, '$.childHash')")}
    )
    OR EXISTS (
      SELECT 1 FROM (${access}) AS family
      LEFT JOIN ${DOCUMENTS} AS link ON link.bucket = 'refresh_chain_access_tokens' AND link.key = family.document_key
      WHERE link.key IS NULL OR json_type(link.document, '$.accessTokenHash') IS NOT 'text'
         OR json_type(link.document, '$.rootHash') IS NOT 'text'
         OR json_extract(link.document, '$.rootHash') != ${root}
         OR ${liveToken("access_tokens", "json_extract(link.document, '$.accessTokenHash')")}
    )
  )`;
}

function liveCodeLink(document: string): string {
  return `(json_type(${document}, '$.codeHash') IS NOT 'text'
    OR json_type(${document}, '$.accessTokenHash') IS NOT 'text'
    OR json_type(${document}, '$.refreshRootHash') IS NOT 'text'
    OR ${liveToken("authorization_codes", `json_extract(${document}, '$.codeHash')`)}
    OR ${liveToken("access_tokens", `json_extract(${document}, '$.accessTokenHash')`)}
    OR ${liveRoot(`json_extract(${document}, '$.refreshRootHash')`)})`;
}

function liveConsumedCode(code: string): string {
  const links = `SELECT document_key FROM ${INDEXES}
    WHERE index_name = 'auth_code_token_links_by_code' AND index_key = ${code}
      AND bucket = 'auth_code_token_links' LIMIT ${PROBE_LIMIT}`;
  return `(${liveToken("authorization_codes", code)}
    OR (SELECT COUNT(*) FROM (${links})) > ${MAX_REFRESH_CHAIN_RETENTION_DEPENDENCIES}
    OR EXISTS (SELECT 1 FROM (${links}) AS issued
      LEFT JOIN ${DOCUMENTS} AS code_link ON code_link.bucket = 'auth_code_token_links'
        AND code_link.key = issued.document_key
      WHERE code_link.key IS NULL OR ${liveCodeLink("code_link.document")})
  )`;
}

function liveDependency(phase: RefreshChainRetentionPhase): string {
  if (phase === "chain_links") {
    return `(json_type(candidate.document, '$.parentHash') IS NOT 'text'
      OR json_type(candidate.document, '$.childHash') IS NOT 'text'
      OR json_type(candidate.document, '$.rootHash') IS NOT 'text'
      OR ${liveToken("refresh_tokens", "json_extract(candidate.document, '$.parentHash')")}
      OR ${liveToken("refresh_tokens", "json_extract(candidate.document, '$.childHash')")})`;
  }
  if (phase === "chain_access_tokens") {
    return `(json_type(candidate.document, '$.accessTokenHash') IS NOT 'text'
      OR json_type(candidate.document, '$.rootHash') IS NOT 'text'
      OR ${liveToken("access_tokens", "json_extract(candidate.document, '$.accessTokenHash')")})`;
  }
  if (phase === "revoked_roots") return liveRoot("candidate.key");
  if (phase === "consumed_codes") return liveConsumedCode("candidate.key");
  return liveCodeLink("candidate.document");
}

/** Atomically retain live dependencies and delete both the document and indexes. */
export async function deleteD1RefreshRetentionCandidate(
  db: D1Database,
  input: {
    readonly phase: RefreshChainRetentionPhase;
    readonly bucket: string;
    readonly key: string;
    readonly timestampField: "createdAt" | "revokedAt" | "consumedAt";
    readonly at: number;
    readonly now: number;
  },
): Promise<boolean> {
  const eligible = `candidate.bucket = ? AND candidate.key = ?
    AND json_type(candidate.document, '$.${input.timestampField}') IN ('integer', 'real')
    AND CAST(json_extract(candidate.document, '$.${input.timestampField}') AS INTEGER) = ?
    AND NOT (${liveDependency(input.phase)})`;
  const results = await db.batch<{ key: string }>([
    db.prepare(`WITH retention_bounds(now) AS (SELECT ?)
      DELETE FROM ${INDEXES} WHERE bucket = ? AND document_key = ?
       AND EXISTS (SELECT 1 FROM ${DOCUMENTS} AS candidate WHERE ${eligible})`)
      .bind(input.now, input.bucket, input.key, input.bucket, input.key, input.at),
    db.prepare(`WITH retention_bounds(now) AS (SELECT ?)
      DELETE FROM ${DOCUMENTS} AS candidate WHERE ${eligible} RETURNING key`)
      .bind(input.now, input.bucket, input.key, input.at),
  ]);
  if (results.length !== 2 || results.some((result) => !result.success)) {
    throw new Error("D1 refresh-chain guarded deletion failed");
  }
  const deleted = results[1];
  const returned = Array.isArray(deleted.results) ? deleted.results.length : undefined;
  const changes = deleted.meta?.changes;
  const count = returned ?? changes;
  if ((count !== 0 && count !== 1) ||
      (returned !== undefined && changes !== undefined && returned !== changes)) {
    throw new Error("D1 refresh-chain guarded deletion has no reliable affected-row count");
  }
  return count === 1;
}

export interface D1RefreshRetentionCheckpoint {
  readonly generation: number;
  readonly cursor?: RefreshChainRetentionCursor;
}

export async function readD1RefreshRetentionCheckpoint(
  db: D1Database,
): Promise<D1RefreshRetentionCheckpoint> {
  const row = await db.prepare(`SELECT document FROM ${DOCUMENTS}
    WHERE bucket = 'maintenance_cursors' AND key = 'refresh-chain-retention'`)
    .first<{ document: string }>();
  if (!row) return { generation: 0 };
  const value = JSON.parse(row.document) as D1RefreshRetentionCheckpoint;
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (value.cursor !== undefined && (!isRefreshChainRetentionPhase(value.cursor.phase) ||
        (value.cursor.after !== undefined && typeof value.cursor.after !== "string")))) {
    throw new TypeError("invalid D1 refresh-chain retention checkpoint");
  }
  return value;
}

/** A stale overlapping cron cannot rewind or reset a newer checkpoint. */
export async function advanceD1RefreshRetentionCheckpoint(
  db: D1Database,
  previous: D1RefreshRetentionCheckpoint,
  cursor: RefreshChainRetentionCursor | undefined,
): Promise<boolean> {
  if (!Number.isSafeInteger(previous.generation) || previous.generation < 0 ||
      previous.generation >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("invalid D1 refresh-chain retention generation");
  }
  const document = JSON.stringify({ generation: previous.generation + 1, ...(cursor ? { cursor } : {}) });
  const result = await db.prepare(`INSERT INTO ${DOCUMENTS}(bucket, key, document, updated_at)
    SELECT 'maintenance_cursors', 'refresh-chain-retention', ?, ?
     WHERE ? = 0 OR EXISTS (SELECT 1 FROM ${DOCUMENTS}
       WHERE bucket = 'maintenance_cursors' AND key = 'refresh-chain-retention'
         AND CAST(json_extract(document, '$.generation') AS INTEGER) = ?)
    ON CONFLICT(bucket, key) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at
     WHERE CAST(json_extract(${DOCUMENTS}.document, '$.generation') AS INTEGER) = ?
    RETURNING key`).bind(document, Date.now(), previous.generation, previous.generation, previous.generation)
    .all<{ key: string }>();
  if (!result.success || !Array.isArray(result.results)) {
    throw new Error("D1 refresh-chain retention checkpoint update failed");
  }
  return result.results.length > 0;
}
