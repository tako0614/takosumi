import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import type {
  PlanResourceChange,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
  type InstallationProviderEnvBindingMintEntry,
} from "../../../../core/adapters/vault/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedInstallationModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

// Official catalog modules are dispatched as generatedRoot.moduleFiles; the
// user source is irrelevant to the OpenTofu surface (build input only). A
// trivial git source keeps validateSource happy.
const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
}

function recordingRunner(options?: {
  readonly planResourceChanges?: readonly PlanResourceChange[];
  readonly outputs?: Record<string, { sensitive?: boolean; value: unknown }>;
}): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  return {
    planJobs,
    applyJobs,
    plan: (job) => {
      planJobs.push(job);
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        ...(options?.planResourceChanges
          ? { planResourceChanges: options.planResourceChanges }
          : {}),
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      const hasOutputsOption =
        options !== undefined &&
        Object.prototype.hasOwnProperty.call(options, "outputs");
      const outputs = hasOutputsOption
        ? options.outputs
        : {
            worker_name: { sensitive: false, value: "my-worker" },
            url: { sensitive: false, value: "https://my-worker.example" },
          };
      return Promise.resolve({
        ...(outputs ? { outputs: outputs as never } : {}),
      });
    },
    destroy: () => Promise.resolve({}),
  };
}

// A minimal Vault so the controller mints (and the dispatch carries) credentials.
function fakeVault() {
  const sharedEvidence = [
    {
      provider: FIXTURE_CLOUDFLARE_PROVIDER,
      connectionId: "conn_template",
      delivery: "provider_env" as const,
      rootOnly: false,
      temporary: true,
      ttlEnforced: true,
      phase: "plan" as const,
    },
  ];
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () =>
      Promise.resolve({ status: "verified" } satisfies TestConnectionResponse),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          { CLOUDFLARE_API_TOKEN: "tok-secret" },
          [],
          sharedEvidence,
        ),
      ),
    mintForPhase: () =>
      Promise.resolve(new PhaseMintBundle({ env: {} }, [], [])),
    mintForInstallationProviderEnvBindings: (
      _spaceId: string,
      entries: readonly InstallationProviderEnvBindingMintEntry[],
      options?: { readonly phase?: "plan" | "apply" | "destroy" },
    ) =>
      Promise.resolve(
        new PhaseMintBundle(
          {
            env: Object.fromEntries(
              entries.map((entry) => {
                const alias = entry.alias ? `_${entry.alias}` : "";
                return [`TF_VAR_cloudflare${alias}_api_token`, "tok-secret"];
              }),
            ),
          },
          [],
          entries.map((entry) => ({
            provider: FIXTURE_CLOUDFLARE_PROVIDER,
            connectionId: entry.connectionId,
            delivery: "generated_root_variable" as const,
            rootOnly: true,
            temporary: true,
            ttlEnforced: true,
            phase: options?.phase ?? "plan",
          })),
        ),
      ),
  };
}

const INSTALLATION_ID = "inst_template";
// The Installation is seeded with a prior current Deployment so the
// installation-first apply guard (`installationCurrentDeploymentId`) is
// satisfiable; the template tests drive templateId directly through
// createPlanRun (the user source stays a build input only), so the seeded
// Source/Snapshot are present only to keep the Installation row well-formed.
const SEED_DEPLOYMENT_ID = "dep_seed";

/**
 * Builds a controller whose store already holds the Space-direct Installation
 * model (spec §5) the installation-first plan/apply path requires, plus a
 * seeded current Deployment so a template-driven apply passes the
 * `installationCurrentDeploymentId` guard. Returns the controller and the
 * seeded installation id used as `createPlanRun({ installationId })`.
 */
