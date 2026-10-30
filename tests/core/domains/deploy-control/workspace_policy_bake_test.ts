/**
 * TASK-0118 P9.1-g: Workspace policy bake (strictest merge into each app's
 * InstallConfig policy) and the runtime rule that skips the Workspace ceiling
 * only where it is already baked.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type {
  InstallConfigInstallExperience,
  PolicyConfig,
} from "../../../../contract/install-configs.ts";
import type { ScopeBoundaryRule } from "../../../../contract/plan-scope.ts";
import {
  bakeWorkspacePolicy,
  canonicalPolicyJson,
  effectiveProviderPolicy,
  mergePolicyConfigs,
  workspacePolicyBakedInto,
  workspacePolicyCeiling,
} from "../../../../core/domains/deploy-control/provider_policy.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  applyWorkspacePolicyBake,
  planWorkspacePolicyBake,
} from "../../../../core/domains/deploy-control/workspace_policy_bake.ts";
import { runWorkspacePolicyBake } from "../../../../scripts/bake-workspace-policies.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(180_000);

const P_A = "registry.opentofu.org/example/a";
const P_C = "registry.opentofu.org/example/c";
const P_E = "registry.opentofu.org/example/e";

function rule(pattern: string, region: string): ScopeBoundaryRule {
  return {
    resourceTypePattern: pattern,
    dimensions: {
      region: { selector: "/region", allowedValues: [region] },
    },
  };
}

const R1 = rule("example_*", "ap-1");
const R2 = rule("other_*", "ap-2");

const WORKSPACE_POLICY: PolicyConfig = {
  allowedProviders: [P_A, P_C],
  destructiveChanges: { requireExplicitConfirmation: true },
  providerLockfile: { requireDigest: true },
  providerCredentials: {
    allowedConnectionIds: ["conn_a", "conn_b"],
    forbiddenConnectionIds: ["conn_x"],
    requireTemporary: true,
  },
  scopeBoundary: { mode: "strict", rules: [R1] },
  quota: { runs: 5 },
  // Never a runtime ceiling; must be ignored, never baked.
  lifecycleActions: {
    allowedExecutors: ["runner"],
    allowedRunnerCapabilities: ["shell"],
  },
};

const INSTALL_POLICY: PolicyConfig = {
  allowedProviders: [P_E, P_C],
  destructiveChanges: { requireExplicitConfirmation: false },
  providerCredentials: {
    allowedConnectionIds: ["conn_b", "conn_c"],
    forbiddenConnectionIds: ["conn_y"],
  },
  scopeBoundary: { rules: [R1, R2] },
  quota: { runs: 10, applies: 3 },
  repositoryInstallUx: { allowedInterfacePermissions: ["read"] },
};

const OIDC_EXPERIENCE: InstallConfigInstallExperience = {
  projections: [{
    kind: "oidc_client",
    variables: {
      accountsUrl: "takosumi_accounts_url",
      issuerUrl: "takosumi_accounts_issuer_url",
      clientId: "takosumi_accounts_client_id",
      redirectUri: "takosumi_accounts_redirect_uri",
    },
    callbackPath: "/auth/oidc/callback",
    scopes: ["openid", "profile"],
  }],
};

const pgClients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

test("bake is the strictest merge of every Workspace ceiling key", () => {
  const baked = bakeWorkspacePolicy(WORKSPACE_POLICY, INSTALL_POLICY)!;
  expect(baked.allowedProviders).toEqual([P_C]);
  // The runtime let the InstallConfig layer override a stricter Workspace;
  // the bake keeps the stricter value.
  expect(baked.destructiveChanges).toEqual({ requireExplicitConfirmation: true });
  expect(baked.providerLockfile).toEqual({ requireDigest: true });
  expect(baked.providerCredentials).toEqual({
    allowedConnectionIds: ["conn_b"],
    forbiddenConnectionIds: ["conn_x", "conn_y"],
    requireTemporary: true,
    requireTtlEnforced: false,
  });
  // Both rule sets stay enforceable; the duplicate rule is dropped.
  expect(baked.scopeBoundary).toEqual({ mode: "strict", rules: [R1, R2] });
  expect(baked.quota).toEqual({ runs: 5, applies: 3 });
  // Keys the Workspace layer never contributed keep the InstallConfig value
  // and are never copied from the Workspace.
  expect(baked.repositoryInstallUx).toEqual(INSTALL_POLICY.repositoryInstallUx);
  expect(baked.lifecycleActions).toBeUndefined();
});

test("bake is idempotent and an absent InstallConfig layer takes the ceiling", () => {
  const baked = bakeWorkspacePolicy(WORKSPACE_POLICY, INSTALL_POLICY);
  expect(canonicalPolicyJson(bakeWorkspacePolicy(WORKSPACE_POLICY, baked)))
    .toBe(canonicalPolicyJson(baked));
  const fromEmpty = bakeWorkspacePolicy(WORKSPACE_POLICY, {})!;
  const ceiling = workspacePolicyCeiling(WORKSPACE_POLICY)!;
  // The ceiling itself, in the normalized form the runtime composition uses.
  expect(fromEmpty).toEqual({
    ...ceiling,
    providerCredentials: {
      ...ceiling.providerCredentials,
      requireTtlEnforced: false,
    },
  });
  expect(fromEmpty.lifecycleActions).toBeUndefined();
  expect(canonicalPolicyJson(bakeWorkspacePolicy(WORKSPACE_POLICY, fromEmpty)))
    .toBe(canonicalPolicyJson(fromEmpty));
  // A Workspace policy without a ceiling key changes nothing.
  expect(bakeWorkspacePolicy({ lifecycleActions: WORKSPACE_POLICY.lifecycleActions }, INSTALL_POLICY))
    .toBe(INSTALL_POLICY);
  expect(workspacePolicyCeiling(undefined)).toBeUndefined();
});

test("runtime skips the Workspace ceiling only where it is already baked", () => {
  // Unbaked: the Workspace ceiling is still enforced exactly as before.
  expect(workspacePolicyBakedInto(WORKSPACE_POLICY, INSTALL_POLICY)).toBe(false);
  expect(effectiveProviderPolicy(WORKSPACE_POLICY, INSTALL_POLICY))
    .toEqual(mergePolicyConfigs(WORKSPACE_POLICY, INSTALL_POLICY));
  // Baked: the InstallConfig alone decides, and it is at least as strict as
  // the old composition for every key (only duplicate scope rules differ).
  const baked = bakeWorkspacePolicy(WORKSPACE_POLICY, INSTALL_POLICY)!;
  expect(workspacePolicyBakedInto(WORKSPACE_POLICY, baked)).toBe(true);
  const effective = effectiveProviderPolicy(WORKSPACE_POLICY, baked)!;
  expect(effective).toEqual(mergePolicyConfigs(undefined, baked)!);
  const composed = mergePolicyConfigs(WORKSPACE_POLICY, baked)!;
  for (const key of Object.keys(composed) as (keyof PolicyConfig)[]) {
    if (key === "scopeBoundary") continue;
    expect(effective[key], key).toEqual(composed[key]);
  }
  expect(effective.scopeBoundary).toEqual({ mode: "strict", rules: [R1, R2] });
  // A widened Workspace policy keeps the baked app as it is; a tightened one
  // is unbaked again and enforced again (fail closed).
  expect(workspacePolicyBakedInto({ ...WORKSPACE_POLICY, allowedProviders: [P_A, P_C, P_E] }, baked))
    .toBe(true);
  const tightened = { ...WORKSPACE_POLICY, quota: { runs: 1 } };
  expect(workspacePolicyBakedInto(tightened, baked)).toBe(false);
  expect(effectiveProviderPolicy(tightened, baked)?.quota).toEqual({ runs: 1, applies: 3 });
  // No Workspace policy: nothing to skip.
  expect(effectiveProviderPolicy(undefined, INSTALL_POLICY))
    .toEqual(mergePolicyConfigs(undefined, INSTALL_POLICY));
});

test("operator bake: dry-run, digest-confirmed apply, idempotent re-run on all three stores", async () => {
  for (const [label, store] of await stores()) {
    const ws = `ws_bake_${label}`;
    const other = `ws_nopolicy_${label}`;
    const seed = (
      capsuleId: string,
      workspaceId: string,
      policy: PolicyConfig,
      installExperience?: InstallConfigInstallExperience,
    ) =>
      seedCapsuleModel(store, {
        workspaceId,
        capsuleId,
        sourceId: `src_${capsuleId}`,
        snapshotId: `snap_${capsuleId}`,
        installConfigId: `cfg_${capsuleId}`,
        name: capsuleId.replaceAll("_", "-"),
        installConfig: {
          policy,
          ...(installExperience ? { installExperience } : {}),
        },
      });
    const a = await seed(`cap_a_${label}`, ws, INSTALL_POLICY);
    const b = await seed(`cap_b_${label}`, ws, {}, OIDC_EXPERIENCE);
    const gone = await seed(`cap_gone_${label}`, ws, {});
    const leaving = await seed(`cap_leaving_${label}`, ws, {});
    const elsewhere = await seed(`cap_elsewhere_${label}`, other, {});
    await store.putCapsule({ ...gone.capsule, status: "destroyed" });
    await store.putCapsule({ ...leaving.capsule, status: "uninstalled" });
    const workspace = (await store.getWorkspace(ws))!;
    await store.putWorkspace({ ...workspace, policy: WORKSPACE_POLICY });

    const plan = await planWorkspacePolicyBake(store);
    expect(plan.workspaces, label).toEqual([
      expect.objectContaining({
        workspaceId: ws,
        ignoredKeys: ["lifecycleActions"],
        liveCapsules: 3,
      }),
    ]);
    expect(plan.liveCapsules, label).toBe(3);
    expect(plan.alreadyBaked, label).toBe(0);
    expect(plan.writes.map((write) => write.capsuleId), label)
      .toEqual([a.capsule.id, b.capsule.id]);
    expect(plan.writes[0]!.tightenedKeys, label).toEqual(["destructiveChanges"]);
    expect(plan.writes[1]!.tightenedKeys, label).toEqual([]);
    // Sign-in to an app with an Accounts OIDC client pauses until its next
    // Apply; the dry-run says which apps that is.
    expect(plan.writes.map((write) => write.oidcReactivationRequired), label)
      .toEqual([false, true]);
    expect(plan.refused, label).toEqual([
      { capsuleId: leaving.capsule.id, workspaceId: ws, reason: "capsule_uninstalled" },
    ]);
    expect(plan.unbaked, label).toBe(3);
    // The dry-run writes nothing.
    expect((await store.getCapsule(a.capsule.id))!.installConfigId, label)
      .toBe(`cfg_${a.capsule.id}`);
    expect(await runWorkspacePolicyBake(store, {}), label)
      .toEqual({ mode: "dry-run", ...plan });

    await expect(runWorkspacePolicyBake(store, { apply: true }), label)
      .rejects.toThrow(/--plan-digest/);
    await expect(applyWorkspacePolicyBake(store, `sha256:${"0".repeat(64)}`), label)
      .rejects.toThrow(/changed since review/);
    // A Workspace policy changed after review invalidates the reviewed digest.
    await store.putWorkspace({ ...workspace, policy: { ...WORKSPACE_POLICY, quota: { runs: 4 } } });
    await expect(applyWorkspacePolicyBake(store, plan.digest), label)
      .rejects.toThrow(/changed since review/);
    await store.putWorkspace({ ...workspace, policy: WORKSPACE_POLICY });

    const applied = await runWorkspacePolicyBake(store, {
      apply: true,
      expectedDigest: plan.digest,
    });
    expect(applied, label).toEqual({
      mode: "apply",
      baked: [a.capsule.id, b.capsule.id],
      skipped: [],
      remaining: 1,
    });
    for (const [seeded, write] of [[a, plan.writes[0]!], [b, plan.writes[1]!]] as const) {
      const capsule = (await store.getCapsule(seeded.capsule.id))!;
      expect(capsule.installConfigId, label).toBe(write.targetInstallConfigId);
      const successor = (await store.getInstallConfig(capsule.installConfigId))!;
      expect(successor.policy, label).toEqual(
        bakeWorkspacePolicy(WORKSPACE_POLICY, seeded.installConfig.policy)!,
      );
      expect(successor.internal, label).toMatchObject({
        reason: "per_install_overrides",
        workspacePolicyBake: {
          workspaceId: ws,
          workspacePolicyDigest: write.workspacePolicyDigest,
          previousInstallConfigId: seeded.installConfig.id,
          previousInstallConfigDigest: write.installConfigDigest,
        },
      });
      expect(successor.workspaceId, label).toBe(ws);
      // The predecessor row is immutable and unchanged.
      expect((await store.getInstallConfig(seeded.installConfig.id))!.policy, label)
        .toEqual(seeded.installConfig.policy);
      // The runtime now decides from the InstallConfig alone.
      expect(workspacePolicyBakedInto(WORKSPACE_POLICY, successor.policy), label).toBe(true);
      expect(await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id), label)
        .toBe(write.executionAuthorityEpoch + 1);
    }
    // Untouched: destroyed, uninstalled, and apps in a Workspace without policy.
    for (const seeded of [gone, leaving, elsewhere]) {
      expect((await store.getCapsule(seeded.capsule.id))!.installConfigId, label)
        .toBe(seeded.installConfig.id);
    }

    // Idempotent: nothing left to write, the gate reports only the refusal.
    const again = await planWorkspacePolicyBake(store);
    expect(again.writes, label).toEqual([]);
    expect(again.alreadyBaked, label).toBe(2);
    expect(again.unbaked, label).toBe(1);
    expect(await applyWorkspacePolicyBake(store, again.digest), label).toEqual({
      baked: [],
      skipped: [],
      remaining: 1,
    });
    expect((await store.getCapsule(a.capsule.id))!.installConfigId, label)
      .toBe(plan.writes[0]!.targetInstallConfigId);
  }
});

test("operator bake reports zero when every live app already contains its ceiling", async () => {
  for (const [label, store] of await stores()) {
    const ws = `ws_zero_${label}`;
    const baked = bakeWorkspacePolicy(WORKSPACE_POLICY, INSTALL_POLICY)!;
    await seedCapsuleModel(store, {
      workspaceId: ws,
      capsuleId: `cap_zero_${label}`,
      installConfig: { policy: baked },
    });
    const workspace = (await store.getWorkspace(ws))!;
    await store.putWorkspace({ ...workspace, policy: WORKSPACE_POLICY });
    const plan = await planWorkspacePolicyBake(store);
    expect(plan, label).toMatchObject({
      liveCapsules: 1,
      alreadyBaked: 1,
      writes: [],
      refused: [],
      unbaked: 0,
    });
  }
});
