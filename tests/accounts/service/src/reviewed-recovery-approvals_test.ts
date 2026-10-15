/** Isolated synthetic signed reviews only. No real review issuer is configured. */
import { expect, test } from "bun:test";
import { identityContextFixture, acceptIsolatedIdentityContexts, isolatedContextReconciler } from "../fixtures/identity-context-fixture.ts";
import { consentIdentityMerge, quarantineIdentityMerge } from "../../../../accounts/service/src/identity-merge.ts";
import { createReviewedRecoveryApprovalAuthority, createReviewedRecoveryReviewVerifier, recordVerifiedReviewedRecoveryApproval, reviewedRecoveryApprovalDigest, reviewedRecoveryDecisionDigest, reviewedRecoverySignatureInput } from "../../../../accounts/service/src/reviewed-recovery-approvals.ts";
import type { ReviewedRecoveryApprovalClaims, ReviewedRecoveryApprovalRecord, ReviewedRecoveryApprovalMutation } from "../../../../accounts/service/src/reviewed-recovery-state.ts";
import { ownerOperationContextEvidenceId, digest, reviewedApprovalBucket, reviewedApprovalRefBucket, reviewedApprovalRefKey, ownerContextBucket, ownerReceiptBucket } from "../../../../accounts/service/src/owner-operation-evidence.ts";
import type { OwnerOperationContextEvidence, OwnerOperationTarget } from "../../../../accounts/service/src/owner-operation-contract.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../../contract/identity-reconciliation.ts";
import { sha256Text, base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { MemoryIdentityRecordRepository } from "../../../../accounts/service/src/memory-identity-records.ts";
import type { IdentityRecordRepository } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { D1IdentityRecordRepository } from "../../../../accounts/service/src/d1-identity-records.ts";
import { PostgresIdentityRecordRepository } from "../../../../accounts/service/src/postgres/identity-records.ts";
import type { D1Database } from "../../../../accounts/service/src/d1-store.ts";

const keys = crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const target: OwnerOperationTarget = { ownerKind: "hosted-intents", ownerClientId: "isolated-owner-client", targetBindingDigest: await sha256Text("isolated-target") };
const ownerEvidenceDigest = await sha256Text("isolated-original-receipt-and-current-epochs");

async function fixture(kind: "memory" | "native-d1" | "postgres") {
  const f = await identityContextFixture(kind);
  let operation = await acceptIsolatedIdentityContexts(f.store, f.operation, f.now);
  operation = await consentIdentityMerge({ store: f.store, operation, session: f.session(), reconciler: isolatedContextReconciler(f.store, f.now), retryCapability: {pendingCapacity: 100, assertAvailable: async () => {}}, consent: true, now: f.now });
  let now = f.now + 1;
  const reviewIssuer = { issuer: "isolated-authenticated-review-authority", keyId: "isolated-ephemeral-key", publicKey: (await keys).publicKey };
  const authority = createReviewedRecoveryApprovalAuthority({ store: f.store, target, reviewIssuer, now: () => now });
  const verifier = createReviewedRecoveryReviewVerifier({ target, reviewIssuer, now: () => now });
  async function signed(overrides: Partial<ReviewedRecoveryApprovalClaims> = {}): Promise<ReviewedRecoveryApprovalRecord> {
    const approval: ReviewedRecoveryApprovalClaims = {
      operationId: operation.operationId, recoveryId: "isolated-reviewed-recovery", operationRevision: operation.revision,
      sourceAccountId: operation.sourceSubject, targetAccountId: operation.targetSubject, planDigest: operation.contextPlan!.planDigest,
      sourceIdentityGeneration: await f.store.getAccountAuthenticationGeneration!(operation.sourceSubject), targetIdentityGeneration: await f.store.getAccountAuthenticationGeneration!(operation.targetSubject),
      mode: "abort-before-active", rootReviewRef: "isolated-immutable-root-decision", reviewedApprovalRef: `isolated-review-event-${now}`, target, ownerEvidenceDigest, createdAt: now, expiresAt: now + 250000, ...overrides,
    };
    const record: ReviewedRecoveryApprovalRecord = {version:"takosumi.accounts.reviewed-recovery@v1", approval, approvalDigest:"", decisionDigest:await reviewedRecoveryDecisionDigest(approval), attestation:{algorithm:"ES256",issuer:reviewIssuer.issuer,keyId:reviewIssuer.keyId,signature:""}};
    record.approvalDigest = await reviewedRecoveryApprovalDigest(record);
    record.attestation.signature = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},(await keys).privateKey,reviewedRecoverySignatureInput(record.approvalDigest).buffer as ArrayBuffer)));
    return record;
  }
  async function save(record: ReviewedRecoveryApprovalRecord) {
    const review = await verifier.verify(record);
    if (!review) return false;
    return recordVerifiedReviewedRecoveryApproval({store:f.store,review,now:()=>now});
  }
  return {...f,operation,authority,verifier,signed,save,reviewIssuer,time:(value:number)=>{now=value;},now:()=>now};
}

