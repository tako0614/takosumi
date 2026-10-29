import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema, verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../../worker/src/bindings.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { workerdD1Database, workerdD1Module } from "../../../helpers/deploy-control/workerd_d1.ts";

const authority = "billing-owner-fixture";
const account = "canonical_actor";

async function adapters() {
  const postgres = await PGliteSqlClient.create();
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17", modules: [workerdD1Module("workspace-billing-binding-native.mjs")],
    d1Databases: { CONTROL: "workspace-billing-binding-native" },
  });
  const native = workerdD1Database(runtime);
  const memory = new InMemoryOpenTofuControlStore();
  const rows: readonly {label: string; first: OpenTofuControlStore; second: OpenTofuControlStore}[] = [
    { label: "memory", first: memory, second: memory },
    { label: "postgres", first: new SqlOpenTofuControlStore({client:postgres}), second: new SqlOpenTofuControlStore({client:postgres}) },
    { label: "d1-workerd", first: new CloudflareD1OpenTofuControlStore(native), second: new CloudflareD1OpenTofuControlStore(native) },
  ];
  return { rows, native, postgres, close: async () => { await runtime.dispose(); await postgres.close(); } };
}

function service(store: OpenTofuControlStore, prefix: string) {
  let id = 0;
  return new WorkspacesService({store,newId:(kind)=>`${kind}_${prefix}_${++id}`,now:()=>new Date("2026-10-15T00:00:00.000Z")});
}

async function alterMember(store: OpenTofuControlStore, workspace: Workspace, patch: Partial<WorkspaceMember>) {
  const member = await store.getWorkspaceMember(workspace.id, account);
  await store.putWorkspaceMember({...member!,...patch});
}

test("concurrent actual Control prepare/claim selects one immutable Workspace/Org winner across memory/Postgres/native D1", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const first = service(adapter.first, `${adapter.label}_first`);
      const second = service(adapter.second, `${adapter.label}_second`);
      const workspace = await first.ensurePersonalWorkspaceForSharedAccount(account, `binding-${adapter.label}`);
      await adapter.second.listWorkspaces();
      const request = {workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account};
      const intents = await Promise.all([
        first.billingBindings.prepare(request), second.billingBindings.prepare(request),
        first.billingBindings.prepare(request), second.billingBindings.prepare(request),
      ]);
      expect(new Set(intents.map((row)=>row.intentId)).size,adapter.label).toBe(1);
      expect(new Set(intents.map((row)=>row.workspaceRef)).size,adapter.label).toBe(1);
      const intent = intents[0]!;
      expect(Object.keys(intent).sort(),adapter.label).toEqual(["actorAccountId","billingAuthority","createdAt","intentId","managementEpoch","workspaceCreatedAt","workspaceId","workspaceRef"]);
      const ack = {workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:account,organizationRef:"org_retained",ownerAcknowledgementRef:"ack_retained"};
      const bindings = await Promise.all([first.billingBindings.claim(ack),second.billingBindings.claim(ack),first.billingBindings.claim(ack)]);
      expect(bindings,adapter.label).toEqual([bindings[0],bindings[0],bindings[0]]);
      expect(await second.billingBindings.get(workspace.id),adapter.label).toEqual({intent,binding:bindings[0]});
      await expect(second.billingBindings.prepare({...request,billingAuthority:"different-owner"})).rejects.toMatchObject({code:"failed_precondition"});
      await expect(second.billingBindings.claim({...ack,organizationRef:"different-org"})).rejects.toMatchObject({code:"failed_precondition"});
      await expect(second.billingBindings.claim({...ack,ownerAcknowledgementRef:"different-ack"})).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toEqual(bindings[0]);
      const stored = await adapter.first.getWorkspaceBillingBindingIntent(workspace.id);
      const tampered = await adapter.second.prepareWorkspaceBillingBinding({...stored!,workspaceRef:"wrk_tampered_same_intent"});
      expect(tampered.status,adapter.label).toBe("conflict");
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toEqual(stored);
    }
  } finally { await f.close(); }
},30_000);

