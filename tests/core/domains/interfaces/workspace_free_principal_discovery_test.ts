/**
 * Workspace-free Principal Binding discovery (TASK-0118 9.1) pages the same
 * way in the in-memory, Postgres (PGlite) and SQLite-D1 Interface stores: it
 * returns only Interfaces with the exact current Principal Binding and
 * permission, accepts a Binding only as evidence of the consumer app (its own
 * partition, or materialized from its own link), and honours the owner filter.
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
        });
        created[name] = iface.metadata.id;
        if (subject && permission) {
          await service.createBinding(iface.metadata.id, {
            subjectRef: { kind: "Principal", id: subject },
            permissions: [permission],
            delivery: { type: "none" },
          });
        }
      }
      // ns_two's owner bound app cap_one's (learned) subject manually: not
      // evidence for cap_one, which sees only its own partition.
      const appOne = { capsuleId: "cap_one", partition: "ns_one" };
      const appTwo = { capsuleId: "cap_two", partition: "ns_two" };
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
      });
      await service.createBinding(extra.metadata.id, {
        subjectRef: { kind: "Principal", id: "principal_app" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
      });
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
      await expect(
        service.getAuthorizedForPrincipal(created.two!, "principal_app", "mcp.invoke", appOne), label,
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await service.getAuthorizedForPrincipal(created.two!, "principal_app", "mcp.invoke", appTwo)).metadata.id, label)
        .toBe(created.two!);
      // The partitioned projection is unchanged.
      const partitioned = await service.listAuthorizedForPrincipal(
        { workspaceId: "ns_one" }, "principal_app", "mcp.invoke",
      );
      expect(partitioned.map((iface) => iface.metadata.id).sort(), label).toEqual([created.one!, extra.metadata.id].sort());
    }
  } finally {
    await close();
  }
});