type BackendKind = "memory" | "native-d1" | "postgres";
async function captureCommit(kind: BackendKind, save: () => Promise<boolean>) {
  const prototype: IdentityRecordRepository = (kind === "memory" ? MemoryIdentityRecordRepository : kind === "native-d1" ? D1IdentityRecordRepository : PostgresIdentityRecordRepository).prototype;
  const original = prototype.commitReviewedRecoveryApproval;
  let captured: { repository: IdentityRecordRepository; mutation: ReviewedRecoveryApprovalMutation } | undefined;
  prototype.commitReviewedRecoveryApproval = async function (input) {
    captured = { repository: this, mutation: structuredClone(input) };
    return original.call(this, input);
  };
  try { expect(await save()).toBe(true); } finally { prototype.commitReviewedRecoveryApproval = original; }
  if (!captured) throw new Error("isolated_commit_not_observed");
  return captured;
}
async function removeDocument(repository: IdentityRecordRepository, bucket: string, key: string) {
  if (repository instanceof MemoryIdentityRecordRepository) repository.records.delete(`${bucket}\n${key}`);
  else if (repository instanceof D1IdentityRecordRepository) await repository.db.prepare("DELETE FROM takosumi_accounts_documents WHERE bucket=? AND key=?").bind(bucket, key).run();
  else if (repository instanceof PostgresIdentityRecordRepository) await repository.client.queryObject("DELETE FROM accounts_v1.hosted_identity_records WHERE bucket=$1 AND key=$2", [bucket, key]);
  else throw new Error("unknown_isolated_backend");
}

