import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type {
  Capsule,
  InstallConfig,
} from "takosumi-contract/install-configs";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Workspace } from "takosumi-contract/workspaces";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  CapsulePlanCreationFenceConflictError,
  WorkspaceManagementAdmissionConflictError,
  InMemoryOpenTofuControlStore,
  planRunExecutionInputsDigestMaterial,
  type CapsuleInstallConfigRebindInput,
  type CapsuleInitialAuthorityInput,
  type OpenTofuControlStore,
  type PlanRunInputs,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const NOW = "2026-09-04T00:00:00.000Z";
const LATER = "2026-09-04T00:00:01.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function installConfig(id: string, workspaceId?: string): InstallConfig {
  return {
    id,
    ...(workspaceId ? { workspaceId } : {}),
    name: id,
    variableMapping: { region: "ap-northeast-1" },
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workspace(id: string): Workspace {
  return {
    id,
    handle: id.replace(/[^a-z0-9-]/gu, "-").slice(0, 39),
    displayName: id,
    type: "personal",
    ownerUserId: `owner_${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function capsule(
  id: string,
  installConfigId: string,
  status: Capsule["status"] = "pending",
): Capsule {
  return {
    id,
    workspaceId: `workspace_${id}`,
    projectId: `project_${id}`,
    name: id,
    slug: id,
    sourceId: `source_${id}`,
    installConfigId,
    installingPrincipalId: `principal_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function initialAuthority(suffix: string, workspaceId?: string): CapsuleInitialAuthorityInput {
  const row = {
    ...capsule(`capsule_initial_${suffix}`, `config_initial_${suffix}`),
    ...(workspaceId ? { workspaceId } : {}),
  };
  const config = installConfig(row.installConfigId, row.workspaceId);
  const providerBindingSet: ProviderBindingSet = {
    id: `binding_initial_${suffix}`,
    workspaceId: row.workspaceId,
    capsuleId: row.id,
    environment: row.environment,
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { installConfig: config, capsule: row, providerBindingSet };
}

async function configurationPlanPreparation(
  authority: CapsuleInitialAuthorityInput,
  suffix: string,
): Promise<{ readonly run: PlanRun; readonly inputs: PlanRunInputs }> {
  const runId = `plan_configuration_${suffix}`;
  const inputs: PlanRunInputs = { planRunId: runId, variables: {} };
  return {
    inputs,
    run: {
      id: runId,
      workspaceId: authority.capsule.workspaceId,
      capsuleId: authority.capsule.id,
      capsuleContext: {
        workspaceId: authority.capsule.workspaceId,
        capsuleId: authority.capsule.id,
        environment: authority.capsule.environment,
      },
      source: {
        kind: "git",
        url: "https://example.com/acme/configuration.git",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      sourceDigest: `sha256:${"1".repeat(64)}`,
      operation: "create",
      runnerProfileId: "opentofu-default",
      variablesDigest: await stableJsonDigest(inputs.variables),
      executionInputsDigest: await stableJsonDigest(
        planRunExecutionInputsDigestMaterial(inputs, undefined),
      ),
      requiredProviders: [],
      requiredProviderRequirements: [],
      status: "queued",
      policy: { status: "passed", reasons: [], checkedAt: 1 },
      policyDecisionDigest: `sha256:${"2".repeat(64)}`,
      baseStateGeneration: 0,
      capsuleExecutionAuthorityEpoch: 1,
      auditEvents: [],
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

test("initial Capsule authority is one create-only atomic unit across every store", async () => {
  for (const [label, store] of await stores()) {
    const concurrent = initialAuthority(`${label}_concurrent`);
    await store.putWorkspace(workspace(concurrent.capsule.workspaceId));
    const concurrentResults = await Promise.all([
      store.createCapsuleInitialAuthority(concurrent),
      store.createCapsuleInitialAuthority(concurrent),
    ]);
    expect(concurrentResults.map((result) => result.status).sort()).toEqual([
      "created",
      "replayed",
    ]);

    const input = initialAuthority(label);
    await store.putWorkspace(workspace(input.capsule.workspaceId));
    expect(await store.createCapsuleInitialAuthority(input)).toEqual({
      status: "created",
      capsule: input.capsule,
    });
    expect(await store.getInstallConfig(input.installConfig.id)).toEqual(
      input.installConfig,
    );
    expect(await store.getCapsule(input.capsule.id)).toEqual(input.capsule);
    expect(
      await store.getProviderBindingSetByCapsule(
        input.capsule.id,
        input.capsule.environment,
      ),
    ).toEqual(input.providerBindingSet);
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(input.capsule.id),
    ).toBe(1);

    expect(await store.createCapsuleInitialAuthority(input)).toEqual({
      status: "replayed",
      capsule: input.capsule,
    });
    const conflicting: CapsuleInitialAuthorityInput = {
      ...input,
      installConfig: {
        ...input.installConfig,
        variableMapping: { region: "must-not-overwrite" },
      },
    };
    expect(await store.createCapsuleInitialAuthority(conflicting)).toEqual({
      status: "conflict",
    });
    expect(await store.getInstallConfig(input.installConfig.id)).toEqual(
      input.installConfig,
    );
    expect(await store.getCapsule(input.capsule.id)).toEqual(input.capsule);

    const partial = initialAuthority(`${label}_partial`);
    await store.putWorkspace(workspace(partial.capsule.workspaceId));
    await store.putInstallConfig(partial.installConfig);
    expect(await store.createCapsuleInitialAuthority(partial)).toEqual({
      status: "conflict",
    });
    expect(await store.getCapsule(partial.capsule.id)).toBeUndefined();
    expect(
      await store.getProviderBindingSetByCapsule(
        partial.capsule.id,
        partial.capsule.environment,
      ),
    ).toBeUndefined();
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(partial.capsule.id),
    ).toBeUndefined();

    const occupiedSlot = initialAuthority(`${label}_occupied_slot`);
    await store.putWorkspace(workspace(occupiedSlot.capsule.workspaceId));
    const occupyingAuthority: CapsuleInitialAuthorityInput = {
      ...occupiedSlot,
      providerBindingSet: {
        ...occupiedSlot.providerBindingSet,
        id: `${occupiedSlot.providerBindingSet.id}_other`,
      },
    };
    expect(await store.createCapsuleInitialAuthority(occupyingAuthority)).toEqual({
      status: "created",
      capsule: occupiedSlot.capsule,
    });
    expect(await store.createCapsuleInitialAuthority(occupiedSlot)).toEqual({
      status: "conflict",
    });
    expect(await store.getInstallConfig(occupiedSlot.installConfig.id)).toEqual(
      occupiedSlot.installConfig,
    );
    expect(await store.getCapsule(occupiedSlot.capsule.id)).toEqual(
      occupiedSlot.capsule,
    );
    expect(
      await store.getProviderBindingSetByCapsule(
        occupiedSlot.capsule.id,
        occupiedSlot.capsule.environment,
      ),
    ).toEqual(occupyingAuthority.providerBindingSet);
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(occupiedSlot.capsule.id),
    ).toBe(1);
  }
});

test("Workspace drain refuses new initial authority without stranding exact replay", async () => {
  const outcomes: string[] = [];
  for (const [label, store] of await stores()) {
    const existing = initialAuthority(`${label}_management_existing`);
    const workspaceId = existing.capsule.workspaceId;
    await store.putWorkspace(workspace(workspaceId));
    await store.createCapsuleInitialAuthority(existing);
    const management = { workspaceId, managementState: "active" as const, managementEpoch: 1 };
    const stale = initialAuthority(`${label}_management_stale`, workspaceId);
    await expect(store.createCapsuleInitialAuthority({
      ...stale,
      expectedWorkspaceManagementAuthority: { ...management, managementEpoch: 2 },
    })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await store.getInstallConfig(stale.installConfig.id)).toBeUndefined();
    await expect(store.createCapsuleInitialAuthority(initialAuthority(`${label}_missing_workspace`)))
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await store.beginWorkspaceDraining(workspaceId, management);
    expect(await store.createCapsuleInitialAuthority(existing)).toMatchObject({ status: "replayed" });
    const fresh = initialAuthority(`${label}_management_new`, workspaceId);
    const outcome = await store.createCapsuleInitialAuthority(fresh).then(
      (result) => result.status,
      (error) => error instanceof WorkspaceManagementAdmissionConflictError ? "refused" : "unexpected_error",
    );
    outcomes.push(`${label}:${outcome}`);
    if (outcome === "refused") {
      expect(await store.getCapsule(fresh.capsule.id)).toBeUndefined();
      expect(await store.getInstallConfig(fresh.installConfig.id)).toBeUndefined();
      expect(await store.getProviderBindingSetByCapsule(fresh.capsule.id, fresh.capsule.environment)).toBeUndefined();
      expect(await store.getCapsuleExecutionAuthorityEpoch(fresh.capsule.id)).toBeUndefined();
    }
  }
  expect(outcomes).toEqual(["memory:refused", "postgres:refused", "d1:refused"]);
});

test("Workspace drain refuses new successor configs while retaining existing config observations", async () => {
  const outcomes: string[] = [];
  for (const [label, store] of await stores()) {
    const workspaceId = `workspace_config_${label}`;
    await store.putWorkspace(workspace(workspaceId));
    const existing = installConfig(`config_existing_${label}`, workspaceId);
    expect(await store.createInstallConfigIfAbsent(existing)).toBe(true);
    await store.beginWorkspaceDraining(workspaceId, {
      workspaceId,
      managementState: "active",
      managementEpoch: 1,
    });
    expect(await store.createInstallConfigIfAbsent(existing)).toBe(false);
    expect(await store.getInstallConfig(existing.id)).toEqual(existing);
    const fresh = installConfig(`config_fresh_${label}`, workspaceId);
    const outcome = await store.createInstallConfigIfAbsent(fresh).then(
      (created) => created ? "created" : "existing",
      (error) => {
        if (error instanceof WorkspaceManagementAdmissionConflictError) return "refused";
        throw error;
      },
    );
    outcomes.push(`${label}:${outcome}`);
    if (outcome === "refused") {
      expect(await store.getInstallConfig(fresh.id)).toBeUndefined();
    }
  }
  expect(outcomes).toEqual(["memory:refused", "postgres:refused", "d1:refused"]);
});

test("Workspace management fences Capsule InstallConfig rebind across adapters", async () => {
  for (const [label, store] of await stores()) {
    const existing = initialAuthority(
      `${label}_rebind_existing`,
      `ws_${label}_rebind_existing`,
    );
    const workspaceId = existing.capsule.workspaceId;
    await store.putWorkspace(workspace(workspaceId));
    expect(await store.createCapsuleInitialAuthority(existing), label).toMatchObject({
      status: "created",
    });
    const target = installConfig(`config_${label}_rebind_target`, workspaceId);
    await store.putInstallConfig(target);
    const authority: WorkspaceManagementAuthority = {
      workspaceId,
      managementState: "active",
      managementEpoch: 1,
    };
    const rebindInput = async (
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ): Promise<CapsuleInstallConfigRebindInput> => ({
      capsuleId: existing.capsule.id,
      targetInstallConfigId: target.id,
      expectedWorkspaceManagementAuthority,
      expected: {
        installConfigId: existing.installConfig.id,
        installConfigDigest: await stableJsonDigest(existing.installConfig),
        targetInstallConfigDigest: await stableJsonDigest(target),
        currentStateGeneration: existing.capsule.currentStateGeneration,
        currentStateVersionId: existing.capsule.currentStateVersionId,
        status: existing.capsule.status,
        executionAuthorityEpoch: 1,
      },
      updatedAt: LATER,
    });
    const assertUnchanged = async () => {
      expect(await store.getCapsule(existing.capsule.id), label).toEqual(
        existing.capsule,
      );
      expect(
        await store.getCapsuleExecutionAuthorityEpoch(existing.capsule.id),
        label,
      ).toBe(1);
      expect(
        await store.getProviderBindingSetByCapsule(
          existing.capsule.id,
          existing.capsule.environment,
        ),
        label,
      ).toEqual(existing.providerBindingSet);
    };

    // A stale captured epoch is rejected even while the Workspace is active.
    await expect(
      store.rebindCapsuleInstallConfig(
        await rebindInput({ ...authority, managementEpoch: 2 }),
      ),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await assertUnchanged();

    await store.beginWorkspaceDraining(workspaceId, authority);
    // A new rebind captured before the drain cannot publish after it.
    await expect(
      store.rebindCapsuleInstallConfig(await rebindInput(authority)),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await assertUnchanged();

    // A Capsule whose Workspace row is absent is never admitted, even when
    // the optional authority is omitted.
    const missingWorkspaceCapsule = capsule(
      `${label}_rebind_missing_workspace`,
      `config_${label}_rebind_missing_previous`,
    );
    const missingPrevious = installConfig(
      missingWorkspaceCapsule.installConfigId,
      missingWorkspaceCapsule.workspaceId,
    );
    const missingTarget = installConfig(
      `config_${label}_rebind_missing_target`,
      missingWorkspaceCapsule.workspaceId,
    );
    await store.putInstallConfig(missingPrevious);
    await store.putInstallConfig(missingTarget);
    await store.putCapsule(missingWorkspaceCapsule);
    await expect(
      store.rebindCapsuleInstallConfig({
        capsuleId: missingWorkspaceCapsule.id,
        targetInstallConfigId: missingTarget.id,
        expected: {
          installConfigId: missingPrevious.id,
          installConfigDigest: await stableJsonDigest(missingPrevious),
          targetInstallConfigDigest: await stableJsonDigest(missingTarget),
          currentStateGeneration: missingWorkspaceCapsule.currentStateGeneration,
          currentStateVersionId: missingWorkspaceCapsule.currentStateVersionId,
          status: missingWorkspaceCapsule.status,
          executionAuthorityEpoch: 1,
        },
        updatedAt: LATER,
      }),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await store.getCapsule(missingWorkspaceCapsule.id), label).toEqual(
      missingWorkspaceCapsule,
    );
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(missingWorkspaceCapsule.id),
      label,
    ).toBe(1);

    // An exact completed rebind remains a read-only replay after draining.
    const replayExisting = initialAuthority(
      `${label}_rebind_replay`,
      `ws_${label}_rebind_replay`,
    );
    const replayWorkspaceId = replayExisting.capsule.workspaceId;
    await store.putWorkspace(workspace(replayWorkspaceId));
    expect(await store.createCapsuleInitialAuthority(replayExisting), label).toMatchObject({
      status: "created",
    });
    const replayTarget = installConfig(
      `config_${label}_rebind_replay_target`,
      replayWorkspaceId,
    );
    await store.putInstallConfig(replayTarget);
    const replayInput: CapsuleInstallConfigRebindInput = {
      capsuleId: replayExisting.capsule.id,
      targetInstallConfigId: replayTarget.id,
      expectedWorkspaceManagementAuthority: {
        workspaceId: replayWorkspaceId,
        managementState: "active",
        managementEpoch: 1,
      },
      expected: {
        installConfigId: replayExisting.installConfig.id,
        installConfigDigest: await stableJsonDigest(replayExisting.installConfig),
        targetInstallConfigDigest: await stableJsonDigest(replayTarget),
        currentStateGeneration: replayExisting.capsule.currentStateGeneration,
        currentStateVersionId: replayExisting.capsule.currentStateVersionId,
        status: replayExisting.capsule.status,
        executionAuthorityEpoch: 1,
      },
      updatedAt: LATER,
    };
    expect(
      await store.rebindCapsuleInstallConfig(replayInput),
      label,
    ).toMatchObject({
      status: "updated",
      capsule: { installConfigId: replayTarget.id },
    });
    const reboundCapsule = await store.getCapsule(replayExisting.capsule.id);
    const reboundBinding = await store.getProviderBindingSetByCapsule(
      replayExisting.capsule.id,
      replayExisting.capsule.environment,
    );
    const reboundEpoch = await store.getCapsuleExecutionAuthorityEpoch(
      replayExisting.capsule.id,
    );
    expect(await store.beginWorkspaceDraining(replayWorkspaceId, {
      workspaceId: replayWorkspaceId,
      managementState: "active",
      managementEpoch: 1,
    }), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });
    expect(await store.rebindCapsuleInstallConfig(replayInput), label).toEqual({
      status: "replayed",
      capsule: reboundCapsule,
    });
    expect(await store.getCapsule(replayExisting.capsule.id), label).toEqual(
      reboundCapsule,
    );
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(replayExisting.capsule.id),
      label,
    ).toBe(reboundEpoch);
    expect(
      await store.getProviderBindingSetByCapsule(
        replayExisting.capsule.id,
        replayExisting.capsule.environment,
      ),
      label,
    ).toEqual(reboundBinding);
  }
});

test("configuration Plan preparation fences Capsule authority in every store", async () => {
  for (const [label, store] of await stores()) {
    const authority = initialAuthority(`${label}_plan_fence`);
    await store.putWorkspace(workspace(authority.capsule.workspaceId));
    expect(await store.createCapsuleInitialAuthority(authority)).toMatchObject({
      status: "created",
    });
    const management = await store.getWorkspaceManagement(
      authority.capsule.workspaceId,
    );
    if (!management || management.managementState !== "active") {
      throw new Error(`${label}: Workspace management is not active`);
    }
    const expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority = {
      workspaceId: management.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    };
    const expectedCapsulePlanAuthority = {
      installConfigId: authority.installConfig.id,
      executionAuthorityEpoch: 1,
      currentStateGeneration: 0,
      currentStateVersionId: undefined,
    } as const;

    const accepted = await configurationPlanPreparation(
      authority,
      `${label}_accepted`,
    );
    expect(
      await store.preparePlanRun({
        ...accepted,
        expectedCapsulePlanAuthority,
        expectedWorkspaceManagementAuthority,
      }),
      label,
    ).toMatchObject({ status: "created", run: accepted.run });

    const current = await store.getCapsule(authority.capsule.id);
    if (!current) throw new Error(`${label}: initial Capsule is missing`);
    await store.putCapsule({
      ...current,
      status: "destroyed",
      updatedAt: LATER,
    });
    const stale = await configurationPlanPreparation(
      authority,
      `${label}_stale`,
    );
    await expect(
      store.preparePlanRun({
        ...stale,
        expectedCapsulePlanAuthority,
        expectedWorkspaceManagementAuthority,
      }),
      label,
    ).rejects.toBeInstanceOf(CapsulePlanCreationFenceConflictError);
    expect(await store.getPlanRun(stale.run.id), label).toBeUndefined();
    expect(await store.getPlanRunInputs(stale.run.id), label).toBeUndefined();
  }
});

test("shared template CAS permits only unattached rows and counts destroyed references across every store", async () => {
  for (const [label, store] of await stores()) {
    const shared = installConfig(`config_shared_${label}`);
    const replacement: InstallConfig = {
      ...shared,
      variableMapping: { region: "us-east-1" },
      updatedAt: LATER,
    };
    await store.putInstallConfig(shared);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(shared, replacement),
    ).toBe(true);
    expect(await store.getInstallConfig(shared.id)).toEqual(replacement);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(shared, {
        ...replacement,
        updatedAt: "2026-09-04T00:00:02.000Z",
      }),
    ).toBe(false);
    expect(await store.getInstallConfig(shared.id)).toEqual(replacement);

    const referenced = installConfig(`config_referenced_${label}`);
    const referencedReplacement = {
      ...referenced,
      variableMapping: { region: "must-not-change" },
      updatedAt: LATER,
    };
    const reference = capsule(`capsule_reference_${label}`, referenced.id);
    await store.putInstallConfig(referenced);
    await store.putCapsule(reference);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(
        referenced,
        referencedReplacement,
      ),
    ).toBe(false);
    expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);

    await store.putCapsule({
      ...reference,
      status: "destroyed",
      updatedAt: LATER,
    });
    expect(
      await store.replaceUnreferencedSharedInstallConfig(
        referenced,
        referencedReplacement,
      ),
    ).toBe(false);
    expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);

    const workspaceScoped = installConfig(
      `config_workspace_${label}`,
      `workspace_${label}`,
    );
    await store.putInstallConfig(workspaceScoped);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(workspaceScoped, {
        ...workspaceScoped,
        variableMapping: { region: "must-not-change" },
        updatedAt: LATER,
      }),
    ).toBe(false);
    expect(await store.getInstallConfig(workspaceScoped.id)).toEqual(
      workspaceScoped,
    );
  }
});
