/** Actual Accounts producer/store integration. Financial challenges, Control
 * context and receiver ACKs below are synthetic ports, not payer authority or
 * qualification of a deployed Accounts/Control/Financial service graph. */
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createEphemeralAccountsHandler,
  type OidcClientRegistration,
} from "../../../../accounts/service/src/mod.ts";
import {
  InMemoryAccountsStore,
  type AccountsStore,
  type TokenRecord,
} from "../../../../accounts/service/src/store.ts";
import {
  D1AccountsStore,
  type D1Database,
} from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../../accounts/service/src/d1-migrations.ts";
import {
  HOSTED_ACCOUNT_SESSION_COOKIE_NAME,
  rotateAccountSession,
} from "../../../../accounts/service/src/account-session.ts";
import {
  createAccountsFinancialSource,
  type AccountsFinancialSourceOptions,
  type AccountsFinancialEventEvidenceOptions,
} from "../../../../accounts/service/src/financial-source.ts";
import {
  financialSourceEventDigest,
  canonicalFinancialSourceJson,
  parseFinancialSourceEvent,
  parseFinancialSourceReceipt,
  type FinancialIdentityChallenge,
  type FinancialSourceMaterialization,
  type FinancialSourceReceipt,
  type FinancialSourceRegistration,
  materializeFinancialSourceEvent,
} from "../../../../accounts/service/src/financial-source-contract.ts";
import { makeFinancialSourceReceipt, type FinancialSourceRegisteredHead, type FinancialSourceCredentialContext } from "../../../../accounts/service/src/financial-source-abi.ts";
import { HostedIdentityRecords, type IdentityRecordRepository } from "../../../../accounts/service/src/hosted-identity-records.ts";
import { MemoryIdentityRecordRepository } from "../../../../accounts/service/src/memory-identity-records.ts";
import type {
  FinancialSourceParentScope,
  FinancialSourceRawRecord,
  IdentityOperationReceiptRecord,
} from "../../../../accounts/service/src/identity-state.ts";
import {
  createIdentityMerge,
  proveIdentityMerge,
  consentIdentityMerge,
} from "../../../../accounts/service/src/identity-merge.ts";
import {
  base64UrlEncodeBytes,
  sha256Text,
} from "../../../../accounts/service/src/encoding.ts";
import {
  acceptIsolatedIdentityContexts,
  isolatedContextReconciler,
} from "../fixtures/identity-context-fixture.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const issuer = "https://financial-issuer.example.test";
const subject = "tsub_financial_integration";
const otherSubject = "tsub_financial_integration_other";
const address = "FinancialOwner@example.test";
const verifier = "v".repeat(43);
type Backend = "memory" | "d1" | "postgres";