for (const kind of ["memory", "native-d1", "postgres"] as const) {
  test(`${kind}: one initial approval wins; history/ref/pointer are atomic, idempotent and cloned`, async () => {
    const f=await fixture(kind);
    try {
      const first=await f.signed({reviewedApprovalRef:"isolated-first-event"}), second=await f.signed({reviewedApprovalRef:"isolated-second-event"});
      const results=await Promise.all([f.save(first),f.save(second)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner=results[0]?first:second, loser=results[0]?second:first;
      expect(await f.save(winner)).toBe(true);
      expect((await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId))?.revision).toBe(0);
      expect(await f.store.findReviewedRecoveryApproval!(loser.approvalDigest)).toBeUndefined();
      expect(await f.store.findReviewedRecoveryApprovalByRef!(loser.approval)).toBeUndefined();
      const read=await f.authority.findForOperation(f.operation.operationId);
      expect(read?.approvalDigest).toBe(winner.approvalDigest);
      Object.assign(read!.target,{ownerClientId:"caller-edit"});
      expect((await f.authority.findForOperation(f.operation.operationId))?.target.ownerClientId).toBe(target.ownerClientId);
      expect(await f.authority.readRecoveryEvidence(winner.approval)).toMatchObject({approvalDigest:winner.approvalDigest,ownerEvidenceDigest});
      expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef(winner.approval)).toMatchObject({approvalDigest:winner.approvalDigest});
      if(f.pg)expect((await f.pg.query("SELECT balance,pending_original_key,workspace_id,org_id FROM accounts_v1.context_protected_refs")).rows).toEqual([{balance:123456,pending_original_key:"pending-original-B",workspace_id:"workspace_B",org_id:"org_B"}]);
    } finally {await f.close();}
  },20000);

  test(`${kind}: renewal retains immutable decision/history; expired latest never falls back`, async () => {
    const f=await fixture(kind);
    try {
      const first=await f.signed();expect(await f.save(first)).toBe(true);
      f.time(f.now()+10);
      const renewed=await f.signed({previousApprovalDigest:first.approvalDigest,expiresAt:f.now()+20});
      expect(renewed.decisionDigest).toBe(first.decisionDigest);
      expect(await f.save(renewed)).toBe(true);
      expect((await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId))?.revision).toBe(1);
      expect(await f.save(first)).toBe(false);
      f.time(f.now()+30);
      expect(first.approval.expiresAt).toBeGreaterThan(f.now());
      expect(await f.authority.findForOperation(f.operation.operationId)).toBeUndefined();
      expect(await f.authority.readHistoricalRecoveryEvidence({operationId:f.operation.operationId,recoveryId:first.approval.recoveryId,approvalDigest:first.approvalDigest})).toMatchObject({approvalDigest:first.approvalDigest});
      expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef(renewed.approval)).toMatchObject({approvalDigest:renewed.approvalDigest});
      expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef({...renewed.approval,reviewedApprovalRef:"absent-event"})).toBeUndefined();
      const changed=await f.signed({previousApprovalDigest:renewed.approvalDigest,ownerEvidenceDigest:await sha256Text("changed-custody-epoch")});
      expect(await f.save(changed)).toBe(false);
      const reused=await f.signed({previousApprovalDigest:renewed.approvalDigest,reviewedApprovalRef:renewed.approval.reviewedApprovalRef});
      expect(await f.save(reused)).toBe(false);
      expect(await f.store.findReviewedRecoveryApproval!(reused.approvalDigest)).toBeUndefined();
    } finally {await f.close();}
  },20000);

  test(`${kind}: two renewal writers retain exactly one immutable new event`, async () => {
    const f=await fixture(kind);
    try {
      const first=await f.signed(); expect(await f.save(first)).toBe(true);
      f.time(f.now()+10);
      const a=await f.signed({previousApprovalDigest:first.approvalDigest,reviewedApprovalRef:"isolated-renew-a"});
      const b=await f.signed({previousApprovalDigest:first.approvalDigest,reviewedApprovalRef:"isolated-renew-b"});
      const results=await Promise.all([f.save(a),f.save(b)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner=results[0]?a:b,loser=results[0]?b:a;
      expect((await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId))?.approvalDigest).toBe(winner.approvalDigest);
      expect(await f.store.findReviewedRecoveryApproval!(loser.approvalDigest)).toBeUndefined();
      expect(await f.store.findReviewedRecoveryApprovalByRef!(loser.approval)).toBeUndefined();
      expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef(first.approval)).toMatchObject({approvalDigest:first.approvalDigest});
    }finally{await f.close();}
  },20000);

  test(`${kind}: raw replay never repairs absent history/ref or accepts altered state/ref body`, async () => {
    const f=await fixture(kind);
    try {
      const record=await f.signed();
      const {repository,mutation}=await captureCommit(kind,()=>f.save(record));
      expect(await repository.commitReviewedRecoveryApproval(mutation)).toBe(true);
      const refKey=reviewedApprovalRefKey(record.approval),ref=await repository.get(reviewedApprovalRefBucket,refKey);
      await removeDocument(repository,reviewedApprovalRefBucket,refKey);
      expect(await repository.commitReviewedRecoveryApproval(mutation)).toBe(false);
      expect(await f.save(record)).toBe(false);
      expect(await f.authority.findForOperation(f.operation.operationId)).toBeUndefined();
      expect(await repository.get(reviewedApprovalRefBucket,refKey)).toBeUndefined();
      await repository.put(reviewedApprovalRefBucket,refKey,{...ref as object,operationId:"foreign-operation"});
      expect(await repository.commitReviewedRecoveryApproval(mutation)).toBe(false);
      expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef(record.approval)).toBeUndefined();
      await repository.put(reviewedApprovalRefBucket,refKey,ref);
      await removeDocument(repository,reviewedApprovalBucket,record.approvalDigest);
      expect(await repository.commitReviewedRecoveryApproval(mutation)).toBe(false);
      expect(await repository.get(reviewedApprovalBucket,record.approvalDigest)).toBeUndefined();
      await repository.put(reviewedApprovalBucket,record.approvalDigest,record);
      await quarantineIdentityMerge({store:f.store,operation:f.operation,now:f.now(),reason:"isolated-replay-state-change"});
      expect(await repository.commitReviewedRecoveryApproval(mutation)).toBe(false);
    }finally{await f.close();}
  },20000);

  test(`${kind}: a security transition after verification loses atomic pending-state admission`, async () => {
    const f=await fixture(kind);
    try {
      const record=await f.signed();
      const original=f.store.compareAndSetReviewedRecoveryApproval!.bind(f.store);
      f.store.compareAndSetReviewedRecoveryApproval=async(input)=>{
        await quarantineIdentityMerge({store:f.store,operation:f.operation,now:f.now(),reason:"isolated-concurrent-security-change"});
        return original(input);
      };
      expect(await f.save(record)).toBe(false);
      expect(await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId)).toBeUndefined();
      expect(await f.store.findReviewedRecoveryApproval!(record.approvalDigest)).toBeUndefined();
      expect(await f.store.findReviewedRecoveryApprovalByRef!(record.approval)).toBeUndefined();
    } finally {await f.close();}
  },20000);

  test(`${kind}: evidence journal preserves exact original context and rejects target/receipt forks`, async () => {
    const f=await fixture(kind);
    try {
      const body:Omit<OwnerOperationContextEvidence,"evidenceId">={version:"takosumi.accounts.owner-context@v1",context:{operationId:f.operation.operationId,kind:"merge",sourceAccountId:f.operation.sourceSubject,targetAccountId:f.operation.targetSubject,planDigest:f.operation.contextPlan!.planDigest,authorityVersion:CONTROL_IDENTITY_AUTHORITY_VERSION,admissionDigest:await sha256Text("original-admission"),controlReceiptId:"isolated-core-receipt"},coreReceipt:{receiptId:"isolated-core-receipt",operationId:f.operation.operationId,kind:"merge-applied",planDigest:f.operation.contextPlan!.planDigest,authorityVersion:CONTROL_IDENTITY_AUTHORITY_VERSION,inventoryDigest:`sha256:${"a".repeat(64)}`,revision:1,recordedAt:new Date(f.now()).toISOString()},target,capturedOperationRevision:f.operation.revision,capturedAt:f.now()};
      const record={...body,evidenceId:await ownerOperationContextEvidenceId(body)};
      const extraBody={...body,token:"forbidden-unbounded-extra-field"},extra={...extraBody,evidenceId:await ownerOperationContextEvidenceId(extraBody)};
      expect(await f.store.createOwnerOperationContextEvidence!(extra)).toBe(false);
      expect(await f.store.createOwnerOperationContextEvidence!(record)).toBe(true);
      expect(await f.store.createOwnerOperationContextEvidence!(record)).toBe(true);
      const otherBody={...body,target:{...target,ownerClientId:"other-client"}},other={...otherBody,evidenceId:await ownerOperationContextEvidenceId(otherBody)};
      expect(await f.store.createOwnerOperationContextEvidence!(other)).toBe(false);
      await expect(f.store.findOwnerOperationContextEvidence!({...body.context,target:otherBody.target})).rejects.toThrow("owner_operation_evidence_conflict");
      const receipt={contextEvidenceId:record.evidenceId,ownerKind:"hosted-intents" as const,receipt:{...body.context,receiptId:"isolated-durable-owner-receipt",ownerId:"isolated-real-port",ownerVersion:"1",recordedAt:f.now()},observedAt:f.now()};
      expect(await f.store.createOwnerOperationReceiptEvidence!(receipt)).toBe(true);
      expect(await f.store.createOwnerOperationReceiptEvidence!(receipt)).toBe(true);
      expect(await f.store.createOwnerOperationReceiptEvidence!({...receipt,receipt:{...receipt.receipt,receiptId:"foreign-receipt"}})).toBe(false);
      expect((await f.store.findOwnerOperationReceiptEvidence!(receipt))?.receipt.receiptId).toBe(receipt.receipt.receiptId);
      expect(await f.store.createOwnerOperationReceiptEvidence!({...receipt,contextEvidenceId:await sha256Text("missing-context")})).toBe(false);
      if(f.pg) expect((await f.pg.query("SELECT subject,other_subject FROM accounts_v1.hosted_identity_records WHERE bucket IN($1,$2)",[ownerContextBucket,ownerReceiptBucket])).rows).toEqual([{subject:f.operation.targetSubject,other_subject:f.operation.sourceSubject},{subject:f.operation.targetSubject,other_subject:f.operation.sourceSubject}]);
    } finally {await f.close();}
  },20000);
}

