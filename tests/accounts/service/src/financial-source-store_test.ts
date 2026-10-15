/** Actual native D1 atomic boundaries. Control/challenge/receiver ports are
 * synthetic fixtures and provide no deployed graph or payer qualification. */
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { D1IdentityRecordRepository } from "../../../../accounts/service/src/d1-identity-records.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { createAccountsFinancialSource, type AccountsFinancialControlSnapshot } from "../../../../accounts/service/src/financial-source.ts";
import { financialSourceBuckets, financialSourceJson, financialSourceScopeKey } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { materializeFinancialSourceEvent, type FinancialSourceMaterialization, type FinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-contract.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import type { FinancialSourceParentScope, HostedOidcGrantRecord, FinancialSourceEnrollmentMutation } from "../../../../accounts/service/src/identity-state.ts";
import type { TokenRecord } from "../../../../accounts/service/src/store.ts";
import { prepareIsolatedReserveMutation } from "../fixtures/identity-merge-precommit-fixture.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { createCredentialUnlinkIntent, completeCredentialUnlink } from "../../../../accounts/service/src/identity-unlink.ts";
import type { CredentialUnlinkReceipt } from "../../../../accounts/service/src/identity-unlink-state.ts";

const slots=["grant","issuerSession","client","accountGeneration"] as const;
async function fixture(existing?:Awaited<ReturnType<typeof prepareIsolatedReserveMutation>>) {
  let mf:Miniflare|undefined;
  let db:D1Database,store:D1AccountsStore,repository:D1IdentityRecordRepository;
  if(existing){store=existing.store as D1AccountsStore;repository=existing.repository as D1IdentityRecordRepository;db=repository.db;}
  else{
    mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('isolated');}}",compatibilityDate:"2026-07-01",d1Databases:{ACCOUNTS:"financial-source-native"}});
    db=await mf.getD1Database("ACCOUNTS") as unknown as D1Database;
    for(const migration of (await loadD1AccountsMigrationCatalog()).migrations)await applyD1AccountsMigrationBatch(db,migration,100);
    store=new D1AccountsStore(db,{schemaMode:"predeployed"});
    repository=new D1IdentityRecordRepository(db,async()=>{},sha256Text);
  }
  let now=existing?.clock()??1_000_000;
  const subject=existing?.operation.sourceSubject??"tsub_financial_native",token="isolated-native-access-never-persist";
  if(!existing)await store.saveAccount({subject,createdAt:now,updatedAt:now});
  const issuer="https://native-financial.example.test";
  const record:TokenRecord={clientId:"native-hosted",scope:"openid",subject,takosumiSubject:subject,oidcProfile:"shared-account",issuer,authTime:1000,sid:"native-sid",issuerSessionId:"native-issuer-session",identityGeneration:0,expiresAt:now+200000};
  const grant:HostedOidcGrantRecord={sid:record.sid!,issuerSessionId:record.issuerSessionId!,clientId:record.clientId,subject,scope:record.scope,issuer,authTime:1000,identityGeneration:0,createdAt:now,absoluteExpiresAt:now+300000};
  await store.saveAccessToken(token,record);await store.saveHostedOidcGrant(grant);
  await repository.put("isolated_original_refs","original",{subject,workspaceId:"workspace-original",organizationId:"org-original",balance:123456,pendingOriginalKey:"pending-original"});
  const original=await repository.get("isolated_original_refs","original");
  const registration={registrationRef:"native-reg",incarnation:"native-inc",genesisDigest:`sha256:${"a".repeat(64)}` as const,receivers:[{receiverRef:"native-A",targetRef:"target-A"},{receiverRef:"native-B",targetRef:"target-B"}]};
  await store.registerFinancialSourceRegistration(registration);
  const challenge={v:1 as const,challengeRef:"native-challenge",registrationRef:registration.registrationRef,clientId:record.clientId,workspaceId:"workspace-original",organizationId:"org-original",workspaceRef:"workspace-original-ref",requestFingerprint:`sha256:${"b".repeat(64)}` as const,createdAt:now,expiresAt:now+120000};
  const control:AccountsFinancialControlSnapshot={accountId:subject,workspaceId:challenge.workspaceId,organizationId:challenge.organizationId,workspaceRef:challenge.workspaceRef,evidence:{evidenceRef:"native-control",evidenceDigest:`sha256:${"c".repeat(64)}` as const,expiresAt:now+120000,source:{registrationRef:"native-core-reg",incarnation:"native-core-inc",affectedRef:challenge.workspaceId,sequence:0,eventRef:null,eventDigest:`sha256:${"d".repeat(64)}` as const,receivers:[{receiverRef:"core-receiver",targetRef:"core-target"}]}}};
  const received=new Map<string,FinancialSourceMaterialization>();
  const receipt=(m:FinancialSourceMaterialization):FinancialSourceReceipt=>({v:1,eventRef:m.event.eventRef,eventDigest:m.eventDigest,receiptRef:`receipt/${m.event.eventRef}`,incarnation:m.event.incarnation,sequence:m.event.sequence,state:m.event.kind==="close"?"admission-closed":"advanced"});
  const producer=createAccountsFinancialSource({store,issuer,registration,now:()=>now,clients:[{clientId:record.clientId,profile:"shared-account",enabled:true,allowedScopes:["openid"],redirectUris:["https://native-client.example.test/callback"]}],challenges:{read:async()=>structuredClone(challenge)},control:{capture:async()=>structuredClone(control),assertCurrent:async()=>true},receivers:registration.receivers.map(r=>({...r,read:async m=>{const prior=received.get(r.receiverRef+"/"+m.event.eventRef);return prior?receipt(prior):undefined;},deliver:async m=>{received.set(r.receiverRef+"/"+m.event.eventRef,structuredClone(m));return receipt(m);}}))});
  const scopes={grant:{kind:"grant",sid:record.sid!},issuerSession:{kind:"issuer-session",issuerSessionId:record.issuerSessionId!},client:{kind:"client",clientId:record.clientId},accountGeneration:{kind:"account-generation",subject,identityGeneration:0}} satisfies Record<typeof slots[number],FinancialSourceParentScope>;
  const rows=async(bucket:string)=>(await db.prepare("SELECT key,document FROM takosumi_accounts_documents WHERE bucket=? ORDER BY key").bind(bucket).all<{key:string;document:string}>()).results??[];
  return {store,db,repository,producer,scopes,subject,token,record,grant,registration,challenge,original,time:(value:number)=>{now=value;},clock:()=>now,rows,prove:()=>producer.prove({accessToken:token,challengeRef:challenge.challengeRef}),close:async()=>{await mf?.dispose();}};
}
async function enrolled(f:Awaited<ReturnType<typeof fixture>>){await expect(f.prove()).rejects.toThrow("source_pending");expect(await f.rows(financialSourceBuckets.parents)).toHaveLength(4);}
async function unchanged(f:Awaited<ReturnType<typeof fixture>>){expect(await f.repository.get("isolated_original_refs","original")).toEqual(f.original);expect(JSON.stringify(await f.rows(financialSourceBuckets.raw))).not.toContain(f.token);expect(await f.rows("financial_source_cas_claims")).toHaveLength(0);}

