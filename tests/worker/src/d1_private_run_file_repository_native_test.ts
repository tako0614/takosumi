import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../worker/src/d1_opentofu_store.ts";
import { D1PrivateRunFileRepository } from "../../../worker/src/d1_private_run_file_repository.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";

const scope = {
  workspaceId: "native_private_ws",
  capsuleId: "native_private_capsule",
  environment: "production",
  slot: "intent",
} as const;
const authority = {
  scope,
  runId: "native_private_plan",
  executionAuthorityEpoch: 7,
  leaseToken: "native_private_lease",
} as const;
const digest = `sha256:${"a".repeat(64)}` as const;

async function seed(db: D1Database): Promise<void> {
  await db.prepare(`insert into workspaces
    (id, handle, record_json, created_at, updated_at)
    values (?, 'native-private-workspace', '{}', '2026-10-12', '2026-10-12')`)
    .bind(scope.workspaceId).run();
  await db.prepare(`insert into capsules
    (id, space_id, project_id, name, slug, install_config_id,
     environment, status, record_json, created_at, updated_at,
     execution_authority_epoch)
    values (?, ?, 'native_project', 'native-capsule', 'native-capsule',
      'native_install', ?, 'active', '{}', '2026-10-12', '2026-10-12', ?)`)
    .bind(
      scope.capsuleId,
      scope.workspaceId,
      scope.environment,
      authority.executionAuthorityEpoch,
    ).run();
  await db.prepare(`insert into runs
    (id, space_id, installation_id, environment, type, status,
     lease_token, run_json, created_at)
    values (?, ?, ?, ?, 'plan', 'running', ?, ?, '2026-10-12')`)
    .bind(
      authority.runId,
      scope.workspaceId,
      scope.capsuleId,
      scope.environment,
      authority.leaseToken,
      JSON.stringify({
        id: authority.runId,
        workspaceId: scope.workspaceId,
        capsuleId: scope.capsuleId,
        status: "running",
        capsuleExecutionAuthorityEpoch: authority.executionAuthorityEpoch,
        workspaceManagementAuthority: {
          workspaceId: scope.workspaceId,
          managementState: "active",
          managementEpoch: 1,
        },
      }),
    )
    .run();
}

