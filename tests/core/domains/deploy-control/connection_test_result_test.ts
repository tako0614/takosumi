import { expect, test } from "bun:test";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  type CommitConnectionTestResultInput,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const now = "2026-06-04T00:00:00.000Z";
const later = "2026-06-04T00:01:00.000Z";
const authority = { workspaceId: "workspace_test", managementState: "active" as const, managementEpoch: 1 };

function connection(): ProviderConnection {
  return {
    id: "conn_test_result", workspaceId: authority.workspaceId, scope: "workspace",
    provider: "registry.opentofu.org/example/service", providerSource: "registry.opentofu.org/example/service",
    secretPartition: "provider-credentials", status: "pending", materialization: "secret",
    envNames: ["EXAMPLE_TOKEN"], createdAt: now, updatedAt: now,
  };
}

function blob(row: ProviderConnection): StoredSecretBlob {
  return {
    id: `blob_${row.id}`, connectionId: row.id, workspaceId: row.workspaceId,
    kind: "provider-credentials", ciphertext: "ZmFrZQ==", encryptedDek: "fixture-dek",
    nonce: "ZmFrZQ==", aad: "fixture-aad", keyVersion: 1, createdAt: now,
  };
}

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: test results require exact material and original Workspace authority`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg ? new SqlOpenTofuControlStore({ client: pg })
      : d1 ? new CloudflareD1OpenTofuControlStore(d1) : new InMemoryOpenTofuControlStore();
    try {
      await store.putWorkspace({
        id: authority.workspaceId, handle: "test-result", displayName: "Test result", type: "personal",
        ownerUserId: "owner", createdAt: now, updatedAt: now,
      });
      const row = connection();
      const material = blob(row);
      await store.createConnectionRegistration({ connection: row, secretBlob: material, expectedWorkspaceManagementAuthority: authority, actorAuthority: null });
      const ownedRow = { ...row, ownerAccountId: "owner" };
      const verified: ProviderConnection = { ...row, status: "verified", verifiedAt: later, updatedAt: later };
      const input: CommitConnectionTestResultInput = {
        expectedConnection: row, expectedSecretBlob: material, replacement: verified,
        expectedWorkspaceManagementAuthority: authority,
        actorAuthority: null,
      };
      await expect(store.commitConnectionTestResult({ ...input, replacement: { ...verified, provider: "other" } })).rejects.toThrow();
      await expect(store.commitConnectionTestResult({ ...input, expectedWorkspaceManagementAuthority: undefined })).rejects.toThrow();
      expect(await store.commitConnectionTestResult({ ...input, expectedConnection: { ...row, displayName: "stale" }, replacement: { ...verified, displayName: "stale" } })).toBe(false);
      const rotated = { ...material, ciphertext: "cm90YXRlZA==", rotatedAt: later };
      await store.putSecretBlob(rotated);
      expect(await store.commitConnectionTestResult(input)).toBe(false);
      expect(await store.getConnection(row.id)).toEqual(ownedRow);
      expect(await store.getSecretBlob(row.id)).toEqual(rotated);
      expect(await store.commitConnectionTestResult({ ...input, expectedSecretBlob: rotated })).toBe(true);
      expect(await store.getConnection(row.id)).toEqual({ ...verified, ownerAccountId: "owner" });
      expect(await store.getSecretBlob(row.id)).toEqual(rotated);
      expect(await store.commitConnectionTestResult({ ...input, expectedSecretBlob: rotated })).toBe(false);

      // Failure cannot overwrite a newer row either, and never mutates material.
      const failedInput = { ...input, expectedConnection: verified, expectedSecretBlob: rotated, replacement: { ...row, updatedAt: later } };
      expect(await store.commitConnectionTestResult(failedInput)).toBe(true);
      await store.beginWorkspaceDraining(authority.workspaceId, authority);
      const pending = (await store.getConnection(row.id))!;
      const pausedInput = { ...input, expectedConnection: pending, expectedSecretBlob: rotated,
        replacement: { ...input.replacement, ownerAccountId: pending.ownerAccountId } };
      await expect(store.commitConnectionTestResult(pausedInput)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getConnection(row.id)).toEqual(pending);
      expect(await store.getSecretBlob(row.id)).toEqual(rotated);
      if (pg || d1) {
        if (pg) await pg.query("update takosumi_workspaces set management_state = 'active', management_epoch = 3 where id = $1", [authority.workspaceId]);
        if (d1) await d1.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind(authority.workspaceId).run();
        await expect(store.commitConnectionTestResult(pausedInput)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
        expect(await store.commitConnectionTestResult({ ...pausedInput, expectedWorkspaceManagementAuthority: { ...authority, managementEpoch: 3 } })).toBe(true);
      }

      // Operator rows have no Workspace fence. Explicit absence still fences a
      // blob inserted after a run-issued/metadata-only credential was tested.
      const operator: ProviderConnection = { ...row, id: "conn_operator_test", scope: "operator", workspaceId: undefined, secretPartition: undefined };
      await store.createConnectionRegistration({ connection: operator, actorAuthority: null });
      const operatorInput: CommitConnectionTestResultInput = {
        expectedConnection: operator, expectedSecretBlob: null,
        replacement: { ...operator, status: "verified", verifiedAt: later, updatedAt: later },
        actorAuthority: null,
      };
      await expect(store.commitConnectionTestResult({ ...operatorInput, expectedWorkspaceManagementAuthority: authority })).rejects.toThrow();
      const unexpected = blob(operator);
      await store.putSecretBlob(unexpected);
      expect(await store.commitConnectionTestResult(operatorInput)).toBe(false);
      expect(await store.getConnection(operator.id)).toEqual(operator);
      expect(await store.getSecretBlob(operator.id)).toEqual(unexpected);
      await store.deleteSecretBlob(operator.id);
      expect(await store.commitConnectionTestResult(operatorInput)).toBe(true);
      expect(await store.getSecretBlob(operator.id)).toBeUndefined();
    } finally {
      await pg?.close();
    }
  });
  test(`${name}: sealed token renewal is atomic and cannot change ownership`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg ? new SqlOpenTofuControlStore({ client: pg })
      : d1 ? new CloudflareD1OpenTofuControlStore(d1) : new InMemoryOpenTofuControlStore();
    try {
      await store.putWorkspace({ id: authority.workspaceId, handle: "renewal", displayName: "Renewal", type: "personal", ownerUserId: "owner", createdAt: now, updatedAt: now });
      const row = connection(); const material = blob(row);
      await store.createConnectionRegistration({ connection: row, secretBlob: material, expectedWorkspaceManagementAuthority: authority, actorAuthority: null });
      const renewed = { ...material, ciphertext: "cmVuZXdlZA==", rotatedAt: later };
      const replacement = { ...row, updatedAt: later };
      const input: CommitConnectionTestResultInput = { expectedConnection: row, expectedSecretBlob: material,
        replacement, replacementSecretBlob: renewed, expectedWorkspaceManagementAuthority: authority, actorAuthority: null };
      await expect(store.commitConnectionTestResult({ ...input, replacementSecretBlob: { ...renewed, connectionId: "another" } })).rejects.toThrow();
      expect(await store.commitConnectionTestResult(input)).toBe(true);
      expect(await store.getConnection(row.id)).toEqual({ ...replacement, ownerAccountId: "owner" });
      expect(await store.getSecretBlob(row.id)).toEqual(renewed);
      expect(await store.commitConnectionTestResult(input)).toBe(false);
      expect(await store.getSecretBlob(row.id)).toEqual(renewed);
      await store.beginWorkspaceDraining(authority.workspaceId, authority);
      await expect(store.commitConnectionTestResult({ ...input, expectedConnection: replacement, expectedSecretBlob: renewed })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getSecretBlob(row.id)).toEqual(renewed);
    } finally { await pg?.close(); }
  });

}

for (const name of ["Postgres", "D1"] as const) {
  test(`${name}: legacy Connection snapshot cannot mutate a changed physical owner`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg
      ? new SqlOpenTofuControlStore({ client: pg })
      : new CloudflareD1OpenTofuControlStore(d1!);
    try {
      await store.putWorkspace({ id: authority.workspaceId, handle: "owner-drift", displayName: "Owner drift",
        type: "personal", ownerUserId: "owner", createdAt: now, updatedAt: now });
      const row = connection();
      const material = blob(row);
      expect(await store.createConnectionRegistration({ connection: row, secretBlob: material,
        expectedWorkspaceManagementAuthority: authority, actorAuthority: null })).toBe(true);
      if (pg) await pg.query("update takosumi_connections set owner_account_id = $2 where id = $1", [row.id, "other-owner"]);
      if (d1) await d1.prepare("update connections set owner_account_id = ? where id = ?").bind("other-owner", row.id).run();
      expect(await store.getConnection(row.id)).toMatchObject({ ownerAccountId: "other-owner" });
      const replacement = { ...row, status: "verified" as const, updatedAt: later, verifiedAt: later };
      expect(await store.replaceConnectionIfUnchanged(row, replacement)).toBe(false);
      expect(await store.replaceConnectionIfUnchanged({ ...row, ownerAccountId: "owner" },
        { ...replacement, ownerAccountId: "owner" })).toBe(false);
      expect(await store.commitConnectionTestResult({ expectedConnection: row, expectedSecretBlob: material,
        replacement, expectedWorkspaceManagementAuthority: authority, actorAuthority: null })).toBe(false);
      expect(await store.revokeConnectionIfUnchanged({ expectedConnection: row,
        expectedWorkspaceManagementAuthority: authority, actorAuthority: null })).toBe(false);
      expect(await store.getSecretBlob(row.id)).toEqual(material);
      expect(await store.getConnection(row.id)).toMatchObject({ status: "pending", ownerAccountId: "other-owner" });
    } finally { await pg?.close(); }
  });
}

for (const name of ["Postgres", "D1"] as const) {
  test(`${name}: pre-ownership Connection snapshots still pass test, expiry and revoke CAS after expand`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.createThroughMigrationVersion(122) : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    try {
      if (d1) await ensureD1OpenTofuLedgerSchema(d1, { throughMigrationVersion: 76 });
      const rows = ["tested", "expired", "revoked"].map((suffix) => ({
        ...connection(), id: `conn_prior_${name.toLowerCase()}_${suffix}`,
        expiresAt: "2026-06-04T00:01:00.000Z",
      }));
      const material = rows.map(blob);
      if (d1) {
        for (const row of rows) {
          await d1.prepare(`insert into connections
            (id,space_id,provider,status,connection_json,created_at,updated_at)
            values (?,?,?,?,?,?,?)`).bind(row.id, row.workspaceId, row.provider,
            row.status, JSON.stringify(row), row.createdAt, row.updatedAt).run();
        }
        await ensureD1OpenTofuLedgerSchema(d1!, { throughMigrationVersion: 77 });
      } else {
        for (const row of rows) {
          await pg!.query(`insert into takosumi_connections
            (id, space_id, provider, status, connection_json, created_at, updated_at)
            values ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [row.id, row.workspaceId,
            row.provider, row.status, JSON.stringify(row), row.createdAt, row.updatedAt]);
        }
        const migration = postgresStorageMigrationStatements.find((item) => item.version === 123);
        expect(migration?.id).toBe("deploy.app_ownership.expand");
        for (const statement of splitSqlStatements(migration!.sql)) await pg!.query(statement);
      }
      const store: OpenTofuControlStore = pg ? new SqlOpenTofuControlStore({ client: pg })
        : new CloudflareD1OpenTofuControlStore(d1!, { schemaMode: "predeployed" });
      await store.putWorkspace({ id: authority.workspaceId, handle: "prior-connection",
        displayName: "Prior Connection", type: "personal", ownerUserId: "owner",
        createdAt: now, updatedAt: now });
      for (const item of material) await store.putSecretBlob(item);
      for (const row of rows) {
        expect(await store.getConnection(row.id), `${name}:${row.id}:prior`).toEqual(row);
      }
      const verified = { ...rows[0]!, status: "verified" as const, verifiedAt: later, updatedAt: later };
      expect(await store.commitConnectionTestResult({ expectedConnection: rows[0]!,
        expectedSecretBlob: material[0]!, replacement: verified,
        expectedWorkspaceManagementAuthority: authority, actorAuthority: null }), `${name}:test`).toBe(true);
      expect((await store.getConnection(rows[0]!.id))?.status).toBe("verified");
      expect(await store.markConnectionExpiredIfUnchanged({ expectedConnection: rows[1]!,
        observedAt: later }), `${name}:expiry`).toBe(true);
      expect((await store.getConnection(rows[1]!.id))?.status).toBe("expired");
      expect(await store.revokeConnectionIfUnchanged({ expectedConnection: rows[2]!,
        expectedWorkspaceManagementAuthority: authority, actorAuthority: null }), `${name}:revoke`).toBe(true);
      expect(await store.getConnection(rows[2]!.id)).toBeUndefined();
      expect(await store.getSecretBlob(rows[2]!.id)).toBeUndefined();
    } finally { await pg?.close(); }
  });
}
