import { expect, test } from "bun:test";

import type {
  PlanRunResponse,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { ProviderConnection } from "takosumi-contract/connections";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  InMemoryGitInstallPlanStore,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import { createTakosumiAccountsOidcModuleVariableMaterializer } from "../../../../deploy/platform/accounts_oidc_module_variable_materializer.ts";
import { composeTakosInstallConfig } from "../../../../deploy/platform/takos_install_config.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "../../../../deploy/platform/takoserver_hosted_install_configs.ts";
import {
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
} from "../../../../providers/cloudflare/credentials.ts";
import {
  fakeProviderVault,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-08-25T20:40:11.969Z";
const WORKSPACE_ID = "ws_yuru_production_repro";
const CAPSULE_ID = "cap_yuru_production_repro";
const SOURCE_ID = "src_yuru_production_repro";
const SNAPSHOT_ID = "snap_yuru_production_repro";
const INSTALL_CONFIG_ID = "icfg_yuru_production_repro";
const COMPATIBILITY_REPORT_ID = "caprep_yuru_production_repro";
const CONNECTION_ID = "conn_yuru_production_repro";
const INSTALL_PLAN_ID = "gip_c77aa0f9db174625";
const DURABLE_PLAN_RUN_ID = "plan_c77aa0f9db174625";
const OWNER = "tsub_yuru_production_repro";
const PAIRWISE_SUBJECT_SECRET = "production-repro-pairwise-subject-secret";
const CLOUDFLARE_PROVIDER =
  "registry.opentofu.org/cloudflare/cloudflare" as const;
const HTTP_PROVIDER = "registry.opentofu.org/hashicorp/http" as const;
const RANDOM_PROVIDER = "registry.opentofu.org/hashicorp/random" as const;
const TAKOS_WORKSPACE_ID = "ws_takos_production_repro";
const TAKOS_CAPSULE_ID = "cap_takos_production_repro";
const TAKOS_SOURCE_ID = "src_takos_production_repro";
const TAKOS_SNAPSHOT_ID = "snap_takos_production_repro";
const TAKOS_INSTALL_CONFIG_ID = "icfg_takos_production_repro";
const TAKOS_COMPATIBILITY_REPORT_ID = "caprep_takos_production_repro";
const TAKOS_CONNECTION_ID = "conn_takos_production_repro";
const TAKOS_CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN = "task0032-takos";
const TAKOS_RELEASE_DESCRIPTOR_URL =
  "https://github.com/tako0614/takos/releases/download/v0.12.6/takosumi-artifact.json";
const TAKOS_RELEASE_DESCRIPTOR_SHA256 =
  "sha256:af191aafd9346857ccb3f101fa5390dbb0f3c5b317fa0498b3b1b60508a87eaa";

test("production-shaped Yuru planning creates reviewable Plans through both owner routes", async () => {
  const fixture = await productionYuruFixture();

  const canonical = await fixture.request(
    `/api/v1/capsules/${CAPSULE_ID}/plan`,
    {
      compatibilityReportId: COMPATIBILITY_REPORT_ID,
    },
  );
  expect(canonical.status).toBe(201);
  const canonicalBody = await canonical.json();
  expect(canonicalBody).toMatchObject({
    run: {
      id: "plan_production_repro",
      status: "succeeded",
    },
  });

  const durable = await fixture.request(
    `/api/v1/install-plans/${INSTALL_PLAN_ID}/reconcile`,
  );
  expect(durable.status).toBe(200);
  expect(fixture.planCalls).toEqual([
    {
      capsuleId: CAPSULE_ID,
      options: { compatibilityReportId: COMPATIBILITY_REPORT_ID },
    },
    {
      capsuleId: CAPSULE_ID,
      options: {
        actor: `git-install-plan:${INSTALL_PLAN_ID}`,
        planRunId: DURABLE_PLAN_RUN_ID,
        sourceSnapshotId: SNAPSHOT_ID,
      },
    },
  ]);
  const durableBody = await durable.json();
  expect(durableBody).toMatchObject({
    installPlan: {
      phase: "reviewable",
      planRunId: DURABLE_PLAN_RUN_ID,
    },
    nextAction: "review_run",
  });
  expect(fixture.runnerPlanCalls()).toBe(2);
  expect(await fixture.getRun("plan_production_repro")).toMatchObject({
    id: "plan_production_repro",
    status: "succeeded",
  });
  expect(await fixture.getRun(DURABLE_PLAN_RUN_ID)).toMatchObject({
    id: DURABLE_PLAN_RUN_ID,
    status: "succeeded",
  });
  expect(
    await fixture.accountsStore.findOidcClientForCapsule(CAPSULE_ID),
  ).toBeUndefined();
  expect(JSON.stringify([canonicalBody, durableBody])).not.toContain(
    PAIRWISE_SUBJECT_SECRET,
  );
});

test("production-shaped Takos v0.12.6 planning preserves the nested Cloudflare target through the owner route", async () => {
  const fixture = await productionTakosFixture({
    accountId: TAKOS_CLOUDFLARE_ACCOUNT_ID,
    workersSubdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
  });

  const response = await fixture.request();
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    run: {
      id: "plan_takos_production_repro",
      status: "succeeded",
    },
  });
  expect(fixture.planJobs).toHaveLength(1);
  const job = fixture.planJobs[0]!;
  expect(job.generatedRoot).toBeUndefined();
  expect(job.variables.cloudflare).toEqual({
    account_id: TAKOS_CLOUDFLARE_ACCOUNT_ID,
    workers_subdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
  });
  expect(job.variables).not.toHaveProperty("cloudflare_account_id");
  expect(job.variables).not.toHaveProperty("cloudflare_workers_subdomain");
  expect(fixture.accountsWrites()).toBe(0);
  expect(
    await fixture.accountsStore.findOidcClientForCapsule(TAKOS_CAPSULE_ID),
  ).toBeUndefined();
});