test(
  "isolated workerd D1 v70 fences CAS, receipt, lost ACK and replaced lease",
  async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "private-run-files-native.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "private-run-files-native" },
    });
    try {
      const db = await runtime.getD1Database(
        "CONTROL",
      ) as unknown as D1Database;
      await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 69 });
      await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects
        .toThrow();
      await ensureD1OpenTofuLedgerSchema(db);
      await verifyD1OpenTofuLedgerSchemaPredeployed(db);
      expect(
        (await db.prepare("pragma foreign_keys").first<
          { foreign_keys: number }
        >())
          ?.foreign_keys,
      ).toBe(1);
      await seed(db);

      let batches = 0;
      const lostAck: D1Database = {
        prepare: (query) => db.prepare(query),
        batch: async (statements) => {
          batches++;
          await db.batch(statements);
          throw new Error("lost transport ACK after native D1 commit");
        },
      };
      const request = {
        ...authority,
        expectedVersion: 0,
        commitId: "native_first",
        digest,
        blobId: "native_blob",
      };
      const repo = new D1PrivateRunFileRepository(lostAck);
      expect((await repo.commitPointer(request)).kind).toBe("replayed");
      expect(batches).toBe(1);
      expect((await repo.commitPointer(request)).kind).toBe("replayed");
      expect(batches).toBe(1);
      expect((await repo.readPointer(authority)).kind).toBe("present");

      // The same blob/digest cannot let a second commit ID masquerade as the
      // CAS winner. Its guard aborts without leaving a receipt.
      const loser = { ...request, commitId: "native_loser" };
      expect((await repo.commitPointer(loser)).kind).toBe("unknown");
      expect(
        await repo.lookupReceipt({ ...authority, commitId: loser.commitId }),
      )
        .toEqual({ kind: "absent" });
      expect(
        (await db.prepare(`select count(*) as count
      from private_run_file_receipts`).first<{ count: number }>())?.count,
      ).toBe(1);

      const racedSlot = { ...scope, slot: "native-race" };
      const raced = await Promise.all([
        new D1PrivateRunFileRepository(db).commitPointer({
          ...authority,
          scope: racedSlot,
          expectedVersion: 0,
          commitId: "native_race_a",
          digest,
          blobId: "same_blob",
        }),
        new D1PrivateRunFileRepository(db).commitPointer({
          ...authority,
          scope: racedSlot,
          expectedVersion: 0,
          commitId: "native_race_b",
          digest,
          blobId: "same_blob",
        }),
      ]);
      expect(raced.filter((result) => result.kind === "committed"))
        .toHaveLength(1);
      expect(
        (await db.prepare(`select count(*) as count
        from private_run_file_receipts where slot = ?`)
          .bind(racedSlot.slot).first<{ count: number }>())?.count,
      ).toBe(1);

      let leaseFlipped = false;
      const leaseRace: D1Database = {
        prepare: (query) => db.prepare(query),
        batch: async (statements) => {
          if (!leaseFlipped) {
            leaseFlipped = true;
            await db.prepare(`update runs set lease_token = 'replacement'
              where id = ?`).bind(authority.runId).run();
          }
          return await db.batch(statements);
        },
      };
      expect(
        await new D1PrivateRunFileRepository(leaseRace).commitPointer({
          ...request,
          scope: { ...scope, slot: "lease-race" },
          commitId: "lease_race",
        }),
      ).toEqual({ kind: "authority_rejected" });
      expect(leaseFlipped).toBe(true);
      expect(
        (await db.prepare(`select count(*) as count
        from private_run_file_receipts where slot = 'lease-race'`)
          .first<{ count: number }>())?.count,
      ).toBe(0);
      expect(await repo.readPointer(authority)).toEqual({
        kind: "authority_rejected",
      });
      expect(
        await repo.lookupReceipt({ ...authority, commitId: request.commitId }),
      )
        .toEqual({ kind: "authority_rejected" });
      expect(await repo.commitPointer(request)).toEqual({
        kind: "authority_rejected",
      });

      await db.prepare(`update runs set lease_token = ? where id = ?`)
        .bind(authority.leaseToken, authority.runId).run();
      await db.prepare(`update workspaces set management_state = 'draining',
        management_epoch = 2 where id = ?`).bind(scope.workspaceId).run();
      const settling = new D1PrivateRunFileRepository(db);
      expect((await settling.readPointer(authority)).kind).toBe("present");
      expect(
        (await settling.lookupReceipt({
          ...authority,
          commitId: request.commitId,
        })).kind,
      ).toBe("found");
      expect((await settling.commitPointer(request)).kind).toBe("replayed");
      expect(
        (await settling.commitPointer({
          ...request,
          scope: { ...scope, slot: "native-drain" },
          commitId: "native_drain",
        })).kind,
      ).toBe("committed");

      const frozenSlot = { ...scope, slot: "native-freeze-race" };
      const freezeRace: D1Database = {
        prepare: (query) => db.prepare(query),
        batch: async (statements) => {
          await db.prepare(`update workspaces set management_state = 'frozen'
            where id = ?`).bind(scope.workspaceId).run();
          return await db.batch(statements);
        },
      };
      expect(
        await new D1PrivateRunFileRepository(freezeRace).commitPointer({
          ...request,
          scope: frozenSlot,
          commitId: "native_frozen_race",
        }),
      ).toEqual({ kind: "authority_rejected" });
      expect(
        await db.prepare(`select count(*) as count
        from private_run_file_receipts where slot = ?`)
          .bind(frozenSlot.slot).first<{ count: number }>(),
      )
        .toEqual({ count: 0 });
      expect(
        await db.prepare(`select count(*) as count
        from private_run_file_pointers where slot = ?`)
          .bind(frozenSlot.slot).first<{ count: number }>(),
      )
        .toEqual({ count: 0 });
    } finally {
      await runtime.dispose();
    }
  },
  30_000,
);
