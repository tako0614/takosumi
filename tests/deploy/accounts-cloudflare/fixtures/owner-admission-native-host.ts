import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { D1AccountsStore } from "../../../../accounts/service/src/d1-store.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import type { D1Database } from "../../../../worker/src/bindings.ts";
import type { OwnerOperationAdmission } from "../../../../accounts/service/src/owner-operation-contract.ts";
import { AUTH_STAGING_COMPATIBILITY_DATE, AUTH_STAGING_ISSUER } from "../../../../deploy/accounts-cloudflare/src/staging-target.ts";

/** Miniflare's documented test host is Node. Bun maps require('undici').fetch
 * to a native bridge and two preserved runs reset the platform-proxy socket
 * before a POST response. Keep the same requests/assertions in Node; no retry,
 * fetch replacement, future flag or production request guard is involved. */
const input = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const { bindings, fixture, issuerSource, ownerSource, salt, serviceId, targetDigest } = input;
let assertions = 0;
function equal(actual: unknown, expected: unknown) { assertions++; assert.deepStrictEqual(actual, expected); }
const runtime = new Miniflare({ workers: [
  { name: "issuer", modules: true, script: issuerSource, compatibilityDate: AUTH_STAGING_COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], bindings,
    d1Databases: { TAKOSUMI_ACCOUNTS_DB: "owner-admission-accounts", TAKOSUMI_CONTROL_DB: "owner-admission-control" } },
  { name: "owner", modules: true, script: ownerSource, compatibilityDate: AUTH_STAGING_COMPATIBILITY_DATE,
    serviceBindings: { PRIVATE_ACCOUNTS: { name: "issuer", entrypoint: "AccountsOwnerAdmission" } } },
] });
try {
  const operation = fixture.operation;
  const request = { operationId: operation.operationId, kind: "merge", planDigest: operation.contextPlan.planDigest, purpose: "readiness" };
  const owner = await runtime.getWorker("owner") as unknown as { readOwnerOperation(input: unknown): Promise<OwnerOperationAdmission | undefined>; fetch: (url: string, init?: RequestInit) => Promise<Response> };
  const accounts = await runtime.getD1Database("TAKOSUMI_ACCOUNTS_DB", "issuer");
  const control = await runtime.getD1Database("TAKOSUMI_CONTROL_DB", "issuer");
  equal(await owner.readOwnerOperation(request), undefined);
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations.filter((item) => item.version <= 4)) await applyD1AccountsMigrationBatch(accounts, migration, fixture.now);
  equal(await owner.readOwnerOperation(request), undefined);
  for (const migration of catalog.migrations.filter((item) => item.version > 4)) await applyD1AccountsMigrationBatch(accounts, migration, fixture.now);
  const store = new D1AccountsStore(accounts as unknown as D1Database, { schemaMode: "predeployed", sessionHashSalt: salt });
  for (const record of fixture.accounts) await store.saveAccount(record);
  for (const record of fixture.emailProofs) await store.saveAccountEmailProof!(record);
  for (const record of fixture.identities) await store.linkUpstreamIdentity(record);
  equal(await store.createIdentityMergeOperation!(operation), true);
  equal(await store.createIdentityMergeContextPlan!(fixture.contextPlan), true);
  for (const record of fixture.operationReceipts) equal(await store.createIdentityOperationReceipt!(record), true);
  for (const record of fixture.contextReceipts) equal(await store.createIdentityMergeContextReceipt!(record), true);
  const snapshot = async () => (await accounts.prepare("SELECT bucket,key,document,updated_at FROM takosumi_accounts_documents ORDER BY bucket,key").all()).results;
  const before = await snapshot();
  equal(await owner.readOwnerOperation(request), undefined);
  // The complete predecessor is valid for generic identity operations but is
  // not the dedicated issuer's current schema. These are readiness SQL reads;
  // they must not mutate account/fence or Control reconciliation records.
  await ensureD1OpenTofuLedgerSchema(control as unknown as D1Database, { throughMigrationVersion: 73 });
  equal((await control.prepare("SELECT max(version) as head FROM schema_migrations").first<{ head: number }>())?.head, 73);
  const identityEffects = async () => (await control.prepare(`SELECT
    (SELECT count(*) FROM identity_reconciliation_operations) as operations,
    (SELECT count(*) FROM identity_reconciliation_events) as events`).first());
  const beforeIdentityEffects = await identityEffects();
  equal(await owner.readOwnerOperation(request), undefined);
  equal(await snapshot(), before);
  equal(await identityEffects(), beforeIdentityEffects);
  await ensureD1OpenTofuLedgerSchema(control as unknown as D1Database);
  const admission = await owner.readOwnerOperation(request);
  equal(admission?.admission, "fresh"); equal(admission?.target, { ownerKind: "hosted-intents", ownerClientId: serviceId, targetBindingDigest: targetDigest });
  equal(admission?.context.sourceAccountId, operation.sourceSubject);
  for (const patch of [{ subject: operation.targetSubject }, { authorization: "Bearer fixture" }, { props: { owner: "hosted-intents" } }, { target: admission?.target }, { sourceWorker: "owner" }]) equal(await owner.readOwnerOperation({ ...request, ...patch }), undefined);
  equal(await owner.readOwnerOperation({ ...request, purpose: "release" }), undefined);
  equal(await owner.readOwnerOperation({ ...request, purpose: "reconcile" }), undefined);
  equal(await owner.readOwnerOperation({ ...request, planDigest: "wrong-plan" }), undefined);
  const issuer = await runtime.getWorker("issuer");
  for (const headers of [{ authorization: "Basic Zm9yZ2VkOm93bmVy" }, { authorization: "Bearer fixture-human" }, { cookie: "takosumi_session=fixture-human" }, { "x-owner-client-id": serviceId, "x-takosumi-platform-subject": operation.targetSubject }]) {
    for (const base of [AUTH_STAGING_ISSUER, "https://issuer.example.workers.dev", "https://preview-issuer.example.workers.dev"]) {
      const response = await issuer.fetch(base + "/readOwnerOperation", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(request) });
      equal(response.status, 404); await response.arrayBuffer();
    }
    const response = await owner.fetch("https://owner.example.test/readOwnerOperation", { method: "POST", headers, body: JSON.stringify(request) });
    equal(response.status, 404); await response.arrayBuffer();
  }
  equal(await snapshot(), before);
  const row = await control.prepare("SELECT * FROM schema_migrations WHERE version = 73").first<Record<string, unknown>>();
  assertions++; assert.notEqual(row, null);
  await control.prepare("DELETE FROM schema_migrations WHERE version = 73").run();
  equal(await owner.readOwnerOperation(request), undefined);
  const columns = Object.keys(row!);
  await control.prepare(`INSERT INTO schema_migrations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((name) => row![name])).run();
  equal((await owner.readOwnerOperation(request))?.admission, "fresh");
  await acquireControlD1MaintenanceFence(control as unknown as D1Database, { sourceCommit: "f".repeat(40), manifestDigest: "sha256:" + "f".repeat(64), environment: "staging", databaseRole: "in_place", releasePolicy: "in_place" }, new Date().toISOString());
  equal(await owner.readOwnerOperation(request), undefined);
  equal(await snapshot(), before);
} finally { await runtime.dispose(); }
console.log(JSON.stringify({ host: "node", assertions, disposed: true }));
