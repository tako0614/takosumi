/**
 * Install-type wiring integration tests (Core Specification §10 / §13).
 *
 * M5 completes the §10 install types on the installation-driven plan path:
 *   - `core` / `opentofu_module` / `app_source` template-bound configs drive the
 *     §13 `generateInstallationRoot` generated root (installType-aware, with
 *     per-capability provider aliases derived from the resolved capabilities);
 *   - `app_source` threads the InstallConfig.build onto the dispatch (the build
 *     runs in the Container with ZERO credentials — invariant 3);
 *   - manual-mode capability values merge into the template inputs, overriding
 *     the InstallConfig variableMapping (§13 decision);
 *   - `opentofu_root` rejects a templateBinding (the SourceSnapshot IS the root).
 *
 * A recording runner captures the dispatch payload so the generated root files,
 * build spec, provider aliases, and output projection are asserted directly.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import type {
  Connection,
  InstallConfig,
} from "takosumi-contract/deploy-control-api";
import type { CapabilityBindings } from "takosumi-contract/capability-bindings";
import { seedInstallationModel } from "./test_model_fixture.ts";
import { StaticSecretConnectionVault } from "../../adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
}

function recordingRunner(
  outputs: Record<string, { sensitive?: boolean; value: unknown }>,
): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
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
        // No resource changes recorded so the template policy leaves confirmation
        // unrequired (these installs target an approval-free `preview` env).
        planResourceChanges: [],
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: outputs as never,
        stateDigest: STATE_DIGEST,
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({});
    },
  };
}

/** A space-scoped provider Connection so a capability resolves to a provider. */
function connection(
  id: string,
  provider: string,
  spaceId = "space_test",
): Connection {
  return {
    id,
    spaceId,
    provider,
    scope: "space",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}

interface InstallTypeFixtureOptions {
  readonly installConfig: Partial<InstallConfig>;
  readonly bindings?: CapabilityBindings;
  readonly connections?: readonly Connection[];
  readonly outputs?: Record<string, { sensitive?: boolean; value: unknown }>;
}

/**
 * Seeds the Space-direct Installation model with a template-bound InstallConfig
 * and optional capability bindings + connections, returning a wired controller.
 * Defaults to the approval-free `preview` environment.
 */
async function installTypeFixture(options: InstallTypeFixtureOptions): Promise<{
  store: OpenTofuDeploymentStore;
  runner: RecordingRunner;
  controller: OpenTofuDeploymentController;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  for (const conn of options.connections ?? []) {
    await store.putConnection(conn);
  }
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: options.installConfig,
  });
  if (options.bindings) {
    await store.putDeploymentProfile({
      id: "profile_fixture",
      spaceId: seeded.installation.spaceId,
      installationId: seeded.installation.id,
      environment: seeded.installation.environment,
      bindings: options.bindings,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
  }
  const runner = recordingRunner(options.outputs ?? {});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  return { store, runner, controller };
}

test("core install plan generates a provider-free root and apply projects the 4 core outputs", async () => {
  const { store, runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "core",
      templateBinding: { templateId: "core", templateVersion: "1.0.0" },
      variableMapping: { base_domain: "example.com" },
      outputAllowlist: {
        base_domain: { from: "base_domain", type: "hostname" },
        public_origin: { from: "public_origin", type: "url" },
        member_issuer: { from: "member_issuer", type: "url" },
        service_registry_url: { from: "service_registry_url", type: "url" },
      },
      policy: {},
    },
    outputs: {
      base_domain: { sensitive: false, value: "example.com" },
      public_origin: { sensitive: false, value: "https://example.com" },
      member_issuer: { sensitive: false, value: "https://example.com" },
      service_registry_url: {
        sensitive: false,
        value: "https://example.com/.well-known/services",
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.templateBinding?.templateId).toEqual("core");

  // The generated root is installType-aware but carries NO provider alias blocks
  // (core declares no providers, and no capability resolved to a provider).
  const planJob = runner.planJobs[0]!;
  expect(planJob.template).toEqual({
    id: "core",
    version: "1.0.0",
    localModulePath: "/app/templates/core/module",
  });
  const mainTf = planJob.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('source = "./template-module"');
  expect(mainTf).toContain('base_domain = "example.com"');
  expect(mainTf).not.toContain("provider ");
  expect(mainTf).not.toContain("providers = {");
  // core has no build phase.
  expect(planJob.build).toBeUndefined();

  // Apply projects the 4 core outputs through the InstallConfig output allowlist.
  const { applyRun, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");
  expect((applyRun.outputs ?? []).map((o) => o.name).sort()).toEqual([
    "base_domain",
    "member_issuer",
    "public_origin",
    "service_registry_url",
  ]);
  expect(deployment?.outputsPublic).toMatchObject({
    base_domain: "example.com",
    public_origin: "https://example.com",
  });

  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(1);
});

test("opentofu_module install emits per-capability provider aliases from resolved capabilities", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {},
    },
    connections: [connection("conn_cf", "cloudflare")],
    bindings: {
      compute: { mode: "connection", connectionId: "conn_cf" },
    },
    outputs: {
      worker_name: { sensitive: false, value: "my-worker" },
      url: { sensitive: false, value: "https://my-worker.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  // The compute capability resolved to the cloudflare connection -> an aliased
  // provider block wired from a sensitive per-alias credential var + a providers
  // map on the module (§13).
  expect(mainTf).toContain("provider \"cloudflare\" {");
  expect(mainTf).toContain('alias = "compute"');
  expect(mainTf).toContain("providers = {");
  expect(mainTf).toContain("cloudflare.compute = cloudflare.compute");
  // Per-alias credential split (§13): a sensitive credential var is declared and
  // wired into the alias; the deferred wording is gone.
  expect(mainTf).toContain('variable "cloudflare_compute_api_token" {');
  expect(mainTf).toContain("  api_token = var.cloudflare_compute_api_token");
  expect(mainTf).not.toContain("DEFERRED");
  // The template input is still wired.
  expect(mainTf).toContain('appName = "my-worker"');
});

test("app_source install threads InstallConfig.build onto the dispatch (build precedence over template build)", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "app_source",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-app", accountId: "acct_123" },
      build: {
        enabled: true,
        commands: ["bun install", "bun run bundle"],
        artifactPath: "build/worker.js",
      },
      policy: {},
    },
    connections: [connection("conn_cf", "cloudflare")],
    bindings: {
      compute: { mode: "connection", connectionId: "conn_cf" },
    },
    outputs: {
      worker_name: { sensitive: false, value: "my-app" },
      url: { sensitive: false, value: "https://my-app.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  // InstallConfig.build wins over the template's own build (M5 decision); the
  // build is the standard DispatchBuildSpec (runs in the Container, no creds).
  expect(runner.planJobs[0]!.build).toEqual({
    runtime: "bun",
    commands: ["bun install", "bun run bundle"],
    artifactPath: "build/worker.js",
  });
  // The build phase NEVER carries provider credentials (invariant 3): the
  // credential bundle is a separate dispatch field (absent here — no vault).
  expect(runner.planJobs[0]!.credentials).toBeUndefined();
});

test("app_source with build disabled falls back to the template build", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "app_source",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-app", accountId: "acct_123" },
      build: { enabled: false, commands: ["ignored"] },
      policy: {},
    },
    outputs: {
      worker_name: { sensitive: false, value: "my-app" },
      url: { sensitive: false, value: "https://my-app.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");
  // Disabled InstallConfig.build -> the template's own build is used.
  expect(runner.planJobs[0]!.build).toEqual({
    runtime: "bun",
    commands: ["bun install --frozen-lockfile", "bun run build"],
    artifactPath: "dist/index.js",
  });
});

test("manual-mode capability values override the InstallConfig variableMapping", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      // variableMapping sets appName; the manual value below must override it.
      variableMapping: { appName: "from-mapping", accountId: "acct_mapping" },
      policy: {},
    },
    bindings: {
      // A manual capability supplies override values (not a provider).
      compute: {
        mode: "manual",
        values: { accountId: "acct_override", unknown_key: "ignored" },
      },
    },
    outputs: {
      worker_name: { sensitive: false, value: "from-mapping" },
      url: { sensitive: false, value: "https://x.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  // Manual value wins on the accountId collision; the unknown manual key is
  // ignored (not a declared template input).
  expect(mainTf).toContain('accountId = "acct_override"');
  expect(mainTf).not.toContain("acct_mapping");
  expect(mainTf).not.toContain("unknown_key");
  // The non-overridden mapping value survives.
  expect(mainTf).toContain('appName = "from-mapping"');
});

test("opentofu_root install config rejects a templateBinding", async () => {
  const { controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_root",
      // opentofu_root must NOT carry a templateBinding: the SourceSnapshot is the
      // root configuration directly.
      templateBinding: { templateId: "core", templateVersion: "1.0.0" },
      policy: {},
    },
  });

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow(/opentofu_root .* templateBinding/);
});

