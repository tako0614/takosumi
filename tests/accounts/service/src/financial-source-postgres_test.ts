/** PGlite checks native SQL/rollback semantics only. It does not qualify real
 * PostgreSQL 16 multiwriter/lock-wait behavior; that proof runs separately. */
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { PostgresIdentityRecordRepository } from "../../../../accounts/service/src/postgres/identity-records.ts";
import { createAccountsFinancialSource } from "../../../../accounts/service/src/financial-source.ts";
import { financialSourceBuckets, financialSourceScopeKey } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { materializeFinancialSourceEvent, type FinancialSourceMaterialization, type FinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-contract.ts";
import type { TokenRecord } from "../../../../accounts/service/src/store.ts";
import type { FinancialSourceParentHead } from "../../../../accounts/service/src/identity-state.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { createCredentialUnlinkIntent, completeCredentialUnlink } from "../../../../accounts/service/src/identity-unlink.ts";
import { identityContextFixture, acceptIsolatedIdentityContexts, isolatedContextReconciler, contextA, contextB } from "../fixtures/identity-context-fixture.ts";
import { consentIdentityMerge } from "../../../../accounts/service/src/identity-merge.ts";
const contextNow=Date.now();

const table="accounts_v1.hosted_identity_records";
const baseline=`CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject),created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);`;
const slots=["grant","issuerSession","client","accountGeneration"] as const;
async function fixture() {
  const pg=new PGlite();
  try {
  await pg.exec(baseline);
  await pg.exec(await Bun.file(new URL("../../../../accounts/service/migrations/045_hosted_canonical_identity.sql",import.meta.url)).text());
  let beforeQuery:((sql:string,args:readonly unknown[])=>Promise<void>)|undefined;
  const queries:{sql:string;args:readonly unknown[]}[]=[];
  const client={async queryObject<T>(sql:string,args:readonly unknown[]=[]){queries.push({sql,args});const hook=beforeQuery;if(hook)await hook(sql,args);return {rows:(await pg.query(sql,[...args])).rows as T[]};}};
  const store=new PostgresAccountsStore(client),repository=new PostgresIdentityRecordRepository(client);
  const subject="tsub_context_B",token="isolated-pg-financial-bearer-never-record";
  let time=contextNow,deliveries=0;
  const issuer="https://financial-pg.fixture.invalid";
  await store.saveAccount({subject,createdAt:time,updatedAt:time});
  const record:TokenRecord={clientId:"static-hosted",scope:"openid",subject,takosumiSubject:subject,oidcProfile:"shared-account",issuer,identityGeneration:0,authTime:1000,sid:"sid-pg-source",issuerSessionId:"issuer-session-pg-source",expiresAt:time+200000};
  await store.saveAccessToken(token,record);
  await store.saveHostedOidcGrant({sid:record.sid!,issuerSessionId:record.issuerSessionId!,clientId:record.clientId,subject,scope:record.scope,issuer,identityGeneration:0,authTime:record.authTime!,createdAt:time,absoluteExpiresAt:time+300000});
  const registration={registrationRef:"registration_pg_1",incarnation:"pg-incarnation",genesisDigest:`sha256:${"a".repeat(64)}` as const,receivers:[{receiverRef:"receiver-A",targetRef:"target-A"},{receiverRef:"receiver-B",targetRef:"target-B"}]};
  expect(await store.registerFinancialSourceRegistration!(registration)).toBe(true);
  const challenge={v:1 as const,challengeRef:"challenge-pg",registrationRef:registration.registrationRef,clientId:record.clientId,workspaceId:"workspace-original",organizationId:"org-original",workspaceRef:"workspace-ref-original",requestFingerprint:`sha256:${"b".repeat(64)}` as const,createdAt:time,expiresAt:time+120000};
  const remote=new Map<string,FinancialSourceMaterialization>();
  const receipt=(m:FinancialSourceMaterialization):FinancialSourceReceipt=>({v:1,eventRef:m.event.eventRef,eventDigest:m.eventDigest,receiptRef:"receipt/"+m.event.eventRef,incarnation:m.event.incarnation,sequence:m.event.sequence,state:m.event.kind==="close"?"admission-closed":"advanced"});
  const control={accountId:subject,workspaceId:challenge.workspaceId,organizationId:challenge.organizationId,workspaceRef:challenge.workspaceRef,evidence:{evidenceRef:"control-pg",evidenceDigest:`sha256:${"c".repeat(64)}` as const,expiresAt:time+120000,source:{registrationRef:"control-pg-source",incarnation:"control-pg-incarnation",affectedRef:"control-pg-original-affected",sequence:0,eventRef:null,eventDigest:`sha256:${"d".repeat(64)}` as const,receivers:[{receiverRef:"control-receiver",targetRef:"control-target"}]}}};
  const producer=createAccountsFinancialSource({store,issuer,registration,now:()=>time,clients:[{clientId:record.clientId,profile:"shared-account",enabled:true,allowedScopes:["openid"],redirectUris:["https://app.fixture.invalid/callback"]}],challenges:{read:async()=>structuredClone(challenge)},control:{capture:async()=>structuredClone(control),assertCurrent:async()=>true},receivers:registration.receivers.map(r=>({...r,async read(m){const old=remote.get(r.receiverRef+"/"+m.event.eventRef);return old?receipt(old):undefined;},async deliver(m){deliveries++;remote.set(r.receiverRef+"/"+m.event.eventRef,structuredClone(m));return receipt(m);}}))});
  const scopes={grant:{kind:"grant" as const,sid:record.sid!},issuerSession:{kind:"issuer-session" as const,issuerSessionId:record.issuerSessionId!},client:{kind:"client" as const,clientId:record.clientId},accountGeneration:{kind:"account-generation" as const,subject,identityGeneration:0}};
  return {pg,client,store,repository,subject,token,record,registration,challenge,producer,scopes,queries,clock:()=>time,time:(value:number)=>{time=value;},deliveries:()=>deliveries,
    hook(fn?: (sql:string,args:readonly unknown[])=>Promise<void>){beforeQuery=fn;},
    prove:()=>producer.prove({accessToken:token,challengeRef:challenge.challengeRef}),
    rows:async(bucket?:string)=>(await pg.query(`SELECT bucket,key,document FROM ${table} ${bucket?"WHERE bucket=$1":""} ORDER BY bucket,key`,bucket?[bucket]:[])).rows,
    close:()=>pg.close()};
  }catch(error){await pg.close();throw error;}
}
async function enrolled(f:Awaited<ReturnType<typeof fixture>>) {
  await expect(f.prove()).rejects.toThrow("source_pending");
  const heads={} as Record<typeof slots[number],FinancialSourceParentHead>;
  for(const slot of slots)heads[slot]=(await f.store.findFinancialSourceParent!(f.scopes[slot]))!;
  return heads;
}

test("postgres producer atomically enrolls all four parents and requires every exact receiver ACK before proof",async()=>{
  const f=await fixture();try{
    const heads=await enrolled(f);
    expect(await f.rows(financialSourceBuckets.parents)).toHaveLength(4);
    expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(4);
    expect((await f.store.listFinancialSourcePending!({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(4);
    expect(await f.producer.flush({limit:100})).toEqual({processed:4});expect(f.deliveries()).toBe(8);
    expect((await f.store.listFinancialSourcePending!({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(0);
    const proof=await f.prove(),saved=(await f.store.findFinancialSourceProof!(proof.proofRef))!;expect(saved.proofRef).toBe(proof.proofRef);expect(saved.challenge).toEqual(f.challenge);
    expect(saved.accessTokenHash).toBe(await sha256Text(f.token));expect(saved.accessExpiresAt).toBe(f.record.expiresAt);
    expect(Object.keys(saved.parents).sort()).toEqual([...slots].sort());
    for(const slot of slots)expect(saved.parents[slot].eventRef).toBe(heads[slot].lastEventRef);
    expect(JSON.stringify(await f.rows())).not.toContain(f.token);
    expect(f.queries.filter(q=>q.sql.includes("authority_claim")).every(q=>!q.sql.includes("oidc_clients"))).toBe(true);
  }finally{await f.close();}
},30000);

test("postgres SID absence creates only a terminal Financial scope fence, and session/client revoke persists real tombstones",async()=>{
  const f=await fixture();try{
    const unseen={kind:"grant" as const,sid:"sid-not-yet-minted"};
    expect(await f.store.revokeHostedOidcScope!({scope:unseen,evidenceRef:"revoke-unseen",now:f.clock()})).toBe(true);
    expect(await f.repository.get(financialSourceBuckets.parents,financialSourceScopeKey(unseen))).toMatchObject({scope:unseen,closed:true});
    expect(await f.store.findHostedOidcGrant!(unseen.sid)).toBeUndefined();expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(0);
    await enrolled(f);
    for(const scope of [f.scopes.issuerSession,f.scopes.client]){
      expect(await f.store.revokeHostedOidcScope!({scope,evidenceRef:"revoke-existing",now:f.clock()+1})).toBe(true);
      const head=(await f.store.findFinancialSourceParent!(scope))!;expect(head.state).toBe("closed");expect(head.sequence).toBe(2);
      const raw=(await f.store.findFinancialSourceRaw!(head.lastEventRef))!;expect(raw.raw.kind).toBe("close");
      const before=await f.rows(financialSourceBuckets.pending);
      expect(await f.store.revokeHostedOidcScope!({scope,evidenceRef:"revoke-replay",now:f.clock()+2})).toBe(true);
      expect(await f.rows(financialSourceBuckets.pending)).toEqual(before);
    }
    expect(await f.store.isHostedOidcSessionRevoked!(f.record.issuerSessionId!)).toBe(true);
    expect(await f.store.isHostedOidcClientRevoked!(f.record.clientId)).toBe(true);
    expect((await f.store.findHostedOidcGrant!(f.record.sid!))?.revokedAt).toBe(f.clock()+1);
  }finally{await f.close();}
},30000);

test("postgres revoke forces close raw/outbox cardinality even when the generic grant is already absent",async()=>{
  for(const conflict of ["raw","pending"] as const){
    const f=await fixture();try{
      const heads=await enrolled(f),eventRef=heads.grant.affectedRef+"/closed";
      await f.pg.query(`DELETE FROM ${table} WHERE bucket='hosted_oidc_grants'`);
      const bucket=conflict==="raw"?financialSourceBuckets.raw:financialSourceBuckets.pending;
      const key=conflict==="raw"?eventRef:JSON.stringify([f.registration.registrationRef,eventRef]);
      await f.repository.create(bucket,key,{isolatedConflictingOriginal:true});
      const before=await f.rows();
      await expect(f.store.revokeHostedOidcScope!({scope:f.scopes.grant,evidenceRef:"revoke-conflict",now:f.clock()+1})).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.store.findFinancialSourceParent!(f.scopes.grant))!.state).toBe("open");
    }finally{await f.close();}
  }
},30000);

test("postgres actual token/grant and current security rows defeat cached enrollment, with no partial Financial writes",async()=>{
  for(const attack of ["delete-token","replace-token","revoke-grant","generation","canonical","null-fence","session-tombstone","client-tombstone"] as const){
    const f=await fixture();try{
      f.hook(async(sql)=>{if(!sql.includes("authority_claim"))return;f.hook();
        if(attack==="delete-token")await f.pg.query("DELETE FROM accounts_v1.oauth_access_tokens");
        if(attack==="replace-token")await f.pg.query("UPDATE accounts_v1.oauth_access_tokens SET expires_at=expires_at+interval '1 second'");
        if(attack==="revoke-grant")await f.pg.query(`UPDATE ${table} SET document=document||jsonb_build_object('revokedAt',$1::bigint) WHERE bucket='hosted_oidc_grants'`,[f.clock()]);
        const write=async(bucket:string,key:string,doc:unknown)=>{await f.pg.query(`INSERT INTO ${table}(bucket,key,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(bucket,key) DO UPDATE SET document=excluded.document`,[bucket,key,JSON.stringify(doc)]);};
        if(attack==="generation")await write("authentication_generations",f.subject,{subject:f.subject,generation:1});
        if(attack==="canonical")await write("canonical_accounts",f.subject,{sourceSubject:f.subject,targetSubject:"tsub_foreign"});
        if(attack==="null-fence")await write("identity_merge_locks",f.subject,{subject:f.subject,operationId:null});
        if(attack==="session-tombstone")await write("hosted_oidc_revoked_sessions",f.record.issuerSessionId!,{issuerSessionId:f.record.issuerSessionId,revokedAt:f.clock()});
        if(attack==="client-tombstone")await write("hosted_oidc_revoked_clients",f.record.clientId,{clientId:f.record.clientId,revokedAt:f.clock()});
      });
      await expect(f.prove()).rejects.toThrow();
      for(const bucket of [financialSourceBuckets.parents,financialSourceBuckets.raw,financialSourceBuckets.pending,financialSourceBuckets.affected,financialSourceBuckets.proofs])expect(await f.rows(bucket)).toHaveLength(0);
      expect(JSON.stringify(await f.rows())).not.toContain(f.token);
    }finally{await f.close();}
  }
},30000);

test("postgres skipped native write cardinality rolls back every parent/raw/affected/outbox row",async()=>{
  const f=await fixture();try{
    await f.pg.exec(`CREATE FUNCTION accounts_v1.isolated_skip_raw() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bucket='${financialSourceBuckets.raw}' THEN RETURN NULL; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER isolated_skip_raw BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION accounts_v1.isolated_skip_raw();`);
    await expect(f.prove()).rejects.toThrow();
    for(const bucket of [financialSourceBuckets.parents,financialSourceBuckets.raw,financialSourceBuckets.pending,financialSourceBuckets.affected])expect(await f.rows(bucket)).toHaveLength(0);
    expect((await f.store.findHostedOidcGrant!(f.record.sid!))?.revokedAt).toBeUndefined();
  }finally{await f.close();}
},30000);

test("postgres materialization CAS checks full raw and captured parent, while pending pagination keeps underscore refs literal",async()=>{
  const f=await fixture();try{
    const heads=await enrolled(f),head=heads.grant,raw=(await f.store.findFinancialSourceRaw!(head.lastEventRef))!;
    const materialization=await materializeFinancialSourceEvent({registration:f.registration,raw:raw.raw}),before=await f.rows(financialSourceBuckets.materializations);
    f.hook(async(sql)=>{if(!sql.includes("document_claim"))return;f.hook();await f.pg.query(`UPDATE ${table} SET document=jsonb_set(document,'{cause,challengeRef}','"changed-original"'::jsonb) WHERE bucket=$1 AND key=$2`,[financialSourceBuckets.raw,head.lastEventRef]);});
    expect(await f.store.commitFinancialSourceMaterialization!({expectedRaw:raw,materialization})).toBe(false);
    expect(await f.rows(financialSourceBuckets.materializations)).toEqual(before);
    const foreign={...f.registration,registrationRef:"registrationXpgX1"};await f.store.registerFinancialSourceRegistration!(foreign);
    await f.repository.create(financialSourceBuckets.pending,JSON.stringify([foreign.registrationRef,"foreign-event"]),{registration:foreign,eventRef:"foreign-event",createdAt:f.clock()});
    let after:string|undefined;const seen:string[]=[];
    do{const page=await f.store.listFinancialSourcePending!({registrationRef:f.registration.registrationRef,after,limit:1});
      for(const entry of page.entries){expect(entry.registration.registrationRef).toBe(f.registration.registrationRef);seen.push(entry.eventRef);}after=page.nextCursor;
    }while(after);
    expect(new Set(seen).size).toBe(4);expect(seen).not.toContain("foreign-event");
  }finally{await f.close();}
},30000);

async function unlinkSetup(f:Awaited<ReturnType<typeof fixture>>) {
  const identities=["first","second"].map(providerId=>({subject:f.subject,providerId,upstreamIssuer:`https://${providerId}.fixture.invalid`,upstreamSubject:providerId,createdAt:1,updatedAt:1}));
  for(const identity of identities)await f.store.linkUpstreamIdentity(identity);
  const login=await rotateAccountSession({store:f.store,subject:f.subject,now:f.clock(),ttlMs:60000,hostedPolicy:true});
  const session={...(await f.store.findAccountSession(login.sessionId))!,reauthenticatedAt:1000};await f.store.saveAccountSession(session);
  await f.repository.create("credential_generations",f.subject,{subject:f.subject,revision:0});
  return {identities,session};
}
test("postgres legacy unlink closes exactly the old generation with explicit legacy revision zero",async()=>{
  const f=await fixture();try{
    const heads=await enrolled(f),{identities,session}=await unlinkSetup(f);
    expect(await f.store.unlinkCanonicalUpstreamIdentity!({subject:f.subject,identity:identities[0]!,proof:{sessionId:session.sessionId,subject:f.subject,authTime:1000},operationId:"iunl_pg_legacy",now:f.clock()})).toBe(true);
    expect(await f.store.getAccountAuthenticationGeneration!(f.subject)).toBe(1);
    expect(await f.store.findAccountSession(session.sessionId)).toBeUndefined();
    const closed=(await f.store.findFinancialSourceParent!(heads.accountGeneration.scope))!;
    expect(closed.state).toBe("closed");expect((await f.store.findFinancialSourceRaw!(closed.lastEventRef))!.cause).toEqual({kind:"identity-generation-advanced",subject:f.subject,previousGeneration:0,nextGeneration:1,operationId:"iunl_pg_legacy",operationRevision:0,reason:"unlink",legacyUnlink:true});
    expect(await f.rows(financialSourceBuckets.raw)).toHaveLength(5);
  }finally{await f.close();}
},30000);

test("postgres losing generation writer rolls back closure, audit, credential mutation and native tokens together",async()=>{
  const f=await fixture();try{
    await enrolled(f);const {identities,session}=await unlinkSetup(f),before=await f.rows();
    // A deterministic native write failure exercises the cardinality rollback.
    // It is not a simulation/proof of real-server absent-row multiwriter locks.
    await f.pg.exec(`CREATE FUNCTION accounts_v1.isolated_skip_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bucket='authentication_generations' THEN RETURN NULL; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER isolated_skip_epoch BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION accounts_v1.isolated_skip_epoch();`);
    expect(await f.store.unlinkCanonicalUpstreamIdentity!({subject:f.subject,identity:identities[0]!,proof:{sessionId:session.sessionId,subject:f.subject,authTime:1000},operationId:"iunl_pg_lost_epoch",now:f.clock()})).toBe(false);
    expect(await f.rows()).toEqual(before);expect(await f.store.findAccessToken(f.token)).toEqual(f.record);
    expect(await f.store.findAccountSession(session.sessionId)).toBeDefined();expect(await f.store.getAccountAuthenticationGeneration!(f.subject)).toBe(0);
  }finally{await f.close();}
},30000);

test("postgres modern unlink advances once and closes old generation with durable operation revision",async()=>{
  const f=await fixture();try{
    const heads=await enrolled(f),{identities,session}=await unlinkSetup(f),browserBindingHash=await sha256Text("isolated-pg-unlink-browser");
    const intent=await createCredentialUnlinkIntent({store:f.store,session,removedIdentity:identities[0]!,retainedIdentity:identities[1]!,browserBindingHash,now:f.clock()});
    const receipt={receiptId:`iupr_${crypto.randomUUID()}`,operationId:intent.operationId,subject:f.subject,removedIdentity:intent.removedIdentity,retainedIdentity:intent.retainedIdentity,browserBindingHash,issuerSessionHash:intent.issuerSessionHash,identityGeneration:0,policyVersion:intent.policyVersion,transactionDigest:await sha256Text("isolated-pg-unlink-proof"),startedAt:f.clock(),completedAt:f.clock(),expiresAt:intent.expiresAt,legConsent:true as const,legConsentAt:f.clock(),method:"upstream-oauth-operation" as const};
    expect(await f.store.createCredentialUnlinkReceipt!(receipt)).toBe(true);
    const completed=await completeCredentialUnlink({store:f.store,intent,receiptId:receipt.receiptId,now:f.clock(),clock:f.clock,reconciler:{acknowledgeCredentialUnlinkIntent:async c=>({...c,ownerRef:"isolated-owner",acknowledgedAt:f.clock()})}});
    expect(completed.status).toBe("completed");expect(await f.store.getAccountAuthenticationGeneration!(f.subject)).toBe(1);
    const closed=(await f.store.findFinancialSourceParent!(heads.accountGeneration.scope))!;
    expect((await f.store.findFinancialSourceRaw!(closed.lastEventRef))!.cause).toEqual({kind:"identity-generation-advanced",subject:f.subject,previousGeneration:0,nextGeneration:1,operationId:intent.operationId,operationRevision:completed.revision,reason:"unlink"});
    expect(await f.store.findAccessToken(f.token)).toBeUndefined();
  }finally{await f.close();}
},30000);

test("postgres actual merge reservation closes both old generation scopes atomically with owned fences",async()=>{
  const f=await fixture(),memory=await identityContextFixture();try{
    const heads=await enrolled(f),op=await acceptIsolatedIdentityContexts(memory.store,memory.operation,memory.now);
    f.time(memory.now);
    for(const subject of [contextA,contextB]){
      await f.store.saveAccount((await memory.store.findAccount(subject))!);
      await f.store.saveAccountEmailProof!((await memory.store.findAccountEmailProof!(subject))!);
      for(const identity of await memory.store.listCanonicalUpstreamIdentities!(subject))await f.store.linkUpstreamIdentity(identity);
    }
    await f.store.createIdentityMergeOperation!(op);
    await f.store.createIdentityMergeContextPlan!((await memory.store.findIdentityMergeContextPlan!(op.contextPlan!.planId))!);
    for(const p of [op.sourceProof!,op.targetProof!])await f.store.createIdentityOperationReceipt!((await memory.store.findIdentityOperationReceipt!(p.receiptId))!);
    for(const r of [op.sourceContextAcceptance!,op.targetContextAcceptance!])await f.store.createIdentityMergeContextReceipt!((await memory.store.findIdentityMergeContextReceipt!(r.receiptId))!);
    const login=await rotateAccountSession({store:f.store,subject:contextA,now:f.clock(),ttlMs:60000,hostedPolicy:true}),session=(await f.store.findAccountSession(login.sessionId))!;
    const reserved=await consentIdentityMerge({store:f.store,operation:op,session,now:f.clock(),clock:f.clock,consent:true,retryCapability:{pendingCapacity:100,assertAvailable:async()=>{}},reconciler:isolatedContextReconciler(f.store,f.clock())});
    expect(reserved.consentAt).toBe(f.clock());
    const closed=(await f.store.findFinancialSourceParent!(heads.accountGeneration.scope))!;
    expect(closed.state).toBe("closed");expect((await f.store.findFinancialSourceRaw!(closed.lastEventRef))!.cause).toMatchObject({kind:"identity-generation-advanced",subject:contextB,previousGeneration:0,nextGeneration:1,operationId:op.operationId,operationRevision:reserved.revision,reason:"reserve"});
    for(const subject of [contextA,contextB]){expect(await f.store.getAccountAuthenticationGeneration!(subject)).toBe(1);expect(await f.store.isAccountAuthenticationFenced!(subject)).toBe(true);}
    expect(await f.store.findAccessToken(f.token)).toBeUndefined();
  }finally{await memory.close();await f.close();}
},30000);
