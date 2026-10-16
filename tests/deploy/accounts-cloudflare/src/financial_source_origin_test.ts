import { expect, spyOn, test } from "bun:test";
import {
  createCloudflareWorker,
  type CloudflareWorkerEnv,
  type PrivateAccountsFinancialSourceFacade,
  type PrivateAccountsFinancialSourceInputs,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  D1AccountsStore,
  type D1Database,
} from "../../../../accounts/service/src/d1-store.ts";
import type { TokenRecord } from "../../../../accounts/service/src/store.ts";
import { financialSourceEventDigest } from "../../../../accounts/service/src/financial-source-contract.ts";
import { createAuthStagingWorker } from "../../../../deploy/accounts-cloudflare/src/staging-worker.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../../accounts/service/src/d1-migrations.ts";

// Mechanical source-origin tests only. The fixed callbacks here are synthetic;
// they do not qualify the real C0/peer/key/realm or admit Financial M.
async function accountsDb(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations) {
    if (migration.version > 5) break;
    await applyD1AccountsMigrationBatch(db, migration, 1_000 + migration.version);
  }
  return db;
}

function env(db: SqliteFakeD1): CloudflareWorkerEnv {
  return {
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://issuer.example.test/",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "local-test-only-source-origin-salt",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([{
      clientId: "hosted", redirectUris: ["http://client.example.test/callback"],
      allowedScopes: ["openid"],
    }]),
  } as CloudflareWorkerEnv;
}

const core = new WorkspacesService({store: new InMemoryOpenTofuControlStore()}).financialSource;
const registration = {
  registrationRef: "registration-original",
  incarnation: "incarnation-original",
  genesisDigest: `sha256:${"a".repeat(64)}` as const,
  receivers: [{receiverRef: "financial-primary", targetRef: "selected-target"}],
};
function inputs(): PrivateAccountsFinancialSourceInputs {
  return {
    registration,
    challenges: {read: async () => undefined},
    eventEvidence: {
      sourceCredentialRef: "source-credential-original",
      sourceSchemaRef: "source-schema-original",
      receiverRef: "financial-primary",
      targetRef: "selected-target",
      receiverSchemaRef: "receiver-schema-original",
      registeredHeads: {readRegisteredHead: async () => undefined},
      keyCustody: {readCredentialContext: async (request) => ({
        credentialRef: request.credentialRef,
        incarnationRef: "credential-incarnation-original",
        sourceSchemaRef: "source-schema-original",
        receiverRef: request.receiverRef,
        targetRef: request.targetRef,
        receiverSchemaRef: request.receiverSchemaRef,
        clockPolicyRef: "clock-original",
        purpose: request.purpose,
        validUntil: 2_000,
      })},
      clock: {policyRef: "clock-original", nowMilliseconds: () => 1_000},
    },
  };
}

const full = new Request("http://issuer.example.test/api/v1/workspaces");
const identityOnly = new Request("http://issuer.example.test/.well-known/openid-configuration");

