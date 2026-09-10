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
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
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
      expect(await store.getConnection(row.id)).toEqual(row);
      expect(await store.getSecretBlob(row.id)).toEqual(rotated);
      expect(await store.commitConnectionTestResult({ ...input, expectedSecretBlob: rotated })).toBe(true);
      expect(await store.getConnection(row.id)).toEqual(verified);
      expect(await store.getSecretBlob(row.id)).toEqual(rotated);
      expect(await store.commitConnectionTestResult({ ...input, expectedSecretBlob: rotated })).toBe(false);

      // Failure cannot overwrite a newer row either, and never mutates material.
      const failedInput = { ...input, expectedConnection: verified, expectedSecretBlob: rotated, replacement: { ...row, updatedAt: later } };
      expect(await store.commitConnectionTestResult(failedInput)).toBe(true);
      await store.beginWorkspaceDraining(authority.workspaceId, authority);
      const pending = (await store.getConnection(row.id))!;
      const pausedInput = { ...input, expectedConnection: pending, expectedSecretBlob: rotated };
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
}
