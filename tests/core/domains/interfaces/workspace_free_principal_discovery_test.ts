/**
 * Workspace-free Principal Binding discovery (TASK-0118 9.1) pages the same
 * way in the in-memory, Postgres (PGlite) and SQLite-D1 Interface stores: it
 * returns only Interfaces with the exact current Principal Binding and
 * permission, accepts a Binding only as evidence of the consumer app (on an
 * Interface the app owns, or materialized from its own link; a co-tenant's
 * manual Binding in the app's own partition is not evidence), and honours the
 * owner filter.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createD1InterfaceStores,
  createInMemoryInterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
  type InterfaceStores,
} from "../../../../core/domains/interfaces/mod.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

setDefaultTimeout(60_000);

const NOW = "2026-10-30T00:00:00.000Z";

async function storeSets(): Promise<{ readonly sets: readonly [string, InterfaceStores][]; readonly close: () => Promise<void> }> {
  const pg = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  return {
    sets: [
      ["memory", createInMemoryInterfaceStores()],
      ["postgres", createSqlInterfaceStores(pg)],
      ["d1", createD1InterfaceStores(d1)],
    ],
    close: () => pg.close(),
  };
}

test("Workspace-free Principal Binding discovery accepts only the consumer app's evidence, with parity", async () => {
  const { sets, close } = await storeSets();
  try {
    for (const [label, stores] of sets) {
      let sequence = 0;
      const service = new InterfaceService({
        stores,
        now: () => NOW,
        newId: (prefix) => `${prefix}_${label}_${String(++sequence).padStart(4, "0")}`,
      });
      const created: Record<string, string> = {};
      for (const [workspaceId, capsuleId, name, subject, permission] of [
        ["ns_one", "cap_one", "one", "principal_app", "mcp.invoke"],
        ["ns_two", "cap_two", "two", "principal_app", "mcp.invoke"],
        ["ns_two", "cap_two", "two-other-permission", "principal_app", "mcp.admin"],
        ["ns_two", "cap_three", "three-other-subject", "principal_other", "mcp.invoke"],
        ["ns_one", "cap_one", "one-unbound", undefined, undefined],
      ] as const) {
        const iface = await service.create({
          workspaceId,
          name,
          ownerRef: { kind: "Capsule", id: capsuleId },
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: {},
            inputs: { endpoint: { source: "literal", value: `https://${name}.example.test/mcp` } },
            access: { visibility: "private" },
          },
        }, undefined, undefined, undefined, "app");
        created[name] = iface.metadata.id;
        if (subject && permission) {
          await service.createBinding(iface.metadata.id, {
            subjectRef: { kind: "Principal", id: subject },
            permissions: [permission],
            delivery: { type: "none" },
          }, undefined, undefined, undefined, "app");
        }
      }
      // A co-tenant of cap_one's own partition ns_one bound cap_one's
      // (learned) subject manually, on its own app's Interface and on a
      // Workspace-owned one.
      for (const ownerRef of [
        { kind: "Capsule" as const, id: "cap_cotenant" },
        { kind: "Workspace" as const, id: "ns_one" },
      ]) {
        const name = `cotenant-${ownerRef.kind.toLowerCase()}`;
        const iface = await service.create({
          workspaceId: "ns_one",
          name,
          ownerRef,
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: {},
            inputs: { endpoint: { source: "literal", value: `https://${name}.example.test/mcp` } },
            access: { visibility: "private" },
          },
        });
        created[name] = iface.metadata.id;
        await service.createBinding(iface.metadata.id, {
          subjectRef: { kind: "Principal", id: "principal_app" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
        }, undefined, undefined, undefined, "app");
      }
      // Records "owned" by cap_one that are not its own: an Interface written
      // only under Workspace authority (before cap_one had an ownership
      // record), the app's own Interface with a Binding written under
      // Workspace authority, and a legacy unrecorded manual Interface.
      for (const [name, interfaceUnder, bindingUnder] of [
        ["pre-ownership", "workspace", "workspace"],
        ["foreign-binding", "app", "workspace"],
        ["unrecorded", undefined, undefined],
      ] as const) {
        const iface = await service.create({
          workspaceId: "ns_one",
          name,
          ownerRef: { kind: "Capsule", id: "cap_one" },
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: {},
            inputs: { endpoint: { source: "literal", value: `https://${name}.example.test/mcp` } },
            access: { visibility: "private" },
          },
        }, undefined, undefined, undefined, interfaceUnder);
        created[name] = iface.metadata.id;
        expect(iface.metadata.createdUnder, `${label} ${name}`).toBe(interfaceUnder);
        const binding = await service.createBinding(iface.metadata.id, {
          subjectRef: { kind: "Principal", id: "principal_app" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
        }, undefined, undefined, undefined, bindingUnder);
        expect(binding.metadata.createdUnder, `${label} ${name}`).toBe(bindingUnder);
      }
      // Recorded on Capsule-owned records only, and survives each store.
      expect((await service.get(created["pre-ownership"]!)).metadata.createdUnder, label).toBe("workspace");
      expect((await service.get(created["cotenant-workspace"]!)).metadata.createdUnder, label).toBeUndefined();
      // ns_two's owner also bound it manually: neither is evidence for
      // cap_one, which sees only Interfaces it owns (or its own links).
      const appOne = { capsuleId: "cap_one" };
      const appTwo = { capsuleId: "cap_two" };
      const one = await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        { type: "mcp.server" }, "principal_app", "mcp.invoke", {}, appOne,
      );
      expect(one.items.map((iface) => iface.metadata.id), label).toEqual([created.one!]);
      const crossNarrowed = await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        { ownerKind: "Capsule", ownerId: "cap_two" }, "principal_app", "mcp.invoke", {}, appOne,
      );
      expect(crossNarrowed.items, label).toEqual([]);
      const two = await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        { ownerKind: "Capsule", ownerId: "cap_two" }, "principal_app", "mcp.invoke", {}, appTwo,
      );
      expect(two.items.map((iface) => iface.metadata.id), label).toEqual([created.two!]);
      // Paging within the consumer's evidence.
      const extra = await service.create({
        workspaceId: "ns_one",
        name: "one-more",
        ownerRef: { kind: "Capsule", id: "cap_one" },
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: {},
          inputs: { endpoint: { source: "literal", value: "https://one-more.example.test/mcp" } },
          access: { visibility: "private" },
        },
      }, undefined, undefined, undefined, "operator");
      await service.createBinding(extra.metadata.id, {
        subjectRef: { kind: "Principal", id: "principal_app" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
      }, undefined, undefined, undefined, "operator");
      const firstPage = await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        {}, "principal_app", "mcp.invoke", { limit: 1 }, appOne,
      );
      expect(firstPage.items, label).toHaveLength(1);
      expect(firstPage.nextCursor, label).toBeDefined();
      const secondPage = await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        {}, "principal_app", "mcp.invoke", { limit: 1, cursor: firstPage.nextCursor! }, appOne,
      );
      expect(
        [...firstPage.items, ...secondPage.items].map((iface) => iface.metadata.id).sort(),
        label,
      ).toEqual([created.one!, extra.metadata.id].sort());
      expect(secondPage.nextCursor, label).toBeUndefined();
      // By-id reads apply the same evidence restriction.
      for (const name of ["two", "cotenant-capsule", "cotenant-workspace", "pre-ownership", "foreign-binding", "unrecorded"]) {
        await expect(
          service.getAuthorizedForPrincipal(created[name]!, "principal_app", "mcp.invoke", appOne), `${label} ${name}`,
        ).rejects.toMatchObject({ code: "not_found" });
      }
      expect((await service.getAuthorizedForPrincipal(created.two!, "principal_app", "mcp.invoke", appTwo)).metadata.id, label)
        .toBe(created.two!);
      // The partitioned projection keeps every Binding in the partition,
      // and narrows to the app's evidence when given the consumer.
      const partitioned = await service.listAuthorizedForPrincipal(
        { workspaceId: "ns_one" }, "principal_app", "mcp.invoke",
      );
      expect(partitioned.map((iface) => iface.metadata.id).sort(), label).toEqual(
        [created.one!, extra.metadata.id, created["cotenant-capsule"]!, created["cotenant-workspace"]!,
          created["pre-ownership"]!, created["foreign-binding"]!, created.unrecorded!].sort(),
      );
      // The records that are not cap_one's own wait for its owner's review.
      expect((await service.listInterfacesNeedingReview("ns_one", "cap_one")).map((iface) => iface.metadata.id).sort(), label)
        .toEqual([created["pre-ownership"]!, created["foreign-binding"]!, created.unrecorded!].sort());
      const partitionedForApp = await service.listAuthorizedForPrincipal(
        { workspaceId: "ns_one" }, "principal_app", "mcp.invoke", appOne,
      );
      expect(partitionedForApp.map((iface) => iface.metadata.id).sort(), label).toEqual([created.one!, extra.metadata.id].sort());
    }
  } finally {
    await close();
  }
});