test("only explicit named resolution publishes one source bound to the actual HTTP D1 store", async () => {
  const db = await accountsDb(), actualEnv = env(db);
  const prepare = db.prepare.bind(db);
  const registrationSelect = "SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?";
  const boundRegistrationReads: Array<readonly unknown[]> = [];
  const sql = spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    if (query !== registrationSelect) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind") return (...values: Parameters<typeof target.bind>) => {
          boundRegistrationReads.push(values);
          return target.bind(...values);
        };
        return Reflect.get(target, property, receiver);
      },
    });
  });
  let inputCalls = 0, coreCalls = 0;
  const seen: PrivateAccountsFinancialSourceFacade[] = [];
  const hooks = {
    coreFinancialSource: async () => {coreCalls++; return core;},
    inputs: async () => {inputCalls++; return inputs();},
    observe: (source: PrivateAccountsFinancialSourceFacade) => {seen.push(source);},
  };
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: hooks});
  expect((await worker.fetch(identityOnly, actualEnv)).status).toBe(200);
  expect(inputCalls).toBe(0);
  expect(coreCalls).toBe(0);
  expect(seen).toHaveLength(0);
  // The original function references are captured at worker construction.
  hooks.inputs = async () => {throw new Error("mutated origin must not run");};
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  // Private C0/Core work is detached from ordinary HTTP initialization.
  expect(inputCalls).toBe(0);
  expect(coreCalls).toBe(0);
  const [resolved, joined] = await Promise.all([
    worker.resolvePrivateFinancialSource!(actualEnv),
    worker.resolvePrivateFinancialSource!(actualEnv),
  ]);
  expect(joined).toBe(resolved);
  expect(inputCalls).toBe(1);
  expect(coreCalls).toBe(1);
  expect(seen).toHaveLength(1);
  const source = seen[0]!;
  expect(resolved).toBe(source);
  expect(Reflect.ownKeys(source).map(String).sort()).toEqual([
    "loadFinancialSourceEventEvidence",
    "prepareFinancialIdentityProofSource",
    "preparePendingFinancialSourceOriginals",
  ]);
  expect(Reflect.ownKeys(source)).not.toContain("store");
  expect(Reflect.ownKeys(source)).not.toContain("install");
  expect(Reflect.ownKeys(source)).not.toContain("readOriginal");
  const before = sql.mock.calls.length;
  const boundBefore = boundRegistrationReads.length;
  await expect(source.loadFinancialSourceEventEvidence({v: 1, eventRef: "event-original", eventDigest: `sha256:${"b".repeat(64)}`})).rejects.toThrow();
  expect(sql.mock.calls.length).toBeGreaterThan(before);
  expect(boundRegistrationReads.slice(boundBefore).some((values) =>
    values.length === 2 && values[0] === "financial_source_registrations" && values[1] === registration.registrationRef,
  )).toBe(true);
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  expect(await worker.resolvePrivateFinancialSource!(actualEnv)).toBe(source);
  expect(inputCalls).toBe(1);
  expect(seen).toHaveLength(1);
  sql.mockRestore();
});

