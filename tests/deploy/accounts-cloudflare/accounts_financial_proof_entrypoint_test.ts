import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../accounts/service/src/d1-migrations.ts";
import { D1AccountsStore, type D1Database, type TokenRecord } from "../../../accounts/service/src/d1-store.ts";
import { canonicalFinancialSourceJson, financialSourceEventDigest, type FinancialSourceReceipt } from "../../../accounts/service/src/financial-source-contract.ts";
import { makeFinancialSourceReceipt } from "../../../accounts/service/src/financial-source-abi.ts";
import type { AccountsFinancialGenesisCoveragePort, AccountsFinancialReceiver } from "../../../accounts/service/src/financial-source.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../worker/src/d1_schema_maintenance.ts";

function hostSource() { return `
import { createAuthStagingWorker } from ${JSON.stringify(resolve(import.meta.dir, "../../../deploy/accounts-cloudflare/src/staging-worker.ts"))};
import { createAccountsFinancialProofEntrypoint } from ${JSON.stringify(resolve(import.meta.dir, "../../../deploy/accounts-cloudflare/src/accounts-financial-proof-entrypoint.ts"))};
import { authStagingControlOperations } from ${JSON.stringify(resolve(import.meta.dir, "../../../deploy/accounts-cloudflare/src/staging-owner-bundle.ts"))};
export function create(options) {
  const worker = createAuthStagingWorker(options);
  return { worker, Entry: createAccountsFinancialProofEntrypoint(worker) };
}
export function createWorker(options) { return createAuthStagingWorker(options); }
export function cloneEntry(worker) {
  return createAccountsFinancialProofEntrypoint({ ...worker });
}
export async function getControl(env) { return await authStagingControlOperations(env); }
`; }

async function buildEntrypointModule() {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-accounts-proof-entrypoint-"));
  const harnessPath = join(directory, "host.ts");
  await writeFile(harnessPath, hostSource(), { mode: 0o600 });
  const result = await Bun.build({
    entrypoints: [harnessPath],
    target: "node",
    format: "esm",
    plugins: [{
      name: "workers-entrypoint-test-shim",
      setup(build) {
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers-shim", namespace: "workers-shim" }));
        build.onLoad({ filter: /.*/, namespace: "workers-shim" }, () => ({
          loader: "js",
          contents: `export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`,
        }));
      },
    }],
  });
  if (!result.success) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(result.logs.map(String).join("\n"));
  }
  const modulePath = join(directory, "host.mjs");
  await writeFile(modulePath, await result.outputs[0]!.text(), { mode: 0o600 });
  return { module: await import(pathToFileURL(modulePath).href), close: () => rm(directory, { recursive: true, force: true }) };
}

async function migratedAccountsDb() {
  const db = new SqliteFakeD1();
  for (const migration of (await loadD1AccountsMigrationCatalog()).migrations) {
    if (migration.version > 5) break;
    await applyD1AccountsMigrationBatch(db, migration, 1_000 + migration.version);
  }
  return db;
}

function stagingEnv(db: SqliteFakeD1) {
  return {
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER,
    TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(AUTH_STAGING_CLIENTS.map((client) => ({
      ...client, allowedScopes: ["openid", "email", "offline_access"],
      tokenEndpointAuthMethod: "client_secret_basic", enabled: true, profile: "shared-account",
    }))),
    TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
      { providerId: "google", protocol: "oidc", verificationProfile: "google-oidc", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback`, issuer: "https://accounts.google.com", authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint: "https://oauth2.googleapis.com/token", userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo", clientId: "synthetic-google-client" },
      { providerId: "github", protocol: "oauth2", verificationProfile: "github-oauth", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback`, issuer: "https://github.com", authorizationEndpoint: "https://github.com/login/oauth/authorize", tokenEndpoint: "https://github.com/login/oauth/access_token", userInfoEndpoint: "https://api.github.com/user", clientId: "synthetic-github-client" },
    ]),
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "local-test-only-session-salt",
    TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET: "local-test-only-hosted-secret",
    TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET: "local-test-only-server-secret",
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "local-test-only-subject-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET: "local-test-only-google-secret",
    TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET: "local-test-only-github-secret",
    TAKOSUMI_VERSION_METADATA: { id: "accounts-proof-rpc-test" },
    R2_ARTIFACTS: {}, R2_SOURCE: {}, R2_STATE: {}, R2_BACKUPS: {},
    COORDINATION: {}, RUN_OWNER: {}, RUNNER: {},
  };
}

