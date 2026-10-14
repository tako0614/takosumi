import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
} from "../identity-unlink-state.ts";
import type { IdentityMergeRetryCheckpointMutation } from "../identity-state.ts";
import type { IdentityRecordRepository } from "../hosted-identity-records.ts";
import {
  assertMergeMutation,
  identityMergeProofAudit,
  assertCredentialUnlinkMutation,
  unlinkImmutableContext,
  credentialUnlinkAudit,
  identityRecordsEqual,
} from "../hosted-identity-records.ts";
import type {
  IdentityOperationReceiptRecord,
  IdentityMergeMutation,
  UnlinkUpstreamIdentityInput,
} from "../identity-state.ts";
import {
  MERGE_EMAIL_TRIM_CODE_POINTS,
  upstreamIdentityKey,
} from "../identity-state.ts";
import type {
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
} from "../store.ts";
import {
  accountFromRow,
  upstreamIdentityFromRow,
  type UpstreamIdentityRow,
  type AccountRow,
  hashSecret,
  type PostgresQueryClient,
  runQuery,
} from "./internal.ts";
import { hashSessionId } from "../session-hash-salt.ts";

const table = "accounts_v1.hosted_identity_records";
function candidatePredicate(address: string, local: string): string {
  const email = `btrim(email,${MERGE_EMAIL_TRIM_CODE_POINTS.map((c) => `chr(${c})`).join("||")})`;
  return `(lower(${email})=lower(${address}) OR (lower(split_part(${email},'@',1))=lower(${local}) AND (octet_length(split_part(${email},'@',2))<>length(split_part(${email},'@',2)) OR strpos(split_part(${email},'@',2),'%')>0 OR strpos(split_part(${email},'@',2),chr(92))>0)))`;
}
const fields = new Set([
  "issuerSessionId",
  "clientId",
  "subject",
  "sourceSubject",
  "targetSubject",
  "authorizationCodeHash",
  "sid",
]);