test("revoked prepared membership cannot enter the actual first-set boundary after an earlier role precheck", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const owner = service(adapter.first,`${adapter.label}_prepare_race`);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,`prepare-race-${adapter.label}`);
      const prepare = adapter.first.prepareWorkspaceBillingBinding.bind(adapter.first);
      adapter.first.prepareWorkspaceBillingBinding = async (intent) => {
        await alterMember(adapter.second,workspace,{status:"suspended"});
        return await prepare(intent);
      };
      await expect(owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account})).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toBeUndefined();
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
    }
  } finally { await f.close(); }
},30_000);

test("unknown external ACK remains a durable original intent/ref across service restart without binding or a second Org identity", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const first = service(adapter.first,`${adapter.label}_unknown`);
      const workspace = await first.ensurePersonalWorkspaceForSharedAccount(account,`unknown-${adapter.label}`);
      const request = {workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account};
      const before = await first.billingBindings.prepare(request);
      // The owner operation was sent with before.intentId/workspaceRef; its
      // timeout creates no local success and no fresh identity on retry.
      const restarted = service(adapter.second,`${adapter.label}_restart`);
      expect(await restarted.billingBindings.get(workspace.id),adapter.label).toEqual({intent:before});
      expect(await restarted.billingBindings.prepare(request),adapter.label).toEqual(before);
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
      const binding = await restarted.billingBindings.claim({workspaceId:workspace.id,intentId:before.intentId,actorAccountId:account,organizationRef:"org_acked",ownerAcknowledgementRef:"owner_receipt"});
      expect(binding.workspaceRef,adapter.label).toBe(before.workspaceRef);
      expect(binding.intentId,adapter.label).toBe(before.intentId);
    }
  } finally { await f.close(); }
},30_000);

test("enrollment never trusts namespace owner field, caller Org, viewer, or a different original actor", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const owner = service(adapter.first,`${adapter.label}_roles`);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,`roles-${adapter.label}`);
      const request = {workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account};
      await alterMember(adapter.first,workspace,{status:"suspended"});
      await expect(owner.billingBindings.prepare(request)).rejects.toMatchObject({code:"permission_denied"});
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toBeUndefined();
      await alterMember(adapter.first,workspace,{status:"active",roles:["viewer"]});
      await expect(owner.billingBindings.prepare(request)).rejects.toMatchObject({code:"permission_denied"});
      await alterMember(adapter.first,workspace,{roles:["admin"]});
      const intent = await owner.billingBindings.prepare(request);
      await expect(owner.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:"forged-account",organizationRef:"forged-org",ownerAcknowledgementRef:"forged-ack"})).rejects.toMatchObject({code:"permission_denied"});
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
    }
  } finally { await f.close(); }
},30_000);

test("membership revocation during external ACK and immediately before actual claim commit refuses activation while retaining pending intent", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const owner = service(adapter.first,`${adapter.label}_revocation`);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,`revocation-${adapter.label}`);
      const intent = await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account});
      const original = await adapter.first.getWorkspaceBillingBindingIntent(workspace.id);
      // Simulate an ACK await: the domain keeps the exact stored snapshots.
      await alterMember(adapter.first,workspace,{status:"suspended"});
      const ack = {workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:account,organizationRef:"org_external_retained",ownerAcknowledgementRef:"ack_after_revocation"};
      await expect(owner.billingBindings.claim(ack)).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toEqual(original);
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
      await alterMember(adapter.first,workspace,{status:"active"});
      // The last pre-I/O snapshot still cannot authorize a revoked row at the
      // actual Control primitive, even if the caller's precheck succeeded.
      const claim = adapter.first.claimWorkspaceBillingBinding.bind(adapter.first);
      adapter.first.claimWorkspaceBillingBinding = async (input) => {
        await alterMember(adapter.second,workspace,{status:"suspended"});
        return await claim(input);
      };
      await expect(owner.billingBindings.claim(ack)).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
    }
  } finally { await f.close(); }
},30_000);

