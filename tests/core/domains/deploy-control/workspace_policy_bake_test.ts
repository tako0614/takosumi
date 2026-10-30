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
  evaluateConfiguredProviderAllowlist,
  malformedWorkspacePolicyKeys,
  mergePolicyConfigs,
  WORKSPACE_POLICY_CEILING_KEYS,
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
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  releaseControlD1MaintenanceFence,
} from "../../../../worker/src/d1_schema_maintenance.ts";
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

/** Records every statement the store sends, to prove the dry-run only reads. */
class RecordingD1 extends SqliteFakeD1 {
  readonly statements: string[] = [];
  override prepare(query: string) {
    this.statements.push(query);
    return super.prepare(query);
  }
  override exec(query: string) {
    this.statements.push(query);
    return super.exec(query);
  }
}

const READ_ONLY_STATEMENT = /^\s*(select|with|pragma)\b/iu;

async function stores(): Promise<
  readonly [string, OpenTofuControlStore, RecordingD1?][]
> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const d1 = new RecordingD1();
  // A predeployed database as the production schema lane leaves it: the
  // ledger schema plus a released maintenance fence.
  await ensureD1OpenTofuLedgerSchema(d1);
  const fence = await acquireControlD1MaintenanceFence(d1, {
    sourceCommit: "a".repeat(40),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test",
    databaseRole: "in_place",
    releasePolicy: "in_place",
  }, "2026-10-30T00:00:00.000Z");
  await releaseControlD1MaintenanceFence(d1, fence, "2026-10-30T00:00:01.000Z");
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    // The tool only accepts a predeployed D1 store (no DDL on first access).
    ["d1", new CloudflareD1OpenTofuControlStore(d1, { schemaMode: "predeployed" }), d1],
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
  for (const [label, store, d1] of await stores()) {
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

    d1?.statements.splice(0);
    const plan = await planWorkspacePolicyBake(store);
    // The dry-run sends only reads to D1 (no schema bootstrap, no writes).
    if (d1) {
      expect(d1.statements.length, label).toBeGreaterThan(0);
      expect(
        d1.statements.filter((statement) => !READ_ONLY_STATEMENT.test(statement)),
        label,
      ).toEqual([]);
    }
    expect(plan.workspaces, label).toEqual([
      expect.objectContaining({
        workspaceId: ws,
        ignoredKeys: ["lifecycleActions"],
        malformedKeys: [],
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
      orphanInstallConfigIds: [],
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
      orphanInstallConfigIds: [],
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

test("the tool refuses a D1 store in bootstrap mode before touching it", async () => {
  const d1 = new RecordingD1();
  const store = new CloudflareD1OpenTofuControlStore(d1);
  await expect(runWorkspacePolicyBake(store, {})).rejects.toThrow(/bootstrap mode/);
  await expect(
    runWorkspacePolicyBake(store, { apply: true, expectedDigest: `sha256:${"0".repeat(64)}` }),
  ).rejects.toThrow(/bootstrap mode/);
  expect(d1.statements).toEqual([]);
});

/** Fails the rebind of chosen apps, after their successor row was inserted. */
class FailingRebindStore extends InMemoryOpenTofuControlStore {
  readonly throwFor = new Set<string>();
  readonly conflictFor = new Set<string>();
  override async rebindCapsuleInstallConfig(
    input: Parameters<InMemoryOpenTofuControlStore["rebindCapsuleInstallConfig"]>[0],
  ) {
    if (this.throwFor.has(input.capsuleId)) throw new TypeError("store unavailable");
    if (this.conflictFor.has(input.capsuleId)) {
      return { status: "conflict" as const, capsule: (await this.getCapsule(input.capsuleId))! };
    }
    return await super.rebindCapsuleInstallConfig(input);
  }
}

test("apply tries every app, collects store errors and reports orphan successors", async () => {
  const store = new FailingRebindStore();
  const ws = "ws_partial";
  const seeded = [];
  for (const id of ["cap_p1", "cap_p2", "cap_p3"]) {
    seeded.push(await seedCapsuleModel(store, {
      workspaceId: ws,
      capsuleId: id,
      sourceId: `src_${id}`,
      snapshotId: `snap_${id}`,
      installConfigId: `cfg_${id}`,
      name: id.replaceAll("_", "-"),
    }));
  }
  const workspace = (await store.getWorkspace(ws))!;
  await store.putWorkspace({ ...workspace, policy: WORKSPACE_POLICY });
  const plan = await planWorkspacePolicyBake(store);
  expect(plan.writes.map((write) => write.capsuleId)).toEqual(["cap_p1", "cap_p2", "cap_p3"]);
  store.throwFor.add("cap_p1");
  store.conflictFor.add("cap_p2");
  const result = await applyWorkspacePolicyBake(store, plan.digest);
  const target = (id: string) =>
    plan.writes.find((write) => write.capsuleId === id)!.targetInstallConfigId;
  expect(result).toEqual({
    baked: ["cap_p3"],
    skipped: [
      {
        capsuleId: "cap_p1",
        reason: "error",
        errorName: "TypeError",
        orphanInstallConfigId: target("cap_p1"),
      },
      { capsuleId: "cap_p2", reason: "conflict", orphanInstallConfigId: target("cap_p2") },
    ],
    orphanInstallConfigIds: [target("cap_p1"), target("cap_p2")],
    remaining: 2,
  });
  expect((await store.getInstallConfig(target("cap_p1")))?.policy)
    .toEqual(bakeWorkspacePolicy(WORKSPACE_POLICY, {}));
  expect((await store.getCapsule("cap_p1"))!.installConfigId).toBe("cfg_cap_p1");
  // A re-run of the same reviewed writes reuses the orphan rows.
  store.throwFor.clear();
  store.conflictFor.clear();
  const again = await planWorkspacePolicyBake(store);
  expect(again.writes.map((write) => [write.capsuleId, write.targetInstallConfigId]))
    .toEqual([["cap_p1", target("cap_p1")], ["cap_p2", target("cap_p2")]]);
  expect(await applyWorkspacePolicyBake(store, again.digest)).toEqual({
    baked: ["cap_p1", "cap_p2"],
    skipped: [],
    orphanInstallConfigIds: [],
    remaining: 0,
  });
});

// --- property-style: arbitrary order, duplicates, absent and empty values ---

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPolicy(next: () => number): PolicyConfig {
  const pick = <T>(pool: readonly T[]): T[] => {
    const out: T[] = [];
    const length = Math.floor(next() * (pool.length + 2));
    for (let index = 0; index < length; index += 1) {
      out.push(pool[Math.floor(next() * pool.length)]!);
    }
    return out;
  };
  const maybe = <T>(value: () => T): T | undefined => next() < 0.5 ? value() : undefined;
  const flag = () => next() < 0.5 ? {} : { flag: next() < 0.5 };
  const policy: Record<string, unknown> = {
    allowedProviders: maybe(() => pick(["p/d", "p/a", "p/c", "p/b"])),
    allowedResourceTypes: maybe(() => pick(["r_z", "r_a", "r_m"])),
    allowedDataSourceTypes: maybe(() => pick(["d_b", "d_a"])),
    allowedProvisionerTypes: maybe(() => pick(["local-exec", "file"])),
    destructiveChanges: maybe(() => {
      const value = flag();
      return "flag" in value ? { requireExplicitConfirmation: value.flag } : {};
    }),
    providerLockfile: maybe(() => {
      const value = flag();
      return "flag" in value ? { requireDigest: value.flag } : {};
    }),
    providerInstallation: maybe(() => {
      const value = flag();
      return "flag" in value ? { requireMirror: value.flag } : {};
    }),
    providerCredentials: maybe(() => ({
      ...(next() < 0.5 ? { requiredProviders: pick(["p/b", "p/a"]) } : {}),
      ...(next() < 0.5 ? { allowedConnectionIds: pick(["conn_c", "conn_a", "conn_b"]) } : {}),
      ...(next() < 0.5 ? { forbiddenConnectionIds: pick(["conn_y", "conn_x"]) } : {}),
      ...(next() < 0.5 ? { allowedConnectionScopes: pick(["workspace", "operator"]) } : {}),
      ...(next() < 0.5
        ? {
            allowedCredentialRecipes: pick([
              { id: "r2", authMode: "token" },
              { id: "r1", authMode: "oauth" },
              { id: "r1", authMode: "token" },
            ]),
          }
        : {}),
      ...(next() < 0.5 ? { requiredCredentialCapabilities: pick(["cap.b", "cap.a"]) } : {}),
      ...(next() < 0.5 ? { requireTemporary: next() < 0.5 } : {}),
    })),
    scopeBoundary: maybe(() => ({
      ...(next() < 0.3 ? { mode: "strict" as const } : next() < 0.5 ? { mode: "permissive" as const } : {}),
      rules: pick([R2, R1, rule("third_*", "ap-3")]),
    })),
    quota: maybe(() => ({
      ...(next() < 0.5 ? { runs: Math.floor(next() * 10) } : {}),
      ...(next() < 0.5 ? { applies: Math.floor(next() * 10) } : {}),
    })),
  };
  return JSON.parse(JSON.stringify(policy)) as PolicyConfig;
}

const asSet = (value: readonly unknown[] | undefined) =>
  value === undefined ? undefined : [...new Set(value.map((item) => JSON.stringify(item)))].sort();

test("property: bake is idempotent, baked, verbatim off-ceiling and never weaker", () => {
  const next = prng(0x91a7);
  for (let index = 0; index < 2000; index += 1) {
    const workspace = randomPolicy(next);
    const install = randomPolicy(next);
    const label = JSON.stringify({ index, workspace, install });
    const once = bakeWorkspacePolicy(workspace, install);
    const twice = bakeWorkspacePolicy(workspace, once);
    expect(canonicalPolicyJson(twice), label).toBe(canonicalPolicyJson(once));
    expect(workspacePolicyBakedInto(workspace, once), label).toBe(true);
    const ceiling = workspacePolicyCeiling(workspace);
    for (const key of Object.keys(install) as (keyof PolicyConfig)[]) {
      if (ceiling?.[key] !== undefined) continue;
      expect(once?.[key], `${label}:${key}`).toEqual(install[key]);
    }
    // The decision after the bake (InstallConfig alone) is the old composition,
    // except that destructive confirmation may only get stricter.
    const before = mergePolicyConfigs(workspace, install) ?? {};
    const after = effectiveProviderPolicy(workspace, once) ?? {};
    for (const key of [
      "allowedProviders",
      "allowedResourceTypes",
      "allowedDataSourceTypes",
      "allowedProvisionerTypes",
    ] as const) {
      expect(asSet(after[key]), `${label}:${key}`).toEqual(asSet(before[key]));
    }
    expect(after.providerLockfile?.requireDigest === true, label)
      .toBe(before.providerLockfile?.requireDigest === true);
    expect(after.providerInstallation?.requireMirror === true, label)
      .toBe(before.providerInstallation?.requireMirror === true);
    if (before.destructiveChanges?.requireExplicitConfirmation === true) {
      expect(after.destructiveChanges?.requireExplicitConfirmation, label).toBe(true);
    }
    const beforeCredentials = before.providerCredentials;
    const afterCredentials = after.providerCredentials;
    for (const key of [
      "requiredProviders",
      "allowedConnectionIds",
      "forbiddenConnectionIds",
      "allowedConnectionScopes",
      "allowedCredentialRecipes",
      "requiredCredentialCapabilities",
    ] as const) {
      expect(asSet(afterCredentials?.[key]), `${label}:${key}`)
        .toEqual(asSet(beforeCredentials?.[key]));
    }
    expect(afterCredentials?.requireTemporary === true, label)
      .toBe(beforeCredentials?.requireTemporary === true);
    expect(asSet(after.scopeBoundary?.rules), label).toEqual(asSet(before.scopeBoundary?.rules));
    expect(after.scopeBoundary?.mode, label).toBe(before.scopeBoundary?.mode);
    expect(after.quota ?? {}, label).toEqual(before.quota ?? {});
  }
});

test("canonical bake of the review's probes: unsorted allowlists, empty flags, unsorted ids", () => {
  const cases: readonly [PolicyConfig, PolicyConfig][] = [
    [{ allowedProviders: ["p/random", "p/cloudflare"] }, {}],
    [{ allowedResourceTypes: ["random_id", "cloudflare_worker"] }, { quota: { runs: 3 } }],
    [{ destructiveChanges: {} as PolicyConfig["destructiveChanges"] }, {}],
    [{ providerCredentials: { allowedConnectionIds: ["conn_b", "conn_a"] } }, {}],
  ];
  for (const [workspace, install] of cases) {
    const once = bakeWorkspacePolicy(workspace, install)!;
    expect(workspacePolicyBakedInto(workspace, once), JSON.stringify(workspace)).toBe(true);
    expect(canonicalPolicyJson(bakeWorkspacePolicy(workspace, once)))
      .toBe(canonicalPolicyJson(once));
  }
  expect(bakeWorkspacePolicy(cases[0]![0], {})!.allowedProviders).toEqual(["p/cloudflare", "p/random"]);
  expect(bakeWorkspacePolicy(cases[2]![0], {})!.destructiveChanges)
    .toEqual({ requireExplicitConfirmation: false });
  // An off-ceiling list keeps its order: no rewrite only to sort it.
  expect(bakeWorkspacePolicy({ quota: { runs: 1 } }, { allowedProviders: ["p/z", "p/a"] })!.allowedProviders)
    .toEqual(["p/z", "p/a"]);
});

// --- malformed Workspace ceilings fail closed (TASK-0118 P9.1-g re-review) ---

const MALFORMED_VALUES: readonly unknown[] = [null, "p/a", 7, [1], {}, [], { rules: "x" }, { runs: "3" }];

function malformedWorkspace(next: () => number): PolicyConfig {
  const policy = randomPolicy(next) as Record<string, unknown>;
  const key = WORKSPACE_POLICY_CEILING_KEYS[Math.floor(next() * WORKSPACE_POLICY_CEILING_KEYS.length)]!;
  // Pick a value that is malformed for this key.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const value = MALFORMED_VALUES[Math.floor(next() * MALFORMED_VALUES.length)];
    if (malformedWorkspacePolicyKeys({ [key]: value } as PolicyConfig).length === 1) {
      policy[key] = value;
      return policy as PolicyConfig;
    }
  }
  policy[key] = null;
  return policy as PolicyConfig;
}

test("a null or non-array Workspace allowlist is never baked and stays enforced as before", () => {
  for (const value of [null, "registry.opentofu.org/a/b", 7, {}, [1]]) {
    const workspace = { allowedProviders: value } as unknown as PolicyConfig;
    const label = JSON.stringify(value);
    expect(malformedWorkspacePolicyKeys(workspace), label).toEqual(["allowedProviders"]);
    // The InstallConfig lacks the key: reading the ceiling as "no limit"
    // would make the app unrestricted. It is unbaked instead…
    expect(workspacePolicyBakedInto(workspace, {}), label).toBe(false);
    expect(() => bakeWorkspacePolicy(workspace, {}), label).toThrow(TypeError);
    // …and the runtime keeps the old composition exactly.
    expect(effectiveProviderPolicy(workspace, {}), label).toEqual(mergePolicyConfigs(workspace, {}));
  }
  // The old composition refuses on a null allowlist (fail closed).
  expect(() =>
    evaluateConfiguredProviderAllowlist(
      ["registry.opentofu.org/a/b"],
      effectiveProviderPolicy({ allowedProviders: null } as unknown as PolicyConfig, {}),
      false,
    )
  ).toThrow();
});

test("property: any malformed ceiling value is refused and keeps the old composition", () => {
  const next = prng(0x5a17);
  for (let index = 0; index < 1000; index += 1) {
    const workspace = malformedWorkspace(next);
    const install = randomPolicy(next);
    const label = JSON.stringify({ index, workspace, install });
    expect(malformedWorkspacePolicyKeys(workspace).length, label).toBeGreaterThan(0);
    expect(workspacePolicyBakedInto(workspace, install), label).toBe(false);
    expect(() => bakeWorkspacePolicy(workspace, install), label).toThrow(TypeError);
    const outcome = (run: () => unknown) => {
      try {
        return { value: run() };
      } catch (error) {
        return { threw: error instanceof Error ? error.name : "unknown" };
      }
    };
    expect(outcome(() => effectiveProviderPolicy(workspace, install)), label)
      .toEqual(outcome(() => mergePolicyConfigs(workspace, install)));
  }
});

test("the tool refuses every app of a Workspace whose ceiling is malformed", async () => {
  for (const [label, store] of await stores()) {
    const ws = `ws_malformed_${label}`;
    const seeded = await seedCapsuleModel(store, {
      workspaceId: ws,
      capsuleId: `cap_malformed_${label}`,
    });
    const workspace = (await store.getWorkspace(ws))!;
    await store.putWorkspace({
      ...workspace,
      policy: { allowedProviders: null, quota: { runs: 2 } } as unknown as PolicyConfig,
    });
    const plan = await planWorkspacePolicyBake(store);
    expect(plan.workspaces, label).toEqual([
      expect.objectContaining({ workspaceId: ws, malformedKeys: ["allowedProviders"], liveCapsules: 1 }),
    ]);
    expect(plan.writes, label).toEqual([]);
    expect(plan.refused, label).toEqual([
      { capsuleId: seeded.capsule.id, workspaceId: ws, reason: "workspace_policy_invalid" },
    ]);
    expect(plan.unbaked, label).toBe(1);
  }
});

test("the tool reads schemaMode from the store itself and refuses when it is missing", async () => {
  const memory = new InMemoryOpenTofuControlStore();
  expect(memory.schemaMode).toBe("predeployed");
  // A wrapper that forwards the methods but does not declare the capability.
  const wrapped = {
    listWorkspaces: () => memory.listWorkspaces(),
    getWorkspace: (id: string) => memory.getWorkspace(id),
    listCapsules: (id?: string) => memory.listCapsules(id),
    getInstallConfig: (id: string) => memory.getInstallConfig(id),
    getWorkspaceManagement: (id: string) => memory.getWorkspaceManagement(id),
    getCapsuleExecutionAuthorityEpoch: (id: string) => memory.getCapsuleExecutionAuthorityEpoch(id),
    createInstallConfigIfAbsent: memory.createInstallConfigIfAbsent.bind(memory),
    rebindCapsuleInstallConfig: memory.rebindCapsuleInstallConfig.bind(memory),
  };
  await expect(runWorkspacePolicyBake(wrapped, {})).rejects.toThrow(/schemaMode "predeployed"/);
  await expect(runWorkspacePolicyBake({ ...wrapped, schemaMode: "bootstrap" } as never, {}))
    .rejects.toThrow(/schemaMode "predeployed"/);
  expect(await runWorkspacePolicyBake({ ...wrapped, schemaMode: "predeployed" } as never, {}))
    .toMatchObject({ mode: "dry-run", unbaked: 0 });
  // A proxied bootstrap D1 store is refused before any statement.
  const d1 = new RecordingD1();
  const proxied = new Proxy(new CloudflareD1OpenTofuControlStore(d1), {});
  await expect(runWorkspacePolicyBake(proxied, {})).rejects.toThrow(/schemaMode "predeployed"/);
  expect(d1.statements).toEqual([]);
});