export class PostgresIdentityRecordRepository
  implements IdentityRecordRepository
{
  constructor(readonly client: PostgresQueryClient) {}
  async get<T>(bucket: string, key: string): Promise<T | undefined> {
    const r = await runQuery<{ document: T }>(
      this.client,
      `SELECT document FROM ${table} WHERE bucket=$1 AND key=$2`,
      [bucket, key],
    );
    return r.rows[0]?.document;
  }
  async put(bucket: string, key: string, record: unknown): Promise<void> {
    const [subject, other] = references(record);
    await runQuery(
      this.client,
      `INSERT INTO ${table}(bucket,key,document,subject,other_subject) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document,subject=excluded.subject,other_subject=excluded.other_subject`,
      [bucket, key, JSON.stringify(record), subject, other],
    );
  }
  async create(bucket: string, key: string, record: unknown): Promise<boolean> {
    const [subject, other] = references(record);
    const r = await runQuery(
      this.client,
      `INSERT INTO ${table}(bucket,key,document,subject,other_subject) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING key`,
      [bucket, key, JSON.stringify(record), subject, other],
    );
    return r.rows.length === 1;
  }
  async consume<T>(
    bucket: string,
    key: string,
    binding: string,
    now: number,
  ): Promise<T | undefined> {
    const r = await runQuery<{ document: T }>(
      this.client,
      `DELETE FROM ${table} WHERE bucket=$1 AND key=$2 AND document->>'browserBindingHash'=$3 AND (document->>'expiresAt')::bigint>$4 RETURNING document`,
      [bucket, key, binding, now],
    );
    return r.rows[0]?.document;
  }
  async query<T>(
    bucket: string,
    field: string,
    value: string,
    limit: number,
  ): Promise<readonly T[]> {
    if (!fields.has(field) || limit > 101 || limit < 1)
      throw new TypeError("invalid_identity_record_query");
    return (
      await runQuery<{ document: T }>(
        this.client,
        `SELECT document FROM ${table} WHERE bucket=$1 AND document->>'${field}'=$2 ORDER BY key LIMIT $3`,
        [bucket, value, limit],
      )
    ).rows.map((r) => r.document);
  }
  async revokeGrants(
    field: "issuerSessionId" | "clientId" | "sid",
    value: string,
    now: number,
  ): Promise<void> {
    await runQuery(
      this.client,
      `UPDATE ${table} SET document=jsonb_set(document,'{revokedAt}',to_jsonb($1::bigint)) WHERE bucket='hosted_oidc_grants' AND document->>'${field}'=$2 AND NOT(document ? 'revokedAt')`,
      [now, value],
    );
  }
  async emailCandidates(
    address: string,
  ): Promise<readonly TakosumiAccountRecord[]> {
    return (
      await runQuery<AccountRow>(
        this.client,
        `SELECT * FROM accounts_v1.accounts WHERE ${candidatePredicate("$1", "$2")} ORDER BY subject LIMIT 3`,
        [address, address.slice(0, address.lastIndexOf("@"))],
      )
    ).rows.map(accountFromRow);
  }
  async listIdentities(
    subject: import("@takosjp/takosumi-accounts-contract").TakosumiSubject,
  ): Promise<readonly UpstreamIdentityRecord[]> {
    const rows = await runQuery<UpstreamIdentityRow>(
      this.client,
      `SELECT i.* FROM accounts_v1.upstream_identities i WHERE (i.subject=$1 OR i.subject IN(SELECT key FROM ${table} WHERE bucket='canonical_accounts' AND subject=$1)) AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND d.document ? 'disabledAt' AND d.document->>'providerId'=i.provider_id AND d.document->>'upstreamIssuer'=i.upstream_issuer AND d.document->>'upstreamSubject'=i.upstream_subject) ORDER BY i.provider_id,i.upstream_issuer,i.upstream_subject LIMIT 101`,
      [subject],
    );
    return rows.rows.map(upstreamIdentityFromRow);
  }
  async touchSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean> {
    const r = await runQuery(
      this.client,
      `UPDATE accounts_v1.account_sessions SET expires_at=to_timestamp(least($1::bigint,(hosted_metadata->>'absoluteExpiresAt')::bigint)/1000.0) WHERE session_id=$2 AND hosted_metadata->>'policy'='hosted' AND expires_at>to_timestamp($3/1000.0) AND (hosted_metadata->>'absoluteExpiresAt')::bigint>$3 RETURNING session_id`,
      [idleExpiresAt, await hashSessionId(sessionId), now],
    );
    return r.rows.length === 1;
  }
  async mutateMerge(input: IdentityMergeMutation): Promise<boolean> {
    assertMergeMutation(input);
    const n = input.next;
    const args: unknown[] = [
      JSON.stringify(n),
      n.operationId,
      input.expectedRevision,
      n.sourceSubject,
      n.targetSubject,
      input.now,
    ];
    const bind = (value: unknown) => {
      args.push(value);
      return `$${args.length}`;
    };
    let where = `bucket='identity_merge_operations' AND key=$2 AND (document->>'revision')::integer=$3 AND document->>'sourceSubject'=$4 AND document->>'targetSubject'=$5 AND $6::bigint>=0`;
    if (
      !input.quarantine &&
      !input.restore &&
      !input.abort &&
      !input.requireRecovery
    )
      where += ` AND (document->>'expiresAt')::bigint>$6 AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key IN($4,$5))`;
    if (input.restore)
      where += ` AND document->>'status'='quarantined' AND EXISTS(SELECT 1 FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=$4 AND m.document->>'targetSubject'=$5 AND m.document->>'operationId'=$2)`;
    if (input.abort)
      where += ` AND document ? 'consentAt' AND document->>'status' IN('proved','reconciled','quarantined') AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key IN($4,$5)) AND (SELECT count(*) FROM ${table} WHERE bucket='identity_merge_locks' AND key IN($4,$5) AND document->>'operationId'=$2)=2`;
    if (input.requireRecovery)
      where += ` AND document ? 'consentAt' AND document->>'status'=${bind(n.status)} AND document->>'status' IN('proved','reconciled') AND ((document->>'expiresAt')::bigint<=$6 OR EXISTS(SELECT 1 FROM ${table} r WHERE r.bucket='identity_operation_receipts' AND r.key IN(${table}.document->'sourceProof'->>'receiptId',${table}.document->'targetProof'->>'receiptId') AND (r.document->>'expiresAt')::bigint<=$6) OR EXISTS(SELECT 1 FROM ${table} e WHERE e.bucket='account_email_proofs' AND e.key IN($4,$5) AND (e.document->>'validUntil')::bigint<=$6))`;
    for (const p of input.sessions ?? []) {
      where += ` AND EXISTS(SELECT 1 FROM accounts_v1.account_sessions s WHERE s.session_id=${bind(p.sessionLookupHash ?? (await hashSessionId(p.sessionId!)))} AND s.subject=${bind(p.subject)} AND hosted_metadata->>'policy'='hosted' AND (hosted_metadata->>'${p.reauthentication === false ? "authTime" : "reauthenticatedAt"}')::bigint=${bind(p.authTime)} AND expires_at>to_timestamp($6/1000.0) AND (hosted_metadata->>'absoluteExpiresAt')::bigint>$6 AND coalesce((hosted_metadata->>'identityGeneration')::integer,0)=coalesce((SELECT (g.document->>'generation')::integer FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=s.subject),0))`;
    }
    for (const proof of input.emailProofs ?? [])
      where += ` AND EXISTS(SELECT 1 FROM ${table} e JOIN accounts_v1.accounts a ON a.subject=e.key WHERE e.bucket='account_email_proofs' AND e.key=${bind(proof.subject)} AND e.document=${bind(JSON.stringify(proof))}::jsonb AND a.email=${bind(proof.address)} AND a.email_verified=true)`;
    if (input.receipt)
      where += this.receiptCondition(
        input.receipt,
        n,
        input.now,
        false,
        0,
        bind,
      );
    for (const receipt of input.proofReceipts ?? [])
      where += this.receiptCondition(
        receipt,
        n,
        input.now,
        true,
        input.activate || n.status === "reconciled" ? 1 : 0,
        bind,
      );
    if (n.contextPlan)
      where += ` AND (NOT(document ? 'contextPlan') OR document->'contextPlan'=${bind(JSON.stringify(n.contextPlan))}::jsonb)`;
    else where += ` AND NOT(document ? 'contextPlan')`;
    if (input.contextPlanRecord)
      where += ` AND EXISTS(SELECT 1 FROM ${table} p WHERE p.bucket='identity_merge_context_plans' AND p.key=${bind(input.contextPlanRecord.planId)} AND p.document=${bind(JSON.stringify(input.contextPlanRecord))}::jsonb)`;
    const contexts = input.contextReceipt
      ? [input.contextReceipt]
      : (input.contextReceipts ?? []);
    if (contexts.length) {
      where += ` AND (SELECT count(*) FROM jsonb_array_elements(${bind(JSON.stringify(contexts))}::jsonb) e(value) JOIN ${table} c ON c.bucket='identity_merge_context_receipts' AND c.key=e.value->>'receiptId' WHERE c.document=e.value AND (c.document->>'identityGeneration')::integer+${bind(input.activate || n.status === "reconciled" ? 1 : 0)}=COALESCE((SELECT (g.document->>'generation')::integer FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=c.document->>'subject'),0) AND NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.bucket='hosted_oidc_revoked_sessions' AND x.key=c.document->>'issuerSessionHash'))=${bind(contexts.length)}`;
      if (input.contextReceipt)
        where += ` AND NOT(document ? '${input.contextReceipt.role === "source" ? "sourceContextAcceptance" : "targetContextAcceptance"}')`;
    }
    if (input.activate)
      where += ` AND document->>'status'='reconciled' AND (SELECT count(*) FROM ${table} WHERE bucket='identity_merge_locks' AND key IN($4,$5) AND document->>'operationId'=$2)=2`;
    if (input.reserve || input.activate)
      where += ` AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_locks' AND key IN($4,$5) AND document->>'operationId'<>$2)`;
    if (input.reserve)
      where += ` AND (SELECT count(*) FROM(SELECT key FROM ${table} WHERE bucket='identity_merge_retry_pending' LIMIT ${bind(input.retryCapacity)} ) q)<${bind(input.retryCapacity)}`;
    let inventoryGeneration: number | undefined;
    if (input.reserve || input.activate) {
      await this.create("email_candidate_inventory", "global", {
        generation: 0,
      });
      inventoryGeneration =
        (
          await this.get<{ generation: number }>(
            "email_candidate_inventory",
            "global",
          )
        )?.generation ?? 0;
    }
    if (input.emailProofs?.length) {
      const address = input.emailProofs[0]!.normalizedAddress;
      where += ` AND (SELECT count(*) FROM accounts_v1.accounts WHERE ${candidatePredicate(bind(address), bind(address.slice(0, address.lastIndexOf("@"))))})=2`;
    }
    const ctes = [
      `changed AS(UPDATE ${table} SET document=$1::jsonb WHERE ${where} RETURNING document)`,
    ];
    if (inventoryGeneration !== undefined) {
      ctes.unshift(
        `inventory_claim AS(UPDATE ${table} SET document=jsonb_set(document,'{generation}',to_jsonb((document->>'generation')::bigint+1)) WHERE bucket='email_candidate_inventory' AND key='global' AND (document->>'generation')::bigint=${bind(inventoryGeneration)} RETURNING key)`,
      );
      ctes[1] = ctes[1]!.replace(
        " RETURNING document)",
        " AND EXISTS(SELECT 1 FROM inventory_claim) RETURNING document)",
      );
    }
    const insert = (
      name: string,
      bucket: string,
      key: string,
      doc: unknown,
      subject: string | null,
      other: string | null,
      strict = false,
    ) => {
      ctes.push(
        `${name} AS(INSERT INTO ${table}(bucket,key,document,subject,other_subject) SELECT ${bind(bucket)},${bind(key)},${bind(JSON.stringify(doc))}::jsonb,${bind(subject)},${bind(other)} FROM changed ${strict ? "" : "ON CONFLICT DO NOTHING"} RETURNING key)`,
      );
    };
    insert(
      "audit",
      "identity_merge_audit",
      `${n.operationId}:${n.revision}`,
      {
        operationId: n.operationId,
        sourceSubject: n.sourceSubject,
        targetSubject: n.targetSubject,
        actor: n.actor,
        policyVersion: n.policyVersion,
        decision: n.status,
        proofs: identityMergeProofAudit(n),
        consentAt: n.consentAt,
        acknowledgements: n.acknowledgements,
        undoOperationId: n.undoOperationId,
        recoveryAcknowledgements: n.recoveryAcknowledgements,
        conflict: n.conflict,
        at: input.now,
      },
      n.targetSubject,
      n.sourceSubject,
      true,
    );
    if (input.contextReceipt)
      ctes.push(
        `consume_context AS(UPDATE ${table} SET document=jsonb_set(jsonb_set(document,'{consumedByOperation}',to_jsonb($2::text)),'{consumedAt}',to_jsonb($6::bigint)) WHERE bucket='identity_merge_context_receipts' AND key=${bind(input.contextReceipt.receiptId)} AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
      );
    if (input.receipt)
      ctes.push(
        `consume_receipt AS(UPDATE ${table} SET document=jsonb_set(jsonb_set(document,'{consumedByOperation}',to_jsonb($2::text)),'{consumedAt}',to_jsonb($6::bigint)) WHERE bucket='identity_operation_receipts' AND key=${bind(input.receipt.receiptId)} AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
      );
    if (input.reserve || input.quarantine) {
      for (const [i, subject] of [n.sourceSubject, n.targetSubject].entries())
        insert(
          `lock${i}`,
          "identity_merge_locks",
          subject,
          { operationId: n.operationId, subject },
          subject,
          null,
          !!input.reserve,
        );
      this.revokeCtes(
        ctes,
        `SELECT 1 FROM changed`,
        `subject IN($4,$5)`,
        input.now,
        bind,
      );
    }
    if (input.restore || input.abort) {
      this.revokeCtes(
        ctes,
        `SELECT 1 FROM changed`,
        `subject IN($4,$5)`,
        input.now,
        bind,
      );
      if (input.restore)
        ctes.push(
          `restore_mapping AS(DELETE FROM ${table} WHERE bucket='canonical_accounts' AND key=$4 AND document->>'operationId'=$2 AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
        );
      ctes.push(
        `release_locks AS(DELETE FROM ${table} WHERE bucket='identity_merge_locks' AND key IN($4,$5) AND document->>'operationId'=$2 AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
      );
    }
    if (input.activate)
      this.revokeCtes(
        ctes,
        `SELECT 1 FROM changed`,
        `subject IN($4,$5)`,
        input.now,
        bind,
      );
    if (
      input.reserve ||
      input.activate ||
      input.quarantine ||
      input.restore ||
      input.abort
    )
      this.generationCtes(ctes, [n.sourceSubject, n.targetSubject], bind);
    if (input.activate)
      insert(
        "canonical",
        "canonical_accounts",
        n.sourceSubject,
        {
          sourceSubject: n.sourceSubject,
          targetSubject: n.targetSubject,
          operationId: n.operationId,
          activatedAt: input.now,
        },
        n.targetSubject,
        n.sourceSubject,
        true,
      );
    if (input.reserve)
      insert(
        "schedule_pending",
        "identity_merge_retry_pending",
        n.operationId,
        { operationId: n.operationId },
        null,
        null,
      );
    if (input.activate || input.requireRecovery || input.abort || input.restore)
      ctes.push(
        `unschedule_pending AS(DELETE FROM ${table} WHERE bucket='identity_merge_retry_pending' AND key=$2 AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
      );
    try {
      return (
        (
          await runQuery(
            this.client,
            `WITH ${ctes.join(",")} SELECT document FROM changed`,
            args,
          )
        ).rows.length === 1
      );
    } catch (e) {
      if (isConflict(e)) return false;
      throw e;
    }
  }
  private receiptCondition(
    r: IdentityOperationReceiptRecord,
    op: IdentityMergeMutation["next"],
    now: number,
    consumed: boolean,
    offset: number,
    bind: (value: unknown) => string,
  ): string {
    return ` AND EXISTS(SELECT 1 FROM ${table} r WHERE r.bucket='identity_operation_receipts' AND r.key=${bind(r.receiptId)} AND r.document=${bind(JSON.stringify(r))}::jsonb AND r.document->>'operationId'=$2 AND r.document->>'sourceSubject'=$4 AND r.document->>'targetSubject'=$5 AND r.document->>'subject'=${bind(r.role === "source" ? op.sourceSubject : op.targetSubject)} AND r.document->>'role'=${bind(r.role)} AND (r.document->>'completedAt')::bigint<=$6 AND (r.document->>'expiresAt')::bigint>$6 AND (r.document->>'identityGeneration')::integer+${bind(offset)}=COALESCE((SELECT (g.document->>'generation')::integer FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=r.document->>'subject'),0) AND ${consumed ? "r.document->>'consumedByOperation'=$2" : "NOT(r.document ? 'consumedByOperation')"} AND r.document->>'browserBindingHash'=${table}.document->>'browserBindingHash' AND r.document->>'policyVersion'=${table}.document->>'policyVersion' AND r.document->>'emailDigest'=${table}.document->>'addressDigest' AND (r.document->>'startedAt')::bigint>=(${table}.document->>'createdAt')::bigint AND (r.document->>'completedAt')::bigint>=(r.document->>'startedAt')::bigint AND (r.document->>'legConsentAt')::bigint BETWEEN (r.document->>'startedAt')::bigint AND (r.document->>'completedAt')::bigint AND (r.document->>'expiresAt')::bigint<=(r.document->>'startedAt')::bigint+300000 AND (r.document->>'legConsent')::boolean=true AND r.document->>'method' IN('upstream-oauth-operation','issuer-credential-reauth') AND NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.bucket='hosted_oidc_revoked_sessions' AND x.key=r.document->>'issuerSessionHash') AND EXISTS(SELECT 1 FROM accounts_v1.upstream_identities i WHERE i.provider_id=r.document->>'providerId' AND i.upstream_issuer=r.document->>'upstreamIssuer' AND i.upstream_subject=r.document->>'upstreamSubject' AND i.subject=r.document->>'subject') AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND d.document ? 'disabledAt' AND d.document->>'providerId'=r.document->>'providerId' AND d.document->>'upstreamIssuer'=r.document->>'upstreamIssuer' AND d.document->>'upstreamSubject'=r.document->>'upstreamSubject'))`;
  }
  private revokeCtes(
    ctes: string[],
    guard: string,
    subjects: string,
    now: number,
    bind: (value: unknown) => string,
  ): void {
    ctes.push(
      `sessions AS(DELETE FROM accounts_v1.account_sessions WHERE ${subjects} AND EXISTS(${guard}) RETURNING session_id)`,
    );
    for (const [name, tableName] of [
      ["codes", "authorization_codes"],
      ["access", "oauth_access_tokens"],
      ["refresh", "oauth_refresh_tokens"],
    ])
      ctes.push(
        `${name} AS(DELETE FROM accounts_v1.${tableName} WHERE (${subjects} OR ${subjects.replaceAll("subject IN", "takosumi_subject IN")}) AND EXISTS(${guard}) RETURNING ${name === "codes" ? "code_hash" : "token_hash"})`,
      );
    ctes.push(
      `grants AS(UPDATE ${table} SET document=jsonb_set(document,'{revokedAt}',to_jsonb(${bind(now)}::bigint)) WHERE bucket='hosted_oidc_grants' AND ${subjects} AND EXISTS(${guard}) RETURNING key)`,
    );
  }
  private generationCtes(
    ctes: string[],
    subjects: readonly string[],
    bind: (value: unknown) => string,
  ): void {
    for (const [i, subject] of [...new Set(subjects)].entries())
      ctes.push(
        `generation${i} AS(INSERT INTO ${table}(bucket,key,document,subject) SELECT 'authentication_generations',${bind(subject)},${bind(JSON.stringify({ subject, generation: 1 }))}::jsonb,${bind(subject)} FROM changed ON CONFLICT(bucket,key) DO UPDATE SET document=jsonb_set(${table}.document,'{generation}',to_jsonb((${table}.document->>'generation')::integer+1)) RETURNING key)`,
      );
  }

  async page<T>(
    bucket: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly { key: string; record: T }[]> {
    const rows = await runQuery<{ key: string; document: T }>(
      this.client,
      `SELECT key,document FROM ${table} WHERE bucket=$1 AND key>$2 ORDER BY key LIMIT $3`,
      [bucket, after ?? "", limit],
    );
    return rows.rows.map((r) => ({ key: r.key, record: r.document }));
  }
  async compareAndSetCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean> {
    const { key, next } = input;
    const result =
      input.expectedRevision === undefined
        ? await runQuery(
            this.client,
            `INSERT INTO ${table}(bucket,key,document) VALUES('identity_merge_retry_checkpoints',$1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key`,
            [key, JSON.stringify(next)],
          )
        : await runQuery(
            this.client,
            `UPDATE ${table} SET document=$1::jsonb WHERE bucket='identity_merge_retry_checkpoints' AND key=$2 AND (document->>'revision')::integer=$3 RETURNING key`,
            [JSON.stringify(next), key, input.expectedRevision],
          );
    return result.rows.length === 1;
  }
  async completeUnlink(input: CredentialUnlinkMutation): Promise<boolean> {
    try {
      assertCredentialUnlinkMutation(input);
    } catch {
      return false;
    }
    const { next: n, receipt: r, now } = input;
    const old = await this.get<CredentialUnlinkIntent>(
      "credential_unlink_intents",
      n.operationId,
    );
    if (old?.status === "completed") return identityRecordsEqual(old, n);
    const args: unknown[] = [
      JSON.stringify(n),
      n.operationId,
      input.expectedRevision,
      n.subject,
    ];
    const bind = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    let condition = `bucket='credential_unlink_intents' AND key=$2 AND (document->>'revision')::integer=$3 AND document->>'status'='pending' AND (document-'status'-'revision'-'updatedAt'-'receiptId'-'acknowledgement')=${bind(JSON.stringify(unlinkImmutableContext(n)))}::jsonb AND COALESCE((SELECT (g.document->>'generation')::integer FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=$4),0)=${bind(n.identityGeneration)} AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='hosted_oidc_revoked_sessions' AND key=${bind(n.issuerSessionHash)}) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key=$4) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_locks' AND key=$4 AND document->>'operationId' NOT IN(SELECT key FROM ${table} WHERE bucket='identity_merge_operations' AND document->>'status'='active')) AND EXISTS(SELECT 1 FROM ${table} WHERE bucket='credential_unlink_receipts' AND key=${bind(r.receiptId)} AND document=${bind(JSON.stringify(r))}::jsonb)`;
    for (const tuple of [n.removedIdentity, n.retainedIdentity])
      condition += ` AND EXISTS(SELECT 1 FROM accounts_v1.upstream_identities i WHERE i.provider_id=${bind(tuple.providerId)} AND i.upstream_issuer=${bind(tuple.upstreamIssuer)} AND i.upstream_subject=${bind(tuple.upstreamSubject)} AND COALESCE((SELECT m.document->>'targetSubject' FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=i.subject),i.subject)=$4) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='upstream_identity_status' AND key=${bind(upstreamIdentityKey(tuple))} AND document ? 'disabledAt')`;
    // All intents for this account compete on one durable security epoch. A
    // concurrent transaction waiting on this UPDATE rechecks its expected
    // value after the winner commits (Postgres EvalPlanQual), so distinct
    // reciprocal intents cannot each disable the other's retained credential.
    await this.create("authentication_generations", n.subject, {
      subject: n.subject,
      generation: 0,
    });
    const epoch = bind(n.identityGeneration);
    // Also serialize against merge reserve/activation and every old/new
    // account writer participating in the additive inventory trigger.
    await this.create("email_candidate_inventory", "global", { generation: 0 });
    const inventory =
      (
        await this.get<{ generation: number }>(
          "email_candidate_inventory",
          "global",
        )
      )?.generation ?? 0;
    const inventoryEpoch = bind(inventory);
    const ctes = [
      `inventory_claim AS(UPDATE ${table} SET document=jsonb_set(document,'{generation}',to_jsonb((document->>'generation')::bigint+1)) WHERE bucket='email_candidate_inventory' AND key='global' AND (document->>'generation')::bigint=${inventoryEpoch} AND EXISTS(SELECT 1 FROM ${table} WHERE ${condition}) RETURNING key)`,
      `security_claim AS(UPDATE ${table} g SET document=jsonb_set(g.document,'{generation}',to_jsonb((g.document->>'generation')::integer+1)) WHERE g.bucket='authentication_generations' AND g.key=$4 AND (g.document->>'generation')::integer=${epoch} AND EXISTS(SELECT 1 FROM inventory_claim) AND EXISTS(SELECT 1 FROM ${table} WHERE ${condition}) RETURNING key)`,
      `changed AS(UPDATE ${table} SET document=$1::jsonb WHERE ${condition} AND EXISTS(SELECT 1 FROM security_claim) RETURNING key)`,
      `consume_receipt AS(UPDATE ${table} SET document=jsonb_set(document,'{consumedByOperation}',to_jsonb($2::text)) WHERE bucket='credential_unlink_receipts' AND key=${bind(r.receiptId)} AND EXISTS(SELECT 1 FROM changed) RETURNING key)`,
    ];
    const insert = (
      name: string,
      bucket: string,
      key: string,
      record: unknown,
    ) =>
      ctes.push(
        `${name} AS(INSERT INTO ${table}(bucket,key,document,subject) SELECT ${bind(bucket)},${bind(key)},${bind(JSON.stringify(record))}::jsonb,$4 FROM changed RETURNING key)`,
      );
    insert(
      "disable",
      "upstream_identity_status",
      upstreamIdentityKey(n.removedIdentity),
      {
        ...n.removedIdentity,
        identityKey: upstreamIdentityKey(n.removedIdentity),
        canonicalSubject: n.subject,
        disabledAt: now,
        operationId: n.operationId,
      },
    );
    insert(
      "audit",
      "identity_merge_audit",
      n.operationId,
      credentialUnlinkAudit(input),
    );
    this.revokeCtes(ctes, "SELECT 1 FROM changed", "subject IN($4)", now, bind);
    try {
      return (
        (
          await runQuery(
            this.client,
            `WITH ${ctes.join(",")} SELECT key FROM changed`,
            args,
          )
        ).rows.length === 1
      );
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }
  async unlink(input: UnlinkUpstreamIdentityInput): Promise<boolean> {
    const args: unknown[] = [
      input.subject,
      input.identity.providerId,
      input.identity.upstreamIssuer,
      input.identity.upstreamSubject,
      input.proof.sessionLookupHash ??
        (await hashSessionId(input.proof.sessionId!)),
      input.proof.authTime,
      input.now,
    ];
    const bind = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    const canonical = `coalesce((SELECT document->>'targetSubject' FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=i.subject),i.subject)`;
    const identityKey = upstreamIdentityKey(input.identity);
    const status = {
      identityKey,
      ...input.identity,
      canonicalSubject: input.subject,
      disabledAt: input.now,
      operationId: input.operationId,
    };
    const condition = `EXISTS(SELECT 1 FROM accounts_v1.upstream_identities i WHERE i.provider_id=$2 AND i.upstream_issuer=$3 AND i.upstream_subject=$4 AND ${canonical}=$1) AND EXISTS(SELECT 1 FROM accounts_v1.upstream_identities i WHERE ${canonical}=$1 AND NOT(i.provider_id=$2 AND i.upstream_issuer=$3 AND i.upstream_subject=$4) AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND d.document ? 'disabledAt' AND d.document->>'providerId'=i.provider_id AND d.document->>'upstreamIssuer'=i.upstream_issuer AND d.document->>'upstreamSubject'=i.upstream_subject)) AND EXISTS(SELECT 1 FROM accounts_v1.account_sessions WHERE session_id=$5 AND subject=$1 AND hosted_metadata->>'policy'='hosted' AND (hosted_metadata->>'reauthenticatedAt')::bigint=$6 AND expires_at>to_timestamp($7/1000.0) AND (hosted_metadata->>'absoluteExpiresAt')::bigint>$7 AND coalesce((hosted_metadata->>'identityGeneration')::integer,0)=coalesce((SELECT (g.document->>'generation')::integer FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=$1),0)) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_locks' AND key=$1 AND document->>'operationId' NOT IN(SELECT key FROM ${table} WHERE bucket='identity_merge_operations' AND document->>'status'='active'))`;
    const ctes = [
      `changed AS(INSERT INTO ${table}(bucket,key,document,subject) SELECT 'upstream_identity_status',${bind(identityKey)},${bind(JSON.stringify(status))}::jsonb,$1 WHERE ${condition} ON CONFLICT DO NOTHING RETURNING key)`,
    ];
    this.revokeCtes(
      ctes,
      `SELECT 1 FROM changed`,
      `subject IN($1)`,
      input.now,
      bind,
    );
    this.generationCtes(ctes, [input.subject], bind);
    ctes.push(
      `audit AS(INSERT INTO ${table}(bucket,key,document,subject) SELECT 'identity_merge_audit',${bind(input.operationId)},${bind(JSON.stringify({ operationId: input.operationId, subject: input.subject, decision: "credential_unlinked", identityKey, at: input.now }))}::jsonb,$1 FROM changed RETURNING key)`,
    );
    await this.create("credential_generations", input.subject, {
      subject: input.subject,
      revision: 0,
    });
    const generation = await this.get<{ revision: number }>(
      "credential_generations",
      input.subject,
    );
    ctes.unshift(
      `unlink_claim AS(UPDATE ${table} SET document=jsonb_set(document,'{revision}',to_jsonb(${bind((generation?.revision ?? 0) + 1)}::integer)) WHERE bucket='credential_generations' AND key=$1 AND (document->>'revision')::integer=${bind(generation?.revision ?? 0)} AND ${condition} RETURNING key)`,
    );
    ctes[1] = ctes[1].replace(
      `WHERE ${condition}`,
      `WHERE ${condition} AND EXISTS(SELECT 1 FROM unlink_claim)`,
    );
    try {
      return (
        (
          await runQuery(
            this.client,
            `WITH ${ctes.join(",")} SELECT key FROM changed`,
            args,
          )
        ).rows.length === 1
      );
    } catch (e) {
      if (isConflict(e)) return false;
      throw e;
    }
  }
}

function references(value: unknown): readonly [string | null, string | null] {
  const r = value as Record<string, unknown>;
  return [
    ((r.subject ?? r.targetSubject ?? r.canonicalSubject) as string) ?? null,
    (r.sourceSubject as string) ?? null,
  ];
}
function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}