test("named HTTP-store facade retains four fresh originals and the same bounded historical originals", async () => {
  const db = await accountsDb();
  const signingKey = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", signingKey.privateKey);
  const actualEnv = {
    ...env(db),
    TAKOSUMI_ACCOUNTS_ISSUER: "https://issuer.example.test/",
    TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "local-test-only-source-origin-pairwise-secret",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([{
      clientId: "hosted", profile: "shared-account", enabled: true,
      allowedScopes: ["openid"], redirectUris: ["https://client.example.test/callback"],
      clientSecretEnv: "TEST_HOSTED_CLIENT_SECRET", tokenEndpointAuthMethod: "client_secret_basic",
    }]),
    TEST_HOSTED_CLIENT_SECRET: "synthetic-local-client-secret",
  } as CloudflareWorkerEnv;
  const now = Date.now();
  const subject = "tsub_source_origin_actor", token = "synthetic-source-origin-token";
  const issuer = "https://issuer.example.test";
  const authTime = Math.floor(now / 1_000) - 1;
  const hostedFull = new Request("https://issuer.example.test/api/v1/workspaces");
  const sid = "source-origin-sid", issuerSessionId = "source-origin-session";
  const accountRegistration = {
    ...registration,
    registrationRef: "accounts-original-registration",
    incarnation: "accounts-original-incarnation",
  };
  // Seed the same physical D1 database used by the HTTP handler. This store
  // object is fixture-only; it is never passed to the named source resolver.
  // This shared fake returns success:true from run/all, while its Worker D1
  // interface declares success optional. Accounts requires the same runtime
  // result with success present; this bridge changes no fake or store behavior.
  const seed = new D1AccountsStore(db as unknown as D1Database, {
    schemaMode: "predeployed", sessionHashSalt: actualEnv.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT,
  });
  const access: TokenRecord = {
    clientId: "hosted", oidcProfile: "shared-account", issuer, subject,
    takosumiSubject: subject, sid, issuerSessionId, identityGeneration: 0,
    authTime, scope: "openid", expiresAt: now + 200_000,
  };
  await seed.saveAccount({subject, createdAt: now, updatedAt: now});
  await seed.saveAccessToken(token, access);
  await seed.saveHostedOidcGrant({sid, issuerSessionId, clientId: "hosted", issuer,
    subject, identityGeneration: 0, scope: "openid", authTime,
    createdAt: now, absoluteExpiresAt: now + 300_000});
  expect(await seed.registerFinancialSourceRegistration(accountRegistration)).toBe(true);

  const owner = new WorkspacesService({
    store: new InMemoryOpenTofuControlStore(), now: () => new Date(now),
  });
  const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(subject, "source-origin");
  const intent = await owner.billingBindings.prepare({
    workspaceId: workspace.id, billingAuthority: "synthetic_financial_owner", actorAccountId: subject,
  });
  const binding = await owner.billingBindings.claim({
    workspaceId: workspace.id, intentId: intent.intentId, actorAccountId: subject,
    organizationRef: "source-origin-organization", ownerAcknowledgementRef: "synthetic-owner-ack",
  });
  const enrollment = await owner.financialSource.prepareEnrollment({workspaceId: workspace.id});
  expect(enrollment).toBeDefined();
  const controlRegistration = {
    sourceRef: "core-original-registration", incarnation: "core-original-incarnation",
    genesisDigest: "c".repeat(64), requiredReceivers: accountRegistration.receivers,
  };
  expect((await owner.financialSource.enroll({original: enrollment!, registration: controlRegistration}))?.permissionSequence).toBe(0);
  expect(controlRegistration.sourceRef).not.toBe(accountRegistration.registrationRef);
  const challenge = {
    v: 1 as const, challengeRef: "source-origin-challenge",
    registrationRef: accountRegistration.registrationRef, clientId: "hosted",
    workspaceId: workspace.id, organizationId: binding.organizationRef,
    workspaceRef: binding.workspaceRef, requestFingerprint: `sha256:${"d".repeat(64)}` as const,
    createdAt: now, expiresAt: now + 120_000,
  };
  let observed = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => owner.financialSource,
    inputs: async () => ({...inputs(), registration: accountRegistration,
      challenges: {read: async (ref) => ref === challenge.challengeRef ? structuredClone(challenge) : undefined}}),
    observe: () => {observed++;},
  }});
  expect((await worker.fetch(hostedFull, actualEnv)).status).toBe(401);
  const source = await worker.resolvePrivateFinancialSource!(actualEnv);
  expect(observed).toBe(1);
  const prepared = await source.prepareFinancialIdentityProofSource({
    accessToken: token, challengeRef: challenge.challengeRef,
  });
  expect(prepared.kind).toBe("fresh");
  expect(prepared.registration).toEqual(accountRegistration);
  expect(Object.keys(prepared.parents).sort()).toEqual(["accountGeneration", "client", "grant", "issuerSession"]);
  expect(prepared.controlSource.registrationRef).toBe(controlRegistration.sourceRef);
  expect(prepared.controlSource.incarnation).toBe(controlRegistration.incarnation);
  expect(prepared.controlSource.affectedRef).toBe(workspace.id);
  expect(prepared.controlSource.sequence).toBe(0);
  expect(prepared.controlSource.eventRef).toBeNull();
  expect(prepared.controlSource.eventDigest).toBe(`sha256:${controlRegistration.genesisDigest}`);
  expect(prepared.controlSource.receivers).toEqual(controlRegistration.requiredReceivers);
  expect(prepared.controlSource.registrationRef).not.toBe(prepared.registration.registrationRef);
  for (const original of Object.values(prepared.parents)) {
    expect(original.key).toEqual({
      registrationRef: accountRegistration.registrationRef,
      incarnation: accountRegistration.incarnation,
      affectedRef: original.materialization.event.affectedRef,
    });
    expect(original.eventRef).toBe(original.materialization.event.eventRef);
    expect(original.materialization.event.sequence).toBe(1);
    expect(original.materialization.event.previousDigest).toBe(accountRegistration.genesisDigest);
    expect(original.materialization.eventDigest)
      .toBe(await financialSourceEventDigest(original.materialization.event));
    const retainedRaw = await seed.findFinancialSourceRaw(original.eventRef);
    const retainedMaterialization = await seed.findFinancialSourceMaterialization(original.eventRef);
    expect(retainedRaw?.raw.eventRef).toBe(original.eventRef);
    expect(retainedRaw?.raw.registrationRef).toBe(accountRegistration.registrationRef);
    expect(retainedMaterialization?.rawRecord).toEqual(retainedRaw);
    expect(retainedMaterialization?.materialization).toEqual(original.materialization);
    expect(await seed.findFinancialSourceParent(retainedRaw!.parent)).toMatchObject({
      registrationRef: accountRegistration.registrationRef,
      incarnation: accountRegistration.incarnation, lastEventRef: original.eventRef,
    });
  }
  const pending = await source.preparePendingFinancialSourceOriginals({limit: 4});
  expect(pending.kind).toBe("historical");
  expect(pending.registration).toEqual(accountRegistration);
  expect(pending.entries).toHaveLength(4);
  expect(pending.nextCursor).toBeUndefined();
  expect(pending.entries.map(({original}) => original).sort((a, b) => a.eventRef.localeCompare(b.eventRef)))
    .toEqual(Object.values(prepared.parents).sort((a, b) => a.eventRef.localeCompare(b.eventRef)));
  expect((await seed.listFinancialSourcePending({registrationRef: accountRegistration.registrationRef, limit: 4})).entries)
    .toHaveLength(4);
});