test("unconfigured issuer and forged capability cannot promote stored data or reviewer text",async()=>{
  const f=await fixture("memory");
  try{
    const authority=createReviewedRecoveryApprovalAuthority({store:{...f.store,findCurrentReviewedRecoveryApproval:async()=>{throw new Error("must-not-read-unqualified-store");}} as typeof f.store,target});
    expect(await authority.findForOperation(f.operation.operationId)).toBeUndefined();
    expect(await authority.readHistoricalRecoveryEvidenceByReviewRef({operationId:f.operation.operationId,recoveryId:"r",reviewedApprovalRef:"reviewer-claims-approved"})).toBeUndefined();
    expect(await recordVerifiedReviewedRecoveryApproval({store:f.store,review:{} as never,now:f.now})).toBe(false);
    const signed=await f.signed(),invalid={...signed,attestation:{...signed.attestation,signature:"A".repeat(86)}};
    expect(await f.verifier.verify(invalid)).toBeUndefined();
    const noncanonical=signed.approvalDigest.slice(0,-1)+"B";
    expect(digest(noncanonical)).toBe(false);
    expect(digest(await sha256Text("canonical"))).toBe(true);
  }finally{await f.close();}
});

test("fresh writer and reader recheck trusted time after awaited store reads",async()=>{
  const f=await fixture("memory");
  try{
    const record=await f.signed({expiresAt:f.now()+10});
    const find=f.store.findCurrentReviewedRecoveryApproval!.bind(f.store);
    f.store.findCurrentReviewedRecoveryApproval=async(id)=>{const value=await find(id);f.time(record.approval.expiresAt);return value;};
    expect(await f.save(record)).toBe(false);
    expect(await f.store.findReviewedRecoveryApproval!(record.approvalDigest)).toBeUndefined();
    f.store.findCurrentReviewedRecoveryApproval=find;
    f.time(record.approval.createdAt);
    expect(await f.save(record)).toBe(true);
    let reads=0;
    f.store.findCurrentReviewedRecoveryApproval=async(id)=>{const value=await find(id);if(++reads===2)f.time(record.approval.expiresAt);return value;};
    expect(await f.authority.findForOperation(f.operation.operationId)).toBeUndefined();
    expect(await f.authority.readHistoricalRecoveryEvidenceByReviewRef(record.approval)).toMatchObject({approvalDigest:record.approvalDigest});
    const future=await f.signed({createdAt:f.now()+1,expiresAt:f.now()+20});
    expect(await f.verifier.verify(future)).toBeUndefined();
  }finally{await f.close();}
});