function configuredPrivateSourceInputs() {
  const now = Date.now();
  const registration = {
    registrationRef: "rpc-accounts-registration", incarnation: "rpc-accounts-incarnation",
    genesisDigest: `sha256:${"a".repeat(64)}` as const,
    receivers: [{ receiverRef: "rpc-primary", targetRef: "rpc-target" }],
  };
  const receiver = {
    receiverRef: "rpc-primary", targetRef: "rpc-target",
    async read() { return undefined; }, async deliver() { throw new Error("synthetic receiver is read-only"); },
  };
  const clock = { policyRef: "synthetic-local-clock", nowMilliseconds: () => Date.now() };
  const evidence = {
    sourceCredentialRef: "synthetic-source-credential", sourceSchemaRef: "synthetic-source-schema",
    receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
    receiverSchemaRef: "synthetic-receiver-schema", clock,
    registeredHeads: { async readRegisteredHead() { return undefined; } },
    keyCustody: { async readCredentialContext(request: { purpose: string }) {
      return { credentialRef: "synthetic-source-credential", incarnationRef: "synthetic-credential-incarnation",
        sourceSchemaRef: "synthetic-source-schema", receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
        receiverSchemaRef: "synthetic-receiver-schema", clockPolicyRef: clock.policyRef,
        purpose: request.purpose, validUntil: Date.now() + 60_000 };
    } },
  };
  return {
    registration, receivers: [receiver], challenges: { async read(ref: string) {
      return ref === "rpc-challenge" ? { v: 1 as const, challengeRef: ref,
        registrationRef: registration.registrationRef, clientId: AUTH_STAGING_CLIENTS[0]!.clientId,
        workspaceId: "rpc-workspace", organizationId: "rpc-organization", workspaceRef: "rpc-workspace-ref",
        requestFingerprint: `sha256:${"d".repeat(64)}` as const, createdAt: now - 1_000, expiresAt: now + 120_000 } : undefined;
    } },
    eventEvidence: evidence,
    control: { receivers: [receiver], eventEvidence: {
      ...evidence,
      registration: { registrationRef: "rpc-control-registration", incarnation: "rpc-control-incarnation",
        genesisDigest: `sha256:${"b".repeat(64)}` as const, receivers: registration.receivers },
    } },
  };
}