test("production-shaped Takos planning rejects nested Cloudflare target drift before runner or Accounts writes", async () => {
  for (const target of [
    {
      accountId: "f".repeat(32),
      workersSubdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
    },
    {
      accountId: TAKOS_CLOUDFLARE_ACCOUNT_ID,
      workersSubdomain: "other-workers-subdomain",
    },
  ]) {
    const fixture = await productionTakosFixture(target);
    const response = await fixture.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "failed_precondition",
        details: { reason: "module_variable_materialization_failed" },
      },
    });
    expect(fixture.planJobs).toHaveLength(0);
    expect(fixture.accountsWrites()).toBe(0);
    expect(
      await fixture.accountsStore.findOidcClientForCapsule(TAKOS_CAPSULE_ID),
    ).toBeUndefined();
  }
});

test("production-shaped Takos planning rejects retained legacy flat Cloudflare inputs before runner or Accounts writes", async () => {
  const fixture = await productionTakosFixture({
    accountId: TAKOS_CLOUDFLARE_ACCOUNT_ID,
    workersSubdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
    legacyFlatTargets: {
      accountId: "f".repeat(32),
      workersSubdomain: "other-workers-subdomain",
    },
  });

  const response = await fixture.request();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "module_variable_materialization_failed" },
    },
  });
  expect(fixture.planJobs).toHaveLength(0);
  expect(fixture.accountsWrites()).toBe(0);
  expect(
    await fixture.accountsStore.findOidcClientForCapsule(TAKOS_CAPSULE_ID),
  ).toBeUndefined();
});

