/** Synthetic identity/context data and owner ACKs for portable tests only. */
import { PGlite } from "@electric-sql/pglite";
import {
  InMemoryAccountsStore,
  type AccountsStore,
  type AccountSessionRecord,
} from "../../../../accounts/service/src/store.ts";
import {
  D1AccountsStore,
  type D1Database,
} from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../../accounts/service/src/d1-migrations.ts";
import {
  createIdentityMerge,
  proveIdentityMerge,
  type IdentityMergeReconciler,
} from "../../../../accounts/service/src/identity-merge.ts";
import {
  prepareIdentityMergeContextPlan,
  acceptIdentityMergeContextPlan,
} from "../../../../accounts/service/src/identity-context.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import type {
  IdentityMergeOperation,
  IdentityOperationReceiptRecord,
} from "../../../../accounts/service/src/identity-state.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import type { ControlIdentityContextPlan } from "../../../../contract/identity-reconciliation.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../../contract/identity-reconciliation.ts";
import { reviewIssuerAvailabilityFixture } from "./review-issuer-availability-fixture.ts";
export const contextA = "tsub_context_A",
  contextB = "tsub_context_B";
export const contextNow = Date.now();
const baseline = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.context_protected_refs(subject text REFERENCES accounts_v1.accounts(subject),workspace_id text,org_id text,balance bigint,pending_original_key text);`;
export async function identityContextFixture(
  kind: "memory" | "d1" | "postgres" | "native-d1" = "memory",
) {
  let store: AccountsStore,
    pg: PGlite | undefined,
    close = async () => {};
  if (kind === "memory") store = new InMemoryAccountsStore();
  else if (kind === "d1")
    store = new D1AccountsStore(new SqliteFakeD1() as unknown as D1Database);
  else if (kind === "native-d1") {
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('fixture');}}",
      compatibilityDate: "2026-07-01",
      d1Databases: { ACCOUNTS: "identity-context-fixture" },
    });
    close = async () => {
      await mf.dispose();
    };
    const db = await mf.getD1Database("ACCOUNTS");
    for (const migration of (await loadD1AccountsMigrationCatalog()).migrations)
      await applyD1AccountsMigrationBatch(db, migration, contextNow);
    store = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed",
    });
  } else {
    pg = new PGlite();
    close = async () => {
      await pg!.close();
    };
    await pg.exec(baseline);
    await pg.exec(
      await Bun.file(
        new URL(
          "../../../../accounts/service/migrations/045_hosted_canonical_identity.sql",
          import.meta.url,
        ),
      ).text(),
    );
    store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({
        rows: (await pg!.query(sql, [...args])).rows as T[],
      }),
    });
  }
  for (const subject of [contextA, contextB]) {
    const providerId = subject === contextA ? "google" : "github";
    const identity = {
      providerId,
      upstreamIssuer:
        providerId === "google"
          ? "https://accounts.google.com"
          : "https://github.com",
      upstreamSubject: providerId === "google" ? "context-google-A" : "4711",
    };
    await store.saveAccount({
      subject,
      email: "Owner@example.test",
      emailVerified: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.linkUpstreamIdentity({
      ...identity,
      subject,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveAccountEmailProof!({
      ...identity,
      subject,
      address: "Owner@example.test",
      normalizedAddress: "Owner@example.test",
      verification: "provider",
      authoritative: true,
      observedAt: contextNow,
      validUntil: contextNow + 300000,
    });
  }
  if (pg)
    await pg.query(
      "INSERT INTO accounts_v1.context_protected_refs VALUES($1,'workspace_B','org_B',123456,'pending-original-B')",
      [contextB],
    );
  let session: AccountSessionRecord;
  async function login(subject: string) {
    const result = await rotateAccountSession({
      store,
      subject,
      oldSessionId: session?.sessionId,
      now: contextNow,
      ttlMs: 60000,
      hostedPolicy: true,
    });
    session = (await store.findAccountSession(result.sessionId))!;
    return session;
  }
  const browserBindingHash = await sha256Text(
    "merge-browser:" + "a".repeat(64),
  );
  await login(contextB);
  let operation = await createIdentityMerge({
    store,
    actor: contextB,
    sourceSubject: contextB,
    targetSubject: contextA,
    browserBindingHash,
    now: contextNow,
  });
  async function prove(role: "source" | "target") {
    const subject = role === "source" ? contextB : contextA;
    const providerId = role === "source" ? "github" : "google";
    const receipt: IdentityOperationReceiptRecord = {
      receiptId: `ircp_${crypto.randomUUID()}`,
      operationId: operation.operationId,
      role,
      subject,
      sourceSubject: contextB,
      targetSubject: contextA,
      providerId,
      upstreamIssuer:
        providerId === "google"
          ? "https://accounts.google.com"
          : "https://github.com",
      upstreamSubject: providerId === "google" ? "context-google-A" : "4711",
      browserBindingHash,
      policyVersion: operation.policyVersion,
      identityGeneration: 0,
      transactionDigest: await sha256Text(crypto.randomUUID()),
      startedAt: contextNow,
      completedAt: contextNow,
      expiresAt: contextNow + 300000,
      emailDigest: operation.addressDigest,
      legConsent: true,
      legConsentAt: contextNow,
      method: "upstream-oauth-operation",
      issuerSessionHash: session.issuerSessionId!,
    };
    await store.createIdentityOperationReceipt!(receipt);
    operation = await proveIdentityMerge({
      store,
      operation,
      session,
      receiptId: receipt.receiptId,
      now: contextNow,
    });
    return operation;
  }
  await prove("source");
  await login(contextA);
  await prove("target");
  return {
    store,
    pg,
    operation,
    browserBindingHash,
    now: contextNow,
    session: () => session,
    login,
    close,
  };
}

/** Unit test fixture only; integration tests use the real Core service. */
export function isolatedContextReconciler(
  store: AccountsStore,
  now: number | (() => number),
): IdentityMergeReconciler {
  const clock = typeof now === "function" ? now : () => now;
  async function availabilityFixture() {
    const target = { ownerKind: "hosted-intents" as const, ownerClientId: "isolated-context-fixture",
      targetBindingDigest: await sha256Text("isolated-context-fixture-target") };
    return { target, ...await reviewIssuerAvailabilityFixture({ target, now: clock }) };
  }
  let availability: ReturnType<typeof availabilityFixture> | undefined;
  return {
    reconcile: async () => undefined,
    async assertReady(op) {
      // This isolated fixture uses actual ephemeral ES256 verification. It is
      // never a real owner/review-issuer qualification or affirmative boolean.
      const { target, reader } = await (availability ??= availabilityFixture());
      const availabilityCheckpoint = await reader.getAvailabilityCheckpoint({ operationId: op.operationId,
        kind: "merge", planDigest: op.contextPlan!.planDigest });
      if (!availabilityCheckpoint) throw new Error("isolated_issuer_unavailable");
      return { target, availabilityCheckpoint };
    },
    async prepareContextPlan(op): Promise<ControlIdentityContextPlan> {
      const contexts = [
        {
          workspaceId: "workspace_A",
          workspaceRef: "workspace_ref_A",
          billingAuthority: "fixture-financial",
          organizationRef: "org_A",
          originalOwnerAccountId: op.targetSubject,
          canonicalAccountId: op.targetSubject,
          roles: ["owner"],
          disposition: "retain-personal-anchor" as const,
        },
        {
          workspaceId: "workspace_B",
          workspaceRef: "workspace_ref_B",
          billingAuthority: "fixture-financial",
          organizationRef: "org_B",
          originalOwnerAccountId: op.sourceSubject,
          canonicalAccountId: op.targetSubject,
          roles: ["owner"],
          disposition: "insert-additional-membership" as const,
        },
      ];
      return {
        planId: `icpl_${crypto.randomUUID()}`,
        operationId: op.operationId,
        authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION,
        planningRevision: op.revision,
        sourceAccountId: op.sourceSubject,
        targetAccountId: op.targetSubject,
        proofBindingDigest: await sha256Text(
          JSON.stringify([
            op.sourceProof,
            op.targetProof,
            op.browserBindingHash,
            op.policyVersion,
          ]),
        ),
        inventoryDigest: await sha256Text(JSON.stringify(contexts)),
        supportedInventory: "two-disjoint-personal-contexts/v1",
        personalWorkspaceId: "workspace_A",
        contexts,
        createdAt: new Date(clock()).toISOString(),
        digest: await sha256Text(`fixture-context-plan:${op.operationId}`),
      };
    },
    async assertContextPlanCurrent(op) {
      const plan = await store.findIdentityMergeContextPlan?.(
        op.contextPlan!.planId,
      );
      if (!plan) throw new Error("fixture plan missing");
      return plan.controlPlan;
    },
  };
}
export async function acceptIsolatedIdentityContexts(
  store: AccountsStore,
  operation: IdentityMergeOperation,
  now: number,
): Promise<IdentityMergeOperation> {
  const reconciler = isolatedContextReconciler(store, now);
  let op = (
    await prepareIdentityMergeContextPlan({ store, operation, reconciler, now })
  ).operation;
  for (const subject of [operation.sourceSubject, operation.targetSubject]) {
    // Preserve already issued unit-test sessions; mint an explicit current leg
    // when the fixture did not retain one. This helper is never production code.
    const rotated = await rotateAccountSession({
      store,
      subject,
      now,
      ttlMs: 60000,
      hostedPolicy: true,
    });
    const session = (await store.findAccountSession(rotated.sessionId))!;
    op = await acceptIdentityMergeContextPlan({
      store,
      operation: op,
      session,
      browserBindingHash: operation.browserBindingHash,
      planDigest: op.contextPlan!.planDigest,
      consent: true,
      now,
    });
  }
  return op;
}
