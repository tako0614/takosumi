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
import {
  canonicalFinancialSourceJson,
  financialSourceEventDigest,
  type FinancialSourceReceipt,
} from "../../../../accounts/service/src/financial-source-contract.ts";
import { makeFinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-abi.ts";
import {
  createAccountsFinancialControlSource, FinancialSourceUnavailable,
  type AccountsFinancialReceiver, type AccountsFinancialGenesisCoveragePort,
} from "../../../../accounts/service/src/financial-source.ts";
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
    "control",
    "flush",
    "loadFinancialIdentityProof",
    "loadFinancialSourceEventEvidence",
    "prepareFinancialIdentityProofSource",
    "preparePendingFinancialSourceOriginals",
    "prove",
    "verifyCurrentFinancialIdentityProof",
  ]);
  expect(Reflect.ownKeys(source.control).map(String).sort()).toEqual([
    "flush", "loadFinancialSourceEventEvidence",
    "prepareHistoricalFinancialControlSourceOriginals",
    "prepareInitialFinancialControlSourceOriginal",
    "prepareOriginalFinancialControlSource",
  ]);
  expect(Reflect.ownKeys(source)).not.toContain("store");
  expect(Reflect.ownKeys(source)).not.toContain("install");
  expect(Reflect.ownKeys(source)).not.toContain("readOriginal");
  // Preparation-only inputs still cannot acquire new proof/receiver or C
  // capabilities merely because the named method projection is present.
  await expect(source.prove({accessToken: "unused", challengeRef: "unused"})).rejects.toThrow("source_unavailable");
  await expect(source.control.prepareInitialFinancialControlSourceOriginal({workspaceId: "unused"})).rejects.toThrow("source_unavailable");
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
  // This Set models only an explicitly supplied local M prerequisite. It is
  // not a Financial command constructor, M/G implementation or real authority.
  const admittedOriginals = new Set<string>();
  const receiverReceipts = new Map<string, FinancialSourceReceipt>();
  let deliveries = 0;
  const receiver: AccountsFinancialReceiver = {
    receiverRef: accountRegistration.receivers[0]!.receiverRef,
    targetRef: accountRegistration.receivers[0]!.targetRef,
    async read(materialization) {
      expect(this).toBe(receiver);
      return receiverReceipts.get(canonicalFinancialSourceJson(materialization));
    },
    async deliver(materialization) {
      expect(this).toBe(receiver);
      const originalKey = canonicalFinancialSourceJson(materialization);
      if (!admittedOriginals.has(originalKey)) throw new Error("local original M prerequisite unavailable");
      const receipt = await makeFinancialSourceReceipt({
        registrationRef: materialization.event.registrationRef,
        receiverRef: accountRegistration.receivers[0]!.receiverRef,
        targetRef: accountRegistration.receivers[0]!.targetRef,
        event: materialization.event, eventDigest: materialization.eventDigest,
      });
      deliveries++;
      receiverReceipts.set(originalKey, receipt);
      return receipt;
    },
  };
  let clockNow = now;
  const expiryClock = {policyRef: "clock-original", nowMilliseconds() {return clockNow;}};
  const baseInputs = inputs();
  const fixedInputs: PrivateAccountsFinancialSourceInputs = {
    ...baseInputs, registration: accountRegistration,
    receivers: [receiver],
    challenges: {read: async (ref) => ref === challenge.challengeRef ? structuredClone(challenge) : undefined},
    eventEvidence: {
      ...baseInputs.eventEvidence, clock: expiryClock,
      keyCustody: {readCredentialContext: async (request) => ({
        credentialRef: "source-credential-original", incarnationRef: "credential-incarnation-original",
        sourceSchemaRef: "source-schema-original", receiverRef: receiver.receiverRef,
        targetRef: receiver.targetRef, receiverSchemaRef: "receiver-schema-original",
        clockPolicyRef: "clock-original", purpose: request.purpose, validUntil: now + 180_000,
      })},
    },
    control: {
      receivers: [receiver],
      eventEvidence: {
        registration: {registrationRef: controlRegistration.sourceRef, incarnation: controlRegistration.incarnation,
          genesisDigest: `sha256:${controlRegistration.genesisDigest}` as const, receivers: controlRegistration.requiredReceivers},
        sourceCredentialRef: "control-credential-original", sourceSchemaRef: "control-schema-original",
        receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
        receiverSchemaRef: "receiver-schema-original", clock: expiryClock,
        registeredHeads: {readRegisteredHead: async ({head}) => {
          const current = await owner.financialSource.readHead(head.affectedRef);
          if (!current || current.sourceRef !== head.registrationRef || current.incarnation !== head.incarnation) return undefined;
          return {v: 1 as const, head: {registrationRef: current.sourceRef, incarnation: current.incarnation, affectedRef: current.workspaceId},
            genesisDigest: `sha256:${current.genesisDigest}` as const, receivers: current.requiredReceivers,
            sourceSchemaRef: "control-schema-original", sourceCredentialRef: "control-credential-original", clockPolicyRef: "clock-original"};
        }},
        keyCustody: {readCredentialContext: async (request) => ({
          credentialRef: "control-credential-original", incarnationRef: "control-credential-incarnation",
          sourceSchemaRef: "control-schema-original", receiverRef: receiver.receiverRef,
          targetRef: receiver.targetRef, receiverSchemaRef: "receiver-schema-original",
          clockPolicyRef: "clock-original", purpose: request.purpose, validUntil: now + 180_000,
        })},
      },
    },
  };
  const retainedEnrollment = await owner.financialSource.readEnrollmentOriginal({
    workspaceId: workspace.id, sourceRef: controlRegistration.sourceRef,
    incarnation: controlRegistration.incarnation,
  });
  if (!retainedEnrollment) throw new Error("actual retained Core original missing");
  // Original command custody and G GET below are explicit synthetic external
  // fixtures. They neither implement a genuine Root factory nor dispatch G/M.
  const originalGCommand = Object.freeze({admissionRef: "synthetic-original-g-admission",
    commandRef: "synthetic-original-g-command", receiptRef: "synthetic-original-g-receipt",
    enrollmentOriginal: structuredClone(retainedEnrollment)});
  let gStatus: "found" | "absent" | "unknown" = "absent";
  let genesisReads = 0;
  let coverage!: AccountsFinancialGenesisCoveragePort;
  let observed = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => owner.financialSource,
    inputs: async (_env, construction) => {
      expect(construction.createAccountsFinancialControlSource).toBe(createAccountsFinancialControlSource);
      expect(construction.FinancialSourceUnavailable).toBe(FinancialSourceUnavailable);
      expect(new construction.FinancialSourceUnavailable("source_conflict")).toBeInstanceOf(FinancialSourceUnavailable);
      expect(Object.isFrozen(construction)).toBe(true);
      expect(Object.isFrozen(construction.core)).toBe(true);
      expect(Reflect.ownKeys(construction.core).sort()).toEqual([
        "assertFinancialSourceSnapshotCurrent", "captureFinancialSourceSnapshot", "readEnrollmentOriginal",
      ]);
      expect(Reflect.set(construction.core, "readEnrollmentOriginal", async () => undefined)).toBe(false);
      expect(genesisReads).toBe(0);
      const selectedPeer = {
        receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, affectedRef: workspace.id,
        genesisQualificationRef: "synthetic-g-genesis-qualification",
        source: {
          registration: fixedInputs.control!.eventEvidence.registration,
          registrationDigest: `sha256:${"1".repeat(64)}` as const,
          qualificationRef: "synthetic-g-source-qualification",
          sourceSchemaDigest: `sha256:${"2".repeat(64)}` as const,
          sourceCredentialRef: "control-credential-original", clockPolicyRef: "clock-original",
          originRef: "synthetic-g-selected-origin",
        },
      };
      coverage = {
        peers: [structuredClone(selectedPeer)],
        async readCurrentOriginals({coreSnapshot, coreOriginal}) {
          expect(this).toBe(coverage);
          genesisReads++;
          const before = await construction.core.captureFinancialSourceSnapshot({workspaceId: workspace.id,
            actorAccountId: subject});
          expect(before).toEqual(coreSnapshot);
          expect(await construction.core.readEnrollmentOriginal({workspaceId: workspace.id,
            sourceRef: controlRegistration.sourceRef, incarnation: controlRegistration.incarnation})).toEqual(retainedEnrollment);
          expect(coreOriginal).toEqual(originalGCommand.enrollmentOriginal);
          if (gStatus === "unknown") throw new construction.FinancialSourceUnavailable("source_unavailable");
          const row = {receiverRef: selectedPeer.receiverRef, targetRef: selectedPeer.targetRef,
            command: structuredClone(originalGCommand)};
          const result = gStatus === "absent" ? {...row, status: "absent" as const} :
            {...row, status: "found" as const, receipt: {admissionRef: originalGCommand.admissionRef,
              commandRef: originalGCommand.commandRef, receiptRef: originalGCommand.receiptRef}};
          if (!await construction.core.assertFinancialSourceSnapshotCurrent(coreSnapshot))
            throw new construction.FinancialSourceUnavailable("source_unavailable");
          return [result];
        },
      };
      return {...fixedInputs, control: {...fixedInputs.control!, genesisCoverage: coverage}};
    },
    observe: async (published) => {
      observed++;
      expect(genesisReads).toBe(0);
      // Publication is not dispatch. Every family must refuse observer reentry
      // until resolve completes, before any actual source operation can start.
      await expect(published.prepareFinancialIdentityProofSource({accessToken: token, challengeRef: challenge.challengeRef})).rejects.toThrow("source_unavailable");
      await expect(published.flush({limit: 4})).rejects.toThrow("source_unavailable");
      await expect(published.control.prepareInitialFinancialControlSourceOriginal({workspaceId: workspace.id})).rejects.toThrow("source_unavailable");
    },
  }});
  expect((await worker.fetch(hostedFull, actualEnv)).status).toBe(401);
  const source = await worker.resolvePrivateFinancialSource!(actualEnv);
  expect(observed).toBe(1);
  expect(genesisReads).toBe(0);
  await expect(source.prepareFinancialIdentityProofSource({accessToken: token,
    challengeRef: challenge.challengeRef})).rejects.toThrow("source_unavailable");
  gStatus = "unknown";
  await expect(source.prepareFinancialIdentityProofSource({accessToken: token,
    challengeRef: challenge.challengeRef})).rejects.toBeInstanceOf(FinancialSourceUnavailable);
  expect((await seed.listFinancialSourcePending({registrationRef: accountRegistration.registrationRef, limit: 4})).entries).toEqual([]);
  expect(deliveries).toBe(0);
  gStatus = "found";
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
  const readsBeforeMutation = genesisReads;
  Reflect.set(coverage, "readCurrentOriginals", async () => {throw new Error("late G callable replacement");});
  Reflect.set(coverage.peers[0]!.source, "qualificationRef", "late G selected-source replacement");
  expect((await source.prepareFinancialIdentityProofSource({accessToken: token,
    challengeRef: challenge.challengeRef})).parents).toEqual(prepared.parents);
  expect(genesisReads).toBeGreaterThan(readsBeforeMutation);
  // Both direct captures keep their original functions/receiver after publish.
  // Core's internal virtual call from assertCurrent to capture remains Core's
  // existing behavior; this test does not replace that transitive dependency.
  const coreRead = Object.getOwnPropertyDescriptor(owner.financialSource, "readEnrollmentOriginal");
  const coreAssert = Object.getOwnPropertyDescriptor(owner.financialSource, "assertFinancialSourceSnapshotCurrent");
  try {
    for (const key of ["readEnrollmentOriginal", "assertFinancialSourceSnapshotCurrent"] as const)
      Object.defineProperty(owner.financialSource, key, {configurable: true,
        value: async () => {throw new Error("late direct Core callable replacement");}});
    expect((await source.prepareFinancialIdentityProofSource({accessToken: token,
      challengeRef: challenge.challengeRef})).parents).toEqual(prepared.parents);
  } finally {
    for (const [key, descriptor] of [["readEnrollmentOriginal", coreRead],
      ["assertFinancialSourceSnapshotCurrent", coreAssert]] as const) {
      if (descriptor) Object.defineProperty(owner.financialSource, key, descriptor);
      else Reflect.deleteProperty(owner.financialSource, key);
    }
  }
  // Permission-seq0/G is not an event0/ACK0. Existing initial-event preparation
  // must refuse it. The synthetic G readback creates no Core event/ACK0,
  // empty fallback or writer; it is not a genuine external G qualification.
  await expect(source.control.prepareInitialFinancialControlSourceOriginal({workspaceId: workspace.id})).rejects.toThrow("source_pending");
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

  // A real canonical permission mutation creates C event1. Until its actual
  // materialization exists, the unchanged C.capture predicate denies A prep.
  await owner.upsertWorkspaceMember({workspaceId: workspace.id, accountId: subject,
    actorAccountId: subject, roles: ["owner", "admin"], status: "active", requireCurrentMembership: true});
  expect((await owner.financialSource.readHead(workspace.id))?.permissionSequence).toBe(1);
  await expect(source.prepareFinancialIdentityProofSource({accessToken: token, challengeRef: challenge.challengeRef})).rejects.toThrow("source_unavailable");
  const controlOriginal = await source.control.prepareInitialFinancialControlSourceOriginal({workspaceId: workspace.id});
  expect(controlOriginal.original.key).toEqual({registrationRef: controlRegistration.sourceRef,
    incarnation: controlRegistration.incarnation, affectedRef: workspace.id});
  expect(controlOriginal.original.materialization.event.sequence).toBe(1);
  expect(controlOriginal.original.materialization.event.previousDigest).toBe(`sha256:${controlRegistration.genesisDigest}`);
  await expect(source.control.flush({workspaceId: workspace.id, afterSequence: 0, limit: 4})).rejects.toThrow("local original M prerequisite unavailable");
  expect(deliveries).toBe(0);
  // C's explicit original M prerequisite and actual original receiver ACK come
  // before the new A preparation. This is never the permission-seq0/G path.
  admittedOriginals.add(canonicalFinancialSourceJson(controlOriginal.original.materialization));
  // Later replacement of supplied callable slots cannot swap the captured
  // receivers or clocks. The actual callbacks still read their current state.
  Reflect.set(receiver, "read", async () => {throw new Error("late read replacement");});
  Reflect.set(receiver, "deliver", async () => {throw new Error("late deliver replacement");});
  Reflect.set(expiryClock, "nowMilliseconds", () => {throw new Error("late clock replacement");});
  clockNow = now + 17;
  expect((await source.control.flush({workspaceId: workspace.id, afterSequence: 0, limit: 4})).processed).toBe(1);
  expect((await owner.financialSource.listPendingEvents({workspaceId: workspace.id,
    receiverRef: accountRegistration.receivers[0]!.receiverRef, afterSequence: 0, limit: 4}))).toEqual([]);
  expect(deliveries).toBe(1);
  const refreshed = await source.prepareFinancialIdentityProofSource({accessToken: token, challengeRef: challenge.challengeRef});
  expect(refreshed.parents).toEqual(prepared.parents);
  expect(refreshed.controlSource.eventRef).toBe(controlOriginal.original.eventRef);
  expect(refreshed.controlSource.registrationRef).not.toBe(refreshed.registration.registrationRef);
  await expect(source.control.prepareOriginalFinancialControlSource({workspaceId: workspace.id, accountId: subject,
    expectedSource: {...refreshed.controlSource, incarnation: "wrong-full-key"}})).rejects.toThrow("source_conflict");
  expect((await source.control.prepareOriginalFinancialControlSource({workspaceId: workspace.id,
    accountId: subject, expectedSource: refreshed.controlSource})).original).toEqual(controlOriginal.original);
  const evidence = await source.control.loadFinancialSourceEventEvidence({v: 1,
    eventRef: controlOriginal.original.eventRef, eventDigest: controlOriginal.original.materialization.eventDigest});
  expect(evidence.status).toBe("found");
  if (evidence.status === "found") expect(evidence.registeredHead.head).toEqual(controlOriginal.original.key);
  await expect(source.prove({accessToken: token, challengeRef: challenge.challengeRef})).rejects.toThrow("source_pending");
  await expect(source.flush({limit: 4})).rejects.toThrow("local original M prerequisite unavailable");
  expect(deliveries).toBe(1);

  // Select only retained originals in the explicit local M fixture. No source
  // code here implements M, manufactures G or turns missing readback into ACK.
  for (const original of Object.values(refreshed.parents)) admittedOriginals.add(canonicalFinancialSourceJson(original.materialization));
  expect((await source.flush({limit: 4})).processed).toBe(4);
  expect(deliveries).toBe(5);
  for (const original of Object.values(refreshed.parents)) {
    expect((await seed.findFinancialSourceReceipt({registrationRef: accountRegistration.registrationRef,
      eventRef: original.eventRef, receiverRef: accountRegistration.receivers[0]!.receiverRef}))?.receipt.eventRef).toBe(original.eventRef);
  }
  const proof = await source.prove({accessToken: token, challengeRef: challenge.challengeRef});
  const loaded = await source.loadFinancialIdentityProof({v: 1, proofRef: proof.proofRef, challengeRef: challenge.challengeRef});
  expect(loaded.status).toBe("found");
  if (loaded.status === "found") {
    expect(loaded.proof.issuedAt).toBe(clockNow);
    expect(loaded.proof.control.source).toEqual(refreshed.controlSource);
  }
  expect((await source.verifyCurrentFinancialIdentityProof({v: 1, proofRef: proof.proofRef,
    challengeRef: challenge.challengeRef})).status).toBe("current");
  expect(await source.prove({accessToken: token, challengeRef: challenge.challengeRef})).toEqual(proof);
  expect((await source.control.prepareHistoricalFinancialControlSourceOriginals({workspaceId: workspace.id,
    afterSequence: 0, limit: 4})).entries.map(({original}) => original)).toEqual([controlOriginal.original]);
  clockNow = challenge.expiresAt;
  expect((await source.verifyCurrentFinancialIdentityProof({v: 1, proofRef: proof.proofRef,
    challengeRef: challenge.challengeRef})).status).toBe("not-current");
  await expect(source.prove({accessToken: token, challengeRef: challenge.challengeRef})).rejects.toThrow("invalid_challenge");
  expect(await source.loadFinancialIdentityProof({v: 1, proofRef: proof.proofRef,
    challengeRef: challenge.challengeRef})).toEqual(loaded);
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