test("original management epoch and full Workspace snapshot are held across ACK, archival and UID reuse", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const owner = service(adapter.first,`${adapter.label}_epochs`);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,`epochs-${adapter.label}`);
      const intent = await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account});
      const ack = {workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:account,organizationRef:"org_before_drain",ownerAcknowledgementRef:"ack_before_drain"};
      await adapter.first.beginWorkspaceDraining(workspace.id,{workspaceId:workspace.id,managementState:"active",managementEpoch:intent.managementEpoch});
      await expect(owner.billingBindings.claim(ack)).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toBeUndefined();
      const retained = await adapter.first.getWorkspaceBillingBindingIntent(workspace.id);
      await adapter.first.deleteWorkspace(workspace.id);
      await adapter.first.putWorkspace({...workspace,createdAt:"2026-10-16T00:00:00.000Z",updatedAt:"2026-10-16T00:00:00.000Z"});
      await expect(owner.billingBindings.get(workspace.id)).rejects.toMatchObject({code:"failed_precondition"});
      await expect(owner.billingBindings.claim(ack)).rejects.toMatchObject({code:"failed_precondition"});
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toEqual(retained);
    }
  } finally { await f.close(); }
},30_000);

test("archive/delete/current membership changes preserve historical binding, org, money and resource references without cascade", async () => {
  const f = await adapters();
  try {
    for (const adapter of f.rows) {
      const owner = service(adapter.first,`${adapter.label}_retention`);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,`retention-${adapter.label}`);
      const intent = await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account});
      const binding = await owner.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:account,organizationRef:"org_with_money_resources",ownerAcknowledgementRef:"existing_owner_receipt"});
      const before = await adapter.first.getWorkspaceBillingBindingIntent(workspace.id);
      // Synthetic external owner state is represented only by immutable opaque
      // refs; the Control source never reads or rewrites its ledger/resources.
      await owner.updateWorkspace(workspace.id,{archived:true});
      expect((await owner.billingBindings.get(workspace.id)).binding,adapter.label).toEqual(binding);
      await alterMember(adapter.first,workspace,{status:"suspended"});
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toEqual(binding);
      await adapter.first.deleteWorkspace(workspace.id);
      expect(await adapter.first.getWorkspaceBillingBindingIntent(workspace.id),adapter.label).toEqual(before);
      expect(await adapter.first.getWorkspaceBillingBinding(workspace.id),adapter.label).toEqual(binding);
      expect(binding.organizationRef,adapter.label).toBe("org_with_money_resources");
    }
    const foreignKeys = await f.native.prepare("pragma foreign_key_list(workspace_billing_bindings)").all();
    expect(foreignKeys.results).toEqual([]);
    const pgForeignKeys = await f.postgres.rawQuery("select conname from pg_constraint where conrelid in ('takosumi_workspace_billing_intents'::regclass,'takosumi_workspace_billing_bindings'::regclass) and contype='f'");
    expect(pgForeignKeys.rows).toEqual([]);
  } finally { await f.close(); }
},30_000);

