import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { InterfaceLink } from "takosumi-contract/interfaces";
import { createD1InterfaceStores } from "../../../core/domains/interfaces/d1_stores.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { workerdD1Database, workerdD1Module } from "../../helpers/deploy-control/workerd_d1.ts";

// The runtime and DB are local isolated workerd/D1 fixtures. This proves the
// native batch/changes()/constraint semantics, not a deployed D1 timing result.
test("native D1 InterfaceLink races, atomic replacement rollback and management fencing", async () => {
  const runtime = new Miniflare({
    host: "127.0.0.1", port: 0, compatibilityDate: "2026-06-01",
    modules: [workerdD1Module("interface-links-native.mjs")], d1Databases: { CONTROL: "interface-links-native" },
  });
  try {
    const db = workerdD1Database(runtime);
    await ensureD1OpenTofuLedgerSchema(db);
    await db.prepare("insert into workspaces(id,handle,record_json,created_at,updated_at) values('workspace','workspace','{}','','')").run();
    const guard = { workspaceId: "workspace", managementState: "active" as const, managementEpoch: 1 };
    const links = createD1InterfaceStores(db).links;
    const initial: InterfaceLink = {
      id: "first", generation: 1, consumerCapsuleId: "consumer", requirementKey: "storage",
      interface: { type: "storage", version: "1" }, requestedPermissions: ["read"], approvedPermissions: [],
      deliveryType: "oauth2", providerInterfaceId: "provider_interface", providerCapsuleId: "provider",
      state: "pending_approval", selection: "explicit", requestedBy: "requester", createdAt: "2026-10-28", updatedAt: "2026-10-28",
    };
    const key = { consumerCapsuleId: initial.consumerCapsuleId, requirementKey: initial.requirementKey };
    const attempts = [initial, { ...initial, id: "racing_first" }];
    const created = await Promise.all(attempts.map((record) => links.create(record, guard)));
    expect(created.filter(Boolean)).toHaveLength(1);
    const first = attempts[created.indexOf(true)]!;
    const active: InterfaceLink = { ...first, generation: 2, state: "active", approvedPermissions: ["read"], approval: { kind: "provider_approved", approvedBy: "provider-owner", approvedAt: "2026-10-28" } };
    const approved = await Promise.all([links.compareAndSet(active, 1, guard), links.compareAndSet({ ...active, approvedPermissions: [] }, 1, guard)]);
    expect(approved.filter(Boolean)).toHaveLength(1);
    const old = (await links.getCurrent(key))!;
    const revoked: InterfaceLink = { ...old, state: "revoked", generation: 3, revoked: { revokedBy: "owner", revokedAt: "2026-10-28" } };
    const replacement: InterfaceLink = { ...active, id: "next", generation: 4 };
    const fault: D1Database = {
      prepare(query) { return db.prepare(query.startsWith("insert into interface_links") ? "insert into deliberately_missing_link_fixture values(1)" : query); },
      batch: (statements) => db.batch(statements),
    };
    await expect(createD1InterfaceStores(fault).links.replace({ record: replacement, expected: old, revoked }, guard)).rejects.toThrow();
    expect(await links.getCurrent(key)).toEqual(old); // The first UPDATE rolled back with the failed INSERT.
    expect(await links.get(replacement.id)).toBeUndefined();
    const replacements = [replacement, { ...replacement, id: "next_racer", providerInterfaceId: "provider_next", providerCapsuleId: "provider_next" }];
    const results = await Promise.all(replacements.map((record) => links.replace({ record, expected: old, revoked }, guard)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = replacements[results.indexOf(true)]!, loser = replacements[results.indexOf(false)]!;
    expect(await links.getCurrent(key)).toEqual(winner);
    expect(await links.get(loser.id)).toBeUndefined();
    expect((await links.listByConsumerCapsule("consumer")).filter((record) => record.state === "active")).toEqual([winner]);
    await db.prepare("update workspaces set management_state='frozen',management_epoch=2 where id='workspace'").run();
    const revokeWinner: InterfaceLink = { ...winner, generation: 5, state: "revoked" };
    expect(await links.compareAndSet(revokeWinner, 4, guard)).toBe(false);
    expect(await links.replace({ record: { ...replacement, id: "frozen_racer", generation: 6 }, expected: winner, revoked: revokeWinner }, guard)).toBe(false);
    expect(await links.create({ ...initial, id: "frozen_new", requirementKey: "other" }, guard)).toBe(false);
    expect(await links.getCurrent(key)).toEqual(winner);
  } finally { await runtime.dispose(); }
}, 30_000);