test("apply dispatch carries TF_VAR_<provider>_<capability>_<arg> per-alias creds and never leaks values into run records (§13)", async () => {
  const SECRET_TOKEN = "cf-secret-per-alias-token";
  const store = new InMemoryOpenTofuDeploymentStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  // Register the cloudflare connection THROUGH the vault so its sealed blob
  // exists; bind compute to it so resolveCapabilities -> per-alias mint resolves.
  const conn = await vault.register({
    spaceId: "space_test",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN },
  });
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {},
    },
  });
  await store.putDeploymentProfile({
    id: "profile_creds",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: { compute: { mode: "connection", connectionId: conn.id } },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({
    worker_name: { sensitive: false, value: "my-worker" },
    url: { sensitive: false, value: "https://my-worker.workers.dev" },
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  // The plan dispatch already carries the per-alias TF_VAR credential, merged on
  // top of the shared provider env (CLOUDFLARE_API_TOKEN for compatibility).
  const planCreds = runner.planJobs[0]!.credentials!;
  expect(planCreds.TF_VAR_cloudflare_compute_api_token).toEqual(SECRET_TOKEN);
  expect(planCreds.CLOUDFLARE_API_TOKEN).toEqual(SECRET_TOKEN);

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  // The apply dispatch ALSO carries the per-alias TF_VAR (re-resolved at mint).
  const applyCreds = runner.applyJobs[0]!.credentials!;
  expect(applyCreds.TF_VAR_cloudflare_compute_api_token).toEqual(SECRET_TOKEN);

  // The secret value must NEVER reach any persisted run record (plan / apply /
  // deployment / state). Credentials live only on the dispatch payload.
  const persistedPlan = await store.getPlanRun(planRun.id);
  const persistedApply = await store.getApplyRun(applyRun.id);
  expect(JSON.stringify(persistedPlan)).not.toContain(SECRET_TOKEN);
  expect(JSON.stringify(persistedApply)).not.toContain(SECRET_TOKEN);
  const installation = (await store.getInstallation("inst_fixture"))!;
  const deployment = installation.currentDeploymentId
    ? await store.getDeployment(installation.currentDeploymentId)
    : undefined;
  expect(JSON.stringify(deployment)).not.toContain(SECRET_TOKEN);
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(JSON.stringify(latest)).not.toContain(SECRET_TOKEN);
});

test("opentofu_root install uses the raw-module path (snapshot as root, no generated root)", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_root",
      // No templateBinding: the snapshot is the OpenTofu root configuration.
      policy: {},
    },
    outputs: { launch_url: { sensitive: false, value: "https://x.example" } },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");
  // Raw-module path: no template binding, no generated root, no build.
  expect(planRun.templateBinding).toBeUndefined();
  const planJob = runner.planJobs[0]!;
  expect(planJob.template).toBeUndefined();
  expect(planJob.generatedRoot).toBeUndefined();
  expect(planJob.build).toBeUndefined();
  // The dispatch source is the resolved snapshot (pinned to the commit).
  expect(planJob.planRun.source.kind).toEqual("git");
});
