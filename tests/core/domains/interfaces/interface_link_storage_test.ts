import { expect, test } from "bun:test";
import type { D1PreparedStatement, D1Result } from "../../../../worker/src/bindings.ts";
import type { WorkspaceManagementAuthority } from "../../../../core/domains/deploy-control/store.ts";
import { TAKOSUMI_API_VERSION } from "takosumi-contract";
import type { Interface, InterfaceBinding, InterfaceLink } from "takosumi-contract/interfaces";
import { createD1InterfaceStores, createInMemoryInterfaceStores, createSqlInterfaceStores, InterfaceService, type InterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const key = { consumerCapsuleId: "consumer", requirementKey: "storage" };

function link(overrides: Partial<InterfaceLink> = {}): InterfaceLink {
  return {
    id: "link_first", generation: 1, ...key,
    interface: { type: "example.storage", version: "1" },
    requestedPermissions: ["storage.read", "storage.write"], approvedPermissions: [],
    deliveryType: "oauth2", providerInterfaceId: "interface_provider", providerCapsuleId: "provider",
    state: "pending_approval", selection: "explicit", requestedBy: "requester", createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function active(record: InterfaceLink): InterfaceLink {
  return { ...record, state: "active", generation: record.generation + 1,
    approvedPermissions: ["storage.read"], approval: { kind: "provider_approved", approvedBy: "provider-owner", approvedAt: NOW } };
}

function revoke(record: InterfaceLink): InterfaceLink {
  return { ...record, state: "revoked", generation: record.generation + 1,
    revoked: { revokedBy: "provider-owner", revokedAt: NOW, reason: "test" } };
}

// D1 serializes batches on one database. The local SQLite harness exposes
// its raw transaction, so queue concurrent test requests at that same boundary.
// This exercises competing API calls; it is not a remote D1 timing test.
class SerializedTestD1 extends SqliteFakeD1 {
  #tail: Promise<unknown> = Promise.resolve();
  override batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const next = this.#tail.then(() => super.batch<T>(statements));
    this.#tail = next.catch(() => {});
    return next;
  }
}

const backends: readonly {
  readonly label: string;
  setup(): Promise<{ readonly stores: InterfaceStores; readonly close: () => Promise<void>;
    readonly setManagement: (state: "active" | "frozen", epoch: number) => Promise<void> }>;

}[] = [
  { label: "memory", setup: async () => {
    let management = { state: "active", epoch: 1 };
    return { stores: createInMemoryInterfaceStores({ workspaceManagementAuthority: {
      isWorkspaceManagementAdmissionAllowed(workspaceId, expected) {
        return workspaceId === "workspace" && management.state === "active" && (!expected || expected.managementEpoch === management.epoch);
      },
    } }), close: async () => {}, setManagement: async (state, epoch) => { management = { state, epoch }; } };
  } },
  { label: "D1", setup: async () => {
    const db = new SerializedTestD1(); await ensureD1OpenTofuLedgerSchema(db);
    await db.prepare("insert into workspaces(id,handle,record_json,created_at,updated_at) values('workspace','workspace','{}','','')").run();
    return { stores: createD1InterfaceStores(db), close: async () => {}, setManagement: async (state, epoch) => {
      await db.prepare("update workspaces set management_state=?, management_epoch=? where id='workspace'").bind(state, epoch).run();
    } };
  } },
  { label: "Postgres", setup: async () => {
    const client = await PGliteSqlClient.create();
    await client.query("insert into takosumi_workspaces(id,handle,space_json,created_at,updated_at) values('workspace','workspace','{}','','')");
    return { stores: createSqlInterfaceStores(client), close: () => client.close(), setManagement: async (state, epoch) => {
      await client.query("update takosumi_workspaces set management_state=$1, management_epoch=$2 where id='workspace'", [state, epoch]);
    } };
  } },
];

for (const backend of backends) {
  test(`InterfaceLink CAS, current uniqueness and reverse lookup (${backend.label})`, async () => {
    const { stores, close } = await backend.setup();
    const links = stores.links;
    try {
      const initial = link();
      expect(await links.create(initial)).toBe(true);
      expect(await links.get(initial.id)).toEqual(initial);
      expect(await links.getCurrent(key)).toEqual(initial);
      expect(await links.getLatest(key)).toEqual(initial);
      expect(await links.create(link({ id: "same_key_racer" }))).toBe(false);
      expect(await links.create(link({ id: "bad_generation", requirementKey: "other", generation: 2 }))).toBe(false);
      const approved = active(initial);
      expect(await links.compareAndSet(approved, 1)).toBe(true);
      expect(await links.compareAndSet({ ...approved, approvedPermissions: ["storage.write"] }, 1)).toBe(false);
      expect(await links.compareAndSet({ ...approved, generation: 3, providerCapsuleId: "moved" }, 2)).toBe(false);
      expect(await links.compareAndSet({ ...approved, generation: 2, state: "revoked" }, 2)).toBe(false);
      expect(await links.listByConsumerCapsule("consumer")).toEqual([approved]);
      expect(await links.listByProviderInterface("interface_provider")).toEqual([approved]);
      expect(await links.listByProviderCapsule("provider")).toEqual([approved]);
      expect(await links.listByProviderCapsule("absent")).toEqual([]);
      const revoked = revoke(approved);
      expect(await links.compareAndSet(revoked, 2)).toBe(true);
      expect(await links.getCurrent(key)).toBeUndefined();
      expect(await links.getLatest(key)).toEqual(revoked);
      expect(await links.create(link({ id: "terminal_bypass" }))).toBe(false);
      expect(await links.compareAndSet({ ...approved, generation: 4 }, 3)).toBe(false);
    } finally { await close(); }
  });

  test(`InterfaceLink atomic replacement retains the prior winner on conflicts (${backend.label})`, async () => {
    const { stores, close } = await backend.setup();
    const links = stores.links;
    try {
      const initial = link();
      expect(await links.create(initial)).toBe(true);
      const old = active(initial);
      expect(await links.compareAndSet(old, 1)).toBe(true);
      const occupied = link({ id: "occupied", consumerCapsuleId: "other_consumer" });
      expect(await links.create(occupied)).toBe(true);
      const replacement = link({ id: "link_next", generation: old.generation + 2, providerInterfaceId: "interface_next", providerCapsuleId: "provider_next" });
      expect(await links.replace({ record: { ...replacement, id: occupied.id }, expected: old, revoked: revoke(old) })).toBe(false);
      expect(await links.getCurrent(key)).toEqual(old);
      expect(await links.get(old.id)).toEqual(old);
      expect(await links.replace({ record: replacement, expected: { ...old, requestedBy: "stale" }, revoked: revoke(old) })).toBe(false);
      expect(await links.replace({ record: { ...replacement, generation: 3 }, expected: old, revoked: revoke(old) })).toBe(false);
      expect(await links.replace({ record: replacement, expected: old, revoked: revoke(old) })).toBe(true);
      expect(await links.get(old.id)).toEqual(revoke(old));
      expect(await links.getCurrent(key)).toEqual(replacement);
      expect(await links.getLatest(key)).toEqual(replacement); // fixed timestamp and arbitrary ids cannot choose old history.
      expect(await links.replace({ record: { ...replacement, id: "racer" }, expected: old, revoked: revoke(old) })).toBe(false);
      const declined = { ...replacement, state: "declined" as const, generation: replacement.generation + 1 };
      expect(await links.compareAndSet(declined, replacement.generation)).toBe(true);
      const next = link({ id: "a_sorts_before_history", generation: declined.generation + 1 });
      expect(await links.replace({ record: next, expected: declined })).toBe(true);
      expect(await links.getLatest(key)).toEqual(next);
      expect(await links.replace({ record: { ...next, id: "stale_terminal" }, expected: declined })).toBe(false);
      expect(await links.getCurrent(key)).toEqual(next);
      expect(await links.listByProviderCapsule("provider_next")).toEqual([declined]);
    } finally { await close(); }
  });

  test(`InterfaceLink racing create and approval have one winner (${backend.label})`, async () => {
    const { stores, close } = await backend.setup();
    try {
      const contenders = [link({ id: "racer_a" }), link({ id: "racer_b" })];
      expect((await Promise.all(contenders.map((record) => stores.links.create(record)))).filter(Boolean)).toHaveLength(1);
      const winner = (await stores.links.getCurrent(key))!;
      const approvals = [active(winner), { ...active(winner), approvedPermissions: ["storage.write"] }];
      expect((await Promise.all(approvals.map((record) => stores.links.compareAndSet(record, 1)))).filter(Boolean)).toHaveLength(1);
      expect(approvals).toContainEqual(await stores.links.getCurrent(key));
      expect((await stores.links.listByConsumerCapsule("consumer"))).toHaveLength(1);
    } finally { await close(); }
  });

  test(`InterfaceLink concurrent replacements have one winner and no loser insert (${backend.label})`, async () => {
    const { stores, close } = await backend.setup();
    try {
      const initial = link();
      expect(await stores.links.create(initial)).toBe(true);
      const old = active(initial);
      expect(await stores.links.compareAndSet(old, 1)).toBe(true);
      const contenders = ["replacement_a", "replacement_b"].map((id) => ({
        ...old, id, generation: old.generation + 2, providerInterfaceId: id, providerCapsuleId: id,
      }));
      const outcomes = await Promise.all(contenders.map((record) => stores.links.replace({ record, expected: old, revoked: revoke(old) })));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const winner = contenders[outcomes.indexOf(true)]!, loser = contenders[outcomes.indexOf(false)]!;
      expect(await stores.links.getCurrent(key)).toEqual(winner);
      expect(await stores.links.get(loser.id)).toBeUndefined();
      expect(await stores.links.get(old.id)).toEqual(revoke(old));
      expect((await stores.links.listByConsumerCapsule("consumer")).filter((record) => record.state === "active")).toEqual([winner]);
      expect(await stores.links.listByProviderCapsule(loser.providerCapsuleId)).toEqual([]);
      expect(await stores.links.create(link({ id: "after_race" }))).toBe(false);
    } finally { await close(); }
  });

  test(`InterfaceLink writes atomically fence Workspace management state and epoch (${backend.label})`, async () => {
    const { stores, close, setManagement } = await backend.setup();
    const guard: WorkspaceManagementAuthority = { workspaceId: "workspace", managementState: "active", managementEpoch: 1 };
    try {
      await setManagement("frozen", 2);
      expect(await stores.links.create(link(), guard)).toBe(false);
      expect(await stores.links.get("link_first")).toBeUndefined();
      await setManagement("active", 2);
      expect(await stores.links.create(link(), guard)).toBe(false); // Old epoch cannot reopen authority.
      const currentGuard = { ...guard, managementEpoch: 2 };
      expect(await stores.links.create(link(), currentGuard)).toBe(true);
      const approved = active(link());
      await setManagement("frozen", 3);
      expect(await stores.links.compareAndSet(approved, 1, currentGuard)).toBe(false);
      expect(await stores.links.getCurrent(key)).toEqual(link());
      const replacement = link({ id: "guarded_replacement", generation: 3 });
      expect(await stores.links.replace({ record: replacement, expected: link(), revoked: revoke(link()) }, currentGuard)).toBe(false);
      expect(await stores.links.getCurrent(key)).toEqual(link());
      expect(await stores.links.get(replacement.id)).toBeUndefined();
      await setManagement("active", 3);
      expect(await stores.links.compareAndSet(approved, 1, currentGuard)).toBe(false);
      const newestGuard = { ...guard, managementEpoch: 3 };
      expect(await stores.links.compareAndSet(approved, 1, newestGuard)).toBe(true);
      expect(await stores.links.replace({ record: { ...replacement, generation: 4 }, expected: approved, revoked: revoke(approved) }, newestGuard)).toBe(true);
    } finally { await close(); }
  });

  test(`InterfaceService provider approve and decline keep store parity and the management fence (${backend.label})`, async () => {
    const { stores, close, setManagement } = await backend.setup();
    try {
      await setManagement("active", 1);
      const requirement = { key: "storage", interface: { type: "example.storage", version: "1" }, permissions: ["storage.read", "storage.write"], delivery: { type: "oauth2" } } as const;
      const capsules = new Map(["consumer", "consumer_two", "provider"].map((id) => [id, { id, workspaceId: "workspace", name: id, installConfigId: "config", status: "active" } as Capsule]));
      const service = new InterfaceService({
        stores, now: () => NOW, linkApprovalPolicy: { evaluate: async () => undefined }, oauth2ResourceAuthorizer: () => true,
        credentialIssuer: { issuePrincipalOAuth2Token: async () => ({ accessToken: "runtime-token", expiresAt: "2026-10-28T00:01:00.000Z" }) },
        capsules: {
          getCapsule: async (id) => { const capsule = capsules.get(id); if (!capsule) throw new OpenTofuControllerError("not_found", "Capsule not found"); return capsule; },
          getInstallConfig: async () => ({ requiredInterfaces: [requirement] }) as unknown as InstallConfig,
        },
      });
      const iface = await service.create({ workspaceId: "workspace", name: "storage", ownerRef: { kind: "Capsule", id: "provider" }, spec: { type: "example.storage", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: "https://provider.example.test/storage" } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } } });
      const select = async (capsuleId: string) => (await service.ensureCapsuleInterfaceLinks({ workspaceId: "workspace", capsuleId, requirements: [requirement], selections: [{ requirementKey: "storage", interfaceId: iface.metadata.id, selection: "explicit" }] }))[0]!;
      const first = await select("consumer");
      const second = await select("consumer_two");
      expect([first.state, second.state]).toEqual(["pending_approval", "pending_approval"]);
      expect((await service.listProviderInterfaceLinkRequests("provider")).map((record) => record.id).sort()).toEqual([first.id, second.id].sort());
      const actor = { actorAccountId: "provider-owner", roles: [], requestId: "parity" };
      const fence = (managementEpoch: number) => ({ assertCurrent: async (): Promise<WorkspaceManagementAuthority> => ({ workspaceId: "workspace", managementState: "active", managementEpoch }) });

      await setManagement("frozen", 2);
      await expect(service.approveInterfaceLink({ providerCapsuleId: "provider", linkId: first.id, expectedGeneration: first.generation }, actor, fence(1))).rejects.toMatchObject({ code: "conflict" });
      expect(await stores.links.get(first.id)).toEqual(first);
      await setManagement("active", 2);
      await expect(service.declineInterfaceLink({ providerCapsuleId: "provider", linkId: second.id, expectedGeneration: second.generation }, actor, fence(1))).rejects.toMatchObject({ code: "conflict" });

      const approved = await service.approveInterfaceLink({ providerCapsuleId: "provider", linkId: first.id, expectedGeneration: first.generation, approvedPermissions: ["storage.read"] }, actor, fence(2));
      expect(approved).toMatchObject({ state: "active", generation: 2, approvedPermissions: ["storage.read"], approval: { kind: "provider_approved", approvedBy: "provider-owner" } });
      expect(await stores.links.get(first.id)).toEqual(approved);
      const declined = await service.declineInterfaceLink({ providerCapsuleId: "provider", linkId: second.id, expectedGeneration: second.generation }, actor, fence(2));
      expect(declined).toMatchObject({ state: "declined", generation: 2, approvedPermissions: [], declined: { declinedBy: "provider-owner" } });
      expect(await stores.links.get(second.id)).toEqual(declined);
      expect(await stores.links.getCurrent({ consumerCapsuleId: "consumer_two", requirementKey: "storage" })).toBeUndefined();
      expect(await service.listProviderInterfaceLinkRequests("provider")).toEqual([]);

      for (const capsuleId of ["consumer", "consumer_two"]) await service.ensureCapsuleRequiredInterfaces({ workspaceId: "workspace", capsuleId, principalId: `${capsuleId}_alice`, requirements: [requirement] });
      const bindings = await service.listBindings(iface.metadata.id);
      expect(bindings.map((binding) => [binding.spec.subjectRef.id, binding.spec.permissions])).toEqual([["consumer_alice", ["storage.read"]]]);
      expect((await service.issueToken(iface.metadata.id, { permission: "storage.read" }, { workspaceId: "workspace", subjectId: "consumer_alice" })).access_token).toBe("runtime-token");
      await expect(service.issueToken(iface.metadata.id, { permission: "storage.write" }, { workspaceId: "workspace", subjectId: "consumer_alice" })).rejects.toThrow("grant not found");
    } finally { await close(); }
  });

  test(`required InterfaceBinding authorization requires exact active consent (${backend.label})`, async () => {
    const { stores, close } = await backend.setup();
    try {
      const iface: Interface = {
        apiVersion: TAKOSUMI_API_VERSION, kind: "Interface",
        metadata: { id: "interface_provider", workspaceId: "workspace", ownerRef: { kind: "Capsule", id: "provider" }, name: "provider", generation: 1, createdAt: NOW, updatedAt: NOW },
        spec: { type: "example.storage", version: "1", document: {}, access: { visibility: "workspace" } },
        status: { phase: "Resolved", observedGeneration: 1, resolvedRevision: 1 },
      };
      expect(await stores.interfaces.create(iface)).toBe(true);
      let binding: InterfaceBinding = {
        apiVersion: TAKOSUMI_API_VERSION, kind: "InterfaceBinding",
        metadata: { id: "required_binding", workspaceId: "workspace", generation: 1, createdAt: NOW, updatedAt: NOW,
          materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "storage", interfaceType: "example.storage", interfaceVersion: "1" } },
        spec: { interfaceId: iface.metadata.id, subjectRef: { kind: "Principal", id: "pairwise" }, permissions: ["storage.read", "storage.write"], delivery: { type: "oauth2" } },
        status: { phase: "Ready", observedInterfaceRevision: 1 },
      };
      expect(await stores.bindings.create(binding)).toBe(true);
      const page = (permission = "storage.read") => stores.authorized.listPage({ filter: { workspaceId: "workspace" }, subjectId: "pairwise", permission, params: { limit: 20 } });
      expect((await page()).items).toEqual([]); // Legacy provenance is not consent.
      const initial = link();
      expect(await stores.links.create(initial)).toBe(true);
      const source = binding.metadata.materializedFrom!;
      if (source.source !== "capsule_required_interface") throw new Error("unexpected provenance");
      binding = { ...binding, metadata: { ...binding.metadata, generation: 2, materializedFrom: { ...source, linkId: initial.id } } };
      expect(await stores.bindings.compareAndSet(binding, 1)).toBe(true);
      expect((await page()).items).toEqual([]); // Pending consent never grants.
      const approved = active(initial);
      expect(await stores.links.compareAndSet(approved, 1)).toBe(true);
      expect((await page()).items).toEqual([iface]);
      const legacySource = source;
      const legacy = { ...binding, metadata: { ...binding.metadata, generation: 3, materializedFrom: legacySource } };
      expect(await stores.bindings.compareAndSet(legacy, 2)).toBe(true);
      expect((await page()).items).toEqual([iface]); // Exact active consent also covers pre-link provenance.
      expect((await page("storage.write")).items).toEqual([]);
      expect(await stores.bindings.compareAndSet({ ...binding, metadata: { ...binding.metadata, generation: 4 } }, 3)).toBe(true); // Only requested AND approved grants.
      const mismatched = { ...binding, metadata: { ...binding.metadata, generation: 5, materializedFrom: { ...source, linkId: initial.id, capsuleId: "another_consumer" } } };
      expect(await stores.bindings.compareAndSet(mismatched, 4)).toBe(true);
      expect((await page()).items).toEqual([]);
      expect(await stores.bindings.compareAndSet({ ...binding, metadata: { ...binding.metadata, generation: 6 } }, 5)).toBe(true);
      expect((await page()).items).toEqual([iface]);
      expect(await stores.links.compareAndSet(revoke(approved), 2)).toBe(true);
      expect((await page()).items).toEqual([]); // A retained Ready Binding cannot outlive consent.
    } finally { await close(); }
  });
}