test("a Core reader replaced during owner-input await cannot split bridge and C source capture", async () => {
  for (const key of ["captureFinancialSourceSnapshot", "assertFinancialSourceSnapshotCurrent", "readEnrollmentOriginal"] as const) {
    for (const replacement of ["data", "accessor"] as const) {
      const actualEnv = env(await accountsDb());
      const actualCore = new WorkspacesService({store: new InMemoryOpenTofuControlStore()}).financialSource;
      let entered!: () => void, release!: () => void;
      const inputEntered = new Promise<void>((resolve) => {entered = resolve;});
      const held = new Promise<void>((resolve) => {release = resolve;});
      let inputCalls = 0, observed = 0, replacementCalls = 0;
      const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
        coreFinancialSource: async () => actualCore,
        inputs: async (_env, construction) => {
          inputCalls++;
          expect(construction.FinancialSourceUnavailable).toBe(FinancialSourceUnavailable);
          entered();
          await held;
          return inputs();
        },
        observe: () => {observed++;},
      }});
      const pending = worker.resolvePrivateFinancialSource!(actualEnv);
      await inputEntered;
      const original = actualCore[key];
      if (replacement === "data") Object.defineProperty(actualCore, key, {configurable: true,
        value: async () => {replacementCalls++; throw new Error("changed Core callable must not run");}});
      else Object.defineProperty(actualCore, key, {configurable: true,
        get() {replacementCalls++; return original;}});
      release();
      await expect(pending).rejects.toThrow("source_unavailable");
      expect(inputCalls).toBe(1);
      expect(observed).toBe(0);
      expect(replacementCalls).toBe(0);
      expect((await worker.fetch(full, actualEnv)).status).toBe(401);
    }
  }
});

