/**
 * Install-type wiring integration tests (Core Specification §10 / §13).
 *
 * M5 completes the §10 install types on the installation-driven plan path:
 *   - `core` / `opentofu_module` / `app_source` template-bound configs drive the
 *     §13 `generateInstallationRoot` generated root (installType-aware, with
 *     provider aliases derived from the resolved provider bindings);
 *   - `app_source` threads the InstallConfig.build onto the dispatch (the build
 *     runs in the Container with ZERO credentials — invariant 3);
 *   - manual-mode provider values merge into the template inputs, overriding
 *     the InstallConfig variableMapping (§13 decision);
 *   - legacy `opentofu_root` rows remain readable but fail closed at plan time;
 *     Takosumi v1 requires a generated-root Capsule install type.
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
import { projectPlanRun } from "./projection_run.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import type {
  Connection,
  InstallConfig,
} from "@takosumi/internal/deploy-control-api";
import type { ProviderBindings } from "takosumi-contract/provider-bindings";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedInstallationModel,
} from "./test_model_fixture.ts";
import {
  CredentialBundle,
  StaticSecretConnectionVault,
} from "../../adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
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
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
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

/** A space-scoped provider Connection so a provider binding resolves. */
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

async function markConnectionVerified(
  store: InMemoryOpenTofuDeploymentStore,
  conn: Connection,
): Promise<Connection> {
  const verified: Connection = {
    ...conn,
    status: "verified",
    verifiedAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putConnection(verified);
  return verified;
}

interface InstallTypeFixtureOptions {
  readonly installConfig: Partial<InstallConfig>;
  readonly bindings?: ProviderBindings;
  readonly connections?: readonly Connection[];
  readonly outputs?: Record<string, { sensitive?: boolean; value: unknown }>;
}

/**
 * Seeds the Space-direct Installation model with a template-bound InstallConfig
 * and optional provider bindings + connections, returning a wired controller.
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
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  return { store, runner, controller };
}

function fakeProviderVault() {
  const sharedEvidence = {
    provider: FIXTURE_CLOUDFLARE_PROVIDER,
    connectionId: "conn_cf",
    delivery: "provider_env" as const,
    rootOnly: false,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  const rootEvidence = {
    provider: FIXTURE_CLOUDFLARE_PROVIDER,
    connectionId: "conn_cf",
    delivery: "generated_root_variable" as const,
    rootOnly: true,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          {
            CLOUDFLARE_API_TOKEN: "fixture-provider-token",
          },
          [],
          [sharedEvidence],
        ),
      ),
    mintForProviderBindings: () =>
      Promise.resolve(
        new CredentialBundle(
          {
            TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
          },
          [],
          [rootEvidence],
        ),
      ),
  };
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
  expect("templateBinding" in planRun).toBe(false);
  expect(
    (await store.getPlanRun(planRun.id))?.templateBinding?.templateId,
  ).toEqual("core");

  // The generated root is installType-aware but carries NO provider alias blocks
  // (core declares no providers, and no provider binding resolved).
  const planJob = runner.planJobs[0]!;
  expect(planJob.template).toBeUndefined();
  expect(planJob.generatedRoot?.moduleFiles?.[0]?.path).toEqual("main.tf");
  expect(planJob.generatedRoot?.moduleFiles?.[0]?.text).toContain(
    'output "member_issuer"',
  );
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
  expect(JSON.stringify(applyRun.diagnostics ?? [])).toEqual("[]");
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

test("opentofu_module install emits provider aliases from resolved provider bindings", async () => {
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
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_cf",
      },
    ],
    outputs: {
      worker_name: { sensitive: false, value: "my-worker" },
      url: { sensitive: false, value: "https://my-worker.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  // The cloudflare binding resolved to the connection -> an aliased provider
  // block wired from a sensitive per-alias credential var + a providers map on
  // the module (§13).
  expect(mainTf).toContain('provider "cloudflare" {');
  expect(mainTf).toContain('alias = "main"');
  expect(mainTf).toContain("providers = {");
  expect(mainTf).toContain("cloudflare.main = cloudflare.main");
  // Per-alias credential split (§13): a sensitive credential var is declared and
  // wired into the alias; the deferred wording is gone.
  expect(mainTf).toContain('variable "cloudflare_main_api_token" {');
  expect(mainTf).toContain("  api_token = var.cloudflare_main_api_token");
  expect(mainTf).not.toContain("DEFERRED");
  // The template input is still wired.
  expect(mainTf).toContain('appName = "my-worker"');
});

test("managed worker install (operator-default credential) redirects the cloudflare provider base_url to the cf-proxy; self-host does not", async () => {
  // SELF-HOST: a Space connection binds the cloudflare provider -> NOT the
  // operator default -> no base_url redirect, so the generated root renders the
  // plain provider block byte-identically (no `base_url`).
  const selfHost = await installTypeFixture({
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
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_cf",
      },
    ],
  });
  const { planRun: selfHostPlan } =
    await selfHost.controller.createInstallationPlan("inst_fixture");
  expect(selfHostPlan.status).toEqual("succeeded");
  const selfHostMainTf =
    selfHost.runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(selfHostMainTf).not.toContain("base_url");

  // MANAGED: no Space connection and no explicit binding -> the cloudflare
  // provider falls through to the operator default (§7.1, the managed key) ->
  // the control plane redirects the provider base_url to the cf-proxy so a plain
  // worker script lands in the operator's dispatch namespace.
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putConnection({
    id: "conn_op_cf",
    scope: "operator",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } as Connection);
  await store.putOperatorConnectionDefault({
    id: "ocd_cf",
    provider: "cloudflare",
    connectionId: "conn_op_cf",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await seedInstallationModel(store, {
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
  // Minimal vault: mints a temporary per-alias token for the operator-default
  // cloudflare binding (the cloudflare-default profile rejects static creds).
  const operatorDefaultVault = {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" as const }),
    revoke: () => Promise.resolve(true),
    mint: () => Promise.resolve(new CredentialBundle({})),
    mintForProviderBindings: (
      _spaceId: string,
      entries: readonly { provider: string; connectionId: string; alias?: string }[],
    ) =>
      Promise.resolve(
        new CredentialBundle(
          Object.fromEntries(
            entries.map((entry) => [
              `TF_VAR_cloudflare${entry.alias ? `_${entry.alias}` : ""}_api_token`,
              "operator-key-token",
            ]),
          ),
          [],
          entries.map((entry) => ({
            provider: FIXTURE_CLOUDFLARE_PROVIDER,
            connectionId: entry.connectionId,
            delivery: "generated_root_variable" as const,
            rootOnly: true,
            temporary: true,
            ttlEnforced: true,
            expiresAt: "2026-06-07T01:00:00.000Z",
            ttlSeconds: 3600,
            phase: "plan" as const,
          })),
        ),
      ),
  };
  const managedRunner = recordingRunner({});
  const managedController = new OpenTofuDeploymentController({
    store,
    runner: managedRunner,
    vault: operatorDefaultVault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  const { planRun: managedPlan } =
    await managedController.createInstallationPlan("inst_fixture");
  expect(managedPlan.status).toEqual("succeeded");
  const managedMainTf =
    managedRunner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  // The cloudflare provider block carries the cf-proxy base_url scoped to the
  // dispatch namespace + the install slug ("app"); a capsule cannot override it.
  expect(managedMainTf).toContain(
    'base_url = "https://app.takosumi.com/internal/cf-proxy/takosumi-tenants/app/client/v4"',
  );
});

test("provider-using installation fails closed when the connection vault is absent", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const conn = connection("conn_cf", "cloudflare");
  await store.putConnection(conn);
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
    id: "profile_no_vault",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: conn.id }],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("failed");
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "credential_mint_failed: connection vault is not configured",
  );
  expect(runner.planJobs).toHaveLength(0);
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
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: "conn_cf" }],
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
  // The build phase NEVER carries provider credentials: the provider bundle is
  // a separate plan-phase dispatch field, not part of DispatchBuildSpec.
  expect(JSON.stringify(runner.planJobs[0]!.build)).not.toContain(
    "fixture-provider-token",
  );
  expect(runner.planJobs[0]!.credentials).toEqual({
    TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
  });
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

test("manual-mode provider values override the InstallConfig variableMapping", async () => {
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
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "manual",
        values: { accountId: "acct_override" },
      },
    ],
    outputs: {
      worker_name: { sensitive: false, value: "from-mapping" },
      url: { sensitive: false, value: "https://x.workers.dev" },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  // Manual value wins on the accountId collision.
  expect(mainTf).toContain('accountId = "acct_override"');
  expect(mainTf).not.toContain("acct_mapping");
  // The non-overridden mapping value survives.
  expect(mainTf).toContain('appName = "from-mapping"');
});

test("manual-mode provider values reject keys outside the template input contract", async () => {
  const { controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "from-mapping", accountId: "acct_mapping" },
      policy: {},
    },
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "manual",
        values: { unknown_key: "rejected" },
      },
    ],
  });

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow(/manual provider value 'unknown_key'/);
});

test("legacy opentofu_root install config fails closed even when it carries a templateBinding", async () => {
  const { controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_root",
      templateBinding: { templateId: "core", templateVersion: "1.0.0" },
      policy: {},
    },
  });

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow(/legacy opentofu_root/);
});

test("apply dispatch carries TF_VAR_<provider>_<alias>_<arg> per-alias creds and never leaks values into run records (§13)", async () => {
  const BOOTSTRAP_TOKEN = "cf-bootstrap-per-alias-token";
  const RUN_TOKEN = "cf-run-scoped-per-alias-token";
  const store = new InMemoryOpenTofuDeploymentStore();
  let cloudflareTokenCreateCalls = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    fetch: (async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://api.cloudflare.com/client/v4/user/tokens");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${BOOTSTRAP_TOKEN}`,
      );
      cloudflareTokenCreateCalls += 1;
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            value: `${RUN_TOKEN}-${cloudflareTokenCreateCalls}`,
            expires_on: "2026-06-06T01:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as never,
  });
  // Register the cloudflare connection THROUGH the vault so its sealed blob
  // exists; bind compute to it so resolveCapabilities -> per-alias mint resolves.
  const conn = await markConnectionVerified(
    store,
    await vault.register({
      spaceId: "space_test",
      provider: "cloudflare",
      authMethod: "static_secret",
      scopeHints: {
        cloudflareTokenVending: {
          ttlSeconds: 3600,
          policies: [
            {
              effect: "allow",
              permission_groups: [{ id: "perm_workers_write" }],
              resources: {
                "com.cloudflare.api.account.acct_123": "*",
              },
            },
          ],
        },
      },
      values: { CLOUDFLARE_API_TOKEN: BOOTSTRAP_TOKEN },
    }),
  );
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
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: conn.id }],
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

  // The plan dispatch carries only the per-alias TF_VAR credential for
  // providers rootgen can express as generated-root variables.
  const planCreds = runner.planJobs[0]!.credentials!;
  expect(planCreds.TF_VAR_cloudflare_main_api_token).toEqual(
    `${RUN_TOKEN}-1`,
  );
  expect(planCreds.CLOUDFLARE_API_TOKEN).toBeUndefined();
  const planMintEvents = await store.listCredentialMintEventsForRun(planRun.id);
  expect(planMintEvents).toHaveLength(1);
  expect(planMintEvents[0]).toMatchObject({
    runId: planRun.id,
    spaceId: "space_test",
    installationId: "inst_fixture",
    connectionId: conn.id,
    phase: "plan",
    capabilities: ["cloudflare"],
  });
  expect(planMintEvents[0]!.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-06T01:00:00.000Z",
      ttlSeconds: 3600,
      issuer: "cloudflare_api_token_vending",
    },
  ]);

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  // The apply dispatch ALSO carries the per-alias TF_VAR (re-resolved at mint).
  const applyCreds = runner.applyJobs[0]!.credentials!;
  expect(applyCreds.TF_VAR_cloudflare_main_api_token).toEqual(
    `${RUN_TOKEN}-2`,
  );
  expect(await store.listCredentialMintEventsForRun(planRun.id)).toHaveLength(
    1,
  );
  const applyMintEvents = await store.listCredentialMintEventsForRun(
    applyRun.id,
  );
  expect(applyMintEvents).toHaveLength(1);
  expect(applyMintEvents[0]).toMatchObject({
    runId: applyRun.id,
    phase: "apply",
    connectionId: conn.id,
    capabilities: ["cloudflare"],
  });
  expect(applyMintEvents[0]!.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-06T01:00:00.000Z",
      ttlSeconds: 3600,
      issuer: "cloudflare_api_token_vending",
    },
  ]);

  // The secret value must NEVER reach any persisted run record (plan / apply /
  // deployment / state). Credentials live only on the dispatch payload.
  const persistedPlan = await store.getPlanRun(planRun.id);
  const persistedApply = await store.getApplyRun(applyRun.id);
  expect(JSON.stringify(persistedPlan)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(persistedApply)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(persistedPlan)).not.toContain(RUN_TOKEN);
  expect(JSON.stringify(persistedApply)).not.toContain(RUN_TOKEN);
  const installation = (await store.getInstallation("inst_fixture"))!;
  const deployment = installation.currentDeploymentId
    ? await store.getDeployment(installation.currentDeploymentId)
    : undefined;
  expect(JSON.stringify(deployment)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(deployment)).not.toContain(RUN_TOKEN);
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(JSON.stringify(latest)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(latest)).not.toContain(RUN_TOKEN);
  expect(JSON.stringify(planMintEvents)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(applyMintEvents)).not.toContain(BOOTSTRAP_TOKEN);
  expect(JSON.stringify(planMintEvents)).not.toContain(RUN_TOKEN);
  expect(JSON.stringify(applyMintEvents)).not.toContain(RUN_TOKEN);
});

test("provider credential policy can fail closed on static non-ttl provider secrets", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  const conn = await markConnectionVerified(
    store,
    await vault.register({
      spaceId: "space_test",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-static-token" },
    }),
  );
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {
        providerCredentials: {
          requireTemporary: true,
          requireTtlEnforced: true,
          requireRootOnly: true,
        },
      },
    },
  });
  await store.putDeploymentProfile({
    id: "profile_credential_policy",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: conn.id }],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault,
    now: sequenceNow(100),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("failed");
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "credential_policy_failed",
  );
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "requires temporary credentials",
  );
  expect(runner.planJobs).toHaveLength(0);
  const mintEvents = await store.listCredentialMintEventsForRun(planRun.id);
  expect(mintEvents).toHaveLength(1);
  expect(mintEvents[0]!.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("provider credential policy fails closed when required provider mint returns no evidence", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putConnection(connection("conn_cf", "cloudflare"));
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {
        providerCredentials: {
          requireRootOnly: true,
        },
      },
    },
  });
  await store.putDeploymentProfile({
    id: "profile_missing_credential_evidence",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_cf",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: {
      register: () => Promise.reject(new Error("not used")),
      test: () => Promise.resolve({ status: "verified" }),
      revoke: () => Promise.resolve(true),
      mint: () => Promise.resolve(new CredentialBundle({})),
      mintForProviderBindings: () => Promise.resolve(new CredentialBundle({})),
    } as never,
    now: sequenceNow(100),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "credential_policy_failed",
  );
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "requires mint evidence",
  );
  expect(runner.planJobs).toHaveLength(0);
  const mintEvents = await store.listCredentialMintEventsForRun(planRun.id);
  expect(mintEvents).toHaveLength(1);
  expect(mintEvents[0]!.providerCredentialEvidence ?? []).toEqual([]);
});

test("provider credential policy fails closed when provider mint evidence is partial", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putConnection(connection("conn_main", "cloudflare"));
  await store.putConnection(connection("conn_zone", "cloudflare"));
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {
        providerCredentials: {
          requireRootOnly: true,
        },
      },
    },
  });
  await store.putDeploymentProfile({
    id: "profile_partial_credential_evidence",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_main",
      },
      {
        provider: "cloudflare",
        alias: "zone",
        mode: "connection",
        connectionId: "conn_zone",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: {
      register: () => Promise.reject(new Error("not used")),
      test: () => Promise.resolve({ status: "verified" }),
      revoke: () => Promise.resolve(true),
      mint: () => Promise.resolve(new CredentialBundle({})),
      mintForProviderBindings: () =>
        Promise.resolve(
          new CredentialBundle(
            { TF_VAR_cloudflare_main_api_token: "fixture-provider-token" },
            [],
            [
              {
                connectionId: "conn_main",
                provider: "cloudflare",
                delivery: "generated_root_variable",
                rootOnly: true,
                temporary: false,
                ttlEnforced: false,
                issuer: "static_secret",
              },
            ],
          ),
        ),
    } as never,
    now: sequenceNow(100),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "credential_policy_failed",
  );
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "requires mint evidence",
  );
  expect(runner.planJobs).toHaveLength(0);
  const mintEvents = await store.listCredentialMintEventsForRun(planRun.id);
  expect(mintEvents).toHaveLength(2);
  expect(
    mintEvents.flatMap((event) => event.providerCredentialEvidence ?? []),
  ).toHaveLength(1);
});

test("provider credential policy fails closed when provider mint evidence names the wrong provider", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putConnection(connection("conn_cf", "cloudflare"));
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      installType: "opentofu_module",
      templateBinding: {
        templateId: "cloudflare-worker-service",
        templateVersion: "1.0.0",
      },
      variableMapping: { appName: "my-worker", accountId: "acct_123" },
      policy: {
        providerCredentials: {
          requireRootOnly: true,
        },
      },
    },
  });
  await store.putDeploymentProfile({
    id: "profile_wrong_provider_credential_evidence",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_cf",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: {
      register: () => Promise.reject(new Error("not used")),
      test: () => Promise.resolve({ status: "verified" }),
      revoke: () => Promise.resolve(true),
      mint: () => Promise.resolve(new CredentialBundle({})),
      mintForProviderBindings: () =>
        Promise.resolve(
          new CredentialBundle(
            { TF_VAR_cloudflare_main_api_token: "fixture-provider-token" },
            [],
            [
              {
                connectionId: "conn_cf",
                provider: "aws",
                delivery: "generated_root_variable",
                rootOnly: true,
                temporary: false,
                ttlEnforced: false,
                issuer: "static_secret",
              },
            ],
          ),
        ),
    } as never,
    now: sequenceNow(100),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
  expect(JSON.stringify(planRun.diagnostics)).toContain(
    "credential_policy_failed",
  );
  expect(JSON.stringify(planRun.diagnostics)).toContain("cloudflare");
  expect(runner.planJobs).toHaveLength(0);
});

test("disabled provider binding does not fall back to space-wide provider credentials", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  await vault.register({
    spaceId: "space_test",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "space-wide-token" },
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
    id: "profile_disabled",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "disabled" }],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const runner = recordingRunner({});
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
  expect(
    projectPlanRun(planRun, {
      installationId: seeded.installation.id,
      environment: seeded.installation.environment,
    }).errorCode,
  ).toBe("credential_mint_failed");
  expect(runner.planJobs).toHaveLength(0);
  const failedPlan = await store.getPlanRun(planRun.id);
  expect(failedPlan?.status).toBe("failed");
  expect(
    failedPlan
      ? projectPlanRun(failedPlan, {
          installationId: seeded.installation.id,
          environment: seeded.installation.environment,
        }).errorCode
      : undefined,
  ).toBe("credential_mint_failed");
  expect(JSON.stringify(failedPlan)).not.toContain("space-wide-token");
});

test("legacy opentofu_root install fails closed before generated-root dispatch", async () => {
  const { runner, controller } = await installTypeFixture({
    installConfig: {
      installType: "opentofu_root",
      policy: {},
    },
    outputs: { launch_url: { sensitive: false, value: "https://x.example" } },
  });

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow(/legacy opentofu_root/);
  expect(runner.planJobs).toHaveLength(0);
});