test("native D1 rolls back pointer/history when the final ref write fails",async()=>{
  const f=await fixture("native-d1");
  const original=D1IdentityRecordRepository.prototype.commitReviewedRecoveryApproval;
  try{
    const record=await f.signed();
    D1IdentityRecordRepository.prototype.commitReviewedRecoveryApproval=function(input){
      const db=this.db;
      const proxy:D1Database={prepare:db.prepare.bind(db),exec:db.exec.bind(db),batch:(statements)=>db.batch([...statements.slice(0,-1),db.prepare("SELECT json('isolated-invalid-json')")])};
      return original.call(new D1IdentityRecordRepository(proxy,this.initialize,this.hashSession),input);
    };
    await expect(f.save(record)).rejects.toThrow();
    expect(await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId)).toBeUndefined();
    expect(await f.store.findReviewedRecoveryApproval!(record.approvalDigest)).toBeUndefined();
    expect(await f.store.findReviewedRecoveryApprovalByRef!(record.approval)).toBeUndefined();
  }finally{D1IdentityRecordRepository.prototype.commitReviewedRecoveryApproval=original;await f.close();}
},20000);

test("PG adapter uses one CTE and PGlite rolls back on the final ref failure",async()=>{
  const f=await fixture("postgres");
  const original=PostgresIdentityRecordRepository.prototype.commitReviewedRecoveryApproval;
  let statements=0;
  try{
    const record=await f.signed();
    PostgresIdentityRecordRepository.prototype.commitReviewedRecoveryApproval=function(input){
      const client=this.client;
      return original.call(new PostgresIdentityRecordRepository({queryObject:async<T>(sql,args)=>{
        if(sql.startsWith("WITH operation_claim")){
          statements++;
          sql=sql.replace("SELECT 'reviewed_recovery_refs',", "SELECT (1/(length(changed.key)-length(changed.key)))::text,");
        }
        return client.queryObject<T>(sql,args);
      }}),input);
    };
    await expect(f.save(record)).rejects.toThrow();
    expect(statements).toBe(1);
    expect(await f.store.findCurrentReviewedRecoveryApproval!(f.operation.operationId)).toBeUndefined();
    expect(await f.store.findReviewedRecoveryApproval!(record.approvalDigest)).toBeUndefined();
  }finally{PostgresIdentityRecordRepository.prototype.commitReviewedRecoveryApproval=original;await f.close();}
},20000);
