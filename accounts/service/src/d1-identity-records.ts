import { readReviewedRecoveryIssuerAvailabilityCheckpoint, consumeReviewedRecoveryIssuerAvailabilityCheckpoint } from "./reviewed-recovery-issuer-availability.ts";
import type { ReviewedRecoveryApprovalMutation } from "./reviewed-recovery-state.ts";
import { canonicalOwnerJson, ownerContextBucket, ownerReceiptBucket, reviewedApprovalBucket, reviewedApprovalCurrentBucket, reviewedApprovalRefBucket, reviewedApprovalRefKey } from "./owner-operation-evidence.ts";
import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
} from "./identity-unlink-state.ts";
import type { IdentityMergeRetryCheckpointMutation } from "./identity-state.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { D1Database, D1PreparedStatement } from "./d1-store.ts";
import type { IdentityRecordRepository } from "./hosted-identity-records.ts";
import type * as FS from "./identity-state.ts";
import type { FinancialSourceAtomicMutation } from "./hosted-identity-records.ts";
import { FinancialSourceDocumentRecords, financialSourceBuckets, financialSourceScopeKey, financialSourceJson, financialSourceEqual, validFinancialSourceAuthority } from "./hosted-identity-records.ts";
import { financialSourceRef } from "./financial-source-contract.ts";
import {
  assertMergeMutation,
  identityMergeProofAudit,
  assertCredentialUnlinkMutation,
  unlinkImmutableContext,
  credentialUnlinkAudit,
  identityRecordsEqual,
} from "./hosted-identity-records.ts";
import type {
  IdentityOperationReceiptRecord,
  IdentityMergeMutation,
  UnlinkUpstreamIdentityInput,
} from "./identity-state.ts";
import {
  MERGE_EMAIL_TRIM_CODE_POINTS,
  upstreamIdentityKey,
} from "./identity-state.ts";
import type { TakosumiAccountRecord, UpstreamIdentityRecord } from "./store.ts";

