import { expect, test } from "bun:test";

import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import {
  InMemoryOpenTofuControlStore,
  type ConnectionActorAuthority,
  type OpenTofuControlStore,
  type StoredSecretBlob,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-09-10T00:00:00.000Z";
const LATER = "2026-09-10T00:01:00.000Z";
const BACKENDS = ["Memory", "Postgres", "D1"] as const;
type Backend = (typeof BACKENDS)[number];

interface StoreFixture {
  readonly store: OpenTofuControlStore;
  readonly close: () => Promise<void>;
}

async function openStore(backend: Backend): Promise<StoreFixture> {
  if (backend === "Postgres") {
    const client = await PGliteSqlClient.create();
    return {
      store: new SqlOpenTofuControlStore({ client }),
      close: () => client.close(),
    };
  }
  if (backend === "D1") {
    return {
      store: new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
      close: async () => {},
    };
  }
  return {
    store: new InMemoryOpenTofuControlStore(),
    close: async () => {},
  };
}

function workspace(id: string, ownerUserId: string): Workspace {
  return {
    id,
    handle: `connection-actor-${id}`,
    displayName: "Connection actor fixture",
    type: "personal",
    ownerUserId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function member(
  workspaceId: string,
  accountId: string,
  overrides: Partial<WorkspaceMember> = {},
): WorkspaceMember {
  return {
    id: `member_${workspaceId}_${accountId}`,
    workspaceId,
    accountId,
    roles: ["admin"],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function connection(id: string, workspaceId: string): ProviderConnection {
  return {
    id,
    workspaceId,
    scope: "workspace",
    provider: "registry.opentofu.org/example/example",
    providerSource: "registry.opentofu.org/example/example",
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
    envNames: ["EXAMPLE_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function secretBlob(row: ProviderConnection): StoredSecretBlob {
  return {
    id: `blob_${row.id}`,
    connectionId: row.id,
    workspaceId: row.workspaceId,
    kind: "provider-credentials",
    ciphertext: "ZmFrZS1jaXBoZXJ0ZXh0",
    encryptedDek: "fixture-dek",
    nonce: "ZmFrZS1ub25jZQ==",
    aad: "fixture-aad",
    keyVersion: 1,
    createdAt: NOW,
  };
}

async function activeManagementAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error(`Workspace ${workspaceId} was not active in the fixture`);
  }
  return {
    workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

async function actorAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
  actorAccountId: string,
): Promise<ConnectionActorAuthority> {
  const expectedWorkspace = await store.getWorkspace(workspaceId);
  if (!expectedWorkspace) throw new Error(`Workspace ${workspaceId} is missing`);
  const expectedActor = await store.getWorkspaceMember(
    workspaceId,
    actorAccountId,
  );
  return {
    actorAccountId,
    expectedWorkspace: structuredClone(expectedWorkspace),
    ...(expectedActor === undefined
      ? {}
      : { expectedActor: structuredClone(expectedActor) }),
  };
}

for (const backend of BACKENDS) {
  test(`${backend}: active Workspace admin can register a Connection and sealed blob as one pair`, async () => {
    const fixture = await openStore(backend);
    try {
      const ws = workspace(`registration-${backend.toLowerCase()}`, "namespace-owner");
      await fixture.store.putWorkspace(ws);
      await fixture.store.putWorkspaceMember(member(ws.id, "account-admin"));
      const management = await activeManagementAuthority(fixture.store, ws.id);
      const actor = await actorAuthority(fixture.store, ws.id, "account-admin");
      const row = connection(`conn_admin_${backend.toLowerCase()}`, ws.id);
      const blob = secretBlob(row);

      expect(
        await fixture.store.createConnectionRegistration({
          connection: row,
          secretBlob: blob,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: actor,
        }),
      ).toBe(true);
      expect(await fixture.store.getConnection(row.id)).toEqual(row);
      expect(await fixture.store.getSecretBlob(row.id)).toEqual(blob);
    } finally {
      await fixture.close();
    }
  });
}

for (const backend of BACKENDS) {
  test(`${backend}: a same-epoch admin suspension or demotion fences all Connection mutations`, async () => {
    const fixture = await openStore(backend);
    try {
      for (const mutation of ["suspend", "demote"] as const) {
        const ws = workspace(
          `${mutation}-${backend.toLowerCase()}`,
          "namespace-owner",
        );
        await fixture.store.putWorkspace(ws);
        const admin = member(ws.id, "account-admin");
        await fixture.store.putWorkspaceMember(admin);
        const management = await activeManagementAuthority(fixture.store, ws.id);
        const actor = await actorAuthority(fixture.store, ws.id, admin.accountId);
        const row = connection(
          `conn_existing_${mutation}_${backend.toLowerCase()}`,
          ws.id,
        );
        const blob = secretBlob(row);
        expect(
          await fixture.store.createConnectionRegistration({
            connection: row,
            secretBlob: blob,
            expectedWorkspaceManagementAuthority: management,
            actorAuthority: actor,
          }),
        ).toBe(true);
        const beforeRow = structuredClone(await fixture.store.getConnection(row.id));
        const beforeBlob = structuredClone(await fixture.store.getSecretBlob(row.id));
        expect(beforeRow).toEqual(row);
        expect(beforeBlob).toEqual(blob);

        const changedAdmin = mutation === "suspend"
          ? { ...admin, status: "suspended" as const }
          : { ...admin, roles: ["member"] as const };
        await fixture.store.putWorkspaceMember(changedAdmin);
        expect(
          await fixture.store.getWorkspaceMember(ws.id, admin.accountId),
        ).toEqual(changedAdmin);

        const candidate = connection(
          `conn_candidate_${mutation}_${backend.toLowerCase()}`,
          ws.id,
        );
        const candidateBlob = secretBlob(candidate);
        expect(
          await fixture.store.createConnectionRegistration({
            connection: candidate,
            secretBlob: candidateBlob,
            expectedWorkspaceManagementAuthority: management,
            actorAuthority: actor,
          }),
        ).toBe(false);
        expect(await fixture.store.getConnection(candidate.id)).toBeUndefined();
        expect(await fixture.store.getSecretBlob(candidate.id)).toBeUndefined();

        const verified = {
          ...row,
          status: "verified" as const,
          verifiedAt: LATER,
          updatedAt: LATER,
        };
        expect(
          await fixture.store.commitConnectionTestResult({
            expectedConnection: row,
            expectedSecretBlob: blob,
            replacement: verified,
            expectedWorkspaceManagementAuthority: management,
            actorAuthority: actor,
          }),
        ).toBe(false);
        expect(await fixture.store.getConnection(row.id)).toEqual(beforeRow);
        expect(await fixture.store.getSecretBlob(row.id)).toEqual(beforeBlob);

        expect(
          await fixture.store.revokeConnectionIfUnchanged({
            expectedConnection: row,
            expectedWorkspaceManagementAuthority: management,
            actorAuthority: actor,
          }),
        ).toBe(false);
        expect(await fixture.store.getConnection(row.id)).toEqual(beforeRow);
        expect(await fixture.store.getSecretBlob(row.id)).toEqual(beforeBlob);
      }
    } finally {
      await fixture.close();
    }
  });
}

for (const backend of BACKENDS) {
  test(`${backend}: namespace owner without a roster succeeds, omitted actor authority rejects, and null is trusted internal authority`, async () => {
    const fixture = await openStore(backend);
    try {
      const ownerWorkspace = workspace(
        `owner-${backend.toLowerCase()}`,
        "namespace-owner",
      );
      await fixture.store.putWorkspace(ownerWorkspace);
      expect(
        await fixture.store.getWorkspaceMember(ownerWorkspace.id, ownerWorkspace.ownerUserId),
      ).toBeUndefined();
      const management = await activeManagementAuthority(
        fixture.store,
        ownerWorkspace.id,
      );
      const owner = await actorAuthority(
        fixture.store,
        ownerWorkspace.id,
        ownerWorkspace.ownerUserId,
      );
      expect(owner.expectedActor).toBeUndefined();
      const ownerRow = connection(
        `conn_owner_${backend.toLowerCase()}`,
        ownerWorkspace.id,
      );
      const ownerBlob = secretBlob(ownerRow);
      expect(
        await fixture.store.createConnectionRegistration({
          connection: ownerRow,
          secretBlob: ownerBlob,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: owner,
        }),
      ).toBe(true);
      const ownerReplacement = {
        ...ownerRow,
        status: "verified" as const,
        verifiedAt: LATER,
        updatedAt: LATER,
      };
      await expect(
        fixture.store.commitConnectionTestResult({
          expectedConnection: ownerRow,
          expectedSecretBlob: ownerBlob,
          replacement: ownerReplacement,
          expectedWorkspaceManagementAuthority: management,
        } as never),
      ).rejects.toThrow(
        "Connection mutation requires explicit internal or Workspace account authority",
      );
      expect(await fixture.store.getConnection(ownerRow.id)).toEqual(ownerRow);
      expect(await fixture.store.getSecretBlob(ownerRow.id)).toEqual(ownerBlob);
      expect(
        await fixture.store.commitConnectionTestResult({
          expectedConnection: ownerRow,
          expectedSecretBlob: ownerBlob,
          replacement: ownerReplacement,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: owner,
        }),
      ).toBe(true);
      expect(await fixture.store.getConnection(ownerRow.id)).toEqual(ownerReplacement);
      expect(await fixture.store.getSecretBlob(ownerRow.id)).toEqual(ownerBlob);
      await expect(
        fixture.store.revokeConnectionIfUnchanged({
          expectedConnection: ownerReplacement,
          expectedWorkspaceManagementAuthority: management,
        } as never),
      ).rejects.toThrow(
        "Connection mutation requires explicit internal or Workspace account authority",
      );
      expect(await fixture.store.getConnection(ownerRow.id)).toEqual(ownerReplacement);
      expect(await fixture.store.getSecretBlob(ownerRow.id)).toEqual(ownerBlob);
      expect(
        await fixture.store.revokeConnectionIfUnchanged({
          expectedConnection: ownerReplacement,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: owner,
        }),
      ).toBe(true);
      expect(await fixture.store.getConnection(ownerRow.id)).toBeUndefined();
      expect(await fixture.store.getSecretBlob(ownerRow.id)).toBeUndefined();

      const omittedRow = connection(
        `conn_omitted_${backend.toLowerCase()}`,
        ownerWorkspace.id,
      );
      const omittedBlob = secretBlob(omittedRow);
      await expect(
        fixture.store.createConnectionRegistration({
          connection: omittedRow,
          secretBlob: omittedBlob,
          expectedWorkspaceManagementAuthority: management,
        } as never),
      ).rejects.toThrow(
        "Connection mutation requires explicit internal or Workspace account authority",
      );
      expect(await fixture.store.getConnection(omittedRow.id)).toBeUndefined();
      expect(await fixture.store.getSecretBlob(omittedRow.id)).toBeUndefined();

      const internalRow = connection(
        `conn_internal_${backend.toLowerCase()}`,
        ownerWorkspace.id,
      );
      const internalBlob = secretBlob(internalRow);
      expect(
        await fixture.store.createConnectionRegistration({
          connection: internalRow,
          secretBlob: internalBlob,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: null,
        }),
      ).toBe(true);
      const internalReplacement = {
        ...internalRow,
        status: "verified" as const,
        verifiedAt: LATER,
        updatedAt: LATER,
      };
      expect(
        await fixture.store.commitConnectionTestResult({
          expectedConnection: internalRow,
          expectedSecretBlob: internalBlob,
          replacement: internalReplacement,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: null,
        }),
      ).toBe(true);
      expect(await fixture.store.getConnection(internalRow.id)).toEqual(internalReplacement);
      expect(await fixture.store.getSecretBlob(internalRow.id)).toEqual(internalBlob);
      expect(
        await fixture.store.revokeConnectionIfUnchanged({
          expectedConnection: internalReplacement,
          expectedWorkspaceManagementAuthority: management,
          actorAuthority: null,
        }),
      ).toBe(true);
      expect(await fixture.store.getConnection(internalRow.id)).toBeUndefined();
      expect(await fixture.store.getSecretBlob(internalRow.id)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
}
