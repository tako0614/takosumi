/**
 * The one-time backfill that records `createdUnder: "operator"` on Interfaces
 * the legacy Output migration created (TASK-0118 9.1), with parity across the
 * in-memory, Postgres (PGlite) and SQLite-D1 Interface stores.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import type { Interface } from "takosumi-contract";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createD1InterfaceStores,
  createInMemoryInterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
  type InterfaceStores,
} from "../../../../core/domains/interfaces/mod.ts";
import { LEGACY_OUTPUT_MIGRATION_EVIDENCE_ACTION } from "../../../../core/domains/interfaces/legacy_output_provenance.ts";
import { runLegacyOutputInterfaceProvenance } from "../../../../scripts/backfill-legacy-output-interface-provenance.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
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

function spec(name: string) {
  return {
    type: "mcp.server",
    version: "2025-11-25",
    document: {},
    inputs: { endpoint: { source: "literal" as const, value: `https://${name}.example.test/mcp` } },
    access: { visibility: "private" as const },
  };
}

test("marks only the legacy Output migration's unchanged Interfaces, digest-confirmed and idempotent, with parity", async () => {
  const { sets, close } = await storeSets();
  try {
    for (const [label, stores] of sets) {
      const control = new InMemoryOpenTofuControlStore();
      const seeded = await seedCapsuleModel(control, { workspaceId: "ns_a", capsuleId: "cap_a" });
      await control.putCapsule({ ...seeded.capsule, id: "cap_b", name: "b", slug: "b" });
      let sequence = 0;
      const service = new InterfaceService({ stores, now: () => NOW, newId: (prefix) => `${prefix}_${label}_${++sequence}` });
      const create = (name: string, capsuleId: string, createdUnder?: "operator") =>
        service.create({ workspaceId: "ns_a", name, ownerRef: { kind: "Capsule", id: capsuleId }, spec: spec(name) }, undefined, undefined, undefined, createdUnder);
      // What the migration created before writes were recorded.
      const migrated = await create("migrated", "cap_a");
      const changed = await create("changed", "cap_a");
      const recorded = await create("recorded", "cap_a", "operator");
      const otherOwner = await create("other-owner", "cap_b");
      const blueprint = await create("blueprint", "cap_a");
      const materialized: Interface = {
        ...blueprint,
        metadata: { ...blueprint.metadata, id: `if_${label}_materialized`, name: "materialized", materializedFrom: { source: "capsule_blueprint", key: "mcp" } },
      };
      expect(await stores.interfaces.create(materialized), label).toBe(true);
      // Not listed by any evidence: never touched.
      const manual = await create("manual", "cap_a");
      const digest = async (record: Interface) => await stableJsonDigest(record.spec);
      await control.putActivityEvent({
        id: `evt_${label}`,
        workspaceId: "ns_a",
        actorId: "operator",
        action: LEGACY_OUTPUT_MIGRATION_EVIDENCE_ACTION,
        targetType: "capsule",
        targetId: "cap_a",
        metadata: {
          interfaceIds: [migrated, changed, recorded, otherOwner, materialized].map((record) => record.metadata.id).concat("if_missing"),
          // `changed` no longer has the spec the migration recorded.
          interfaceSpecDigests: await Promise.all([migrated, recorded, otherOwner, materialized].map(digest)).then((list) => [...list, "sha256:changed-since"]),
        },
        createdAt: NOW,
      });
      // A Binding the operator wrote: the app's evidence once the Interface is its own.
      await service.createBinding(migrated.metadata.id, {
        subjectRef: { kind: "Principal", id: "pairwise_app_a" }, permissions: ["mcp.invoke"], delivery: { type: "none" },
      }, undefined, undefined, undefined, "operator");
      const discovered = async () => (await service.listAuthorizedForPrincipalAcrossPartitionsPage(
        {}, "pairwise_app_a", "mcp.invoke", {}, { capsuleId: "cap_a" },
      )).items.map((record) => record.metadata.id);
      expect(await discovered(), label).toEqual([]);

      const context = { control, interfaces: stores.interfaces };
      const dryRun = await runLegacyOutputInterfaceProvenance(context, {}) as {
        mode: string;
        marks: { interfaceId: string }[];
        skipped: { interfaceId: string; reason: string }[];
        digest: string;
      };
      expect(dryRun.mode, label).toBe("dry-run");
      expect(dryRun.marks.map((mark) => mark.interfaceId), label).toEqual([migrated.metadata.id]);
      expect(Object.fromEntries(dryRun.skipped.map((entry) => [entry.interfaceId, entry.reason])), label).toEqual({
        [changed.metadata.id]: "spec_changed",
        [recorded.metadata.id]: "already_recorded",
        [otherOwner.metadata.id]: "not_capsule_owned_here",
        [materialized.metadata.id]: "materialized",
        if_missing: "missing",
      });
      // Dry-run wrote nothing; apply needs the reviewed digest.
      expect((await stores.interfaces.get(migrated.metadata.id))!.metadata.createdUnder, label).toBeUndefined();
      await expect(runLegacyOutputInterfaceProvenance(context, { apply: true }), label).rejects.toThrow("--plan-digest");
      await expect(runLegacyOutputInterfaceProvenance(context, { apply: true, expectedDigest: "sha256:other" }), label).rejects.toThrow("changed since");
      expect(await runLegacyOutputInterfaceProvenance(context, { apply: true, expectedDigest: dryRun.digest }), label)
        .toEqual({ mode: "apply", applied: 1 });
      const marked = (await stores.interfaces.get(migrated.metadata.id))!;
      expect(marked.metadata.createdUnder, label).toBe("operator");
      expect(marked.metadata.generation, label).toBe(migrated.metadata.generation);
      for (const untouched of [changed, manual]) {
        expect((await stores.interfaces.get(untouched.metadata.id))!.metadata.createdUnder, label).toBeUndefined();
      }
      // Now the app's own record: its evidence, and out of the review list.
      expect(await discovered(), label).toEqual([migrated.metadata.id]);
      expect((await service.listInterfacesNeedingReview("ns_a", "cap_a")).map((record) => record.metadata.id), label)
        .not.toContain(migrated.metadata.id);
      // A second run finds nothing to do.
      const again = await runLegacyOutputInterfaceProvenance(context, {}) as { marks: unknown[]; digest: string };
      expect(again.marks, label).toEqual([]);
      expect(await runLegacyOutputInterfaceProvenance(context, { apply: true, expectedDigest: again.digest }), label)
        .toEqual({ mode: "apply", applied: 0 });
    }
  } finally {
    await close();
  }
});