test("canonical Core failure refuses construction before owner inputs or observation", async () => {
  const actualEnv = env(await accountsDb());
  let inputCalls = 0, observed = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => {throw new Error("private-core-failure-sentinel");},
    inputs: async () => {inputCalls++; return inputs();},
    observe: () => {observed++;},
  }});
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  await expect(worker.resolvePrivateFinancialSource!(actualEnv)).rejects.toThrow("source_unavailable");
  expect(inputCalls).toBe(0);
  expect(observed).toBe(0);
  const ordinary = await worker.fetch(full, actualEnv);
  expect(ordinary.status).toBe(401);
  expect(await ordinary.text()).not.toContain("private-core-failure-sentinel");
});

test("a timed-out canonical Core cannot invoke construction inputs or publish late", async () => {
  const actualEnv = env(await accountsDb());
  let release!: (value: typeof core) => void;
  let inputsCalled = 0, observed = 0;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: () => new Promise<typeof core>((resolve) => {release = resolve;}),
    inputs: async () => {inputsCalled++; return inputs();},
    observe: () => {observed++;},
  }});
  const pending = worker.resolvePrivateFinancialSource!(actualEnv);
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
  await expect(pending).rejects.toThrow("source_unavailable");
  release(core);
  await Promise.resolve();
  expect(inputsCalled).toBe(0);
  expect(observed).toBe(0);
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
}, 10_000);

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