test("private Accounts proof entrypoint is factory-bound, target-gated, and keeps unknown errors opaque", async () => {
  const host = await buildEntrypointModule();
  try {
    const db = await migratedAccountsDb();
    const controlDb = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(controlDb);
    const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const env = { ...stagingEnv(db), TAKOSUMI_CONTROL_DB: controlDb,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signingKey.privateKey)),
      TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "synthetic-local-test-pairwise-secret-32bytes",
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "synthetic-local-test-only-passphrase-32-bytes",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "synthetic-local-control-token" };
    const { worker, Entry } = host.module.create({ verifySchema: async () => {} });
    const endpoint = new Entry({}, { ...env });

    expect((await endpoint.fetch(new Request("https://internal.example/prove"))).status).toBe(404);
    expect(() => host.module.cloneEntry(worker)).toThrow("source_unavailable");

    // The actual default Accounts resolver is reached. With no private A/C
    // origin configured it must preserve the existing fail-closed result.
    await expect(endpoint.prove({ accessToken: "fixture-token-never-logged", challengeRef: "challenge-original" }))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });

    await expect(endpoint.prove({ accessToken: "x", challengeRef: "challenge-original" }, "extra"))
      .rejects.toMatchObject({ message: "source_conflict", code: "source_conflict" });
    const accessorInput = Object.defineProperty({}, "accessToken", { enumerable: true, get() { throw new Error("fixture-token-never-logged"); } });
    await expect(endpoint.prove(Object.assign(accessorInput, { challengeRef: "challenge-original" })))
      .rejects.toMatchObject({ message: "source_conflict", code: "source_conflict" });
    const proxyInput = new Proxy({ accessToken: "fixture-token-never-logged", challengeRef: "challenge-original" }, {
      ownKeys() { throw new Error("fixture-private-proxy-detail"); },
    });
    await expect(endpoint.prove(proxyInput))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });

    const secret = "fixture-private-callback-detail";
    const failing = host.module.create({ verifySchema: async () => { throw new Error(secret); } });
    await expect(new failing.Entry({}, { ...env }).prove({ accessToken: "fixture-token-never-logged", challengeRef: "challenge-original" }))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });
    await expect(new failing.Entry({}, { ...env }).loadFinancialIdentityProof({ v: 1, proofRef: "proof-original", challengeRef: "challenge-original" }))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });
    const mutableDependencies: { verifySchema: (value: unknown) => Promise<void> } = {
      verifySchema: async () => { throw new Error(secret); },
    };
    const capturedFailure = host.module.create(mutableDependencies);
    mutableDependencies.verifySchema = async () => {};
    await expect(new capturedFailure.Entry({}, { ...env }).prove({ accessToken: "fixture-token-never-logged", challengeRef: "challenge-original" }))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });

    const fakeAccounts = { async fetch() { return Response.json({ fake: true }); },
      async resolvePrivateFinancialSource() { return {}; } };
    const injectedDependencies: { accounts?: typeof fakeAccounts; verifySchema: (value: unknown) => Promise<void> } = {
      accounts: fakeAccounts, verifySchema: async () => {},
    };
    const injectedWorker = host.module.createWorker(injectedDependencies);
    injectedDependencies.accounts = undefined;
    await expect(injectedWorker.resolvePrivateFinancialSource({ ...env }))
      .rejects.toMatchObject({ message: "source_unavailable", code: "source_unavailable" });
    expect(() => host.module.cloneEntry(injectedWorker)).toThrow("source_unavailable");

    // Configure the source inputs on the real staged factory, resolve through
    // its named RPC, and exercise the actual handler-owned Accounts facade.
    // The synthetic challenge intentionally has no retained original, so this
    // proves dispatch/reachability, not a successful proof or qualification.
    const callOrder: string[] = [];
    const financialSourceOrigin = {
      inputs: async () => { callOrder.push("inputs"); return configuredPrivateSourceInputs(); },
      observe: () => { callOrder.push("facade-published"); },
    };
    const configured = host.module.create({ verifySchema: async () => {}, financialSourceOrigin });
    const rpcEnv = { ...env };
    const controlOperations = await host.module.getControl(rpcEnv);
    expect(controlOperations.workspaces.financialSource).toBeDefined();
    const sourceInputs = configuredPrivateSourceInputs();
    const seed = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed", sessionHashSalt: "local-test-only-session-salt",
    });
    expect(await seed.registerFinancialSourceRegistration(sourceInputs.registration)).toBe(true);
    const rpc = new configured.Entry({}, rpcEnv);
    const proofRef = `afp_${"c".repeat(64)}`;
    await expect(rpc.prove({ accessToken: "synthetic-no-token", challengeRef: "rpc-challenge" }))
      .rejects.toMatchObject({ message: "invalid_grant", code: "invalid_grant" });
    expect(callOrder).toEqual(["inputs", "facade-published"]);
    expect(await rpc.loadFinancialIdentityProof({ v: 1, proofRef, challengeRef: "rpc-challenge" }))
      .toEqual({ v: 1, status: "not-found" });
    expect(await rpc.verifyCurrentFinancialIdentityProof({ v: 1, proofRef, challengeRef: "rpc-challenge" }))
      .toEqual({ v: 1, status: "not-current" });
    expect(callOrder).toEqual(["inputs", "facade-published"]);
  } finally {
    await host.close();
  }
});