for (const head of [71, 75]) {
  test(`D1 v${head} bridge keeps ordinary authorization while denying unlinked requirements`, async () => {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: head });
    const stores = createD1InterfaceStores(db);
    const iface: Interface = {
      apiVersion: TAKOSUMI_API_VERSION, kind: "Interface",
      metadata: { id: "ordinary", workspaceId: "workspace", ownerRef: { kind: "Capsule", id: "provider" }, name: "ordinary", generation: 1, createdAt: NOW, updatedAt: NOW },
      spec: { type: "example.storage", version: "1", document: {}, access: { visibility: "workspace" } },
      status: { phase: "Resolved", observedGeneration: 1, resolvedRevision: 1 },
    };
    expect(await stores.interfaces.create(iface)).toBe(true);
    const ordinary: InterfaceBinding = {
      apiVersion: TAKOSUMI_API_VERSION, kind: "InterfaceBinding",
      metadata: { id: "ordinary_binding", workspaceId: "workspace", generation: 1, createdAt: NOW, updatedAt: NOW },
      spec: { interfaceId: iface.metadata.id, subjectRef: { kind: "Principal", id: "ordinary" }, permissions: ["storage.read"], delivery: { type: "none" } },
      status: { phase: "Ready", observedInterfaceRevision: 1 },
    };
    expect(await stores.bindings.create(ordinary)).toBe(true);
    const required: InterfaceBinding = { ...ordinary, metadata: { ...ordinary.metadata, id: "required_binding", materializedFrom: { source: "capsule_required_interface", capsuleId: "consumer", requirementKey: "storage", interfaceType: "example.storage", interfaceVersion: "1", linkId: "unledgered_link" } }, spec: { ...ordinary.spec, subjectRef: { kind: "Principal", id: "required" } } };
    expect(await stores.bindings.create(required)).toBe(true);
    const page = (subjectId: string) => stores.authorized.listPage({ filter: { workspaceId: "workspace" }, subjectId, permission: "storage.read", params: { limit: 20 } });
    expect((await page("ordinary")).items).toEqual([iface]);
    expect((await page("required")).items).toEqual([]);
  });
}