test("ordinary predeployed runtime bridges exact v71/v72 without DDL while binding capability and staging qualification require v72", async () => {
  const runtime = new Miniflare({compatibilityDate:"2026-07-17",modules:[workerdD1Module("workspace-billing-bridge-native.mjs")],d1Databases:{CONTROL:"workspace-billing-bridge-native"}});
  try {
    const native = workerdD1Database(runtime);
    await ensureD1OpenTofuLedgerSchema(native,{throughMigrationVersion:71});
    const originalLedger = await native.prepare("select version,name,checksum,applied_at from schema_migrations order by version").all();
    const originalManaged = await native.prepare(`select type,name,sql from sqlite_master where name='_cf_METADATA'`).all();
    const fence = await acquireControlD1MaintenanceFence(native,{
      sourceCommit:"a".repeat(40),manifestDigest:`sha256:${"b".repeat(64)}`,environment:"test",databaseRole:"in_place",releasePolicy:"in_place",
    },"2026-10-15T00:00:00.000Z");
    await releaseControlD1MaintenanceFence(native,fence,"2026-10-15T00:01:00.000Z");
    expect((await native.prepare(`select type,name,sql from sqlite_master where name='_cf_METADATA'`).all()).results).toEqual(originalManaged.results);
    expect((await native.prepare(`select name from sqlite_master where type='trigger' and tbl_name='_cf_METADATA'`).all()).results).toEqual([]);
    const queries: string[] = [];
    const tracked: D1Database = {prepare(query) { queries.push(query); return native.prepare(query); },batch: native.batch};
    const store = new CloudflareD1OpenTofuControlStore(tracked,{schemaMode:"predeployed"});
    const ordinary = service(store,"bridge71");
    const workspace = await ordinary.createWorkspace({handle:"profile-off-bridge",displayName:"Bridge",type:"personal",ownerUserId:account});
    expect(await ordinary.getWorkspace(workspace.id)).toEqual(workspace);
    const updated = await ordinary.updateWorkspace(workspace.id,{displayName:"Ordinary v71 still works"});
    expect((await ordinary.getWorkspace(workspace.id)).displayName).toBe(updated.displayName);
    await expect(verifyD1OpenTofuLedgerSchemaPredeployed(tracked)).rejects.toThrow("verification failed");
    await expect(ordinary.billingBindings.get(workspace.id)).rejects.toThrow("verification failed");
    expect(queries.some((query)=>/^\s*(CREATE|ALTER|DROP)\b/i.test(query))).toBe(false);
    expect((await native.prepare(`select type,name,sql from sqlite_master where name='_cf_METADATA'`).all()).results).toEqual(originalManaged.results);
    expect(queries.some((query)=>/from ["`]?workspace_billing_(bindings|intents)/i.test(query))).toBe(false);
    const tables = await native.prepare("select name from sqlite_master where name in ('workspace_billing_intents','workspace_billing_bindings')").all();
    expect(tables.results).toEqual([]);
    // Exact operator-side additive migration on this isolated fixture; the
    // runtime neither constructs tables nor weakens staging qualification.
    await ensureD1OpenTofuLedgerSchema(native);
    expect((await native.prepare("select version,name,checksum,applied_at from schema_migrations where version <= 71 order by version").all()).results).toEqual(originalLedger.results);
    await verifyD1OpenTofuLedgerSchemaPredeployed(tracked);
    const intent = await ordinary.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:authority,actorAccountId:account});
    const binding = await ordinary.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:account,organizationRef:"org_bridge72",ownerAcknowledgementRef:"ack_bridge72"});
    expect((await ordinary.billingBindings.get(workspace.id)).binding).toEqual(binding);
    expect(queries.some((query)=>/^\s*(CREATE|ALTER|DROP)\b/i.test(query))).toBe(false);
  } finally { await runtime.dispose(); }
},30_000);

test("Postgres v119 expands protected-shaped v118 rows without rewriting Workspace/member or previous migration SQL", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(118);
  try {
    const store = new SqlOpenTofuControlStore({client});
    const owner = service(store,"pg118_preserved");
    const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(account,"retained-v118-personal");
    const originalMember = await store.getWorkspaceMember(workspace.id,account);
    const migration = postgresStorageMigrationStatements.find((row)=>row.version===119);
    expect(migration?.id).toBe("deploy.workspace_billing_bindings.create");
    expect(migration?.sql).not.toMatch(/\b(drop|truncate|update|delete|references|cascade)\b/i);
    for (const statement of splitSqlStatements(migration!.sql)) await client.exec(statement);
    expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await store.getWorkspaceMember(workspace.id,account)).toEqual(originalMember);
    expect(await store.getWorkspaceBillingBindingIntent(workspace.id)).toBeUndefined();
    expect(await store.getWorkspaceBillingBinding(workspace.id)).toBeUndefined();
    expect(postgresStorageMigrationStatements.filter((row)=>row.version>118).map((row)=>row.version)).toEqual([119,120,121,122,123,124]);
  } finally { await client.close(); }
},30_000);
