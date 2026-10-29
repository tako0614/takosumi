import { expect, test } from "bun:test";

import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type { D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";
import {
  WorkspaceManagementAdmissionConflictError,
  type CapsuleInitialAuthorityInput,
} from "../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const workspaceId = "workspace_d1_source_guard";
const sourceId = "source_d1_source_guard";
const now = "2026-10-28T00:00:00.000Z";

class InterleavedD1 extends SqliteFakeD1 {
  beforeNextBatch?: () => Promise<void>;

  override async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    if (hook) await hook();
    return await super.batch<T>(statements);
  }
}

async function setup() {
  const db = new InterleavedD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace({
    id: workspaceId, handle: "d1-source-guard", displayName: "D1 Source guard",
    type: "personal", ownerUserId: "owner_d1_source_guard",
    createdAt: now, updatedAt: now,
  });
  await store.putSource({
    id: sourceId, workspaceId, name: "repo", url: "https://example.com/repo.git",
    defaultRef: "main", defaultPath: ".", status: "active", autoSync: true,
    hookSecretHash: "hash", createdAt: now, updatedAt: now,
  });
  return { db, store };
}

function authority(): CapsuleInitialAuthorityInput {
  const capsuleId = "capsule_d1_source_guard";
  const installConfig: InstallConfig = {
    id: "config_d1_source_guard", workspaceId, name: "app",
    variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: now, updatedAt: now,
  };
  const capsule: Capsule = {
    id: capsuleId, workspaceId, projectId: "project_d1_source_guard",
    name: "app", slug: "app", sourceId, installConfigId: installConfig.id,
    installingPrincipalId: "principal_d1_source_guard", environment: "production",
    currentStateGeneration: 0, status: "pending", createdAt: now, updatedAt: now,
  };
  const providerBindingSet: ProviderBindingSet = {
    id: "bindings_d1_source_guard", workspaceId, capsuleId,
    environment: "production", bindings: [], createdAt: now, updatedAt: now,
  };
  return { installConfig, capsule, providerBindingSet };
}

test("D1 classifies a raced same-Workspace Source reference as Source ownership", async () => {
  const { db, store } = await setup();
  const input = authority();
  db.beforeNextBatch = async () => {
    await store.putCapsule({
      ...input.capsule, id: "capsule_other_d1_source_guard",
      name: "other", slug: "other", status: "destroyed",
    });
  };

  expect(await store.createCapsuleInitialAuthority(input))
    .toEqual({ status: "source_owned_by_another_app" });
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
  expect(await store.getInstallConfig(input.installConfig.id)).toBeUndefined();
  expect(await store.getCapsule(input.capsule.id)).toBeUndefined();
});

test("D1 keeps a raced Workspace admission failure distinct from a Source guard", async () => {
  const { db, store } = await setup();
  const input = authority();
  db.beforeNextBatch = async () => {
    expect((await store.beginWorkspaceDraining(workspaceId, {
      workspaceId, managementState: "active", managementEpoch: 1,
    })).status).toBe("started");
  };

  await expect(store.createCapsuleInitialAuthority(input))
    .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
  expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
  expect(await store.getCapsule(input.capsule.id)).toBeUndefined();
});

test("D1 rolls back a claim when retirement wins after its eligibility read", async () => {
  for (const status of ["active", "disabled"] as const) {
    const { db, store } = await setup();
    const input = authority();
    db.beforeNextBatch = async () => {
      const source = (await store.getSource(sourceId))!;
      await store.putSource({ ...source, status, retiringAt: now, autoSync: false });
    };
    expect(await store.createCapsuleInitialAuthority(input)).toEqual({ status: "conflict" });
    expect((await store.getSource(sourceId))?.ownerCapsuleId).toBeUndefined();
    expect(await store.getCapsule(input.capsule.id)).toBeUndefined();
    expect(await store.getInstallConfig(input.installConfig.id)).toBeUndefined();
  }
});