test("native D1 atomically enrolls four parents, materializes exact raw, waits for full ACKs and issues current-root proof",async()=>{
  const f=await fixture();try{await enrolled(f);expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(4);expect((await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(4);
    expect(await f.producer.flush({limit:100})).toEqual({processed:4});const proof=await f.prove(),saved=await f.store.findFinancialSourceProof(proof.proofRef);expect(saved?.proofRef).toBe(proof.proofRef);expect(Object.keys(saved!.parents).sort()).toEqual([...slots].sort());expect(await f.rows(financialSourceBuckets.receipts)).toHaveLength(8);expect((await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(0);await unchanged(f);
  }finally{await f.close();}
},20000);

for(const kind of ["grant","issuerSession","client"] as const)test(`native D1 ${kind} revoke closes only its actual parent with grant/tombstone; replay does not requeue`,async()=>{
  const f=await fixture();try{await enrolled(f);await f.producer.flush({limit:100});
    const revoke=()=>kind==="grant"?f.store.revokeHostedOidcGrant(f.record.sid!,f.clock()):kind==="issuerSession"?f.store.revokeHostedOidcSessionGrants(f.record.issuerSessionId!,f.clock()):f.store.revokeHostedOidcClientGrants(f.record.clientId,f.clock());
    await revoke();for(const slot of slots)expect((await f.store.findFinancialSourceParent(f.scopes[slot]))?.state).toBe(slot===kind?"closed":"open");expect((await f.store.findHostedOidcGrant(f.record.sid!))?.revokedAt).toBe(f.clock());expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(5);expect((await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(1);
    await f.producer.flush({limit:100});await revoke();expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(5);expect((await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(0);if(kind!=="grant")expect(await f.rows(kind==="client"?"hosted_oidc_revoked_clients":"hosted_oidc_revoked_sessions")).toHaveLength(1);await unchanged(f);
  }finally{await f.close();}
},20000);

test("native D1 revoke before enrollment permanently fences same SID without seeding history",async()=>{
  const f=await fixture();try{await f.store.revokeHostedOidcGrant(f.record.sid!,f.clock());expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(0);const envelope=JSON.parse((await f.rows(financialSourceBuckets.parents))[0]!.document);expect(envelope.closed).toBe(true);expect(envelope.head).toBeUndefined();
    // Deliberately simulate late legacy SID persistence: actual current grant is
    // restored, while the financial terminal fence must never be reseeded.
    await f.repository.put("hosted_oidc_grants",f.grant.sid,f.grant);await expect(f.prove()).rejects.toThrow();expect(await f.rows(financialSourceBuckets.parents)).toHaveLength(1);expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(0);await unchanged(f);
  }finally{await f.close();}
},20000);

for(const attack of ["token-replaced","generation-changed","checkpoint-copied","clock-expired","fence-malformed","fence-missing-operation"] as const)test(`native D1 ${attack} after actual service validation leaves enrollment absent`,async()=>{
  const f=await fixture();try{const original=f.store.enrollFinancialSourceParents.bind(f.store);f.store.enrollFinancialSourceParents=async input=>{
    if(attack==="token-replaced")await f.store.saveAccessToken(f.token,{...f.record,expiresAt:f.record.expiresAt+1});
    if(attack==="generation-changed")await f.repository.put("authentication_generations",f.subject,{subject:f.subject,generation:1});
    if(attack==="checkpoint-copied")input={...input,precommitCheckpoint:structuredClone(input.precommitCheckpoint)};
    if(attack==="clock-expired")f.time(f.challenge.expiresAt);
    if(attack==="fence-malformed")await f.repository.put("identity_merge_locks",f.subject,{});
    if(attack==="fence-missing-operation")await f.repository.put("identity_merge_locks",f.subject,{operationId:"missing-operation"});
    return original(input);
  };await expect(f.prove()).rejects.toThrow();for(const bucket of [financialSourceBuckets.parents,financialSourceBuckets.raw,financialSourceBuckets.pending,financialSourceBuckets.affected,financialSourceBuckets.proofs])expect(await f.rows(bucket)).toHaveLength(0);await unchanged(f);
  }finally{await f.close();}
},20000);

for(const expired of [false,true])test(`native D1 final awaited parent preparation ${expired?"expiry leaves no writes":"refreshes all persisted capture timestamps"}`,async()=>{
  const f=await fixture(),original=D1IdentityRecordRepository.prototype.get;let reads=0;const time=expired?f.challenge.expiresAt:f.clock()+3;try{
    D1IdentityRecordRepository.prototype.get=async function<T>(bucket:string,key:string):Promise<T|undefined>{const value=await original.call(this,bucket,key) as T|undefined;if(bucket===financialSourceBuckets.pending&&++reads===4)f.time(time);return value;};
    await expect(f.prove()).rejects.toThrow(expired?"source_conflict":"source_pending");expect(reads).toBe(4);expect(await f.rows(financialSourceBuckets.parents)).toHaveLength(expired?0:4);
    if(!expired)for(const row of await f.rows(financialSourceBuckets.raw))expect(JSON.parse(row.document).capturedAt).toBe(time);await unchanged(f);
  }finally{D1IdentityRecordRepository.prototype.get=original;await f.close();}
},20000);

test("native D1 snapshots caller aliases before awaits and preserves opaque checkpoint provenance",async()=>{
  const f=await fixture(),get=D1IdentityRecordRepository.prototype.get,enroll=f.store.enrollFinancialSourceParents.bind(f.store);let alias:FinancialSourceEnrollmentMutation|undefined,reads=0,altered=0;try{
    f.store.enrollFinancialSourceParents=async input=>{alias=input;return enroll(input);};
    D1IdentityRecordRepository.prototype.get=async function<T>(bucket:string,key:string):Promise<T|undefined>{const value=await get.call(this,bucket,key) as T|undefined;
      if(alias&&altered===0&&bucket===financialSourceBuckets.registrations){(alias.expectedGrant as {subject:string}).subject="tsub_alias_wrong";altered++;}
      if(alias&&bucket===financialSourceBuckets.pending&&++reads===4)(alias.expectedGrant as {subject:string}).subject=f.subject;
      return value;
    };
    await enrolled(f);expect(altered).toBe(1);expect(reads).toBe(4);expect((await f.store.findFinancialSourceParent(f.scopes.accountGeneration))?.scope).toEqual(f.scopes.accountGeneration);expect(await f.repository.get(financialSourceBuckets.parents,financialSourceScopeKey({...f.scopes.accountGeneration,subject:"tsub_alias_wrong"}))).toBeUndefined();await unchanged(f);
  }finally{D1IdentityRecordRepository.prototype.get=get;await f.close();}
},20000);

test("native D1 final outbox write failure rolls back all parent/raw/affected and claim writes",async()=>{
  const f=await fixture(),original=D1IdentityRecordRepository.prototype.enrollFinancialSourceParents;let injected=0;try{
    D1IdentityRecordRepository.prototype.enrollFinancialSourceParents=function(input){
      const db=this.db,proxy=new Proxy(db,{get(target,property){if(property==="batch")return async(statements:Parameters<D1Database["batch"]>[0])=>{injected++;const final=[...statements];final[final.length-2]=db.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES('isolated_failure','x',json('invalid'),0)");return db.batch(final);};const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}});
      return original.call(new D1IdentityRecordRepository(proxy,this.initialize,this.hashSession),input);
    };
    await expect(f.prove()).rejects.toThrow();expect(injected).toBe(1);for(const bucket of [financialSourceBuckets.parents,financialSourceBuckets.raw,financialSourceBuckets.pending,financialSourceBuckets.affected,"financial_source_cas_claims"])expect(await f.rows(bucket)).toHaveLength(0);await unchanged(f);
  }finally{D1IdentityRecordRepository.prototype.enrollFinancialSourceParents=original;await f.close();}
},20000);

test("native D1 merge reserve automatically closes old generation before deleting grants and cannot reopen it",async()=>{
  const merge=await prepareIsolatedReserveMutation("native-d1"),f=await fixture(merge);try{await enrolled(f);const before=await f.store.findFinancialSourceParent(f.scopes.accountGeneration);expect(await merge.execute()).toBe(true);const closed=await f.store.findFinancialSourceParent(f.scopes.accountGeneration);expect(closed?.state).toBe("closed");expect(closed?.sequence).toBe(before!.sequence+1);const raw=await f.store.findFinancialSourceRaw(closed!.lastEventRef);expect(raw?.cause).toEqual({kind:"identity-generation-advanced",subject:f.subject,previousGeneration:0,nextGeneration:1,operationId:merge.operation.operationId,operationRevision:merge.mutation.next.revision,reason:"reserve"});expect(await f.store.getAccountAuthenticationGeneration(f.subject)).toBe(1);expect(await f.store.findAccessToken(f.token)).toBeUndefined();expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(5);expect((await f.store.findFinancialSourceParent(f.scopes.grant))?.state).toBe("open");await unchanged(f);
  }finally{await f.close();await merge.close();}
},20000);

for(const attack of ["token-replaced","affected-missing","affected-rebound","closed-before-dispatch"] as const)test(`native D1 proof final ${attack} recheck rejects after enrollment and full receiver ACKs`,async()=>{
  const f=await fixture();try{await enrolled(f);await f.producer.flush({limit:100});const original=f.store.issueFinancialSourceProof.bind(f.store);let checked=0;
    f.store.issueFinancialSourceProof=async input=>{checked++;
      if(attack==="token-replaced")await f.store.saveAccessToken(f.token,{...f.record,scope:"openid profile"});
      if(attack==="affected-missing")await f.db.prepare("DELETE FROM takosumi_accounts_documents WHERE bucket=? AND key=?").bind(financialSourceBuckets.affected,input.expectedParents.grant.affectedRef).run();
      if(attack==="affected-rebound")await f.repository.put(financialSourceBuckets.affected,input.expectedParents.grant.affectedRef,{affectedRef:input.expectedParents.grant.affectedRef,scope:f.scopes.client,registrationRef:f.registration.registrationRef,incarnation:f.registration.incarnation});
      if(attack==="closed-before-dispatch")await f.store.revokeHostedOidcGrant(f.record.sid!,f.clock());
      return original(input);
    };
    await expect(f.prove()).rejects.toThrow("source_conflict");expect(checked).toBe(1);expect(await f.rows(financialSourceBuckets.proofs)).toHaveLength(0);expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(attack==="closed-before-dispatch"?5:4);await unchanged(f);
  }finally{await f.close();}
},20000);

test("native D1 failed closing outbox write rolls back actual revocation/tombstone and keeps original head",async()=>{
  const f=await fixture(),original=D1IdentityRecordRepository.prototype.revokeHostedOidcScope;let injected=0;try{await enrolled(f);await f.producer.flush({limit:100});const before=await f.store.findFinancialSourceParent(f.scopes.client);
    D1IdentityRecordRepository.prototype.revokeHostedOidcScope=function(input){const db=this.db,proxy=new Proxy(db,{get(target,property){if(property==="batch")return async(statements:Parameters<D1Database["batch"]>[0])=>{injected++;const final=[...statements];final[2]=db.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES('isolated_failure','x',json('invalid'),0)");return db.batch(final);};const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}});return original.call(new D1IdentityRecordRepository(proxy,this.initialize,this.hashSession),input);};
    await expect(f.store.revokeHostedOidcClientGrants(f.record.clientId,f.clock())).rejects.toThrow();expect(injected).toBe(1);expect(await f.store.findFinancialSourceParent(f.scopes.client)).toEqual(before);expect((await f.store.findHostedOidcGrant(f.record.sid!))?.revokedAt).toBeUndefined();expect(await f.rows("hosted_oidc_revoked_clients")).toHaveLength(0);expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(4);await unchanged(f);
  }finally{D1IdentityRecordRepository.prototype.revokeHostedOidcScope=original;await f.close();}
},20000);

test("native D1 pending pages are bounded opaque event refs, registration-isolated and independent of terminal history",async()=>{
  const f=await fixture();try{await enrolled(f);const history=Array.from({length:501},(_,i)=>f.db.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES(?,?,?,0)").bind(financialSourceBuckets.raw,`terminal-${i}`,"{}"));await f.db.batch(history);const other={...f.registration,registrationRef:"native-reg_extra"};expect(await f.store.registerFinancialSourceRegistration(other)).toBe(true);await f.repository.put(financialSourceBuckets.pending,financialSourceJson([other.registrationRef,"unrelated-event"]),{registration:other,eventRef:"unrelated-event",createdAt:f.clock()});
    const refs:string[]=[];let after:string|undefined;do{const page=await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,after,limit:1});expect(page.entries.length).toBe(1);expect(page.entries[0]!.registration).toEqual(f.registration);refs.push(page.entries[0]!.eventRef);after=page.nextCursor;if(after){expect(after).toBe(page.entries[0]!.eventRef);expect(after).not.toContain(f.subject);}}while(after);expect(new Set(refs).size).toBe(4);expect(refs).toEqual([...refs].sort());await expect(f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:101})).rejects.toThrow();await unchanged(f);
  }finally{await f.close();}
},20000);

test("native D1 materialization CAS binds full captured parent and permits sequential catch-up after a concurrent close",async()=>{
  const f=await fixture(),get=D1IdentityRecordRepository.prototype.get;let changed=0;try{await enrolled(f);const head=(await f.store.findFinancialSourceParent(f.scopes.client))!,raw=(await f.store.findFinancialSourceRaw(head.lastEventRef))!,materialization=await materializeFinancialSourceEvent({registration:f.registration,raw:raw.raw});
    D1IdentityRecordRepository.prototype.get=async function<T>(bucket:string,key:string):Promise<T|undefined>{const value=await get.call(this,bucket,key) as T|undefined;if(bucket===financialSourceBuckets.parents&&key===financialSourceScopeKey(f.scopes.client)&&changed++===0)await f.store.revokeHostedOidcClientGrants(f.record.clientId,f.clock());return value;};
    expect(await f.store.commitFinancialSourceMaterialization({expectedRaw:raw,materialization})).toBe(false);D1IdentityRecordRepository.prototype.get=get;expect(await f.store.findFinancialSourceMaterialization(head.lastEventRef)).toBeUndefined();const closed=(await f.store.findFinancialSourceParent(f.scopes.client))!;expect(closed.sequence).toBe(2);
    expect((await f.producer.flush({limit:100})).processed).toBe(5);expect((await f.store.findFinancialSourceMaterialization(head.lastEventRef))?.materialization.event.sequence).toBe(1);expect((await f.store.findFinancialSourceMaterialization(closed.lastEventRef))?.materialization.event.previousDigest).toBe(materialization.eventDigest);expect((await f.store.listFinancialSourcePending({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(0);await unchanged(f);
  }finally{D1IdentityRecordRepository.prototype.get=get;await f.close();}
},20000);

for(const mode of ["modern","legacy"] as const)test(`native D1 ${mode} unlink automatically closes only the old generation with explicit custody`,async()=>{
  const f=await fixture();try{
    const removed={providerId:"google",upstreamIssuer:"https://accounts.google.com",upstreamSubject:"native-google"},retained={providerId:"github",upstreamIssuer:"https://github.com",upstreamSubject:"native-github"};
    for(const identity of [removed,retained])await f.store.linkUpstreamIdentity({...identity,subject:f.subject,createdAt:f.clock(),updatedAt:f.clock()});
    const sessionId=(await rotateAccountSession({store:f.store,subject:f.subject,now:f.clock(),ttlMs:60000,hostedPolicy:true,freshlyAuthenticatedAt:Math.floor(f.clock()/1000)})).sessionId,session=(await f.store.findAccountSession(sessionId))!;
    await enrolled(f);let operationId:string;
    if(mode==="modern"){
      const browserBindingHash=await sha256Text("isolated-native-unlink-browser"),intent=await createCredentialUnlinkIntent({store:f.store,session,removedIdentity:removed,retainedIdentity:retained,browserBindingHash,now:f.clock()});operationId=intent.operationId;
      const receipt:CredentialUnlinkReceipt={receiptId:`iupr_${crypto.randomUUID()}`,operationId,subject:f.subject,removedIdentity:removed,retainedIdentity:retained,browserBindingHash,issuerSessionHash:intent.issuerSessionHash,identityGeneration:0,policyVersion:intent.policyVersion,transactionDigest:await sha256Text("isolated-native-unlink-transaction"),startedAt:f.clock(),completedAt:f.clock(),expiresAt:intent.expiresAt,legConsent:true,legConsentAt:f.clock(),method:"upstream-oauth-operation"};expect(await f.store.createCredentialUnlinkReceipt(receipt)).toBe(true);
      await completeCredentialUnlink({store:f.store,intent,receiptId:receipt.receiptId,now:f.clock(),clock:f.clock,reconciler:{acknowledgeCredentialUnlinkIntent:async context=>({...context,ownerRef:"isolated-native-owner-ack",acknowledgedAt:f.clock()})}});
    }else{operationId="native-legacy-unlink";expect(await f.store.unlinkCanonicalUpstreamIdentity({subject:f.subject,identity:removed,proof:{sessionId,subject:f.subject,authTime:session.reauthenticatedAt!},operationId,now:f.clock()})).toBe(true);}
    const head=await f.store.findFinancialSourceParent(f.scopes.accountGeneration);expect(head?.state).toBe("closed");const raw=await f.store.findFinancialSourceRaw(head!.lastEventRef);expect(raw?.cause).toMatchObject({kind:"identity-generation-advanced",previousGeneration:0,nextGeneration:1,operationId,reason:"unlink",operationRevision:mode==="legacy"?0:1});expect("legacyUnlink" in raw!.cause?raw!.cause.legacyUnlink:undefined).toBe(mode==="legacy"?true:undefined);for(const slot of slots.filter(s=>s!=="accountGeneration"))expect((await f.store.findFinancialSourceParent(f.scopes[slot]))?.state).toBe("open");expect(await f.store.getAccountAuthenticationGeneration(f.subject)).toBe(1);expect(await f.store.findAccessToken(f.token)).toBeUndefined();await unchanged(f);
  }finally{await f.close();}
},20000);