async function productionYuruFixture() {
  const store = new InMemoryOpenTofuControlStore();
  const accountsStore = new InMemoryAccountsStore();
  const planStore = new InMemoryGitInstallPlanStore();
  const cloudflareConfig = TAKOSERVER_HOSTED_INSTALL_CONFIGS.find(
    (config) => config.store?.deploymentProfile?.key === "cloudflare-v1",
  );
  if (!cloudflareConfig) throw new Error("Yuru Cloudflare profile is missing");
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    installConfigId: INSTALL_CONFIG_ID,
    capsuleId: CAPSULE_ID,
    environment: "production",
    name: "task0032-yuru-v218-repro",
    sourceUrl: "https://github.com/tako0614/yurucommu.git",
    ref: "v2.1.8",
    installConfig: {
      ...cloudflareConfig,
      id: INSTALL_CONFIG_ID,
      workspaceId: WORKSPACE_ID,
      name: "task0032 Yurucommu v2.1.8 Cloudflare",
      variableMapping: {
        ...cloudflareConfig.variableMapping,
        project_name: "task0032-yuru-v218-repro",
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const workspace = {
    ...seeded.workspace,
    ownerUserId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putWorkspace(workspace);
  const capsule = {
    ...seeded.capsule,
    installingPrincipalId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putCapsule(capsule);
  const connection: ProviderConnection = {
    id: CONNECTION_ID,
    workspaceId: WORKSPACE_ID,
    // Production creates the Connection from the recipe's accepted
    // default-registry shorthand while providerSource and the ProviderBinding
    // retain the canonical OpenTofu address.
    provider: "cloudflare/cloudflare",
    providerSource: CLOUDFLARE_PROVIDER,
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    secretPartition: "provider-credentials",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    scopeHints: {
      providerSettings: {
        accountId: "0123456789abcdef0123456789abcdef",
        workersSubdomain: "task0032-yuru",
      },
      moduleInputDefaults: {
        cloudflare_account_id: "0123456789abcdef0123456789abcdef",
        cloudflare_workers_subdomain: "task0032-yuru",
      },
    },
    credentialVerification: {
      kind: "takosumi.credential-verification@v1",
      verifierId: CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
      capabilities: [CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY],
    },
    createdAt: NOW,
    updatedAt: NOW,
    verifiedAt: NOW,
  };
  await store.putConnection(connection);
  await store.putProviderBindingSet({
    id: "dpf_yuru_production_repro",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    environment: "production",
    bindings: [{ provider: CLOUDFLARE_PROVIDER, connectionId: CONNECTION_ID }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const report = productionCompatibilityReport();
  await store.putCapsuleCompatibilityReport(report);

  let runnerPlanCalls = 0;
  const runner: OpenTofuRunner = {
    async plan() {
      runnerPlanCalls += 1;
      const digest = `sha256:${"a".repeat(64)}`;
      return {
        planDigest: digest,
        planArtifact: {
          kind: "runner-local",
          ref: `runner-local://plan-${runnerPlanCalls}/tfplan`,
          digest,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: `sha256:${"b".repeat(64)}`,
        requiredProviders: [
          CLOUDFLARE_PROVIDER,
          HTTP_PROVIDER,
          RANDOM_PROVIDER,
        ],
        providerInstallation: [
          CLOUDFLARE_PROVIDER,
          HTTP_PROVIDER,
          RANDOM_PROVIDER,
        ].map((provider) => ({
          provider,
          mirrored: true,
          installationMethod: "filesystem_mirror" as const,
          attested: true,
          attestationMethod: "test_filesystem_mirror",
          mirrorPath: `/opt/opentofu/provider-mirror/${provider}`,
        })),
        summary: { add: 10, change: 0, destroy: 0 },
      };
    },
    async apply() {
      throw new Error("apply is outside the coordinator contract");
    },
  };
  const profile = productionRunnerProfile();
  const moduleVariableMaterializer =
    createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        getCapsule: (id) => store.getCapsule(id),
        getInstallConfig: (id) => store.getInstallConfig(id),
      },
      accounts: accountsStore,
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: PAIRWISE_SUBJECT_SECRET,
      clock: () => new Date(NOW),
    });
  const controller = new OpenTofuController({
    store,
    runner,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      connectionId: CONNECTION_ID,
      provider: CLOUDFLARE_PROVIDER,
    }) as never,
    moduleVariableMaterializer,
    now: () => Date.parse(NOW),
    newId: (prefix) => `${prefix}_production_repro`,
  });

  const planCalls: Array<{
    readonly capsuleId: string;
    readonly options?: Readonly<Record<string, unknown>>;
  }> = [];
  const operations = {
    gitInstallPlans: planStore,
    workspaces: {
      getWorkspace: async () => workspace,
    },
    capsules: {
      getCapsule: async (id: string) => {
        const current = await store.getCapsule(id);
        if (!current) throw new OpenTofuControllerError("not_found", "missing");
        return current;
      },
    },
    getRun: (id: string) => controller.getRun(id),
    getRunCost: async () => {
      throw new OpenTofuControllerError("not_found", "cost unavailable");
    },
    createCapsulePlan: async (
      capsuleId: string,
      options?: {
        readonly compatibilityReportId?: string;
        readonly runnerProfileId?: string;
        readonly sourceSnapshotId?: string;
        readonly planRunId?: string;
        readonly actor?: string;
      },
    ): Promise<PlanRunResponse> => {
      planCalls.push({ capsuleId, ...(options ? { options } : {}) });
      return await controller.createCapsulePlan(
        capsuleId,
        options?.actor ? { actor: options.actor } : {},
        options ?? {},
      );
    },
  } as unknown as ControlPlaneOperations;

  const plan: StoredGitInstallPlan = {
    id: INSTALL_PLAN_ID,
    workspaceId: WORKSPACE_ID,
    createdBy: OWNER,
    actorSubject: OWNER,
    idempotencyKeyHash: `sha256:${"1".repeat(64)}`,
    requestDigest: `sha256:${"2".repeat(64)}`,
    operation: "install",
    source: {
      name: "task0032-yuru-v218-source",
      url: "https://github.com/tako0614/yurucommu.git",
      ref: "v2.1.8",
      path: ".",
    },
    capsule: {
      name: capsule.name,
      environment: capsule.environment,
    },
    options: {
      deploymentProfileKey: "cloudflare-v1",
      providerBindingConnectionIds: {
        [CLOUDFLARE_PROVIDER]: CONNECTION_ID,
      },
    },
    sourceId: SOURCE_ID,
    sourceSyncRunId: "ssr_yuru_production_repro",
    sourceSnapshotId: SNAPSHOT_ID,
    installConfigBaseId: cloudflareConfig.id,
    installConfigBaseDigest: `sha256:${"3".repeat(64)}`,
    installModulePath: ".",
    compatibilityRequestDigest: `sha256:${"4".repeat(64)}`,
    compatibilityCheckRunId: "ccr_yuru_production_repro",
    compatibilityReportId: COMPATIBILITY_REPORT_ID,
    installConfigId: INSTALL_CONFIG_ID,
    capsuleId: CAPSULE_ID,
    phase: "planning",
    generation: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await planStore.create(plan);

  return {
    accountsStore,
    getRun: (id: string) => controller.getRun(id),
    planCalls,
    runnerPlanCalls: () => runnerPlanCalls,
    request: async (path: string, body?: unknown) => {
      const url = new URL(`https://app.takosumi.com${path}`);
      const response = await handleAuthenticatedControlRoute({
        request: new Request(url, {
          method: "POST",
          headers: body === undefined
            ? {}
            : { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        url,
        store: accountsStore,
        operations,
        subject: OWNER,
      });
      if (!response) throw new Error("control route did not dispatch");
      return response;
    },
  };
}

async function productionTakosFixture(target: {
  readonly accountId: string;
  readonly workersSubdomain: string;
  readonly legacyFlatTargets?: {
    readonly accountId: string;
    readonly workersSubdomain: string;
  };
}) {
  const store = new InMemoryOpenTofuControlStore();
  const accountsStore = new InMemoryAccountsStore();
  const base = composeTakosInstallConfig({
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: TAKOS_RELEASE_DESCRIPTOR_URL,
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256:
      TAKOS_RELEASE_DESCRIPTOR_SHA256,
  });
  if (!base?.accountsOidcModuleVariableMaterialization) {
    throw new Error("Takos v0.12.6 hosted profile is missing");
  }
  const seeded = await seedCapsuleModel(store, {
    workspaceId: TAKOS_WORKSPACE_ID,
    sourceId: TAKOS_SOURCE_ID,
    snapshotId: TAKOS_SNAPSHOT_ID,
    installConfigId: TAKOS_INSTALL_CONFIG_ID,
    capsuleId: TAKOS_CAPSULE_ID,
    environment: "production",
    name: "task0032-takos-v0126-repro",
    sourceUrl: "https://github.com/tako0614/takos.git",
    ref: "v0.12.6",
    installConfig: {
      ...base,
      id: TAKOS_INSTALL_CONFIG_ID,
      workspaceId: TAKOS_WORKSPACE_ID,
      name: "task0032 Takos v0.12.6 Cloudflare",
      variableMapping: {
        project_name: "task0032-takos-v0126-repro",
        public_url: null,
        cloudflare: {
          account_id: target.accountId,
          workers_subdomain: target.workersSubdomain,
        },
        ...(target.legacyFlatTargets
          ? {
              cloudflare_account_id: target.legacyFlatTargets.accountId,
              cloudflare_workers_subdomain:
                target.legacyFlatTargets.workersSubdomain,
            }
          : {}),
      },
      // Production persisted this exact v2 profile before the composer stopped
      // naming output-shaped flat values as materializer inputs. RunEngine
      // correctly filters them because the Takos root declares only `cloudflare`.
      accountsOidcModuleVariableMaterialization: {
        ...base.accountsOidcModuleVariableMaterialization,
        additionalInputVariables: [
          "cloudflare_account_id",
          "cloudflare_workers_subdomain",
        ],
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const workspace = {
    ...seeded.workspace,
    ownerUserId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putWorkspace(workspace);
  const capsule = {
    ...seeded.capsule,
    installingPrincipalId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putCapsule(capsule);
  const connection: ProviderConnection = {
    id: TAKOS_CONNECTION_ID,
    workspaceId: TAKOS_WORKSPACE_ID,
    provider: "cloudflare/cloudflare",
    providerSource: CLOUDFLARE_PROVIDER,
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    secretPartition: "provider-credentials",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    scopeHints: {
      providerSettings: {
        accountId: TAKOS_CLOUDFLARE_ACCOUNT_ID,
        workersSubdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
      },
      moduleInputDefaults: {
        cloudflare_account_id: TAKOS_CLOUDFLARE_ACCOUNT_ID,
        cloudflare_workers_subdomain: TAKOS_CLOUDFLARE_WORKERS_SUBDOMAIN,
      },
    },
    credentialVerification: {
      kind: "takosumi.credential-verification@v1",
      verifierId: CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
      capabilities: [CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY],
    },
    createdAt: NOW,
    updatedAt: NOW,
    verifiedAt: NOW,
  };
  await store.putConnection(connection);
  await store.putProviderBindingSet({
    id: "dpf_takos_production_repro",
    workspaceId: TAKOS_WORKSPACE_ID,
    capsuleId: TAKOS_CAPSULE_ID,
    environment: "production",
    bindings: [
      { provider: CLOUDFLARE_PROVIDER, connectionId: TAKOS_CONNECTION_ID },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.putCapsuleCompatibilityReport(
    productionTakosCompatibilityReport(
      target.legacyFlatTargets !== undefined,
    ),
  );

  const planJobs: OpenTofuPlanJob[] = [];
  const runner: OpenTofuRunner = {
    async plan(job) {
      planJobs.push(job);
      const digest = `sha256:${"c".repeat(64)}`;
      return {
        planDigest: digest,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://takos-production-repro/tfplan",
          digest,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: `sha256:${"d".repeat(64)}`,
        requiredProviders: [CLOUDFLARE_PROVIDER],
        providerInstallation: [{
          provider: CLOUDFLARE_PROVIDER,
          mirrored: true,
          installationMethod: "filesystem_mirror",
          attested: true,
          attestationMethod: "test_filesystem_mirror",
          mirrorPath:
            `/opt/opentofu/provider-mirror/${CLOUDFLARE_PROVIDER}`,
        }],
        summary: { add: 10, change: 0, destroy: 0 },
      };
    },
    async apply() {
      throw new Error("apply is outside the coordinator contract");
    },
  };
  let accountsWrites = 0;
  const profile: RunnerProfile = {
    ...productionRunnerProfile(),
    id: "opentofu-default",
    name: "Takos production repro",
    capabilities: ["capsule.lifecycle.command.v1"],
    allowedProviders: [CLOUDFLARE_PROVIDER],
  };
  const moduleVariableMaterializer =
    createTakosumiAccountsOidcModuleVariableMaterializer({
      control: {
        getCapsule: (id) => store.getCapsule(id),
        getInstallConfig: (id) => store.getInstallConfig(id),
      },
      accounts: {
        findOidcClient: (...args) => accountsStore.findOidcClient(...args),
        findOidcClientForCapsule: (...args) =>
          accountsStore.findOidcClientForCapsule(...args),
        saveOidcClient: (...args) => {
          accountsWrites += 1;
          return accountsStore.saveOidcClient(...args);
        },
        revokeOidcClient: (...args) => {
          accountsWrites += 1;
          return accountsStore.revokeOidcClient(...args);
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: PAIRWISE_SUBJECT_SECRET,
      clock: () => new Date(NOW),
    });
  const controller = new OpenTofuController({
    store,
    runner,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      connectionId: TAKOS_CONNECTION_ID,
      provider: CLOUDFLARE_PROVIDER,
    }) as never,
    moduleVariableMaterializer,
    now: () => Date.parse(NOW),
    newId: (prefix) => `${prefix}_takos_production_repro`,
  });
  const operations = {
    workspaces: {
      getWorkspace: async () => workspace,
    },
    capsules: {
      getCapsule: async (id: string) => {
        const current = await store.getCapsule(id);
        if (!current) throw new OpenTofuControllerError("not_found", "missing");
        return current;
      },
    },
    getRun: (id: string) => controller.getRun(id),
    getRunCost: async () => {
      throw new OpenTofuControllerError("not_found", "cost unavailable");
    },
    createCapsulePlan: (
      capsuleId: string,
      options?: {
        readonly compatibilityReportId?: string;
        readonly runnerProfileId?: string;
      },
    ) => controller.createCapsulePlan(capsuleId, {}, options ?? {}),
  } as unknown as ControlPlaneOperations;

  return {
    accountsStore,
    accountsWrites: () => accountsWrites,
    planJobs,
    request: async () => {
      const url = new URL(
        `https://app.takosumi.com/api/v1/capsules/${TAKOS_CAPSULE_ID}/plan`,
      );
      const response = await handleAuthenticatedControlRoute({
        request: new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            compatibilityReportId: TAKOS_COMPATIBILITY_REPORT_ID,
          }),
        }),
        url,
        store: accountsStore,
        operations,
        subject: OWNER,
      });
      if (!response) throw new Error("control route did not dispatch");
      return response;
    },
  };
}

function productionTakosCompatibilityReport(
  declaresLegacyFlatTargets: boolean,
): CapsuleCompatibilityReport {
  return {
    id: TAKOS_COMPATIBILITY_REPORT_ID,
    sourceId: TAKOS_SOURCE_ID,
    sourceSnapshotId: TAKOS_SNAPSHOT_ID,
    modulePath: "deploy/opentofu/cloudflare",
    level: "ready",
    findings: [],
    providers: [{
      source: CLOUDFLARE_PROVIDER,
      aliases: [],
      allowed: true,
      credentialRequired: true,
    }],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [
      "cloudflare",
      ...(declaresLegacyFlatTargets
        ? ["cloudflare_account_id", "cloudflare_workers_subdomain"]
        : []),
      "project_name",
      "public_url",
      "takosumi_accounts_client_id",
      "takosumi_accounts_issuer_url",
      "takosumi_accounts_redirect_uri",
      "takosumi_accounts_url",
      "workspace_id",
    ],
    rootModuleVariableDeclarations: [],
    rootModuleOutputs: [],
    createdAt: NOW,
  };
}

function productionCompatibilityReport(): CapsuleCompatibilityReport {
  return {
    id: COMPATIBILITY_REPORT_ID,
    sourceId: SOURCE_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    modulePath: ".",
    level: "ready",
    findings: [],
    providers: [
      {
        source: CLOUDFLARE_PROVIDER,
        aliases: [],
        allowed: true,
        credentialRequired: true,
      },
      { source: HTTP_PROVIDER, aliases: [], allowed: true },
      { source: RANDOM_PROVIDER, aliases: [], allowed: true },
    ],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [
      "allow_unpinned_owner_claim",
      "app_url",
      "auth_password_hash",
      "cloudflare_account_id",
      "cloudflare_route_pattern",
      "cloudflare_route_zone_id",
      "cloudflare_workers_subdomain",
      "enable_cloudflare_resources",
      "enable_cloudflare_worker_script",
      "enable_worker_assets",
      "enable_workers_dev_subdomain",
      "encryption_key",
      "env",
      "notification_push_gateway_token",
      "notification_push_gateway_url",
      "notification_push_web_push_public_key",
      "oidc_allowed_subs",
      "oidc_owner_sub",
      "project_name",
      "takosumi_accounts_client_id",
      "takosumi_accounts_issuer_url",
      "worker_assets_directory",
      "worker_bundle_path",
      "worker_bundle_sha256",
      "worker_bundle_url",
      "worker_compatibility_date",
      "worker_compatibility_flags",
      "worker_main_module",
      "worker_name",
      "worker_release_tag",
    ],
    rootModuleVariableDeclarations: [],
    rootModuleOutputs: [],
    createdAt: NOW,
  };
}

function productionRunnerProfile(): RunnerProfile {
  return {
    id: "runner_yuru_production_repro",
    name: "Yuru production repro",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [CLOUDFLARE_PROVIDER, HTTP_PROVIDER, RANDOM_PROVIDER],
    requireProviderBindings: false,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: Date.parse(NOW),
  };
}
