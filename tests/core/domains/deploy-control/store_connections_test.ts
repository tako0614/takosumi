/**
 * ProviderConnection + secret-blob store symmetry: the in-memory twin and the D1-shaped
 * store must behave identically for the credential-core methods.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Capsule } from "takosumi-contract/capsules";

// -- Fixtures ------------------------------------------------------------------

function connection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "conn_abcdef0123456789",
    workspaceId: "workspace_1",
    scope: "workspace",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
      declaredEnv: true,
    },
    secretPartition: "provider-credentials",
    kind: "generic_env_provider",
    status: "pending",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function secretBlob(connectionId: string): StoredSecretBlob {
  return {
    id: `secret_${connectionId}`,
    connectionId,
    workspaceId: "workspace_1",
    kind: "provider-credentials",
    ciphertext: "Y2lwaGVydGV4dA==",
    encryptedDek: "secret-boundary-aes-gcm/v1/cloudflare",
    nonce: "aXZpdml2aXZpdg==",
    keyVersion: 1,
    aad: JSON.stringify({
      secretPartition: "provider-credentials",
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
    }),
    createdAt: "2026-06-04T00:00:00.000Z",
  };
}

const STORES: ReadonlyArray<[string, () => OpenTofuControlStore]> = [
  ["in-memory", () => new InMemoryOpenTofuControlStore()],
  ["d1", () => new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
];

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: Connection registration commits one new pair under its original Workspace authority`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg
      ? new SqlOpenTofuControlStore({ client: pg })
      : d1 ? new CloudflareD1OpenTofuControlStore(d1) : new InMemoryOpenTofuControlStore();
    try {
      await store.putWorkspace({
        id: "workspace_1", handle: "registration", displayName: "Registration",
        type: "personal", ownerUserId: "registration_owner",
        createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z",
      });
      const authority = { workspaceId: "workspace_1", managementState: "active" as const, managementEpoch: 1 };
      const row = connection();
      const blob = secretBlob(row.id);
      const input = { connection: row, secretBlob: blob, expectedWorkspaceManagementAuthority: authority, actorAuthority: null };
      expect(await store.createConnectionRegistration(input)).toBe(true);
      expect(await store.getConnection(row.id)).toEqual(row);
      expect(await store.getSecretBlob(row.id)).toEqual(blob);
      expect(await store.createConnectionRegistration({ ...input,
        secretBlob: { ...blob, ciphertext: "cmVwbGFjZW1lbnQ=" } })).toBe(false);
      expect(await store.getSecretBlob(row.id)).toEqual(blob);

      const other = connection({ id: "conn_registration_other" });
      expect(await store.createConnectionRegistration({
        connection: other, secretBlob: { ...secretBlob(other.id), id: blob.id },
        expectedWorkspaceManagementAuthority: authority,
        actorAuthority: null,
      })).toBe(false);
      expect(await store.getConnection(other.id)).toBeUndefined();
      expect(await store.getSecretBlob(other.id)).toBeUndefined();
      const orphan = secretBlob("conn_registration_orphan");
      await store.putSecretBlob(orphan);
      expect(await store.createConnectionRegistration({
        connection: connection({ id: orphan.connectionId, secretPartition: undefined, credentialRecipe: undefined }),
        expectedWorkspaceManagementAuthority: authority,
        actorAuthority: null,
      })).toBe(false);
      expect(await store.getConnection(orphan.connectionId)).toBeUndefined();
      expect(await store.getSecretBlob(orphan.connectionId)).toEqual(orphan);

      if (d1) {
        const raced = secretBlob("conn_registration_raced_orphan");
        const batch = d1.batch.bind(d1);
        let interleaved = false;
        d1.batch = async (statements) => {
          if (!interleaved) {
            interleaved = true;
            // A real opaque-blob write becomes visible after preparation but
            // before D1 starts the registration transaction.
            await store.putSecretBlob(raced);
          }
          return await batch(statements);
        };
        const created = await store.createConnectionRegistration({
          connection: connection({ id: raced.connectionId, secretPartition: undefined, credentialRecipe: undefined }),
          expectedWorkspaceManagementAuthority: authority,
          actorAuthority: null,
        });
        d1.batch = batch;
        expect(interleaved).toBe(true);
        expect(created).toBe(false);
        expect(await store.getConnection(raced.connectionId)).toBeUndefined();
        expect(await store.getSecretBlob(raced.connectionId)).toEqual(raced);
      }

      const candidate = { connection: other, secretBlob: secretBlob(other.id), expectedWorkspaceManagementAuthority: authority, actorAuthority: null };
      expect(await store.beginWorkspaceDraining("workspace_1", authority)).toMatchObject({ status: "started" });
      await expect(store.createConnectionRegistration(candidate)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getConnection(other.id)).toBeUndefined();
      expect(await store.getSecretBlob(other.id)).toBeUndefined();
      if (pg || d1) {
        // Re-open only this fixture; a new epoch must not revive old preparation.
        if (pg) await pg.query("update takosumi_workspaces set management_state = 'active', management_epoch = 3 where id = $1", ["workspace_1"]);
        if (d1) await d1.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind("workspace_1").run();
        await expect(store.createConnectionRegistration(candidate)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
        expect(await store.getConnection(other.id)).toBeUndefined();
        expect(await store.getSecretBlob(other.id)).toBeUndefined();
        expect(await store.createConnectionRegistration({ ...candidate,
          expectedWorkspaceManagementAuthority: { ...authority, managementEpoch: 3 } })).toBe(true);
      }
      const operator = connection({ id: "conn_registration_operator", scope: "operator", workspaceId: undefined,
        secretPartition: undefined, credentialRecipe: undefined });
      expect(await store.createConnectionRegistration({ connection: operator, actorAuthority: null })).toBe(true);
      expect(await store.getConnection(operator.id)).toEqual(operator);
      expect(await store.getSecretBlob(operator.id)).toBeUndefined();
      await expect(store.createConnectionRegistration({ connection: { ...operator, id: "conn_hybrid", workspaceId: "workspace_1" }, actorAuthority: null })).rejects.toThrow();
      await expect(store.createConnectionRegistration({ connection: connection({ id: "conn_missing_tuple" }),
        secretBlob: secretBlob("conn_missing_tuple"), actorAuthority: null })).rejects.toThrow();
    } finally {
      await pg?.close();
    }
  });
}

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: connection expiry is an exact monotonic CAS independent of Workspace management`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg
      ? new SqlOpenTofuControlStore({ client: pg })
      : d1
        ? new CloudflareD1OpenTofuControlStore(d1)
        : new InMemoryOpenTofuControlStore();
    const workspaceId = `workspace_connection_expiry_${name.toLowerCase()}`;
    const workspace = {
      id: workspaceId,
      handle: `connection-expiry-${name.toLowerCase()}`,
      displayName: "Connection expiry",
      type: "personal" as const,
      ownerUserId: "connection-expiry-owner",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
    };
    const authority = {
      workspaceId,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    try {
      await store.putWorkspace(workspace);
      const original = connection({
        id: `conn_expiry_${name.toLowerCase()}`,
        workspaceId,
        expiresAt: "2026-06-04T00:10:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      });
      const blob = {
        ...secretBlob(original.id),
        workspaceId,
      };
      expect(await store.createConnectionRegistration({
        connection: original,
        secretBlob: blob,
        expectedWorkspaceManagementAuthority: authority,
        actorAuthority: null,
      })).toBe(true);

      const newer = {
        ...original,
        displayName: "newer observed metadata",
        updatedAt: "2026-06-04T00:05:00.000Z",
      };
      expect(await store.replaceConnectionIfUnchanged(original, newer)).toBe(true);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: original,
        observedAt: "2026-06-04T00:10:00.000Z",
      })).toBe(false);
      expect(await store.getConnection(original.id)).toEqual(newer);
      expect(await store.getSecretBlob(original.id)).toEqual(blob);

      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: newer,
        observedAt: "2026-06-04T00:10:00.000Z",
      })).toBe(true);
      const expired = {
        ...newer,
        status: "expired" as const,
        updatedAt: "2026-06-04T00:10:00.000Z",
      };
      expect(await store.getConnection(original.id)).toEqual(expired);
      expect(await store.getSecretBlob(original.id)).toEqual(blob);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: expired,
        observedAt: "2026-06-04T00:11:00.000Z",
      })).toBe(false);
      expect(await store.getConnection(original.id)).toEqual(expired);

      const revoked = {
        ...expired,
        status: "revoked" as const,
        updatedAt: "2026-06-04T00:12:00.000Z",
      };
      await store.putConnection(revoked);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: revoked,
        observedAt: "2026-06-04T00:13:00.000Z",
      })).toBe(false);
      expect(await store.getConnection(original.id)).toEqual(revoked);

      const future = connection({
        id: `conn_expiry_future_${name.toLowerCase()}`,
        workspaceId,
        expiresAt: "2026-06-04T00:20:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      });
      await store.putConnection(future);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: future,
        observedAt: "2026-06-04T00:10:00.000Z",
      })).toBe(false);
      expect(await store.getConnection(future.id)).toEqual(future);

      const malformed = {
        ...future,
        id: `conn_expiry_malformed_${name.toLowerCase()}`,
        expiresAt: "not-a-timestamp",
      };
      await store.putConnection(malformed);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: malformed,
        observedAt: "2026-06-04T00:30:00.000Z",
      })).toBe(false);
      expect(await store.getConnection(malformed.id)).toEqual(malformed);
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: future,
        observedAt: "not-a-timestamp",
      })).toBe(false);
      expect(await store.getConnection(future.id)).toEqual(future);

      const whileDraining = connection({
        id: `conn_expiry_draining_${name.toLowerCase()}`,
        workspaceId,
        expiresAt: "2026-06-04T00:10:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      });
      await store.putConnection(whileDraining);
      expect(await store.beginWorkspaceDraining(workspaceId, authority)).toMatchObject({
        status: "started",
      });
      expect(await store.markConnectionExpiredIfUnchanged({
        expectedConnection: whileDraining,
        observedAt: "2026-06-04T00:10:00.000Z",
      })).toBe(true);
      expect(await store.getConnection(whileDraining.id)).toEqual({
        ...whileDraining,
        status: "expired",
        updatedAt: "2026-06-04T00:10:00.000Z",
      });
    } finally {
      await pg?.close();
    }
  });
}

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: revocation removes one exact connection and its current blob atomically`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg ? new SqlOpenTofuControlStore({ client: pg })
      : d1 ? new CloudflareD1OpenTofuControlStore(d1) : new InMemoryOpenTofuControlStore();
    try {
      await store.putWorkspace({
        id: "workspace_1", handle: "revocation", displayName: "Revocation", type: "personal",
        ownerUserId: "owner", createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z",
      });
      const row = connection();
      const blob = secretBlob(row.id);
      const authority = { workspaceId: "workspace_1", managementState: "active" as const, managementEpoch: 1 };
      await store.createConnectionRegistration({ connection: row, secretBlob: blob, expectedWorkspaceManagementAuthority: authority, actorAuthority: null });
      const revoke = (expectedConnection = row, expectedWorkspaceManagementAuthority = authority) =>
        store.revokeConnectionIfUnchanged({ expectedConnection, expectedWorkspaceManagementAuthority, actorAuthority: null });
      expect(await revoke({ ...row, displayName: "stale name" })).toBe(false);
      expect(await store.getConnection(row.id)).toEqual(row);
      expect(await store.getSecretBlob(row.id)).toEqual(blob);
      if (pg) {
        // Keep the canonical JSON untouched while drifting a searchable
        // physical field. Revocation must fence both representations.
        await pg.query(
          "update takosumi_connections set status = 'verified' where id = $1",
          [row.id],
        );
        expect(await revoke()).toBe(false);
        expect(await store.getConnection(row.id)).toEqual(row);
        expect(await store.getSecretBlob(row.id)).toEqual(blob);
        await pg.query(
          "update takosumi_connections set status = 'pending' where id = $1",
          [row.id],
        );
      }
      await store.beginWorkspaceDraining("workspace_1", authority);
      await expect(revoke()).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getConnection(row.id)).toEqual(row);
      expect(await store.getSecretBlob(row.id)).toEqual(blob);
      let fresh = authority;
      if (pg || d1) {
        if (pg) await pg.query("update takosumi_workspaces set management_state = 'active', management_epoch = 3 where id = $1", ["workspace_1"]);
        if (d1) await d1.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind("workspace_1").run();
        await expect(revoke()).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
        fresh = { ...authority, managementEpoch: 3 };
        const rotated = { ...blob, ciphertext: "cm90YXRlZA==" };
        await store.putSecretBlob(rotated);
        if (d1) {
          await d1.prepare("CREATE TRIGGER reject_connection_revoke BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT, 'fixture revoke failure'); END").run();
          await expect(revoke(row, fresh)).rejects.toThrow("fixture revoke failure");
          expect(await store.getConnection(row.id)).toEqual(row);
          expect(await store.getSecretBlob(row.id)).toEqual(rotated);
          await d1.prepare("DROP TRIGGER reject_connection_revoke").run();
        }
        if (pg) {
          await pg.query(`
            create function reject_connection_revoke_blob() returns trigger
            language plpgsql
            as $$
            begin
              raise exception 'fixture revoke blob failure';
            end;
            $$
          `);
          await pg.query(`
            create trigger reject_connection_revoke_blob
            before delete on takosumi_connection_secret_blobs
            for each row execute function reject_connection_revoke_blob()
          `);
          // Drizzle wraps the trigger's PostgreSQL error in a generic
          // "Failed query" message, so assert the transaction fails rather
          // than depending on the driver's inner error formatting.
          await expect(revoke(row, fresh)).rejects.toThrow();
          expect(await store.getConnection(row.id)).toEqual(row);
          expect(await store.getSecretBlob(row.id)).toEqual(rotated);
          await pg.query("drop trigger reject_connection_revoke_blob on takosumi_connection_secret_blobs");
          await pg.query("drop function reject_connection_revoke_blob()");
        }
        expect(await revoke(row, fresh)).toBe(true);
        expect(await store.getConnection(row.id)).toBeUndefined();
        expect(await store.getSecretBlob(row.id)).toBeUndefined();
        expect(await revoke(row, fresh)).toBe(false);
      }
      const operator = connection({ id: "conn_revoke_operator", scope: "operator", workspaceId: undefined });
      const operatorBlob = { ...secretBlob(operator.id), workspaceId: undefined };
      await store.createConnectionRegistration({ connection: operator, secretBlob: operatorBlob, actorAuthority: null });
      await expect(store.revokeConnectionIfUnchanged({ expectedConnection: operator, expectedWorkspaceManagementAuthority: authority, actorAuthority: null })).rejects.toThrow();
      expect(await store.revokeConnectionIfUnchanged({ expectedConnection: operator, actorAuthority: null })).toBe(true);
      expect(await store.getConnection(operator.id)).toBeUndefined();
      expect(await store.getSecretBlob(operator.id)).toBeUndefined();
      const orphan = { ...operatorBlob, id: "blob_revoke_orphan", connectionId: "conn_revoke_orphan" };
      await store.putSecretBlob(orphan);
      expect(await store.revokeConnectionIfUnchanged({ expectedConnection: { ...operator, id: orphan.connectionId }, actorAuthority: null })).toBe(false);
      expect(await store.getSecretBlob(orphan.connectionId)).toEqual(orphan);
    } finally {
      await pg?.close();
    }
  });
}

for (const [name, make] of STORES) {
  test(`${name}: Capsule id batches preserve request order and omit misses`, async () => {
    const store = make();
    const capsule = (id: string): Capsule => ({
      id,
      workspaceId: "workspace_1",
      projectId: "project_1",
      name: id,
      slug: id,
      sourceId: "source_1",
      installConfigId: "config_1",
      environment: "production",
      currentStateGeneration: 0,
      status: "active",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    await store.putCapsule(capsule("capsule_a"));
    await store.putCapsule(capsule("capsule_b"));

    expect(
      (await store.getCapsulesByIds(["capsule_b", "missing", "capsule_a"])).map(
        (row) => row.id,
      ),
    ).toEqual(["capsule_b", "capsule_a"]);
    expect(await store.getCapsulesByIds([])).toEqual([]);
  });

  test(`${name}: connection put/get/list/delete round-trip`, async () => {
    const store = make();
    const conn = connection();
    await store.putConnection(conn);

    expect(await store.getConnection(conn.id)).toEqual(conn);

    const other = connection({
      id: "conn_zzzzzzzz11111111",
      workspaceId: "workspace_2",
    });
    await store.putConnection(other);

    const inWorkspace1 = await store.listConnections("workspace_1");
    expect(inWorkspace1.map((c) => c.id)).toEqual([conn.id]);
    const inWorkspace2 = await store.listConnections("workspace_2");
    expect(inWorkspace2.map((c) => c.id)).toEqual([other.id]);

    expect(await store.deleteConnection(conn.id)).toBe(true);
    expect(await store.getConnection(conn.id)).toBeUndefined();
    expect(await store.deleteConnection(conn.id)).toBe(false);
  });

  test(`${name}: secret blob put/get/delete round-trip`, async () => {
    const store = make();
    const blob = secretBlob("conn_abcdef0123456789");
    await store.putSecretBlob(blob);

    expect(await store.getSecretBlob(blob.connectionId)).toEqual(blob);
    expect(await store.deleteSecretBlob(blob.connectionId)).toBe(true);
    expect(await store.getSecretBlob(blob.connectionId)).toBeUndefined();
    expect(await store.deleteSecretBlob(blob.connectionId)).toBe(false);
  });

  test(`${name}: sealed material create-if-absent preserves the first writer`, async () => {
    const store = make();
    const first = secretBlob("runtime_secret_file_capsule_1");
    const competing = { ...first, ciphertext: "Y29tcGV0aW5n" };

    expect(await store.createSecretBlobIfAbsent(first)).toBe(true);
    expect(await store.createSecretBlobIfAbsent(competing)).toBe(false);
    expect(await store.getSecretBlob(first.connectionId)).toEqual(first);
  });

  test(`${name}: listConnections excludes secret material entirely`, async () => {
    const store = make();
    const conn = connection();
    await store.putConnection(conn);
    await store.putSecretBlob(secretBlob(conn.id));

    const listed = await store.listConnections("workspace_1");
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("Y2lwaGVydGV4dA==");
  });

  test(`${name}: activity event put/list newest-first + Workspace-scoped + limit`, async () => {
    const store = make();
    await store.putActivityEvent(
      activityEvent({
        id: "act_a",
        createdAt: "2026-06-06T00:00:01.000Z",
      }),
    );
    await store.putActivityEvent(
      activityEvent({
        id: "act_b",
        action: "run.applied",
        targetType: "run",
        targetId: "apply_1",
        runId: "apply_1",
        metadata: { stateVersionId: "state_1" },
        createdAt: "2026-06-06T00:00:02.000Z",
      }),
    );
    await store.putActivityEvent(
      activityEvent({
        id: "act_other",
        workspaceId: "workspace_2",
        createdAt: "2026-06-06T00:00:03.000Z",
      }),
    );

    const listed = await store.listActivityEvents("workspace_1");
    expect(listed.map((e) => e.id)).toEqual(["act_b", "act_a"]);
    expect(listed[0]!.runId).toBe("apply_1");
    expect(listed[0]!.metadata.stateVersionId).toBe("state_1");

    expect(
      (await store.listActivityEvents("workspace_2")).map((e) => e.id),
    ).toEqual(["act_other"]);
    expect(
      (await store.listActivityEvents("workspace_1", { limit: 1 })).map(
        (e) => e.id,
      ),
    ).toEqual(["act_b"]);
    expect(
      (
        await store.listActivityEventsForWorkspaces(
          ["workspace_1", "workspace_2"],
          { limit: 2 },
        )
      ).map((event) => event.id),
    ).toEqual(["act_other", "act_b"]);
    expect(await store.listActivityEventsForWorkspaces([])).toEqual([]);
    await expect(
      store.listActivityEventsForWorkspaces(
        Array.from({ length: 13 }, (_, index) => `workspace_${index}`),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
}

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "act_default",
    workspaceId: "workspace_1",
    actorId: "user_1",
    action: "capsule.created",
    targetType: "capsule",
    targetId: "capsule_1",
    metadata: { name: "shop" },
    createdAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}