async function seededTemplateController(
  deps: Omit<
    ConstructorParameters<typeof OpenTofuDeploymentController>[0],
    "store"
  > = {},
): Promise<{
  controller: OpenTofuDeploymentController;
  store: InMemoryOpenTofuDeploymentStore;
  installationId: string;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  // Raw template-driven createPlanRun never sets installationContext, so the
  // controller backfills Installation context from the Installation row. The
  // prior deployment attached below is what unlocks the apply guard.
  await seedInstallationModel(store, { installationId: INSTALLATION_ID });
  await store.putConnection({
    id: "conn_template",
    scope: "space",
    spaceId: "space_test",
    provider: "cloudflare",
    providerSource: FIXTURE_CLOUDFLARE_PROVIDER,
    kind: "cloudflare_api_token",
    displayName: "Template Cloudflare",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  // Attach a prior current Deployment so the apply guard has a concrete cursor.
  const installation = await store.getInstallation(INSTALLATION_ID);
  await store.putInstallation({
    ...installation!,
    currentDeploymentId: SEED_DEPLOYMENT_ID,
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_template",
    spaceId: installation!.spaceId,
    installationId: installation!.id,
    environment: installation!.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_template",
      },
      {
        provider: "cloudflare",
        alias: "zone",
        connectionId: "conn_template",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const controller = new OpenTofuDeploymentController({ ...deps, store });
  return { controller, store, installationId: INSTALLATION_ID };
}

test("template plan dispatch carries generated root module files and no app build payload", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
    ],
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-worker-service",
    templateVersion: "1.0.0",
    inputs: { appName: "my-worker", accountId: "acct_123" },
  });

  expect(planRun.status).toEqual("succeeded");
  expect("templateBinding" in planRun).toBe(false);
  const persistedPlan = await store.getPlanRun(planRun.id);
  expect(persistedPlan?.templateBinding?.templateId).toEqual(
    "cloudflare-worker-service",
  );
  expect(persistedPlan?.templateBinding?.requiresConfirmation).toEqual(false);
  // requiredProviders derived + canonicalized from the template policy.
  expect(planRun.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);

  expect(runner.planJobs).toHaveLength(1);
  const planJob = runner.planJobs[0]!;
  expect(planJob.template).toBeUndefined();
  expect(planJob.generatedRoot?.moduleFiles?.[0]?.path).toEqual("main.tf");
  expect(planJob.generatedRoot?.moduleFiles?.[0]?.text).toContain(
    'resource "cloudflare_workers_script" "this"',
  );
  const sidecar = await store.getPlanRunInputs(planRun.id);
  expect(sidecar?.template).toBeUndefined();
  expect(sidecar?.generatedRoot?.moduleFiles?.[0]?.path).toEqual("main.tf");
  expect(Object.keys(planJob.generatedRoot!.files).sort()).toEqual([
    "main.tf",
    "outputs.tf",
    "versions.tf",
  ]);
  expect(planJob.generatedRoot!.files["main.tf"]).toContain(
    'appName = "my-worker"',
  );
  expect(planJob.build).toBeUndefined();
  // Credentials are minted for the tofu phase and attached to the dispatch only
  // as generated-root variables, never as shared provider env.
  expect(planJob.credentials).toMatchObject({
    TF_VAR_cloudflare_main_api_token: "tok-secret",
  });
  expect(planJob.credentials).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
});

test("template plan is blocked when the plan introduces a disallowed resource type", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
      // Not in the Worker starter template allowlist.
      {
        address: "module.app.cloudflare_r2_bucket.x",
        type: "cloudflare_r2_bucket",
        actions: ["create"],
      },
    ],
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-hello-worker",
    templateVersion: "1.0.0",
    inputs: {
      appName: "my-worker",
      accountId: "a",
      workersSubdomain: "team",
    },
  });

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toMatch(
    /cloudflare_r2_bucket is not allowed/,
  );
});

test("template plan enforces InstallConfig scope boundary and quota", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
        scope: { cloudflareAccountId: "acct_allowed" },
      },
      {
        address: "module.app.cloudflare_workers_script_subdomain.this",
        type: "cloudflare_workers_script_subdomain",
        actions: ["create"],
        scope: { cloudflareAccountId: "acct_allowed" },
      },
    ],
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });
  const installation = await store.getInstallation(installationId);
  const installConfig = await store.getInstallConfig(
    installation!.installConfigId,
  );
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      scopeBoundary: {
        mode: "strict",
        cloudflare: { accountIds: ["acct_allowed"] },
      },
      quota: { "resources.total": 1 },
    },
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-hello-worker",
    templateVersion: "1.0.0",
    inputs: {
      appName: "my-worker",
      accountId: "acct_allowed",
      workersSubdomain: "team",
    },
  });

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).not.toContain("out of scope");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "resources.total count 2 exceeds 1",
  );
});