test("D1 v75 link store reads are empty, writes refuse, and a warm store observes v76", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 75 });
  const stores = createD1InterfaceStores(db);
  expect(await stores.links.get("missing")).toBeUndefined();
  expect(await stores.links.getCurrent(key)).toBeUndefined();
  expect(await stores.links.getLatest(key)).toBeUndefined();
  expect(await stores.links.listByConsumerCapsule("consumer")).toEqual([]);
  expect(await stores.links.listByProviderCapsule("provider")).toEqual([]);
  expect(await stores.links.listByProviderInterface("interface_provider")).toEqual([]);
  await expect(stores.links.create(link())).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(stores.links.compareAndSet(active(link()), 1)).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(stores.links.replace({ record: link({ id: "next", generation: 3 }), expected: link(), revoked: revoke(link()) })).rejects.toMatchObject({ code: "failed_precondition" });
  await ensureD1OpenTofuLedgerSchema(db);
  await Bun.sleep(1_050);
  expect(await stores.links.create(link())).toBe(true);
  expect(await stores.links.get(link().id)).toEqual(link());
});

test("D1 link schema probe retries failures and shares availability with authorization", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  let probes = 0;
  const wrapped = {
    prepare(query: string) {
      const statement = db.prepare(query);
      if (query.includes("select 1 as available from schema_migrations")) {
        probes++;
        if (probes === 1) statement.first = async () => { throw new Error("synthetic temporary probe failure"); };
      }
      return statement;
    },
    batch: db.batch.bind(db),
  };
  const stores = createD1InterfaceStores(wrapped);
  const authorized = () => stores.authorized.listPage({ filter: { workspaceId: "workspace" }, subjectId: "subject", permission: "read", params: { limit: 20 } });
  await expect(authorized()).rejects.toThrow("temporary probe failure");
  expect(await authorized()).toEqual({ items: [] });
  expect(await stores.links.get("missing")).toBeUndefined();
  expect(probes).toBe(2);
});