// The existing pre-045 Accounts tables, followed by the actual owning SQL
// migrations. This is an isolated PGlite database, not a second source store.
const pgBaseline = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);`;

async function fixture(backend: Backend) {
  let store: AccountsStore;
  let d1: SqliteFakeD1 | undefined;
  let pg: PGlite | undefined;
  if (backend === "memory") store = new InMemoryAccountsStore();
  else if (backend === "d1") {
    const db = d1 = new SqliteFakeD1();
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations)
      await applyD1AccountsMigrationBatch(db, migration, 100 + migration.version);
    store = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed",
    });
  } else {
    pg = new PGlite();
    await pg.exec(pgBaseline);
    for (const name of [
      "019_refresh_chain.sql",
      "045_hosted_canonical_identity.sql",
    ])
      await pg.exec(
        await Bun.file(
          new URL(`../../../../accounts/service/migrations/${name}`, import.meta.url),
        ).text(),
      );
    store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({
        rows: (await pg!.query(sql, [...args])).rows as T[],
      }),
    });
  }
  const now = Date.now();
  await store.saveAccount({
    subject, email: address, emailVerified: true, createdAt: now, updatedAt: now,
  });
  const rotated = await rotateAccountSession({
    store, subject, now, ttlMs: 600_000, hostedPolicy: true,
    freshlyAuthenticatedAt: Math.floor(now / 1000),
  });
  const session = (await store.findAccountSession(rotated.sessionId))!;
  const clients: OidcClientRegistration[] = ["hosted", "takoserver"].map((clientId) => ({
    clientId, profile: "shared-account", enabled: true,
    clientSecret: `synthetic-secret-${clientId}`,
    tokenEndpointAuthMethod: "client_secret_basic",
    allowedScopes: ["openid", "offline_access"],
    redirectUris: [`https://${clientId}.example.test/callback`],
  }));
  const handler = await createEphemeralAccountsHandler({
    issuer, store, clients, hostedSessionPolicy: true,
    allowEphemeralKeyOnHttpsIssuer: true,
  });
  const cookie = `${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${session.sessionId}`;
  function exchange(body: Record<string, string>, clientId = "hosted") {
    return handler(new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${clientId}:synthetic-secret-${clientId}`)}`,
      },
      body: new URLSearchParams(body),
    }));
  }
  async function grant(clientId = "hosted") {
    const pkce = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(verifier),
    )));
    const url = new URL(`${issuer}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: clientId,
      redirect_uri: `https://${clientId}.example.test/callback`,
      scope: "openid offline_access", state: "financial-integration-state",
      nonce: "financial-integration-nonce", code_challenge: pkce,
      code_challenge_method: "S256",
    }).toString();
    let response = await handler(new Request(url, {headers: {cookie}}));
    if (response.status === 200) {
      const transaction = (await response.text()).match(/name="consent_transaction" value="([^"]+)"/)?.[1];
      expect(transaction).toBeTruthy();
      response = await handler(new Request(url, {
        method: "POST",
        headers: {cookie, origin: issuer, "content-type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({consent_transaction: transaction!, approve: "yes"}),
      }));
    }
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    expect(code).toStartWith("hcode_");
    const tokenResponse = await exchange({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: `https://${clientId}.example.test/callback`,
    }, clientId);
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as {access_token: string; refresh_token: string};
    const record = await store.findAccessToken(tokens.access_token);
    expect(record).toMatchObject({issuer, clientId, subject, takosumiSubject: subject, oidcProfile: "shared-account"});
    expect(await store.findHostedOidcGrant!(record!.sid!)).toMatchObject({
      issuer, clientId, subject, sid: record!.sid!, issuerSessionId: record!.issuerSessionId!,
    });
    expect((await store.findCanonicalAccount!(subject))?.subject).toBe(subject);
    return {...tokens, record: record!};
  }

  const registration: FinancialSourceRegistration = {
    registrationRef: "financial-integration-registration",
    incarnation: "financial-integration-incarnation",
    genesisDigest: `sha256:${"a".repeat(64)}`,
    receivers: [
      {receiverRef: "synthetic-financial-primary", targetRef: "synthetic-qualified-primary"},
      {receiverRef: "synthetic-financial-secondary", targetRef: "synthetic-qualified-secondary"},
    ],
  };
  let repository:IdentityRecordRepository|undefined;
  const register=HostedIdentityRecords.prototype.registerFinancialSourceRegistration;
  HostedIdentityRecords.prototype.registerFinancialSourceRegistration=function(value){repository=this.repository;return register.call(this,value);};
  try {expect(await store.registerFinancialSourceRegistration!(registration)).toBe(true);}
  finally {HostedIdentityRecords.prototype.registerFinancialSourceRegistration=register;}
  if(!repository)throw new Error("isolated_actual_repository_not_captured");
  const challenge: FinancialIdentityChallenge = {
    v: 1, challengeRef: "synthetic-financial-challenge", registrationRef: registration.registrationRef,
    clientId: "hosted", workspaceId: "original-workspace", organizationId: "original-organization",
    workspaceRef: "original-workspace-reference", requestFingerprint: `sha256:${"b".repeat(64)}`,
    createdAt: now, expiresAt: now + 120_000,
  };
  const snapshot = {
    workspaceId: challenge.workspaceId, organizationId: challenge.organizationId,
    workspaceRef: challenge.workspaceRef, accountId: subject,
    evidence: {
      evidenceRef: "synthetic-current-control", evidenceDigest: `sha256:${"c".repeat(64)}` as const,
      expiresAt: now + 120_000,
      source: {
        registrationRef: "synthetic-control-registration", incarnation: "synthetic-control-incarnation", affectedRef: "original-workspace",
        sequence: 0, eventRef: null, eventDigest: registration.genesisDigest,
        receivers: structuredClone(registration.receivers),
      },
    },
  };
  // Only the remote synthetic receiver custody lives here. All local parents,
  // raw records, materials, pending rows, ACK custody and proofs use real stores.
  const accepted = new Map<string, FinancialSourceReceipt>();
  let deliveries = 0;
  let loseNextAck = false;
  let beforeCapture: (() => Promise<void>) | undefined;
  const options: AccountsFinancialSourceOptions = {
    store, issuer, clients, registration, now: Date.now,
    challenges: {async read(ref) { return ref === challenge.challengeRef ? structuredClone(challenge) : undefined; }},
    control: {
      async capture(input) {
        await beforeCapture?.();
        return input.accountId === subject && input.workspaceId === snapshot.workspaceId ? structuredClone(snapshot) : undefined;
      },
      async assertCurrent(observed) { return JSON.stringify(observed) === JSON.stringify(snapshot); },
    },
    receivers: registration.receivers.map((receiver) => ({
      ...receiver,
      async read(materialization) {
        return accepted.get(`${receiver.receiverRef}/${materialization.event.eventRef}`);
      },
      async deliver(materialization: FinancialSourceMaterialization) {
        const event = parseFinancialSourceEvent(JSON.parse(JSON.stringify(materialization.event)));
        expect(await financialSourceEventDigest(event)).toBe(materialization.eventDigest);
        const key = `${receiver.receiverRef}/${event.eventRef}`;
        expect(accepted.has(key)).toBe(false);
        const receipt = parseFinancialSourceReceipt(await makeFinancialSourceReceipt({
          registrationRef: registration.registrationRef,
          receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
          event, eventDigest: materialization.eventDigest,
        }));
        accepted.set(key, receipt);
        deliveries++;
        if (loseNextAck) { loseNextAck = false; throw new Error("synthetic_lost_ack"); }
        return receipt;
      },
    })),
  };
  return {
    store, get now() { return Date.now(); }, session, registration, challenge, grant, exchange,
    options,
    async sourceVector():Promise<string>{
      if(repository instanceof MemoryIdentityRecordRepository)return sha256Text(canonicalFinancialSourceJson(JSON.parse(JSON.stringify({documents:[...repository.records].sort(),accounts:[...repository.accounts].sort(),sessions:[...repository.sessions].sort(),identities:[...repository.identities].sort()}))));
      const records:Record<string,unknown>={};
      if(d1){
        const tables=await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name:string}>();
        for(const {name} of tables.results??[])records[name]=(await d1.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()).results;
      }else if(pg){
        const tables=await pg.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='accounts_v1' ORDER BY table_name");
        for(const {table_name}of tables.rows)records[table_name]=(await pg.query(`SELECT to_jsonb(t) AS value FROM accounts_v1."${table_name.replaceAll('"','""')}" t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return sha256Text(canonicalFinancialSourceJson(JSON.parse(JSON.stringify(records))));
    },
    producer: (clock: () => number = Date.now) => createAccountsFinancialSource({...options, now: clock}),
    setBeforeCapture(fn: () => Promise<void>) { beforeCapture = fn; },
    setControlAffectedRef(value: string) { snapshot.evidence.source.affectedRef = value; },
    async breakRegistrationRead(): Promise<() => Promise<void>> {
      const corrupt = {...registration, genesisDigest: `sha256:${"d".repeat(64)}`};
      if (d1) {
        const row = await d1.prepare("SELECT * FROM takosumi_accounts_documents WHERE bucket='financial_source_registrations' AND key=?")
          .bind(registration.registrationRef).first<{bucket: string; key: string; document: string; updated_at: number}>();
        expect(row).toBeTruthy();
        await d1.prepare("UPDATE takosumi_accounts_documents SET document=? WHERE bucket='financial_source_registrations' AND key=?")
          .bind(JSON.stringify(corrupt), registration.registrationRef).run();
        expect(await store.findFinancialSourceRegistration!(registration.registrationRef)).toEqual(corrupt);
        return async () => {
          await d1!.prepare("UPDATE takosumi_accounts_documents SET document=? WHERE bucket='financial_source_registrations' AND key=?")
            .bind(row!.document, registration.registrationRef).run();
          expect(await d1!.prepare("SELECT * FROM takosumi_accounts_documents WHERE bucket='financial_source_registrations' AND key=?")
            .bind(registration.registrationRef).first()).toEqual(row);
        };
      }
      if (pg) {
        const row = (await pg.query<{document: unknown}>("SELECT * FROM accounts_v1.hosted_identity_records WHERE bucket='financial_source_registrations' AND key=$1", [registration.registrationRef])).rows[0];
        expect(row).toBeTruthy();
        await pg.query("UPDATE accounts_v1.hosted_identity_records SET document=$1::jsonb WHERE bucket='financial_source_registrations' AND key=$2", [JSON.stringify(corrupt), registration.registrationRef]);
        expect(await store.findFinancialSourceRegistration!(registration.registrationRef)).toEqual(corrupt);
        return async () => {
          await pg!.query("UPDATE accounts_v1.hosted_identity_records SET document=$1::jsonb WHERE bucket='financial_source_registrations' AND key=$2", [JSON.stringify(row!.document), registration.registrationRef]);
          expect((await pg!.query("SELECT * FROM accounts_v1.hosted_identity_records WHERE bucket='financial_source_registrations' AND key=$1", [registration.registrationRef])).rows[0]).toEqual(row);
        };
      }
      // Memory's physical records are private. This is an explicit missing-read
      // fixture at the actual store port, not a claimed physical row deletion.
      const original = store.findFinancialSourceRegistration!;
      store.findFinancialSourceRegistration = async () => undefined;
      return async () => { store.findFinancialSourceRegistration = original; };
    },
    loseAck() { loseNextAck = true; },
    deliveries: () => deliveries,
    close: async () => { await pg?.close(); },
  };
}

function scopes(record: TokenRecord): readonly FinancialSourceParentScope[] {
  return [
    {kind: "grant", sid: record.sid!},
    {kind: "issuer-session", issuerSessionId: record.issuerSessionId!},
    {kind: "client", clientId: record.clientId},
    {kind: "account-generation", subject, identityGeneration: record.identityGeneration ?? 0},
  ];
}

/** These registered-head, key-custody and clock ports are explicitly synthetic.
 * Their heads are enrolled from the ACTUAL Accounts parent tuples below; they
 * qualify no real credential, deployment, receiver or Financial payer context. */
async function eventEvidenceFixture(backend:Backend, materialized=true){
  const f=await fixture(backend);
  try{
    const grant=await f.grant(),producer=f.producer();
    await expect(producer.prove({accessToken:grant.access_token,challengeRef:f.challenge.challengeRef})).rejects.toThrow("source_pending");
    const heads=await Promise.all(scopes(grant.record).map(scope=>f.store.findFinancialSourceParent!(scope)));
    expect(heads.every(Boolean)).toBe(true);
    if(materialized){await producer.flush({limit:100});await producer.prove({accessToken:grant.access_token,challengeRef:f.challenge.challengeRef});}
    const sourceCredentialRef="synthetic-event-evidence-source-credential",sourceSchemaRef="synthetic-event-evidence-source-schema",receiverSchemaRef="synthetic-event-evidence-receiver-schema",clockPolicyRef="synthetic-event-evidence-clock";
    const receiver=f.registration.receivers[0]!;
    const registry=new Map<string,FinancialSourceRegisteredHead>();
    const key=(value:unknown)=>canonicalFinancialSourceJson(value);
    for(const head of heads)registry.set(key({registrationRef:head!.registrationRef,incarnation:head!.incarnation,affectedRef:head!.affectedRef}),{
      v:1,head:{registrationRef:head!.registrationRef,incarnation:head!.incarnation,affectedRef:head!.affectedRef},genesisDigest:f.registration.genesisDigest,receivers:structuredClone(f.registration.receivers),sourceSchemaRef,sourceCredentialRef,clockPolicyRef,
    });
    let time=f.now,validUntil=time+120_000,credentialMissing=false,headMissing=false;
    let credentialPatch:Partial<FinancialSourceCredentialContext>={},headPatch:Partial<FinancialSourceRegisteredHead>={};
    let keyReads=0,headReads=0,materializationReads=0;
    let onKeyRead:((count:number)=>void|Promise<void>)|undefined,onHeadRead:((count:number)=>void|Promise<void>)|undefined;
    let rawOverride:((ref:string,record:FinancialSourceRawRecord|undefined)=>FinancialSourceRawRecord|undefined)|undefined;
    const writes:string[]=[],purposes:string[]=[],requestedHeads:unknown[]=[];
    const readStore=new Proxy(f.store,{get(target,property){
      const value=Reflect.get(target,property,target);
      if(property==="findFinancialSourceRaw")return async(ref:string)=>{const record=await target.findFinancialSourceRaw!(ref);return rawOverride?rawOverride(ref,record):record;};
      if(property==="findFinancialSourceMaterialization")return async(ref:string)=>{materializationReads++;return target.findFinancialSourceMaterialization!(ref);};
      if(typeof value!=="function")return value;
      if(/^(save|create|register|enroll|issue|commit|record|revoke|delete|unlink|compareAndSet|consume|touch|link|rotate|advance)/u.test(String(property)))return()=>{writes.push(String(property));throw new Error("unexpected_event_evidence_store_write");};
      return value.bind(target);
    }});
    const eventEvidence:AccountsFinancialEventEvidenceOptions={sourceCredentialRef,sourceSchemaRef,receiverRef:receiver.receiverRef,targetRef:receiver.targetRef,receiverSchemaRef,
      clock:{policyRef:clockPolicyRef,nowMilliseconds:()=>time},
      registeredHeads:{async readRegisteredHead(input){headReads++;requestedHeads.push(structuredClone(input));const enrolled=registry.get(key(input.head));const result=headMissing||!enrolled?undefined:{...structuredClone(enrolled),...structuredClone(headPatch)};await onHeadRead?.(headReads);return result;}},
      keyCustody:{async readCredentialContext(input){keyReads++;purposes.push(input.purpose);expect(input).toEqual({credentialRef:sourceCredentialRef,receiverRef:receiver.receiverRef,targetRef:receiver.targetRef,receiverSchemaRef,purpose:"event-evidence-read"});const result=credentialMissing?undefined:{credentialRef:sourceCredentialRef,incarnationRef:"synthetic-event-evidence-key-incarnation",sourceSchemaRef,receiverRef:receiver.receiverRef,targetRef:receiver.targetRef,receiverSchemaRef,clockPolicyRef,purpose:"event-evidence-read" as const,validUntil,...credentialPatch};await onKeyRead?.(keyReads);return result;}},
    };
    const makeReader=(qualification:AccountsFinancialEventEvidenceOptions|null=eventEvidence)=>createAccountsFinancialSource({...f.options,store:readStore,eventEvidence:qualification??undefined});
    const reader=makeReader();
    async function readonly<T>(run:()=>Promise<T>):Promise<T>{const before=await f.sourceVector();try{return await run();}finally{expect(await f.sourceVector()).toBe(before);expect(writes).toEqual([]);}}
    return {...f,grant,producer,heads:heads.map(h=>h!),reader,makeReader,eventEvidence,registry,readonly,
      stats:()=>({keyReads,headReads,materializationReads,purposes:[...purposes],requestedHeads:structuredClone(requestedHeads)}),
      patchHead(value:Partial<FinancialSourceRegisteredHead>={}){headPatch=value;},patchCredential(value:Partial<FinancialSourceCredentialContext>={}){credentialPatch=value;},
      missingHead(value:boolean){headMissing=value;},missingCredential(value:boolean){credentialMissing=value;},
      setTime(value:number){time=value;},getTime:()=>time,authorizeUntil(value:number){validUntil=value;},
      afterKeyRead(value:typeof onKeyRead){onKeyRead=value;},afterHeadRead(value:typeof onHeadRead){onHeadRead=value;},rawRead(value:typeof rawOverride){rawOverride=value;},
    };
  }catch(error){await f.close();throw error;}
}

for(const backend of ["memory","d1","postgres"]as const){
  test(`${backend}: event-evidence actual immutable materialization has closed projection after token expiry/revocation and close`,async()=>{
    const f=await eventEvidenceFixture(backend);try{
      const originals=await Promise.all(f.heads.map(h=>f.store.findFinancialSourceMaterialization!(h.lastEventRef)));
      const requests=originals.map(m=>({v:1 as const,eventRef:m!.materialization.event.eventRef,eventDigest:m!.materialization.eventDigest}));
      const loaded=[];
      for(let i=0;i<requests.length;i++){
        const result=await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(requests[i]!));loaded.push(result);
        expect(result.status).toBe("found");if(result.status!=="found")throw new Error("expected_stored_original_event");
        expect(Object.keys(result).sort()).toEqual(["v","status","materialization","registeredHead"].sort());expect(Object.keys(result.materialization).sort()).toEqual(["event","eventDigest"]);
        expect(result.materialization).toEqual({event:originals[i]!.materialization.event,eventDigest:originals[i]!.materialization.eventDigest});
        expect(Object.keys(result.materialization.event).sort()).toEqual(["v","eventRef","registrationRef","incarnation","sequence","previousDigest","kind","affectedRef","evidenceRef"].sort());
        expect(Object.keys(result.registeredHead).sort()).toEqual(["v","head","genesisDigest","receivers","sourceSchemaRef","sourceCredentialRef","clockPolicyRef"].sort());
        expect(result.registeredHead.head).toEqual({registrationRef:f.heads[i]!.registrationRef,incarnation:f.heads[i]!.incarnation,affectedRef:f.heads[i]!.affectedRef});expect(result.registeredHead.receivers).toEqual(f.registration.receivers);
        expect(result).not.toHaveProperty("rawEventDigest");expect(result.materialization).not.toHaveProperty("rawEventDigest");for(const privateField of ["parent","cause","accessTokenHash","accessExpiresAt","scope","parents","subject"])expect(result).not.toHaveProperty(privateField);
        expect(JSON.stringify(result)).not.toContain(f.grant.access_token);expect(JSON.stringify(result)).not.toContain(await sha256Text(f.grant.access_token));
      }
      await f.store.deleteToken(f.grant.access_token);expect(await f.store.findAccessToken(f.grant.access_token)).toBeUndefined();
      await f.store.revokeHostedOidcGrant!(f.grant.record.sid!,f.now);await f.producer.flush({limit:100});
      const closed=(await f.store.findFinancialSourceParent!(scopes(f.grant.record)[0]!))!,closeMaterial=(await f.store.findFinancialSourceMaterialization!(closed.lastEventRef))!;
      f.setTime(f.grant.record.expiresAt+1);f.authorizeUntil(f.getTime()+120_000);
      for(let i=0;i<requests.length;i++)expect(await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(requests[i]!))).toEqual(loaded[i]);
      const result=await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({v:1,eventRef:closed.lastEventRef,eventDigest:closeMaterial.materialization.eventDigest}));
      expect(result).toMatchObject({v:1,status:"found",materialization:{event:{kind:"close",sequence:2,previousDigest:originals[0]!.materialization.eventDigest}}});
      expect(f.stats().purposes.every(p=>p==="event-evidence-read")).toBe(true);
    }finally{await f.close();}
  },30_000);

  test(`${backend}: event-evidence qualified absence and raw-only event read create no materialization, outbox or proof`,async()=>{
    const f=await eventEvidenceFixture(backend,false);try{
      const head=f.heads[1]!,raw=(await f.store.findFinancialSourceRaw!(head.lastEventRef))!;
      expect(await f.store.findFinancialSourceMaterialization!(head.lastEventRef)).toBeUndefined();
      const pure=await materializeFinancialSourceEvent({registration:f.registration,raw:raw.raw});
      const before=f.stats();expect(await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({v:1,eventRef:head.lastEventRef,eventDigest:pure.eventDigest}))).toEqual({v:1,status:"not-found"});
      expect(await f.store.findFinancialSourceMaterialization!(head.lastEventRef)).toBeUndefined();expect(f.stats().keyReads-before.keyReads).toBe(2);expect(f.stats().headReads-before.headReads).toBe(0);
      expect(await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({v:1,eventRef:"absent-original-event",eventDigest:pure.eventDigest}))).toEqual({v:1,status:"not-found"});
      expect((await f.store.listFinancialSourcePending!({registrationRef:f.registration.registrationRef,limit:100})).entries).toHaveLength(4);
      const unavailable=f.makeReader(null);const reads=f.stats().materializationReads;
      await expect(f.readonly(()=>unavailable.loadFinancialSourceEventEvidence({v:1,eventRef:"absent-original-event",eventDigest:pure.eventDigest}))).rejects.toThrow("unavailable");expect(f.stats().materializationReads).toBe(reads);
      f.missingCredential(true);await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({v:1,eventRef:"absent-original-event",eventDigest:pure.eventDigest}))).rejects.toThrow("unavailable");expect(f.stats().materializationReads).toBe(reads);
    }finally{await f.close();}
  },30_000);

  test(`${backend}: event-evidence rejects wrong ref/digest, explicit head tuple, genesis and complete receiver qualification`,async()=>{
    const f=await eventEvidenceFixture(backend);try{
      const original=(await f.store.findFinancialSourceMaterialization!(f.heads[0]!.lastEventRef))!,request={v:1 as const,eventRef:original.materialization.event.eventRef,eventDigest:original.materialization.eventDigest};
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({...request,eventDigest:`sha256:${"0".repeat(64)}`}))).rejects.toThrow("conflict");
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence({...request,eventRef:f.heads[1]!.lastEventRef}))).rejects.toThrow("conflict");
      const enrolled=[...f.registry.values()].find(h=>h.head.affectedRef===f.heads[0]!.affectedRef)!;
      for(const patch of [
        {head:{...enrolled.head,registrationRef:"different-registration"}},
        {head:{...enrolled.head,incarnation:"different-incarnation"}},
        {head:{...enrolled.head,affectedRef:"different-affected-original"}},
        {genesisDigest:`sha256:${"e".repeat(64)}` as const},
        {receivers:[enrolled.receivers[0]!]},
        {receivers:[enrolled.receivers[0]!,{...enrolled.receivers[1]!,targetRef:"different-secondary-target"}]},
        {sourceCredentialRef:"different-source-credential"},
        {sourceSchemaRef:"different-source-schema"},
      ]){f.patchHead(patch);await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unregistered-source");}
      f.patchHead();f.missingHead(true);await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unregistered-source");f.missingHead(false);
      for(const patch of [{credentialRef:"different-credential"},{receiverRef:"different-receiver"},{targetRef:"different-target"},{receiverSchemaRef:"different-receiver-schema"},{sourceSchemaRef:"different-source-schema"},{clockPolicyRef:"different-clock"},{purpose:"receipt-read" as const},{validUntil:f.getTime()},{validUntil:Number.NaN}]){
        f.patchCredential(patch);await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unavailable");
      }
      f.patchCredential();expect((await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).status).toBe("found");f.setTime(f.getTime()-1);await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unavailable");
    }finally{await f.close();}
  },30_000);

  test(`${backend}: event-evidence repeats key/head qualification and checks captured expiry after final awaits`,async()=>{
    const f=await eventEvidenceFixture(backend);try{
      const material=(await f.store.findFinancialSourceMaterialization!(f.heads[0]!.lastEventRef))!,request={v:1 as const,eventRef:material.materialization.event.eventRef,eventDigest:material.materialization.eventDigest};
      const keyAt=f.stats().keyReads;f.afterKeyRead(count=>{if(count===keyAt+1)f.missingCredential(true);});
      // First read returns its original current context. Losing actual custody
      // while the store is read must be detected by the final capability read.
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unavailable");expect(f.stats().keyReads-keyAt).toBe(2);f.missingCredential(false);f.afterKeyRead(undefined);
      const headAt=f.stats().headReads,enrolled=[...f.registry.values()].find(h=>h.head.affectedRef===f.heads[0]!.affectedRef)!;
      f.afterHeadRead(count=>{if(count===headAt+1)f.patchHead({receivers:[enrolled.receivers[0]!,{...enrolled.receivers[1]!,targetRef:"changed-after-first-head"}]});});
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unavailable");f.patchHead();f.afterHeadRead(undefined);
      const deadline=f.getTime()+10,keys=f.stats().keyReads;f.authorizeUntil(deadline);f.afterKeyRead(count=>{if(count===keys+2)f.setTime(deadline);});
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("unavailable");
      f.afterKeyRead(undefined);f.authorizeUntil(f.getTime()+120_000);
      const absent={...request,eventRef:"absent-after-qualified-read"},absentKeys=f.stats().keyReads,absentDeadline=f.getTime()+10;f.authorizeUntil(absentDeadline);f.afterKeyRead(count=>{if(count===absentKeys+2)f.setTime(absentDeadline);});
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(absent))).rejects.toThrow("unavailable");
    }finally{await f.close();}
  },30_000);

  test(`${backend}: event-evidence rechecks FULL original raw and predecessor custody without read-side repair`,async()=>{
    const f=await eventEvidenceFixture(backend);try{
      const old=(await f.store.findFinancialSourceMaterialization!(f.heads[0]!.lastEventRef))!,request={v:1 as const,eventRef:old.materialization.event.eventRef,eventDigest:old.materialization.eventDigest};
      f.rawRead((ref,record)=>ref===request.eventRef&&record?{...record,capturedAt:record.capturedAt+1}:record);
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(request))).rejects.toThrow("conflict");f.rawRead(undefined);
      await f.store.revokeHostedOidcGrant!(f.grant.record.sid!,f.now);await f.producer.flush({limit:100});const closed=(await f.store.findFinancialSourceParent!(scopes(f.grant.record)[0]!))!,material=(await f.store.findFinancialSourceMaterialization!(closed.lastEventRef))!,closeRequest={v:1 as const,eventRef:closed.lastEventRef,eventDigest:material.materialization.eventDigest};
      f.rawRead((ref,record)=>ref===request.eventRef&&record?{...record,parentRevision:record.parentRevision+1}:record);
      await expect(f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(closeRequest))).rejects.toThrow("conflict");f.rawRead(undefined);
      expect((await f.readonly(()=>f.reader.loadFinancialSourceEventEvidence(closeRequest))).status).toBe("found");expect(await f.store.findFinancialSourceMaterialization!(old.materialization.event.eventRef)).toEqual(old);
    }finally{await f.close();}
  },30_000);
}

/** Synthetic upstream receipts and the existing context/review issuer fixture
 * supply no Financial or real Core ACK. Accounts receipt consumption, consent,
 * reserve and authentication fences use the actual implementation. */
async function reserveActualMerge(f: Awaited<ReturnType<typeof fixture>>) {
  const {store, now} = f;
  await store.saveAccount({subject: otherSubject, email: address, emailVerified: true, createdAt: now, updatedAt: now});
  for (const [accountId, providerId] of [[subject, "google"], [otherSubject, "github"]] as const) {
    const binding = {subject: accountId, providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: accountId};
    await store.linkUpstreamIdentity({...binding, createdAt: now, updatedAt: now});
    await store.saveAccountEmailProof!({...binding, address, normalizedAddress: address, verification: "provider", authoritative: true, observedAt: now, validUntil: now + 300_000});
  }
  const rotated = await rotateAccountSession({store, subject: otherSubject, now, ttlMs: 600_000, hostedPolicy: true, freshlyAuthenticatedAt: Math.floor(now / 1000)});
  const otherSession = (await store.findAccountSession(rotated.sessionId))!;
  let operation = await createIdentityMerge({store, actor: subject, sourceSubject: otherSubject, targetSubject: subject, browserBindingHash: "synthetic-merge-browser", now});
  for (const [role, session] of [["source", otherSession], ["target", f.session]] as const) {
    const providerId = role === "source" ? "github" : "google";
    const receipt: IdentityOperationReceiptRecord = {
      receiptId: `ircp_${crypto.randomUUID()}`, operationId: operation.operationId, role,
      sourceSubject: otherSubject, targetSubject: subject, subject: session.subject,
      providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: session.subject,
      browserBindingHash: operation.browserBindingHash, policyVersion: operation.policyVersion,
      identityGeneration: 0, transactionDigest: await sha256Text(`synthetic-upstream/${role}`),
      startedAt: now, completedAt: now, expiresAt: operation.expiresAt,
      emailDigest: operation.addressDigest, legConsent: true, legConsentAt: now,
      method: "upstream-oauth-operation", issuerSessionHash: session.issuerSessionId!,
    };
    expect(await store.createIdentityOperationReceipt!(receipt)).toBe(true);
    operation = await proveIdentityMerge({store, operation, session, receiptId: receipt.receiptId, now});
  }
  operation = await acceptIsolatedIdentityContexts(store, operation, now);
  operation = await consentIdentityMerge({
    store, operation, session: f.session, consent: true, now,
    reconciler: isolatedContextReconciler(store, now),
    retryCapability: {pendingCapacity: 100, assertAvailable: async () => {}},
  });
  expect(operation.status).toBe("proved");
  expect(await store.isAccountAuthenticationFenced!(subject)).toBe(true);
  expect(await store.getAccountAuthenticationGeneration!(subject)).toBe(1);
  return operation;
}

for (const backend of ["memory", "d1", "postgres"] as const) {
  test(`${backend}: actual producer resumes original ACK, issues stored proof, rotates access and closes grant lineage`, async () => {
    const f = await fixture(backend);
    try {
      const grant = await f.grant();
      let producer = f.producer();
      const input = {accessToken: grant.access_token, challengeRef: f.challenge.challengeRef};
      await expect(producer.prove(input)).rejects.toThrow("source_pending");
      const originalHeads = await Promise.all(scopes(grant.record).map((scope) => f.store.findFinancialSourceParent!(scope)));
      expect(originalHeads.every((head) => head?.state === "open" && head.sequence === 1)).toBe(true);
      expect(new Set(originalHeads.map((head) => head!.affectedRef)).size).toBe(4);
      const originalRaw = await Promise.all(originalHeads.map((head) => f.store.findFinancialSourceRaw!(head!.lastEventRef)));
      expect(originalRaw.every((row) => row?.raw.kind === "advance" && row.raw.previousEventRef === null)).toBe(true);
      expect((await f.store.listFinancialSourcePending!({registrationRef: f.registration.registrationRef, limit: 100})).entries).toHaveLength(4);
      f.loseAck();
      await expect(producer.flush({limit: 100})).rejects.toThrow("synthetic_lost_ack");
      await expect(producer.prove(input)).rejects.toThrow("source_pending");
      // New producer instance; remote readback must adopt the original event,
      // not redeliver it or replace any local parent/raw/pending key.
      producer = f.producer();
      expect(await producer.flush({limit: 100})).toEqual({processed: 4, nextCursor: undefined});
      expect(f.deliveries()).toBe(8);
      expect((await f.store.listFinancialSourcePending!({registrationRef: f.registration.registrationRef, limit: 100})).entries).toEqual([]);
      const materials = await Promise.all(originalHeads.map((head) => f.store.findFinancialSourceMaterialization!(head!.lastEventRef)));
      expect(materials.every((row) => row?.materialization.event.previousDigest === f.registration.genesisDigest)).toBe(true);
      const originalReceipts = await Promise.all(originalHeads.flatMap((head) => f.registration.receivers.map((receiver) => f.store.findFinancialSourceReceipt!({registrationRef: f.registration.registrationRef, eventRef: head!.lastEventRef, receiverRef: receiver.receiverRef}))));
      expect(originalReceipts.every((row) => row?.receipt.state === "advanced")).toBe(true);
      const result = await producer.prove(input);
      expect(Object.keys(result)).toEqual(["proofRef"]);
      const proof = await f.store.findFinancialSourceProof!(result.proofRef);
      expect(proof).toMatchObject({proofRef: result.proofRef, issuer, subject, clientId: "hosted", sid: grant.record.sid, challenge: f.challenge});
      expect(proof!.accessTokenHash).toBe(await sha256Text(grant.access_token));
      expect(proof!.accessExpiresAt).toBe(grant.record.expiresAt);
      expect(Object.values(proof!.parents).map((parent) => parent.eventRef).sort()).toEqual(originalHeads.map((head) => head!.lastEventRef).sort());
      expect(JSON.stringify([originalRaw, materials, originalReceipts, proof])).not.toContain(grant.access_token);
      const readRequest = {v: 1 as const, proofRef: result.proofRef, challengeRef: f.challenge.challengeRef};
      const loaded = await producer.loadFinancialIdentityProof(readRequest);
      expect(loaded.status).toBe("found");
      if (loaded.status !== "found") throw new Error("expected original proof custody");
      expect(Object.keys(loaded.proof).sort()).toEqual([
        "v", "proofRef", "challenge", "issuer", "subject", "clientId", "sid",
        "issuerSessionId", "identityGeneration", "control", "parents", "issuedAt", "expiresAt",
      ].sort());
      expect(loaded.proof).not.toHaveProperty("accessTokenHash");
      expect(loaded.proof).not.toHaveProperty("accessExpiresAt");
      for (const parent of Object.values(loaded.proof.parents))
        expect(Object.keys(parent).sort()).toEqual([
          "registrationRef", "incarnation", "affectedRef", "sequence", "eventRef", "eventDigest",
        ].sort());
      const current = await producer.verifyCurrentFinancialIdentityProof(readRequest);
      expect(current).toMatchObject({v: 1, status: "current", proof: loaded.proof});
      if (current.status !== "current") throw new Error("expected current proof");
      expect(current.observedAt).toBeGreaterThanOrEqual(proof!.issuedAt);
      expect(current.observedAt).toBeLessThan(proof!.expiresAt);
      const restoreRegistration = await f.breakRegistrationRead();
      try {
        expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toEqual({v: 1, status: "not-current"});
        expect(await producer.loadFinancialIdentityProof(readRequest)).toEqual(loaded);
      } finally { await restoreRegistration(); }
      expect(await f.store.findFinancialSourceRegistration!(f.registration.registrationRef)).toEqual(f.registration);
      expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toMatchObject({v: 1, status: "current", proof: loaded.proof});
      f.setControlAffectedRef("different-control-workspace");
      try {
        expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toEqual({v: 1, status: "not-current"});
        expect(await producer.loadFinancialIdentityProof(readRequest)).toEqual(loaded);
      } finally { f.setControlAffectedRef("original-workspace"); }
      expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toMatchObject({v: 1, status: "current", proof: loaded.proof});
      const wrongChallenge = {...readRequest, challengeRef: "synthetic-wrong-challenge"};
      expect(await producer.loadFinancialIdentityProof(wrongChallenge)).toEqual({v: 1, status: "not-found"});
      expect(await producer.verifyCurrentFinancialIdentityProof(wrongChallenge)).toEqual({v: 1, status: "not-current"});
      // A separately injected trusted clock tests expiry without advancing the
      // live issuer or mistaking immutable historical custody for fresh proof.
      const expired = f.producer(() => proof!.expiresAt + 1);
      expect(await expired.verifyCurrentFinancialIdentityProof(readRequest)).toEqual({v: 1, status: "not-current"});
      expect(await expired.loadFinancialIdentityProof(readRequest)).toEqual(loaded);

      const refreshed = await f.exchange({grant_type: "refresh_token", refresh_token: grant.refresh_token});
      expect(refreshed.status).toBe(200);
      const rotated = await refreshed.json() as {access_token: string};
      const rotatedRecord = await f.store.findAccessToken(rotated.access_token);
      expect(rotatedRecord).toMatchObject({sid: grant.record.sid, issuerSessionId: grant.record.issuerSessionId});
      const rotatedProof = await producer.prove({...input, accessToken: rotated.access_token});
      expect(rotatedProof.proofRef).toStartWith("afp_");
      const rotatedRequest = {...readRequest, proofRef: rotatedProof.proofRef};
      expect(await producer.verifyCurrentFinancialIdentityProof(rotatedRequest)).toMatchObject({v: 1, status: "current"});
      expect((await f.store.findFinancialSourceProof!(rotatedProof.proofRef))?.accessTokenHash).toBe(await sha256Text(rotated.access_token));
      expect(await Promise.all(scopes(grant.record).map((scope) => f.store.findFinancialSourceParent!(scope)))).toEqual(originalHeads);

      await f.store.revokeHostedOidcGrant!(grant.record.sid!, f.now);
      const closed = await f.store.findFinancialSourceParent!(scopes(grant.record)[0]!);
      expect(closed).toMatchObject({state: "closed", sequence: 2, affectedRef: originalHeads[0]!.affectedRef});
      const closeRaw = await f.store.findFinancialSourceRaw!(closed!.lastEventRef);
      expect(closeRaw).toMatchObject({raw: {kind: "close", previousEventRef: originalHeads[0]!.lastEventRef}, cause: {kind: "grant-revoked", sid: grant.record.sid}});
      await f.store.revokeHostedOidcGrant!(grant.record.sid!, f.now + 1);
      expect(await f.store.findFinancialSourceParent!(scopes(grant.record)[0]!)).toEqual(closed);
      expect(await producer.flush({limit: 100})).toEqual({processed: 1, nextCursor: undefined});
      const closeMaterial = await f.store.findFinancialSourceMaterialization!(closed!.lastEventRef);
      expect(closeMaterial!.materialization.event.previousDigest).toBe(materials[0]!.materialization.eventDigest);
      for (const receiver of f.registration.receivers)
        expect((await f.store.findFinancialSourceReceipt!({registrationRef: f.registration.registrationRef, eventRef: closed!.lastEventRef, receiverRef: receiver.receiverRef}))?.receipt.state).toBe("admission-closed");
      await expect(producer.prove({...input, accessToken: rotated.access_token})).rejects.toThrow("invalid_grant");
      expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toEqual({v: 1, status: "not-current"});
      expect(await producer.verifyCurrentFinancialIdentityProof(rotatedRequest)).toEqual({v: 1, status: "not-current"});
      expect(await producer.loadFinancialIdentityProof(readRequest)).toEqual(loaded);
      expect(await f.store.findFinancialSourceProof!(result.proofRef)).toEqual(proof);
      expect(await Promise.all(originalHeads.map((head) => f.store.findFinancialSourceRaw!(head!.lastEventRef)))).toEqual(originalRaw);
      expect(await Promise.all(originalHeads.map((head) => f.store.findFinancialSourceMaterialization!(head!.lastEventRef)))).toEqual(materials);
      expect(await Promise.all(originalHeads.flatMap((head) => f.registration.receivers.map((receiver) => f.store.findFinancialSourceReceipt!({registrationRef: f.registration.registrationRef, eventRef: head!.lastEventRef, receiverRef: receiver.receiverRef}))))).toEqual(originalReceipts);
      expect(await producer.flush({limit: 100})).toEqual({processed: 0, nextCursor: undefined});
    } finally { await f.close(); }
  }, 30_000);

  test(`${backend}: actual producer refuses expired, foreign-client and resource-bearing stored access before enrollment`, async () => {
    const f = await fixture(backend);
    try {
      const grant = await f.grant();
      const foreign = await f.grant("takoserver");
      const producer = f.producer();
      await expect(producer.prove({accessToken: foreign.access_token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("invalid_grant");
      for (const [suffix, patch] of [
        ["expired", {expiresAt: f.now - 1}],
        ["resource", {interfaceId: "resource-interface", interfaceBindingId: "resource-binding", interfaceResolvedRevision: 1}],
        ["capsule", {capsuleId: "resource-capsule", workspaceId: "resource-workspace", role: "owner"}],
        ["issuer", {issuer: "https://another-issuer.example.test"}],
      ] as const) {
        const token = `synthetic-invalid-${suffix}`;
        await f.store.saveAccessToken(token, {...grant.record, ...patch});
        await expect(producer.prove({accessToken: token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("invalid_grant");
      }
      expect((await f.store.listFinancialSourcePending!({registrationRef: f.registration.registrationRef, limit: 100})).entries).toEqual([]);
      for (const scope of [...scopes(grant.record), ...scopes(foreign.record)])
        expect(await f.store.findFinancialSourceParent!(scope)).toBeUndefined();
      expect(f.deliveries()).toBe(0);
    } finally { await f.close(); }
  }, 30_000);

  test(`${backend}: revocation and real merge reserve during Control await cannot issue a financial source proof`, async () => {
    const f = await fixture(backend);
    try {
      const revoked = await f.grant();
      const producer = f.producer();
      f.setBeforeCapture(async () => { await f.store.revokeHostedOidcGrant!(revoked.record.sid!, f.now); });
      await expect(producer.prove({accessToken: revoked.access_token, challengeRef: f.challenge.challengeRef})).rejects.toThrow("invalid_grant");
      for (const scope of scopes(revoked.record))
        expect(await f.store.findFinancialSourceParent!(scope)).toBeUndefined();

      f.setBeforeCapture(async () => {});
      const grant = await f.grant();
      const input = {accessToken: grant.access_token, challengeRef: f.challenge.challengeRef};
      await expect(producer.prove(input)).rejects.toThrow("source_pending");
      await producer.flush({limit: 100});
      const beforeProof = await producer.prove(input);
      const proof = await f.store.findFinancialSourceProof!(beforeProof.proofRef);
      const readRequest = {v: 1 as const, proofRef: beforeProof.proofRef, challengeRef: f.challenge.challengeRef};
      const loaded = await producer.loadFinancialIdentityProof(readRequest);
      expect(loaded.status).toBe("found");
      expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toMatchObject({v: 1, status: "current"});
      const generationScope = scopes(grant.record)[3]!;
      const before = await f.store.findFinancialSourceParent!(generationScope);
      let operationId: string | undefined;
      f.setBeforeCapture(async () => { operationId = (await reserveActualMerge(f)).operationId; });
      await expect(producer.prove(input)).rejects.toThrow("invalid_grant");
      expect(operationId).toBeString();
      const closed = await f.store.findFinancialSourceParent!(generationScope);
      expect(closed).toMatchObject({state: "closed", sequence: 2, affectedRef: before!.affectedRef});
      expect(await f.store.findFinancialSourceRaw!(closed!.lastEventRef)).toMatchObject({
        raw: {kind: "close", previousEventRef: before!.lastEventRef},
        cause: {kind: "identity-generation-advanced", previousGeneration: 0, nextGeneration: 1, operationId, reason: "reserve"},
      });
      await producer.flush({limit: 100});
      expect((await f.store.findFinancialSourceMaterialization!(closed!.lastEventRef))?.materialization.event.kind).toBe("close");
      expect(await f.store.findFinancialSourceProof!(beforeProof.proofRef)).toEqual(proof);
      expect(await producer.verifyCurrentFinancialIdentityProof(readRequest)).toEqual({v: 1, status: "not-current"});
      expect(await producer.loadFinancialIdentityProof(readRequest)).toEqual(loaded);
      expect(await f.store.findFinancialSourceParent!(generationScope)).toEqual(closed);
    } finally { await f.close(); }
  }, 30_000);
}