test("destructive template plan requires confirmDestructive at apply", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["delete", "create"],
      },
    ],
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-hello-worker",
    templateVersion: "1.0.0",
    inputs: {
      appName: "my-worker",
      accountId: "a",
      workersSubdomain: "team",
    },
  });
  // A template `requiresConfirmation` change stays `succeeded` (it is gated by
  // `confirmDestructive` at apply, NOT by a recorded approval), so the persisted
  // status is `succeeded` and the read projection derives `waiting_approval`.
  expect(planRun.status).toEqual("succeeded");
  expect("templateBinding" in planRun).toBe(false);
  expect(
    (await store.getPlanRun(planRun.id))?.templateBinding?.requiresConfirmation,
  ).toEqual(true);

  // Apply without confirmation is rejected.
  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/confirmDestructive=true/);

  // Apply with confirmation succeeds.
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
    confirmDestructive: true,
  });
  expect(applied.applyRun.status).toEqual("succeeded");
  // Apply dispatch also carries the generated root + bundled module files.
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.template).toBeUndefined();
  expect(runner.applyJobs[0]!.generatedRoot?.moduleFiles?.[0]?.path).toEqual(
    "main.tf",
  );
  expect(runner.applyJobs[0]!.generatedRoot?.files["main.tf"]).toContain(
    'source = "./template-module"',
  );
  expect(runner.applyJobs[0]!.generatedRoot?.files["outputs.tf"]).toContain(
    "module.app.worker_name",
  );
});

test("output allowlist projects only template public outputs after the sensitive filter", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
    ],
    outputs: {
      worker_name: { sensitive: false, value: "my-worker" },
      url: { sensitive: false, value: "https://my-worker.example" },
      // Not declared as a public output: must be dropped.
      internal_arn: { sensitive: false, value: "arn:secret" },
      // Declared public name but sensitive: must be dropped.
    },
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-hello-worker",
    templateVersion: "1.0.0",
    inputs: {
      appName: "my-worker",
      accountId: "a",
      workersSubdomain: "team",
    },
  });
  const rootOutputs = runner.planJobs[0]!.generatedRoot?.files["outputs.tf"];
  expect(rootOutputs).toContain('output "worker_name"');
  expect(rootOutputs).toContain("value = module.app.worker_name");
  expect(rootOutputs).toContain('output "url"');
  expect(rootOutputs).toContain("value = module.app.url");
  expect(rootOutputs).not.toContain("internal_arn");
  const sidecar = await store.getPlanRunInputs(planRun.id);
  expect(sidecar?.generatedRoot?.files["outputs.tf"]).toEqual(rootOutputs);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(runner.applyJobs[0]!.generatedRoot?.files["outputs.tf"]).toEqual(
    rootOutputs,
  );

  // The §21 Deployment records the projected public outputs as `outputsPublic`
  // (name -> value); the ApplyRun keeps the full projected DeploymentOutput[]
  // (both filtered through the sensitive/redaction step). The template output
  // allowlist must leave only the two declared public names.
  expect(applied.applyRun.outputs).toEqual([
    {
      name: "worker_name",
      kind: "string",
      value: "my-worker",
      sensitive: false,
    },
    {
      name: "url",
      kind: "url",
      value: "https://my-worker.example",
      sensitive: false,
    },
  ]);
  expect(applied.deployment?.outputsPublic).toEqual({
    worker_name: "my-worker",
    url: "https://my-worker.example",
  });
});

test("template apply fails closed when declared public outputs are missing", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
    ],
    outputs: {},
  });
  const { controller, store, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    source: SOURCE,
    templateId: "cloudflare-hello-worker",
    templateVersion: "1.0.0",
    inputs: {
      appName: "my-worker",
      accountId: "a",
      workersSubdomain: "team",
    },
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applied.applyRun.status).toBe("failed");
  expect(applied.deployment).toBeUndefined();
  expect(JSON.stringify(applied.applyRun.diagnostics ?? [])).toContain(
    "output worker_name is missing",
  );
  const persistedPlan = await store.getPlanRun(planRun.id);
  expect(persistedPlan?.appliedApplyRunId).toBeUndefined();
});

test("templateVersion/inputs without templateId is rejected", async () => {
  const { controller, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: recordingRunner(),
  });
  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      installationId,
      source: SOURCE,
      templateVersion: "1.0.0",
    }),
  ).rejects.toThrow(/require templateId/);
});

test("requiredProviders must not be passed alongside a template", async () => {
  const { controller, installationId } = await seededTemplateController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: recordingRunner(),
  });
  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      installationId,
      source: SOURCE,
      templateId: "cloudflare-hello-worker",
      templateVersion: "1.0.0",
      inputs: {
        appName: "my-worker",
        accountId: "a",
        workersSubdomain: "team",
      },
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/derived from the template/);
});

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}
