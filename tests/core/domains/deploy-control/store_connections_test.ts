/**
 * ProviderConnection + secret-blob store symmetry: the in-memory twin and the D1-shaped
 * store must behave identically for the credential-core methods.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
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