test("configured staged RPC issues, loads, and checks currentness for one retained original", async () => {
  const host = await buildEntrypointModule();
  try {
    const db = await migratedAccountsDb();
    const controlDb = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(controlDb);
    const maintenanceFence = await acquireControlD1MaintenanceFence(controlDb as unknown as D1Database, {
      sourceCommit: "c".repeat(40), manifestDigest: `sha256:${"d".repeat(64)}`,
      environment: "test", databaseRole: "in_place", releasePolicy: "in_place",
    }, "2026-10-15T00:00:00.000Z");
    await releaseControlD1MaintenanceFence(controlDb as unknown as D1Database, maintenanceFence, "2026-10-15T00:00:01.000Z");
    const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const env = { ...stagingEnv(db), TAKOSUMI_CONTROL_DB: controlDb,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signingKey.privateKey)),
      TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "synthetic-local-test-pairwise-secret-32bytes",
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "synthetic-local-test-only-passphrase-32-bytes",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "synthetic-local-control-token" };
    const now = Date.now();
    const subject = "tsub_rpc_proof_actor";
    const token = "synthetic-retained-rpc-access-token";
    const clientId = AUTH_STAGING_CLIENTS[0]!.clientId;
    const sid = "rpc-proof-sid", issuerSessionId = "rpc-proof-issuer-session";
    const accountRegistration = {
      registrationRef: "rpc-proof-accounts-registration", incarnation: "rpc-proof-accounts-incarnation",
      genesisDigest: `sha256:${"a".repeat(64)}` as const,
      receivers: [{ receiverRef: "rpc-proof-primary", targetRef: "rpc-proof-target" }],
    };
    const seed = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed", sessionHashSalt: "local-test-only-session-salt",
    });
    const access: TokenRecord = {
      clientId, oidcProfile: "shared-account", issuer: AUTH_STAGING_ISSUER, subject,
      takosumiSubject: subject, sid, issuerSessionId, identityGeneration: 0,
      authTime: Math.floor(now / 1_000) - 1, scope: "openid email offline_access", expiresAt: now + 240_000,
    };
    await seed.saveAccount({ subject, createdAt: now, updatedAt: now });
    await seed.saveAccessToken(token, access);
    await seed.saveHostedOidcGrant({ sid, issuerSessionId, clientId, issuer: AUTH_STAGING_ISSUER, subject,
      identityGeneration: 0, scope: access.scope, authTime: access.authTime,
      createdAt: now, absoluteExpiresAt: now + 300_000 });
    expect(await seed.registerFinancialSourceRegistration(accountRegistration)).toBe(true);

    let clockNow = now;
    const expiryClock = { policyRef: "rpc-proof-synthetic-clock", nowMilliseconds() { return clockNow; } };
    const admittedOriginals = new Set<string>();
    const receiverReceipts = new Map<string, FinancialSourceReceipt>();
    let deliveries = 0;
    const receiver: AccountsFinancialReceiver = {
      receiverRef: accountRegistration.receivers[0]!.receiverRef,
      targetRef: accountRegistration.receivers[0]!.targetRef,
      async read(materialization) { return receiverReceipts.get(canonicalFinancialSourceJson(materialization)); },
      async deliver(materialization) {
        const key = canonicalFinancialSourceJson(materialization);
        if (!admittedOriginals.has(key)) throw new Error("synthetic original command not admitted");
        const receipt = await makeFinancialSourceReceipt({
          registrationRef: materialization.event.registrationRef, receiverRef: receiver.receiverRef,
          targetRef: receiver.targetRef, event: materialization.event, eventDigest: materialization.eventDigest,
        });
        deliveries++; receiverReceipts.set(key, receipt); return receipt;
      },
    };
    const rpcEnv = { ...env };
    const operations = await host.module.getControl(rpcEnv);
    const owner = operations.workspaces;
    const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(subject, "rpc-proof");
    const intent = await owner.billingBindings.prepare({ workspaceId: workspace.id,
      billingAuthority: "synthetic-financial-owner", actorAccountId: subject });
    const binding = await owner.billingBindings.claim({ workspaceId: workspace.id, intentId: intent.intentId,
      actorAccountId: subject, organizationRef: "rpc-proof-organization", ownerAcknowledgementRef: "synthetic-owner-ack" });
    const controlRegistration = { sourceRef: "rpc-proof-control-registration", incarnation: "rpc-proof-control-incarnation",
      genesisDigest: "c".repeat(64), requiredReceivers: accountRegistration.receivers };
    const enrollment = await owner.financialSource.prepareEnrollment({ workspaceId: workspace.id });
    if (!enrollment) throw new Error("synthetic Control enrollment unavailable");
    expect(await owner.financialSource.enroll({ original: enrollment, registration: controlRegistration })).toBeDefined();
    const challenge = {
      v: 1 as const, challengeRef: "rpc-proof-challenge", registrationRef: accountRegistration.registrationRef,
      clientId, workspaceId: workspace.id, organizationId: binding.organizationRef, workspaceRef: binding.workspaceRef,
      requestFingerprint: `sha256:${"d".repeat(64)}` as const, createdAt: now, expiresAt: now + 120_000,
    };
    const retainedEnrollment = await owner.financialSource.readEnrollmentOriginal({ workspaceId: workspace.id,
      sourceRef: controlRegistration.sourceRef, incarnation: controlRegistration.incarnation });
    if (!retainedEnrollment) throw new Error("synthetic Control original unavailable");
    const originalGCommand = Object.freeze({ admissionRef: "synthetic-rpc-g-admission",
      commandRef: "synthetic-rpc-g-command", receiptRef: "synthetic-rpc-g-receipt",
      enrollmentOriginal: structuredClone(retainedEnrollment) });
    const selectedPeer = {
      receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, affectedRef: workspace.id,
      genesisQualificationRef: "synthetic-rpc-g-genesis", source: {
        registration: { registrationRef: controlRegistration.sourceRef, incarnation: controlRegistration.incarnation,
          genesisDigest: `sha256:${controlRegistration.genesisDigest}` as const, receivers: controlRegistration.requiredReceivers },
        registrationDigest: `sha256:${"1".repeat(64)}` as const, qualificationRef: "synthetic-rpc-g-source",
        sourceSchemaDigest: `sha256:${"2".repeat(64)}` as const, sourceCredentialRef: "rpc-control-credential",
        clockPolicyRef: expiryClock.policyRef, originRef: "synthetic-rpc-g-origin",
      },
    };
    const genesisCoverage: AccountsFinancialGenesisCoveragePort = {
      peers: [structuredClone(selectedPeer)],
      async readCurrentOriginals({ coreSnapshot, coreOriginal }) {
        const current = await constructionCore.captureFinancialSourceSnapshot({ workspaceId: workspace.id, actorAccountId: subject });
        if (JSON.stringify(current) !== JSON.stringify(coreSnapshot) ||
          JSON.stringify(coreOriginal) !== JSON.stringify(originalGCommand.enrollmentOriginal))
          throw new Error("synthetic G original changed");
        if (!await constructionCore.assertFinancialSourceSnapshotCurrent(coreSnapshot))
          throw new Error("synthetic Core snapshot not current");
        return [{ receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, status: "found" as const,
          command: structuredClone(originalGCommand), receipt: { admissionRef: originalGCommand.admissionRef,
            commandRef: originalGCommand.commandRef, receiptRef: originalGCommand.receiptRef } }];
      },
    };
    let constructionCore: any;
    const callOrder: string[] = [];
    const financialSourceOrigin = {
      inputs: async (_env: unknown, construction: any) => {
        callOrder.push("inputs"); constructionCore = construction.core;
        return {
          registration: accountRegistration, receivers: [receiver],
          challenges: { async read(ref: string) { return ref === challenge.challengeRef ? structuredClone(challenge) : undefined; } },
          eventEvidence: {
            sourceCredentialRef: "rpc-accounts-credential", sourceSchemaRef: "rpc-accounts-schema",
            receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, receiverSchemaRef: "rpc-receiver-schema",
            clock: expiryClock, registeredHeads: { async readRegisteredHead() { return undefined; } },
            keyCustody: { async readCredentialContext(request: { purpose: string }) {
              return { credentialRef: "rpc-accounts-credential", incarnationRef: "rpc-accounts-credential-incarnation",
                sourceSchemaRef: "rpc-accounts-schema", receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
                receiverSchemaRef: "rpc-receiver-schema", clockPolicyRef: expiryClock.policyRef,
                purpose: request.purpose, validUntil: now + 180_000 };
            } },
          },
          control: { receivers: [receiver], genesisCoverage, eventEvidence: {
            registration: { registrationRef: controlRegistration.sourceRef, incarnation: controlRegistration.incarnation,
              genesisDigest: `sha256:${controlRegistration.genesisDigest}` as const, receivers: controlRegistration.requiredReceivers },
            sourceCredentialRef: "rpc-control-credential", sourceSchemaRef: "rpc-control-schema",
            receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, receiverSchemaRef: "rpc-receiver-schema",
            clock: expiryClock,
            registeredHeads: { async readRegisteredHead({ head }: any) {
              const current = await owner.financialSource.readHead(head.affectedRef);
              if (!current || current.sourceRef !== head.registrationRef || current.incarnation !== head.incarnation) return undefined;
              return { v: 1 as const, head: { registrationRef: current.sourceRef, incarnation: current.incarnation,
                affectedRef: current.workspaceId }, genesisDigest: `sha256:${current.genesisDigest}` as const,
                receivers: current.requiredReceivers, sourceSchemaRef: "rpc-control-schema",
                sourceCredentialRef: "rpc-control-credential", clockPolicyRef: expiryClock.policyRef };
            } },
            keyCustody: { async readCredentialContext(request: { purpose: string }) {
              return { credentialRef: "rpc-control-credential", incarnationRef: "rpc-control-credential-incarnation",
                sourceSchemaRef: "rpc-control-schema", receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
                receiverSchemaRef: "rpc-receiver-schema", clockPolicyRef: expiryClock.policyRef,
                purpose: request.purpose, validUntil: now + 180_000 };
            } },
          } },
        };
      },
      observe: () => { callOrder.push("facade-published"); },
    };
    const configured = host.module.create({ verifySchema: async () => {}, financialSourceOrigin });
    const endpoint = new configured.Entry({}, rpcEnv);
    const source = await configured.worker.resolvePrivateFinancialSource(rpcEnv);
    expect(callOrder).toEqual(["inputs", "facade-published"]);
    const prepared = await source.prepareFinancialIdentityProofSource({ accessToken: token, challengeRef: challenge.challengeRef });
    expect(prepared.kind).toBe("fresh");
    await owner.upsertWorkspaceMember({ workspaceId: workspace.id, accountId: subject, actorAccountId: subject,
      roles: ["owner", "admin"], status: "active", requireCurrentMembership: true });
    const controlOriginal = await source.control.prepareInitialFinancialControlSourceOriginal({ workspaceId: challenge.workspaceId });
    admittedOriginals.add(canonicalFinancialSourceJson(controlOriginal.original.materialization));
    expect((await source.control.flush({ workspaceId: challenge.workspaceId, afterSequence: 0, limit: 4 })).processed).toBe(1);
    const refreshed = await source.prepareFinancialIdentityProofSource({ accessToken: token, challengeRef: challenge.challengeRef });
    for (const original of Object.values(refreshed.parents)) admittedOriginals.add(canonicalFinancialSourceJson(original.materialization));
    expect((await source.flush({ limit: 4 })).processed).toBe(4);
    expect(deliveries).toBe(5);
    clockNow = now + 5;

    const proof = await endpoint.prove({ accessToken: token, challengeRef: challenge.challengeRef });
    expect(proof.proofRef).toStartWith("afp_");
    const loaded = await endpoint.loadFinancialIdentityProof({ v: 1, proofRef: proof.proofRef, challengeRef: challenge.challengeRef });
    expect(loaded.status).toBe("found");
    if (loaded.status === "found") expect(loaded.proof.proofRef).toBe(proof.proofRef);
    const current = await endpoint.verifyCurrentFinancialIdentityProof({ v: 1, proofRef: proof.proofRef, challengeRef: challenge.challengeRef });
    expect(current.status).toBe("current");
    if (current.status === "current") expect(current.proof.challenge.challengeRef).toBe(challenge.challengeRef);
    expect(callOrder).toEqual(["inputs", "facade-published"]);
    expect(deliveries).toBe(5);
    expect(await seed.findFinancialSourceProof(proof.proofRef)).toBeDefined();
    expect(await financialSourceEventDigest(refreshed.parents.grant.materialization.event)).toBe(refreshed.parents.grant.materialization.eventDigest);
  } finally {
    await host.close();
  }
});