const table = "takosumi_accounts_documents";
// Compare semantic JSON including every leaf and container path. SQLite json()
// preserves object insertion order, so textual equality is insufficient here.
function financialJsonEquals(actual:string,expected:string):string {
  const leaves=(value:string)=>`SELECT fullkey,type,atom FROM json_tree(${value})`;
  return `(NOT EXISTS(${leaves(actual)} EXCEPT ${leaves(expected)}) AND NOT EXISTS(${leaves(expected)} EXCEPT ${leaves(actual)}))`;
}
function candidatePredicate(alias = ""): string {
  const column = alias ? `${alias}.document` : "document";
  const email = `trim(json_extract(${column},'$.email'),char(${MERGE_EMAIL_TRIM_CODE_POINTS.join(",")}))`;
  const domain = `substr(${email},instr(${email},'@')+1)`;
  // Unknown historical domain syntax cannot silently evade a third candidate.
  return `(lower(${email})=lower(?) OR (lower(substr(${email},1,instr(${email},'@')-1))=lower(?) AND (length(CAST(${domain} AS BLOB))<>length(${domain}) OR instr(${domain},'%')>0 OR instr(${domain},char(92))>0)))`;
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

/** All mutations use one bounded D1 batch, with <= 100 parameters per statement. */
export class D1IdentityRecordRepository implements IdentityRecordRepository {
  constructor(
    readonly db: D1Database,
    readonly initialize: () => Promise<void>,
    readonly hashSession: (value: string) => Promise<string>,
  ) {}
  private financialRecords(): FinancialSourceDocumentRecords {
    return new FinancialSourceDocumentRecords(this, (input) => this.commitFinancialSourceDocuments(input));
  }
  registerFinancialSourceRegistration(value: Parameters<IdentityRecordRepository["registerFinancialSourceRegistration"]>[0]) { return this.financialRecords().registerFinancialSourceRegistration(value); }
  findFinancialSourceRegistration(value: string) { return this.financialRecords().findFinancialSourceRegistration(value); }
  findFinancialSourceParent(value: FS.FinancialSourceParentScope) { return this.financialRecords().findFinancialSourceParent(value); }
  enrollFinancialSourceParents(value: FS.FinancialSourceEnrollmentMutation) { return this.financialRecords().enrollFinancialSourceParents(value); }
  issueFinancialSourceProof(value: FS.FinancialSourceProofMutation) { return this.financialRecords().issueFinancialSourceProof(value); }
  findFinancialSourceProof(value: string) { return this.financialRecords().findFinancialSourceProof(value); }
  findFinancialSourceRaw(value: string) { return this.financialRecords().findFinancialSourceRaw(value); }
  listFinancialSourcePending(value: Parameters<IdentityRecordRepository["listFinancialSourcePending"]>[0]) { return this.financialRecords().listFinancialSourcePending(value); }
  findFinancialSourceMaterialization(value: string) { return this.financialRecords().findFinancialSourceMaterialization(value); }
  commitFinancialSourceMaterialization(value: FS.FinancialSourceMaterializationMutation) { return this.financialRecords().commitFinancialSourceMaterialization(value); }
  findFinancialSourceReceipt(value: Parameters<IdentityRecordRepository["findFinancialSourceReceipt"]>[0]) { return this.financialRecords().findFinancialSourceReceipt(value); }
  recordFinancialSourceReceipt(value: FS.FinancialSourceReceiptMutation) { return this.financialRecords().recordFinancialSourceReceipt(value); }

  /** All reads and checkpoint consumption have finished in the shared planner.
   * Do not insert an await before this single atomic batch is dispatched. */
  private async commitFinancialSourceDocuments(input: FinancialSourceAtomicMutation): Promise<boolean> {
    if (!input.writes.length || input.writes.length > 64 || input.checks.length > 64) return false;
    const rows = new Map<string, { bucket: string; key: string; record: unknown; exists: boolean }>();
    for (const check of [...input.checks, ...input.writes]) {
      const key=financialSourceJson([check.bucket,check.key]), prior=rows.get(key);
      if(prior && (prior.exists !== (check.record!==undefined) || !financialSourceEqual(prior.record,check.record)))return false;
      rows.set(key,{bucket:check.bucket,key:check.key,record:check.record,exists:check.record!==undefined});
    }
    const args: Array<string|number>=[financialSourceJson([...rows.values()])];
    let guard=`NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE (json_extract(e.value,'$.exists')=0 AND EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket=json_extract(e.value,'$.bucket') AND d.key=json_extract(e.value,'$.key'))) OR (json_extract(e.value,'$.exists')=1 AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket=json_extract(e.value,'$.bucket') AND d.key=json_extract(e.value,'$.key') AND ${financialJsonEquals("d.document","json_extract(e.value,'$.record')")})))`;
    if(input.authority){
      if(!validFinancialSourceAuthority(input.authority,input.now))return false;
      const a=input.authority,g=a.expectedGrant;
      guard+=` AND EXISTS(SELECT 1 FROM ${table} a WHERE a.bucket='access_tokens' AND a.key=? AND ${financialJsonEquals("a.document","?")} AND json_extract(a.document,'$.expiresAt')>?) AND EXISTS(SELECT 1 FROM ${table} g WHERE g.bucket='hosted_oidc_grants' AND g.key=? AND ${financialJsonEquals("g.document","?")} AND json_type(g.document,'$.revokedAt') IS NULL AND json_extract(g.document,'$.absoluteExpiresAt')>?) AND EXISTS(SELECT 1 FROM ${table} WHERE bucket='accounts' AND key=?) AND COALESCE((SELECT json_extract(document,'$.generation') FROM ${table} WHERE bucket='authentication_generations' AND key=?),0)=? AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key=?) AND NOT EXISTS(SELECT 1 FROM ${table} l WHERE l.bucket='identity_merge_locks' AND l.key=? AND NOT EXISTS(SELECT 1 FROM ${table} o WHERE o.bucket='identity_merge_operations' AND o.key=json_extract(l.document,'$.operationId') AND json_extract(o.document,'$.status')='active')) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE (bucket='hosted_oidc_revoked_sessions' AND key=?) OR (bucket='hosted_oidc_revoked_clients' AND key=?))`;
      // financialJsonEquals uses each supplied expression twice.
      const access=financialSourceJson(a.expectedAccess),grant=financialSourceJson(g);
      args.push(a.accessTokenHash,access,access,input.now,g.sid,grant,grant,input.now,g.subject,g.subject,a.expectedIdentityGeneration,g.subject,g.subject,g.issuerSessionId,g.clientId);
    }
    const attempt=crypto.randomUUID(),claimBucket="financial_source_cas_claims";
    const claim=this.db.prepare(`INSERT INTO ${table}(bucket,key,document,updated_at) SELECT '${claimBucket}',?,'{}',? WHERE ${guard}`).bind(attempt,input.now,...args);
    const claimed=`EXISTS(SELECT 1 FROM ${table} WHERE bucket='${claimBucket}' AND key=?)`;
    const statements=[claim,...input.writes.map(write=>write.next===undefined
      ?this.db.prepare(`DELETE FROM ${table} WHERE bucket=? AND key=? AND ${claimed}`).bind(write.bucket,write.key,attempt)
      :this.db.prepare(`INSERT INTO ${table}(bucket,key,document,updated_at) SELECT ?,?,?,? WHERE ${claimed} ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at`).bind(write.bucket,write.key,financialSourceJson(write.next),input.now,attempt)),
      this.db.prepare(`DELETE FROM ${table} WHERE bucket='${claimBucket}' AND key=?`).bind(attempt)];
    const result=await this.db.batch(statements);
    if(result.some(r=>!r.success))throw new Error("financial_source_atomic_batch_failed");
    return Number(result[0]?.meta?.changes??0)===1;
  }
  async revokeHostedOidcScope(input: FS.FinancialSourceRevocationMutation): Promise<boolean> {
    financialSourceScopeKey(input.scope);
    if(!financialSourceRef(input.evidenceRef)||!Number.isSafeInteger(input.now)||input.now<0)return false;
    await this.initialize();
    const s=input.scope,field=s.kind==="grant"?"sid":s.kind==="issuer-session"?"issuerSessionId":"clientId";
    const value=s.kind==="grant"?s.sid:s.kind==="issuer-session"?s.issuerSessionId:s.clientId;
    const cause:FS.FinancialSourceRawCause=s.kind==="grant"?{kind:"grant-revoked",sid:s.sid,revokedAt:input.now}:s.kind==="issuer-session"?{kind:"issuer-session-revoked",issuerSessionId:s.issuerSessionId,revokedAt:input.now}:{kind:"client-revoked",clientId:s.clientId,revokedAt:input.now};
    const statements=this.financialCloseStatements({scope:s,cause,evidenceRef:input.evidenceRef,now:input.now},"1",[]);
    if(s.kind!=="grant"){
      const bucket=s.kind==="issuer-session"?"hosted_oidc_revoked_sessions":"hosted_oidc_revoked_clients";
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) VALUES(?,?,?,?)`).bind(bucket,value,financialSourceJson({[field]:value,revokedAt:input.now}),input.now));
    }
    statements.push(this.db.prepare(`UPDATE ${table} SET document=json_set(document,'$.revokedAt',?),updated_at=? WHERE bucket='hosted_oidc_grants' AND json_extract(document,'$.${field}')=? AND json_type(document,'$.revokedAt') IS NULL`).bind(input.now,input.now,value));
    const result=await this.db.batch(statements);
    if(result.some(r=>!r.success))throw new Error("financial_source_revoke_batch_failed");
    return true;
  }

  /** SQLite executes the entire batch under one write transaction. Derive the
   * closing head from that transaction's current envelope, never a stale JS read.
   * An unseen scope is fenced without fabricating a genesis event. */
  private financialCloseStatements(input: {
    scope?: FS.FinancialSourceParentScope;
    subject?: string;
    cause: FS.FinancialSourceRawCause | {kind:"identity-generation-advanced";operationId:string;operationRevision:number;reason:"reserve"|"activate"|"quarantine"|"abort"|"restore"|"unlink";legacyUnlink?:true};
    evidenceRef: string; now:number;
  },guard:string,guardArgs:readonly(string|number)[]):D1PreparedStatement[]{
    const attempt=crypto.randomUUID(),payload=financialSourceJson({...input,attempt});
    const gen=`COALESCE((SELECT json_extract(document,'$.generation') FROM ${table} WHERE bucket='authentication_generations' AND key=json_extract(p,'$.subject')),0)`;
    const scope=input.scope?`json_extract(p,'$.scope')`:`json_object('identityGeneration',${gen},'kind','account-generation','subject',json_extract(p,'$.subject'))`;
    const cause=input.scope?`json_extract(p,'$.cause')`:`json_patch(json_extract(p,'$.cause'),json_object('subject',json_extract(p,'$.subject'),'previousGeneration',json_extract(scope,'$.identityGeneration'),'nextGeneration',json_extract(scope,'$.identityGeneration')+1))`;
    const cte=`WITH payload(p) AS(SELECT ?), scoped AS(SELECT p,${scope} AS scope FROM payload), closing AS(SELECT p,scope,${cause} AS cause FROM scoped)`;
    const doc=`${table}.document`,head=`json_extract(${doc},'$.head')`;
    const raw=`json_object('v',1,'eventRef',json_extract(${head},'$.affectedRef')||'/closed','registrationRef',json_extract(${head},'$.registrationRef'),'incarnation',json_extract(${head},'$.incarnation'),'sequence',json_extract(${head},'$.sequence')+1,'previousEventRef',json_extract(${head},'$.lastEventRef'),'kind','close','affectedRef',json_extract(${head},'$.affectedRef'),'evidenceRef',(SELECT json_extract(p,'$.evidenceRef') FROM closing))`;
    const record=`json_object('raw',${raw},'parent',json_extract(${doc},'$.scope'),'parentRevision',json_extract(${head},'$.revision')+1,'cause',json((SELECT cause FROM closing)),'capturedAt',(SELECT json_extract(p,'$.now') FROM closing))`;
    const changed=`json_object('scope',json_extract(${doc},'$.scope'),'closed',json('true'),'head',json_set(${head},'$.state','closed','$.revision',json_extract(${head},'$.revision')+1,'$.sequence',json_extract(${head},'$.sequence')+1,'$.lastEventRef',json_extract(${head},'$.affectedRef')||'/closed','$.updatedAt',(SELECT json_extract(p,'$.now') FROM closing)),'lastRaw',${record},'closureAttemptId',(SELECT json_extract(p,'$.attempt') FROM closing))`;
    const close=this.db.prepare(`${cte} INSERT INTO ${table}(bucket,key,document,updated_at) SELECT '${financialSourceBuckets.parents}',scope,json_object('scope',json(scope),'closed',json('true'),'closureAttemptId',json_extract(p,'$.attempt')),json_extract(p,'$.now') FROM closing WHERE ${guard} ON CONFLICT(bucket,key) DO UPDATE SET document=CASE WHEN json_extract(${doc},'$.closed')=1 THEN ${doc} WHEN json_extract(${doc},'$.closed')=0 AND json_extract(${head},'$.state')='open' AND json_extract(${head},'$.v')=1 AND json_type(${head},'$.revision')='integer' AND json_extract(${head},'$.revision') BETWEEN 0 AND 9007199254740990 AND json_type(${head},'$.sequence')='integer' AND json_extract(${head},'$.sequence') BETWEEN 1 AND 9007199254740990 AND json_extract(${head},'$.updatedAt')<=(SELECT json_extract(p,'$.now') FROM closing) AND json_extract(${head},'$.lastEventRef')=json_extract(${doc},'$.lastRaw.raw.eventRef') AND json_extract(${head},'$.sequence')=json_extract(${doc},'$.lastRaw.raw.sequence') AND json_extract(${head},'$.revision')=json_extract(${doc},'$.lastRaw.parentRevision') AND json_extract(${head},'$.scope')=json_extract(${doc},'$.scope') AND json_extract(${doc},'$.scope')=(SELECT scope FROM closing) THEN ${changed} ELSE json('financial_parent_conflict') END,updated_at=CASE WHEN json_extract(${doc},'$.closed')=1 THEN ${table}.updated_at ELSE excluded.updated_at END`).bind(payload,...guardArgs);
    const selected=`FROM ${table} h JOIN closing c ON h.key=c.scope LEFT JOIN ${table} r ON r.bucket='${financialSourceBuckets.registrations}' AND r.key=json_extract(h.document,'$.head.registrationRef') WHERE h.bucket='${financialSourceBuckets.parents}' AND json_extract(h.document,'$.closureAttemptId')=json_extract(c.p,'$.attempt') AND json_type(h.document,'$.head')='object'`;
    const rawInsert=this.db.prepare(`${cte} INSERT INTO ${table}(bucket,key,document,updated_at) SELECT '${financialSourceBuckets.raw}',json_extract(h.document,'$.lastRaw.raw.eventRef'),CASE WHEN r.key IS NULL OR json_extract(r.document,'$.incarnation')<>json_extract(h.document,'$.head.incarnation') OR NOT EXISTS(SELECT 1 FROM ${table} a WHERE a.bucket='${financialSourceBuckets.affected}' AND a.key=json_extract(h.document,'$.head.affectedRef') AND json_extract(a.document,'$.affectedRef')=a.key AND json_extract(a.document,'$.scope')=json_extract(h.document,'$.scope') AND json_extract(a.document,'$.registrationRef')=r.key AND json_extract(a.document,'$.incarnation')=json_extract(r.document,'$.incarnation')) THEN json('financial_registration_or_custody_missing') ELSE json_extract(h.document,'$.lastRaw') END,json_extract(c.p,'$.now') ${selected}`).bind(payload);
    const pendingInsert=this.db.prepare(`${cte} INSERT INTO ${table}(bucket,key,document,updated_at) SELECT '${financialSourceBuckets.pending}',json_array(json_extract(h.document,'$.head.registrationRef'),json_extract(h.document,'$.lastRaw.raw.eventRef')),json_object('registration',json(r.document),'eventRef',json_extract(h.document,'$.lastRaw.raw.eventRef'),'createdAt',json_extract(c.p,'$.now')),json_extract(c.p,'$.now') ${selected}`).bind(payload);
    return [close,rawInsert,pendingInsert];
  }
  async commitReviewedRecoveryApproval(input: ReviewedRecoveryApprovalMutation): Promise<boolean> {
    await this.initialize();
    const {record:r,pointer:p}=input,a=r.approval;
    const ref={operationId:a.operationId,recoveryId:a.recoveryId,reviewedApprovalRef:a.reviewedApprovalRef,approvalDigest:r.approvalDigest};
    const params:Array<string|number>=[];const bind=(v:string|number)=>{params.push(v);return "?";};
    let guard=`EXISTS(SELECT 1 FROM ${table} o WHERE o.bucket='identity_merge_operations' AND o.key=${bind(a.operationId)} AND json_extract(o.document,'$.revision')=${bind(a.operationRevision)} AND json_extract(o.document,'$.sourceSubject')=${bind(a.sourceAccountId)} AND json_extract(o.document,'$.targetSubject')=${bind(a.targetAccountId)} AND json_extract(o.document,'$.contextPlan.planDigest')=${bind(a.planDigest)} AND json_extract(o.document,'$.consentAt') IS NOT NULL AND json_extract(o.document,'$.status') ${a.mode==="abort-before-active"?"IN ('proved','reconciled','quarantined')":"='quarantined'"})`;
    for(const [subject,generation]of [[a.sourceAccountId,a.sourceIdentityGeneration],[a.targetAccountId,a.targetIdentityGeneration]]as const){guard+=` AND EXISTS(SELECT 1 FROM ${table} l WHERE l.bucket='identity_merge_locks' AND l.key=${bind(subject)} AND json_extract(l.document,'$.operationId')=${bind(a.operationId)}) AND COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=${bind(subject)}),0)=${bind(generation)}`;}
    for(const [subject,canonical]of [[a.sourceAccountId,a.mode==="abort-before-active"?a.sourceAccountId:a.targetAccountId],[a.targetAccountId,a.targetAccountId]]as const)guard+=` AND COALESCE((SELECT json_extract(c.document,'$.targetSubject') FROM ${table} c WHERE c.bucket='canonical_accounts' AND c.key=${bind(subject)}),${bind(subject)})=${bind(canonical)}`;
    guard+=` AND NOT EXISTS(SELECT 1 FROM ${table} h WHERE h.bucket='${reviewedApprovalBucket}' AND h.key=${bind(r.approvalDigest)} AND json(h.document)<>${bind(canonicalOwnerJson(r))})`;
    const refKey=reviewedApprovalRefKey(a);
    guard+=` AND NOT EXISTS(SELECT 1 FROM ${table} f WHERE f.bucket='${reviewedApprovalRefBucket}' AND f.key=${bind(refKey)} AND json(f.document)<>${bind(canonicalOwnerJson(ref))})`;
    if(input.expectedApprovalDigest!==undefined)guard+=` AND EXISTS(SELECT 1 FROM ${table} h WHERE h.bucket='${reviewedApprovalBucket}' AND h.key=${bind(input.expectedApprovalDigest)} AND json_extract(h.document,'$.decisionDigest')=${bind(r.decisionDigest)} AND json_extract(h.document,'$.approval.createdAt')<${bind(a.createdAt)})`;
    const newRecordGuard=`${guard} AND NOT EXISTS(SELECT 1 FROM ${table} h WHERE h.bucket='${reviewedApprovalBucket}' AND h.key=?) AND NOT EXISTS(SELECT 1 FROM ${table} f WHERE f.bucket='${reviewedApprovalRefBucket}' AND f.key=?)`;
    const newParams=[...params,r.approvalDigest,refKey];
    const first=input.expectedApprovalDigest===undefined
      ?this.db.prepare(`INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT '${reviewedApprovalCurrentBucket}',?,?,? WHERE ${newRecordGuard}`).bind(a.operationId,canonicalOwnerJson(p),p.updatedAt,...newParams)
      :this.db.prepare(`UPDATE ${table} SET document=?,updated_at=? WHERE bucket='${reviewedApprovalCurrentBucket}' AND key=? AND json_extract(document,'$.approvalDigest')=? AND json_extract(document,'$.revision')=? AND json_extract(document,'$.operationId')=? AND ${newRecordGuard}`).bind(canonicalOwnerJson(p),p.updatedAt,a.operationId,input.expectedApprovalDigest,p.revision-1,a.operationId,...newParams);
    const claim=`EXISTS(SELECT 1 FROM ${table} c WHERE c.bucket='${reviewedApprovalCurrentBucket}' AND c.key=? AND json_extract(c.document,'$.mutationId')=?) AND changes()=1`;
    const statements=[first,
      this.db.prepare(`INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT '${reviewedApprovalBucket}',?,?,? WHERE ${claim}`).bind(r.approvalDigest,canonicalOwnerJson(r),p.updatedAt,a.operationId,p.mutationId),
      this.db.prepare(`INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT '${reviewedApprovalRefBucket}',?,?,? WHERE ${claim}`).bind(refKey,canonicalOwnerJson(ref),p.updatedAt,a.operationId,p.mutationId),
    ];
    const result=await this.db.batch(statements);
    if(Number(result[0]?.meta?.changes??0)===1)return true;
    const replay=await this.db.prepare(`SELECT c.key FROM ${table} c WHERE c.bucket='${reviewedApprovalCurrentBucket}' AND c.key=? AND json_extract(c.document,'$.approvalDigest')=? AND json_extract(c.document,'$.revision')=? AND json_extract(c.document,'$.operationId')=? AND EXISTS(SELECT 1 FROM ${table} h WHERE h.bucket='${reviewedApprovalBucket}' AND h.key=? AND json(h.document)=?) AND EXISTS(SELECT 1 FROM ${table} f WHERE f.bucket='${reviewedApprovalRefBucket}' AND f.key=? AND json(f.document)=?) AND ${guard}`).bind(a.operationId,r.approvalDigest,p.revision,a.operationId,r.approvalDigest,canonicalOwnerJson(r),refKey,canonicalOwnerJson(ref),...params).first<{key:string}>();
    return !!replay;
  }
  async get<T>(bucket: string, key: string): Promise<T | undefined> {
    await this.initialize();
    const row = await this.db
      .prepare(`SELECT document FROM ${table} WHERE bucket = ? AND key = ?`)
      .bind(bucket, key)
      .first<{ document: string }>();
    return row ? (JSON.parse(row.document) as T) : undefined;
  }
  async put(bucket: string, key: string, record: unknown): Promise<void> {
    await this.initialize();
    const refs = references(record, bucket);
    const result = await this.db
      .prepare(
        `INSERT INTO ${table} (bucket,key,document,updated_at) SELECT ?,?,?,? WHERE ${refs.map(() => `EXISTS(SELECT 1 FROM ${table} WHERE bucket='accounts' AND key=?)`).join(" AND ") || "1"} ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at`,
      )
      .bind(bucket, key, JSON.stringify(record), Date.now(), ...refs)
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1)
      throw new Error("identity_record_subject_missing");
  }
  async create(bucket: string, key: string, record: unknown): Promise<boolean> {
    await this.initialize();
    const refs = references(record, bucket);
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO ${table} (bucket,key,document,updated_at) SELECT ?,?,?,? WHERE ${refs.map(() => `EXISTS(SELECT 1 FROM ${table} WHERE bucket='accounts' AND key=?)`).join(" AND ") || "1"}`,
      )
      .bind(bucket, key, JSON.stringify(record), Date.now(), ...refs)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
  async consume<T>(
    bucket: string,
    key: string,
    binding: string,
    now: number,
  ): Promise<T | undefined> {
    await this.initialize();
    const row = await this.db
      .prepare(
        `DELETE FROM ${table} WHERE bucket=? AND key=? AND json_extract(document,'$.browserBindingHash')=? AND json_extract(document,'$.expiresAt')>? RETURNING document`,
      )
      .bind(bucket, key, binding, now)
      .first<{ document: string }>();
    return row ? (JSON.parse(row.document) as T) : undefined;
  }
  async query<T>(
    bucket: string,
    field: string,
    value: string,
    limit: number,
  ): Promise<readonly T[]> {
    if (!fields.has(field) || limit > 101 || limit < 1)
      throw new TypeError("invalid_identity_record_query");
    await this.initialize();
    const result = await this.db
      .prepare(
        `SELECT document FROM ${table} WHERE bucket=? AND json_extract(document,'$.${field}')=? ORDER BY updated_at DESC,key LIMIT ?`,
      )
      .bind(bucket, value, limit)
      .all<{ document: string }>();
    return (result.results ?? []).map((row) => JSON.parse(row.document) as T);
  }
  async revokeGrants(
    field: "issuerSessionId" | "clientId" | "sid",
    value: string,
    now: number,
  ): Promise<void> {
    const scope:FS.FinancialSourceRevocationMutation["scope"]=field==="sid"?{kind:"grant",sid:value}:field==="issuerSessionId"?{kind:"issuer-session",issuerSessionId:value}:{kind:"client",clientId:value};
    if(!await this.revokeHostedOidcScope({scope,evidenceRef:crypto.randomUUID(),now}))throw new Error("hosted_scope_revoke_failed");
  }
  async emailCandidates(
    address: string,
  ): Promise<readonly TakosumiAccountRecord[]> {
    await this.initialize();
    const result = await this.db
      .prepare(
        `SELECT document FROM ${table} WHERE bucket='accounts' AND ${candidatePredicate()} ORDER BY key LIMIT 3`,
      )
      .bind(address, address.slice(0, address.lastIndexOf("@")))
      .all<{ document: string }>();
    return (result.results ?? []).map(
      (row) => JSON.parse(row.document) as TakosumiAccountRecord,
    );
  }
  async listIdentities(
    subject: TakosumiSubject,
  ): Promise<readonly UpstreamIdentityRecord[]> {
    await this.initialize();
    const results = await this.db
      .prepare(
        `SELECT i.document FROM ${table} i WHERE i.bucket='upstream_identities' AND (json_extract(i.document,'$.subject')=? OR json_extract(i.document,'$.subject') IN (SELECT key FROM ${table} WHERE bucket='canonical_accounts' AND json_extract(document,'$.targetSubject')=?)) AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND d.key=json_array(json_extract(i.document,'$.providerId'),json_extract(i.document,'$.upstreamIssuer'),json_extract(i.document,'$.upstreamSubject')) AND json_type(d.document,'$.disabledAt') IS NOT NULL) ORDER BY i.key LIMIT 101`,
      )
      .bind(subject, subject)
      .all<{ document: string }>();
    return (results.results ?? []).map(
      (row) => JSON.parse(row.document) as UpstreamIdentityRecord,
    );
  }
  async touchSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean> {
    await this.initialize();
    const hash = await this.hashSession(sessionId);
    const result = await this.db
      .prepare(
        `UPDATE ${table} SET document=json_set(document,'$.expiresAt',min(?,json_extract(document,'$.absoluteExpiresAt'))),updated_at=? WHERE bucket='account_sessions' AND key=? AND json_extract(document,'$.policy')='hosted' AND json_extract(document,'$.expiresAt')>? AND json_extract(document,'$.absoluteExpiresAt')>?`,
      )
      .bind(idleExpiresAt, now, hash, now, now)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }
  async mutateMerge(input: IdentityMergeMutation): Promise<boolean> {
    assertMergeMutation(input);
    await this.initialize();
    const sessionLookups = new Map<NonNullable<IdentityMergeMutation["sessions"]>[number], string>();
    for (const proof of input.sessions ?? [])
      sessionLookups.set(proof, proof.sessionLookupHash ?? await this.hashSession(proof.sessionId!));
    if (input.availabilityCheckpoint !== undefined) {
      const freshNow = readReviewedRecoveryIssuerAvailabilityCheckpoint(input.availabilityCheckpoint, input);
      if (freshNow === undefined) return false;
      input = { ...input, now: freshNow };
      try { assertMergeMutation(input); } catch { return false; }
      if (input.emailProofs?.some((proof) => proof.validUntil <= freshNow || proof.observedAt > freshNow)) return false;
    }
    const next = input.next;
    const args: Array<string | number> = [
      JSON.stringify(next),
      input.now,
      next.operationId,
      input.expectedRevision,
      next.sourceSubject,
      next.targetSubject,
    ];
    let conditions = `json_extract(document,'$.sourceSubject')=? AND json_extract(document,'$.targetSubject')=? AND EXISTS(SELECT 1 FROM ${table} a WHERE a.bucket='accounts' AND a.key=json_extract(${table}.document,'$.sourceSubject')) AND EXISTS(SELECT 1 FROM ${table} a WHERE a.bucket='accounts' AND a.key=json_extract(${table}.document,'$.targetSubject'))`;
    if (
      !input.quarantine &&
      !input.restore &&
      !input.abort &&
      !input.requireRecovery
    ) {
      conditions += ` AND json_extract(document,'$.expiresAt')>? AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key IN (?,?))`;
      args.push(input.now, next.sourceSubject, next.targetSubject);
    }
    if (input.restore) {
      conditions += ` AND json_extract(document,'$.status')='quarantined' AND EXISTS(SELECT 1 FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=? AND json_extract(m.document,'$.targetSubject')=? AND json_extract(m.document,'$.operationId')=?)`;
      args.push(next.sourceSubject, next.targetSubject, next.operationId);
    }
    if (input.abort) {
      conditions += ` AND json_extract(document,'$.consentAt') IS NOT NULL AND json_extract(document,'$.status') IN('proved','reconciled','quarantined') AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key IN (?,?)) AND (SELECT count(*) FROM ${table} WHERE bucket='identity_merge_locks' AND key IN (?,?) AND json_extract(document,'$.operationId')=?)=2`;
      args.push(
        next.sourceSubject,
        next.targetSubject,
        next.sourceSubject,
        next.targetSubject,
        next.operationId,
      );
    }
    if (input.requireRecovery) {
      conditions += ` AND json_extract(document,'$.consentAt') IS NOT NULL AND json_extract(document,'$.status')=? AND json_extract(document,'$.status') IN('proved','reconciled') AND (json_extract(document,'$.expiresAt')<=? OR EXISTS(SELECT 1 FROM ${table} r WHERE r.bucket='identity_operation_receipts' AND r.key IN(json_extract(${table}.document,'$.sourceProof.receiptId'),json_extract(${table}.document,'$.targetProof.receiptId')) AND json_extract(r.document,'$.expiresAt')<=?) OR EXISTS(SELECT 1 FROM ${table} e WHERE e.bucket='account_email_proofs' AND e.key IN(?,?) AND json_extract(e.document,'$.validUntil')<=?))`;
      args.push(
        next.status,
        input.now,
        input.now,
        next.sourceSubject,
        next.targetSubject,
        input.now,
      );
    }
    for (const proof of input.sessions ?? []) {
      conditions += ` AND EXISTS(SELECT 1 FROM ${table} s WHERE s.bucket='account_sessions' AND s.key=? AND json_extract(s.document,'$.subject')=? AND json_extract(s.document,'$.${proof.reauthentication === false ? "authTime" : "reauthenticatedAt"}')=? AND json_extract(s.document,'$.expiresAt')>? AND json_extract(s.document,'$.absoluteExpiresAt')>? AND json_extract(s.document,'$.policy')='hosted' AND COALESCE(json_extract(s.document,'$.identityGeneration'),0)=COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=json_extract(s.document,'$.subject')),0))`;
      args.push(
        sessionLookups.get(proof)!,
        proof.subject,
        proof.authTime,
        input.now,
        input.now,
      );
    }
    for (const proof of input.emailProofs ?? []) {
      conditions += ` AND EXISTS(SELECT 1 FROM ${table} e JOIN ${table} a ON a.bucket='accounts' AND a.key=e.key WHERE e.bucket='account_email_proofs' AND e.key=? AND e.document=? AND json_extract(a.document,'$.email')=? AND json_extract(a.document,'$.emailVerified')=1)`;
      args.push(proof.subject, JSON.stringify(proof), proof.address);
    }
    if (input.emailProofs?.length) {
      const address = input.emailProofs[0]!.normalizedAddress;
      conditions += ` AND (SELECT count(*) FROM ${table} c WHERE c.bucket='accounts' AND ${candidatePredicate("c")})=2`;
      args.push(address, address.slice(0, address.lastIndexOf("@")));
    }
    if (input.receipt)
      conditions += this.receiptCondition(
        input.receipt,
        next,
        input.now,
        false,
        0,
        args,
      );
    for (const receipt of input.proofReceipts ?? [])
      conditions += this.receiptCondition(
        receipt,
        next,
        input.now,
        true,
        input.activate || next.status === "reconciled" ? 1 : 0,
        args,
      );
    if (next.contextPlan) {
      conditions += ` AND (json_type(document,'$.contextPlan') IS NULL OR json_extract(document,'$.contextPlan')=json_extract(?,'$.contextPlan'))`;
      args.push(JSON.stringify(next));
    } else conditions += ` AND json_type(document,'$.contextPlan') IS NULL`;
    if (input.contextPlanRecord) {
      conditions += ` AND EXISTS(SELECT 1 FROM ${table} p WHERE p.bucket='identity_merge_context_plans' AND p.key=? AND p.document=?)`;
      args.push(
        input.contextPlanRecord.planId,
        JSON.stringify(input.contextPlanRecord),
      );
    }
    const contexts = input.contextReceipt
      ? [input.contextReceipt]
      : (input.contextReceipts ?? []);
    if (contexts.length) {
      conditions += ` AND (SELECT count(*) FROM json_each(?) e JOIN ${table} c ON c.bucket='identity_merge_context_receipts' AND c.key=json_extract(e.value,'$.receiptId') WHERE NOT EXISTS(SELECT 1 FROM json_each(e.value) f WHERE json_extract(c.document,'$.'||f.key) IS NOT f.value) AND json_extract(c.document,'$.identityGeneration')+?=COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=json_extract(c.document,'$.subject')),0) AND NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.bucket='hosted_oidc_revoked_sessions' AND x.key=json_extract(c.document,'$.issuerSessionHash')))=?`;
      args.push(
        JSON.stringify(contexts),
        input.activate || next.status === "reconciled" ? 1 : 0,
        contexts.length,
      );
      if (input.contextReceipt)
        conditions += ` AND json_type(document,'$.${input.contextReceipt.role === "source" ? "sourceContextAcceptance" : "targetContextAcceptance"}') IS NULL`;
    }
    if (input.activate) {
      conditions += ` AND json_extract(document,'$.status')='reconciled' AND (SELECT count(*) FROM ${table} l WHERE l.bucket='identity_merge_locks' AND l.key IN (?,?) AND json_extract(l.document,'$.operationId')=?)=2`;
      args.push(next.sourceSubject, next.targetSubject, next.operationId);
    }
    if (input.reserve || input.activate) {
      conditions += ` AND NOT EXISTS(SELECT 1 FROM ${table} l WHERE l.bucket='identity_merge_locks' AND l.key IN (?,?) AND json_extract(l.document,'$.operationId')<>?)`;
      args.push(next.sourceSubject, next.targetSubject, next.operationId);
    }
    if (input.reserve) {
      conditions += ` AND (SELECT count(*) FROM(SELECT key FROM ${table} WHERE bucket='identity_merge_retry_pending' LIMIT ?))<?`;
      args.push(input.retryCapacity!, input.retryCapacity!);
    }
    // A distinct attempt claim is retained for each consumed revision. Even an
    // exact retry with the same next mutationId cannot replay revocations or
    // advance generations again after the first operation committed.
    const claimKey = `${next.operationId}:${input.expectedRevision}`;
    const attemptId = crypto.randomUUID();
    const guard = `EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_cas_claims' AND key=? AND json_extract(document,'$.attemptId')=?)`;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT 'identity_merge_cas_claims',?,?,? FROM ${table} WHERE bucket='identity_merge_operations' AND key=? AND json_extract(document,'$.revision')=? AND ${conditions}`,
        )
        .bind(
          claimKey,
          JSON.stringify({
            operationId: next.operationId,
            revision: input.expectedRevision,
            attemptId,
          }),
          input.now,
          ...args.slice(2),
        ),
      this.db
        .prepare(
          `UPDATE ${table} SET document=?,updated_at=? WHERE bucket='identity_merge_operations' AND key=? AND json_extract(document,'$.revision')=? AND ${conditions} AND ${guard}`,
        )
        .bind(...args, claimKey, attemptId),
    ];
    if(input.reserve||input.activate||input.quarantine||input.restore||input.abort){
      const reason=input.reserve?"reserve":input.activate?"activate":input.quarantine?"quarantine":input.restore?"restore":"abort";
      for(const subject of [next.sourceSubject,next.targetSubject])statements.push(...this.financialCloseStatements({subject,cause:{kind:"identity-generation-advanced",operationId:next.operationId,operationRevision:next.revision,reason},evidenceRef:next.operationId,now:input.now},guard,[claimKey,attemptId]));
    }
    const gatedInsert = (
      bucket: string,
      key: string,
      record: unknown,
      strict = false,
    ) =>
      this.db
        .prepare(
          `INSERT ${strict ? "" : "OR IGNORE "}INTO ${table}(bucket,key,document,updated_at) SELECT ?,?,?,? WHERE ${guard}`,
        )
        .bind(
          bucket,
          key,
          JSON.stringify(record),
          input.now,
          claimKey,
          attemptId,
        );
    statements.push(
      gatedInsert(
        "identity_merge_audit",
        `${next.operationId}:${next.revision}`,
        auditRecord(input),
        true,
      ),
    );
    if (input.contextReceipt)
      statements.push(
        this.db
          .prepare(
            `UPDATE ${table} SET document=json_set(document,'$.consumedByOperation',?,'$.consumedAt',?),updated_at=? WHERE bucket='identity_merge_context_receipts' AND key=? AND ${guard}`,
          )
          .bind(
            next.operationId,
            input.now,
            input.now,
            input.contextReceipt.receiptId,
            claimKey,
            attemptId,
          ),
      );
    if (input.receipt)
      statements.push(
        this.db
          .prepare(
            `UPDATE ${table} SET document=json_set(document,'$.consumedByOperation',?,'$.consumedAt',?),updated_at=? WHERE bucket='identity_operation_receipts' AND key=? AND ${guard}`,
          )
          .bind(
            next.operationId,
            input.now,
            input.now,
            input.receipt.receiptId,
            claimKey,
            attemptId,
          ),
      );
    if (input.reserve || input.quarantine || input.restore) {
      for (const subject of [next.sourceSubject, next.targetSubject])
        statements.push(
          gatedInsert(
            "identity_merge_locks",
            subject,
            { operationId: next.operationId, subject },
            false,
          ),
        );
      statements.push(
        ...this.revokeStatements(
          next.sourceSubject,
          next.targetSubject,
          input.now,
          guard,
          [claimKey, attemptId],
        ),
      );
    }
    if (input.restore || input.abort) {
      if (input.restore)
        statements.push(
          this.db
            .prepare(
              `DELETE FROM ${table} WHERE bucket='canonical_accounts' AND key=? AND json_extract(document,'$.operationId')=? AND ${guard}`,
            )
            .bind(next.sourceSubject, next.operationId, claimKey, attemptId),
        );
      statements.push(
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE bucket='identity_merge_locks' AND key IN (?,?) AND json_extract(document,'$.operationId')=? AND ${guard}`,
          )
          .bind(
            next.sourceSubject,
            next.targetSubject,
            next.operationId,
            claimKey,
            attemptId,
          ),
      );
    }
    if (input.activate || input.abort)
      statements.push(
        ...this.revokeStatements(
          next.sourceSubject,
          next.targetSubject,
          input.now,
          guard,
          [claimKey, attemptId],
        ),
      );
    if (
      input.reserve ||
      input.activate ||
      input.quarantine ||
      input.restore ||
      input.abort
    ) {
      statements.push(
        ...this.generationStatements(
          [next.sourceSubject, next.targetSubject],
          input.now,
          guard,
          [claimKey, attemptId],
        ),
      );
    }
    if (input.activate)
      statements.push(
        gatedInsert(
          "canonical_accounts",
          next.sourceSubject,
          {
            sourceSubject: next.sourceSubject,
            targetSubject: next.targetSubject,
            operationId: next.operationId,
            activatedAt: input.now,
          },
          true,
        ),
      );
    if (input.reserve)
      statements.push(
        gatedInsert("identity_merge_retry_pending", next.operationId, {
          operationId: next.operationId,
        }),
      );
    if (input.activate || input.requireRecovery || input.abort || input.restore)
      statements.push(
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE bucket='identity_merge_retry_pending' AND key=? AND ${guard}`,
          )
          .bind(next.operationId, claimKey, attemptId),
      );
    // The checkpoint and all captured expiry bounds are checked again after
    // preparation. This is a local precommit boundary, not server execution/2PC.
    if (input.availabilityCheckpoint !== undefined && consumeReviewedRecoveryIssuerAvailabilityCheckpoint(input.availabilityCheckpoint, input) === undefined) return false;
    const results = await this.db.batch(statements);
    if (results.some((r) => !r.success))
      throw new Error("identity_merge_batch_failed");
    return (results[1]?.meta?.changes ?? 0) === 1;
  }
  private receiptCondition(
    r: IdentityOperationReceiptRecord,
    op: IdentityMergeMutation["next"],
    now: number,
    consumed: boolean,
    generationOffset: number,
    args: Array<string | number>,
  ): string {
    args.push(
      r.receiptId,
      r.transactionDigest,
      op.operationId,
      op.sourceSubject,
      op.targetSubject,
      r.role === "source" ? op.sourceSubject : op.targetSubject,
      r.role,
      now,
      now,
      generationOffset,
      ...(consumed ? [op.operationId] : []),
    );
    return ` AND EXISTS(SELECT 1 FROM ${table} r WHERE r.bucket='identity_operation_receipts' AND r.key=? AND json_extract(r.document,'$.transactionDigest')=? AND json_extract(r.document,'$.operationId')=? AND json_extract(r.document,'$.sourceSubject')=? AND json_extract(r.document,'$.targetSubject')=? AND json_extract(r.document,'$.subject')=? AND json_extract(r.document,'$.role')=? AND json_extract(r.document,'$.completedAt')<=? AND json_extract(r.document,'$.expiresAt')>? AND json_extract(r.document,'$.identityGeneration')+?=COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=json_extract(r.document,'$.subject')),0) AND ${consumed ? "json_extract(r.document,'$.consumedByOperation')=?" : "json_type(r.document,'$.consumedByOperation') IS NULL"} AND json_extract(r.document,'$.browserBindingHash')=json_extract(${table}.document,'$.browserBindingHash') AND json_extract(r.document,'$.policyVersion')=json_extract(${table}.document,'$.policyVersion') AND json_extract(r.document,'$.emailDigest')=json_extract(${table}.document,'$.addressDigest') AND json_extract(r.document,'$.startedAt')>=json_extract(${table}.document,'$.createdAt') AND json_extract(r.document,'$.completedAt')>=json_extract(r.document,'$.startedAt') AND json_extract(r.document,'$.legConsentAt')>=json_extract(r.document,'$.startedAt') AND json_extract(r.document,'$.legConsentAt')<=json_extract(r.document,'$.completedAt') AND json_extract(r.document,'$.expiresAt')<=json_extract(r.document,'$.startedAt')+300000 AND json_extract(r.document,'$.legConsent')=1 AND json_extract(r.document,'$.method') IN ('upstream-oauth-operation','issuer-credential-reauth') AND NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.bucket='hosted_oidc_revoked_sessions' AND x.key=json_extract(r.document,'$.issuerSessionHash')) AND EXISTS(SELECT 1 FROM ${table} i WHERE i.bucket='upstream_identities' AND i.key=json_extract(r.document,'$.providerId')||char(10)||json_extract(r.document,'$.upstreamIssuer')||char(10)||json_extract(r.document,'$.upstreamSubject') AND json_extract(i.document,'$.subject')=json_extract(r.document,'$.subject')) AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND d.key=json_array(json_extract(r.document,'$.providerId'),json_extract(r.document,'$.upstreamIssuer'),json_extract(r.document,'$.upstreamSubject')) AND json_type(d.document,'$.disabledAt') IS NOT NULL))`;
  }
  private revokeStatements(
    source: TakosumiSubject,
    target: TakosumiSubject,
    now: number,
    guard: string,
    guardArgs: readonly (string | number)[],
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE bucket IN ('account_sessions','authorization_codes','access_tokens','refresh_tokens') AND (json_extract(document,'$.subject') IN (?,?) OR json_extract(document,'$.takosumiSubject') IN (?,?)) AND ${guard}`,
        )
        .bind(source, target, source, target, ...guardArgs),
      this.db
        .prepare(
          `UPDATE ${table} SET document=json_set(document,'$.revokedAt',?),updated_at=? WHERE bucket='hosted_oidc_grants' AND json_extract(document,'$.subject') IN (?,?) AND ${guard}`,
        )
        .bind(now, now, source, target, ...guardArgs),
    ];
  }
  private generationStatements(
    subjects: readonly string[],
    now: number,
    guard: string,
    args: readonly (string | number)[],
  ): D1PreparedStatement[] {
    return [...new Set(subjects)].map((subject) =>
      this.db
        .prepare(
          `INSERT INTO ${table}(bucket,key,document,updated_at) SELECT 'authentication_generations',?,?,? WHERE ${guard} ON CONFLICT(bucket,key) DO UPDATE SET document=json_set(document,'$.generation',json_extract(document,'$.generation')+1),updated_at=excluded.updated_at`,
        )
        .bind(
          subject,
          JSON.stringify({ subject, generation: 1 }),
          now,
          ...args,
        ),
    );
  }

  async page<T>(
    bucket: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly { key: string; record: T }[]> {
    await this.initialize();
    const result = await this.db
      .prepare(
        `SELECT key,document FROM ${table} WHERE bucket=? AND key>? ORDER BY key LIMIT ?`,
      )
      .bind(bucket, after ?? "", limit)
      .all<{ key: string; document: string }>();
    return (result.results ?? []).map((r) => ({
      key: r.key,
      record: JSON.parse(r.document) as T,
    }));
  }
  async compareAndSetCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean> {
    await this.initialize();
    const { key, next } = input;
    const result =
      input.expectedRevision === undefined
        ? await this.db
            .prepare(
              `INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) VALUES('identity_merge_retry_checkpoints',?,?,?)`,
            )
            .bind(key, JSON.stringify(next), next.updatedAt)
            .run()
        : await this.db
            .prepare(
              `UPDATE ${table} SET document=?,updated_at=? WHERE bucket='identity_merge_retry_checkpoints' AND key=? AND json_extract(document,'$.revision')=?`,
            )
            .bind(
              JSON.stringify(next),
              next.updatedAt,
              key,
              input.expectedRevision,
            )
            .run();
    return Number(result.meta?.changes) === 1;
  }
  async completeUnlink(input: CredentialUnlinkMutation): Promise<boolean> {
    try {
      assertCredentialUnlinkMutation(input);
    } catch {
      return false;
    }
    await this.initialize();
    const { next: n, receipt: r, now } = input;
    const old = await this.get<CredentialUnlinkIntent>(
      "credential_unlink_intents",
      n.operationId,
    );
    if (old?.status === "completed") return identityRecordsEqual(old, n);
    const args: Array<string | number> = [
      n.operationId,
      input.expectedRevision,
    ];
    let condition = `bucket='credential_unlink_intents' AND key=? AND json_extract(document,'$.revision')=? AND json_extract(document,'$.status')='pending'`;
    for (const [field, value] of Object.entries(
      unlinkImmutableContext(n) as Record<string, unknown>,
    )) {
      condition += ` AND json_extract(document,'$.${field}')=json_extract(?,'$.${field}')`;
      args.push(JSON.stringify({ [field]: value }));
    }
    condition += ` AND COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=?),0)=? AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='hosted_oidc_revoked_sessions' AND key=?) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='canonical_accounts' AND key=?) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_locks' AND key=? AND json_extract(document,'$.operationId') NOT IN(SELECT key FROM ${table} WHERE bucket='identity_merge_operations' AND json_extract(document,'$.status')='active'))`;
    args.push(
      n.subject,
      n.identityGeneration,
      n.issuerSessionHash,
      n.subject,
      n.subject,
    );
    condition += ` AND EXISTS(SELECT 1 FROM ${table} WHERE bucket='credential_unlink_receipts' AND key=? AND document=?)`;
    args.push(r.receiptId, JSON.stringify(r));
    for (const tuple of [n.removedIdentity, n.retainedIdentity]) {
      condition += ` AND EXISTS(SELECT 1 FROM ${table} i WHERE i.bucket='upstream_identities' AND i.key=? AND COALESCE((SELECT json_extract(m.document,'$.targetSubject') FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=json_extract(i.document,'$.subject')),json_extract(i.document,'$.subject'))=?) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='upstream_identity_status' AND key=? AND json_type(document,'$.disabledAt') IS NOT NULL)`;
      args.push(
        [tuple.providerId, tuple.upstreamIssuer, tuple.upstreamSubject].join(
          "\n",
        ),
        n.subject,
        upstreamIdentityKey(tuple),
      );
    }
    const claim = n.operationId + ":" + input.expectedRevision;
    const attempt = crypto.randomUUID();
    const guard = `EXISTS(SELECT 1 FROM ${table} WHERE bucket='credential_unlink_cas_claims' AND key=? AND json_extract(document,'$.attemptId')=?)`;
    const statements = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT 'credential_unlink_cas_claims',?,?,? FROM ${table} WHERE ${condition}`,
        )
        .bind(claim, JSON.stringify({ attemptId: attempt }), now, ...args),
      this.db
        .prepare(
          `UPDATE ${table} SET document=?,updated_at=? WHERE bucket='credential_unlink_intents' AND key=? AND ${guard}`,
        )
        .bind(JSON.stringify(n), now, n.operationId, claim, attempt),
    ];
    const insert = (bucket: string, key: string, record: unknown) =>
      this.db
        .prepare(
          `INSERT INTO ${table}(bucket,key,document,updated_at) SELECT ?,?,?,? WHERE ${guard}`,
        )
        .bind(bucket, key, JSON.stringify(record), now, claim, attempt);
    statements.push(
      insert(
        "upstream_identity_status",
        upstreamIdentityKey(n.removedIdentity),
        {
          ...n.removedIdentity,
          identityKey: upstreamIdentityKey(n.removedIdentity),
          canonicalSubject: n.subject,
          disabledAt: now,
          operationId: n.operationId,
        },
      ),
      insert(
        "identity_merge_audit",
        n.operationId,
        credentialUnlinkAudit(input),
      ),
      this.db
        .prepare(
          `UPDATE ${table} SET document=json_set(document,'$.consumedByOperation',?),updated_at=? WHERE bucket='credential_unlink_receipts' AND key=? AND ${guard}`,
        )
        .bind(n.operationId, now, r.receiptId, claim, attempt),
      ...this.financialCloseStatements({subject:n.subject,cause:{kind:"identity-generation-advanced",operationId:n.operationId,operationRevision:n.revision,reason:"unlink"},evidenceRef:n.operationId,now},guard,[claim,attempt]),
      ...this.generationStatements([n.subject], now, guard, [claim, attempt]),
      ...this.revokeStatements(n.subject, n.subject, now, guard, [
        claim,
        attempt,
      ]),
    );
    try {
      const result = await this.db.batch(statements);
      if (result.some((r) => !r.success))
        throw new Error("credential_unlink_batch_failed");
      return Number(result[1]?.meta?.changes) === 1;
    } catch (error) {
      if (String(error).includes("UNIQUE")) return false;
      throw error;
    }
  }
  async unlink(input: UnlinkUpstreamIdentityInput): Promise<boolean> {
    await this.initialize();
    const key = upstreamIdentityKey(input.identity);
    const oldIdentityKey = [
      input.identity.providerId,
      input.identity.upstreamIssuer,
      input.identity.upstreamSubject,
    ].join("\n");
    const hash =
      input.proof.sessionLookupHash ??
      (await this.hashSession(input.proof.sessionId!));
    const canonical = `(CASE WHEN EXISTS(SELECT 1 FROM ${table} m WHERE m.bucket='canonical_accounts' AND m.key=json_extract(i.document,'$.subject') AND json_extract(m.document,'$.targetSubject')=?) THEN ? ELSE json_extract(i.document,'$.subject') END)`;
    const remaining = `(SELECT count(*) FROM ${table} i WHERE i.bucket='upstream_identities' AND ${canonical}=? AND i.key<>? AND NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.bucket='upstream_identity_status' AND json_extract(d.document,'$.disabledAt') IS NOT NULL AND json_extract(d.document,'$.providerId')=json_extract(i.document,'$.providerId') AND json_extract(d.document,'$.upstreamIssuer')=json_extract(i.document,'$.upstreamIssuer') AND json_extract(d.document,'$.upstreamSubject')=json_extract(i.document,'$.upstreamSubject')))>0`;
    const mutationId = crypto.randomUUID();
    const status = {
      mutationId,
      identityKey: key,
      ...input.identity,
      canonicalSubject: input.subject,
      disabledAt: input.now,
      operationId: input.operationId,
    };
    const condition = `EXISTS(SELECT 1 FROM ${table} i WHERE i.bucket='upstream_identities' AND i.key=? AND ${canonical}=?) AND ${remaining} AND EXISTS(SELECT 1 FROM ${table} s WHERE s.bucket='account_sessions' AND s.key=? AND json_extract(s.document,'$.subject')=? AND json_extract(s.document,'$.reauthenticatedAt')=? AND json_extract(s.document,'$.policy')='hosted' AND json_extract(s.document,'$.expiresAt')>? AND json_extract(s.document,'$.absoluteExpiresAt')>? AND COALESCE(json_extract(s.document,'$.identityGeneration'),0)=COALESCE((SELECT json_extract(g.document,'$.generation') FROM ${table} g WHERE g.bucket='authentication_generations' AND g.key=json_extract(s.document,'$.subject')),0)) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE bucket='identity_merge_locks' AND key=? AND json_extract(document,'$.operationId') NOT IN (SELECT key FROM ${table} WHERE bucket='identity_merge_operations' AND json_extract(document,'$.status')='active'))`;
    const statement = this.db
      .prepare(
        `INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT 'upstream_identity_status',?,?,? WHERE ${condition}`,
      )
      .bind(
        key,
        JSON.stringify(status),
        input.now,
        oldIdentityKey,
        input.subject,
        input.subject,
        input.subject,
        input.subject,
        input.subject,
        input.subject,
        oldIdentityKey,
        hash,
        input.subject,
        input.proof.authTime,
        input.now,
        input.now,
        input.subject,
      );
    const guard = `EXISTS(SELECT 1 FROM ${table} WHERE bucket='upstream_identity_status' AND key=? AND json_extract(document,'$.mutationId')=?)`;
    const statements = [
      statement,
      ...this.financialCloseStatements({subject:input.subject,cause:{kind:"identity-generation-advanced",operationId:input.operationId,operationRevision:0,reason:"unlink",legacyUnlink:true},evidenceRef:input.operationId,now:input.now},guard,[key,mutationId]),
      ...this.revokeStatements(input.subject, input.subject, input.now, guard, [
        key,
        mutationId,
      ]),
      ...this.generationStatements([input.subject], input.now, guard, [
        key,
        mutationId,
      ]),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table}(bucket,key,document,updated_at) SELECT 'identity_merge_audit',?,?,? WHERE ${guard}`,
        )
        .bind(
          input.operationId,
          JSON.stringify({
            operationId: input.operationId,
            subject: input.subject,
            decision: "credential_unlinked",
            identityKey: key,
            at: input.now,
          }),
          input.now,
          key,
          mutationId,
        ),
    ];
    const results = await this.db.batch(statements);
    if (results.some((r) => !r.success))
      throw new Error("identity_unlink_batch_failed");
    return (results[0]?.meta?.changes ?? 0) === 1;
  }
}

function auditRecord(input: IdentityMergeMutation): unknown {
  const n = input.next;
  return {
    operationId: n.operationId,
    sourceSubject: n.sourceSubject,
    targetSubject: n.targetSubject,
    actor: n.actor,
    policyVersion: n.policyVersion,
    revision: n.revision,
    decision: n.status,
    proofs: identityMergeProofAudit(n),
    consentAt: n.consentAt,
    acknowledgements: n.acknowledgements,
    undoOperationId: n.undoOperationId,
    recoveryAcknowledgements: n.recoveryAcknowledgements,
    conflict: n.conflict,
    at: input.now,
  };
}

function references(value: unknown, bucket: string): readonly string[] {
  const r = value as Record<string, unknown>;
  const context = (bucket === ownerContextBucket ? r.context : bucket === ownerReceiptBucket ? r.receipt : undefined) as Record<string, unknown> | undefined;
  return [
    ...new Set(
      [
        context?.targetAccountId ?? r.subject ?? r.targetSubject ?? r.canonicalSubject,
        context?.sourceAccountId ?? r.sourceSubject,
      ].filter((v): v is string => typeof v === "string"),
    ),
  ];
}