test("a timed-out observer cannot publish or use either retained source family late", async () => {
  const actualEnv = env(await accountsDb());
  const selected = inputs();
  const receiver: AccountsFinancialReceiver = {
    receiverRef: registration.receivers[0]!.receiverRef,
    targetRef: registration.receivers[0]!.targetRef,
    read: async () => undefined,
    deliver: async () => {throw new Error("no receiver is qualified by this fixture");},
  };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {enter = resolve;});
  const held = new Promise<void>((resolve) => {release = resolve;});
  let captured: PrivateAccountsFinancialSourceFacade | undefined;
  const worker = createCloudflareWorker({privateFinancialSourceOrigin: {
    coreFinancialSource: async () => core,
    inputs: async () => ({...selected, receivers: [receiver],
      control: {receivers: [receiver], eventEvidence: {...selected.eventEvidence, registration}}}),
    observe: async (source) => {captured = source; enter(); await held;},
  }});
  const pending = worker.resolvePrivateFinancialSource!(actualEnv);
  await entered;
  await expect(pending).rejects.toThrow("source_unavailable");
  release();
  await Promise.resolve();
  expect(captured).toBeDefined();
  await expect(captured!.loadFinancialIdentityProof({v: 1,
    proofRef: "proof-original", challengeRef: "challenge-original"})).rejects.toThrow("source_unavailable");
  await expect(captured!.control.prepareInitialFinancialControlSourceOriginal({workspaceId: "absent-workspace"})).rejects.toThrow("source_unavailable");
  expect((await worker.fetch(full, actualEnv)).status).toBe(401);
}, 10_000);

test("an injected staging Accounts worker cannot qualify a private source", async () => {
  const worker = createAuthStagingWorker({accounts: {fetch: async () => Response.json({ok: true})}});
  await expect(worker.resolvePrivateFinancialSource(
    env(await accountsDb()) as Parameters<typeof worker.resolvePrivateFinancialSource>[0],
  )).rejects.toThrow("source_unavailable");
});