test("missing fixed C0, selected peer, head, key, clock or Core refuses source placement", async () => {
  for (const omit of ["challenges", "peer", "registeredHeads", "keyCustody", "clock", "core"] as const) {
    const actualEnv = env(await accountsDb());
    let observed = 0;
    const source = inputs();
    if (omit === "challenges") {
      Reflect.deleteProperty(source, "challenges");
    } else if (omit === "peer") {
      Reflect.set(source, "registration", {...registration, receivers: [{receiverRef: "other-peer", targetRef: "other-target"}]});
    } else if (omit !== "core") {
      Reflect.deleteProperty(source.eventEvidence, omit);
    }
    const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
      coreFinancialSource: async () => omit === "core" ? undefined : core,
      inputs: async () => source,
      observe: () => {observed++;},
    }});
    expect((await worker.fetch(full, actualEnv)).status).toBe(401);
    await expect(worker.resolvePrivateFinancialSource!(actualEnv)).rejects.toThrow("source_unavailable");
    expect((await worker.fetch(full, actualEnv)).status).toBe(401);
    expect(observed).toBe(0);
  }
});

test("an absent owner input keeps source off; a second build cannot replace an observed facade", async () => {
  const disabledEnv = env(await accountsDb());
  let seen = 0;
  const disabled = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    observe: () => {seen++;},
  }});
  expect((await disabled.fetch(full, disabledEnv)).status).toBe(401);
  await expect(disabled.resolvePrivateFinancialSource!(disabledEnv)).rejects.toThrow("source_unavailable");
  expect(seen).toBe(0);

  const actualEnv = env(await accountsDb());
  let original: PrivateAccountsFinancialSourceFacade | undefined;
  const first = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    inputs: async () => inputs(),
    observe: (source) => {original = source;},
  }});
  expect((await first.fetch(full, actualEnv)).status).toBe(401);
  expect(original).toBeUndefined();
  expect(await first.resolvePrivateFinancialSource!(actualEnv)).toBeDefined();
  expect(original).toBeDefined();
  let replacement = 0;
  const second = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    inputs: async () => inputs(),
    observe: () => {replacement++;},
  }});
  expect((await second.fetch(full, actualEnv)).status).toBe(401);
  await expect(second.resolvePrivateFinancialSource!(actualEnv)).rejects.toThrow("source_unavailable");
  expect(replacement).toBe(0);
});

test("private owner failure does not enter HTTP initialization or reveal its error", async () => {
  const actualEnv = env(await accountsDb());
  let calls = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    inputs: async () => {calls++; throw new Error("secret-private-callback-sentinel");},
    observe: () => {throw new Error("observer must not run");},
  }});
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  expect(calls).toBe(0);
  await expect(worker.resolvePrivateFinancialSource!(actualEnv)).rejects.toThrow("source_unavailable");
  expect(calls).toBe(1);
  const response = await worker.fetch(full, actualEnv);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("secret-private-callback-sentinel");
  await expect(worker.resolvePrivateFinancialSource!(actualEnv)).rejects.toThrow("source_unavailable");
  expect(calls).toBe(1);
});

test("a hung private input times out only its named caller and cannot publish late", async () => {
  const actualEnv = env(await accountsDb());
  let release!: (value: PrivateAccountsFinancialSourceInputs) => void;
  let seen = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    inputs: () => new Promise<PrivateAccountsFinancialSourceInputs>((resolve) => {release = resolve;}),
    observe: () => {seen++;},
  }});
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  const pending = worker.resolvePrivateFinancialSource!(actualEnv);
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  await expect(pending).rejects.toThrow("source_unavailable");
  release(inputs());
  await Promise.resolve();
  expect(seen).toBe(0);
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
}, 10_000);

test("an injected staging Accounts worker cannot qualify a private source", async () => {
  const worker = createAuthStagingWorker({accounts: {fetch: async () => Response.json({ok: true})}});
  await expect(worker.resolvePrivateFinancialSource(
    env(await accountsDb()) as Parameters<typeof worker.resolvePrivateFinancialSource>[0],
  )).rejects.toThrow("source_unavailable");
});
