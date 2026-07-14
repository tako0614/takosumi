import { expect, test } from "bun:test";
import type {
  ApplyRunResponse,
  ProviderConnection,
  InstallConfig,
  ListCredentialRecipesResponse,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { OutputShare, Output as Output } from "takosumi-contract/outputs";
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  OpenTofuRunner,
  ReleaseActivationInput,
  ReleaseActivator,
} from "../../../core/domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { fakeProviderVault } from "../../helpers/deploy-control/model_fixture.ts";
import { StaticSecretConnectionVault } from "../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../providers/registry.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function readInternalPlanRun(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  runId: string,
): Promise<PlanRunResponse> {
  const response = await app.request(`/internal/v1/plan-runs/${runId}`, {
    headers: headers(),
  });
  expect(response.status).toEqual(200);
  return (await response.json()) as PlanRunResponse;
}

test("bootstrap builds the ConnectionVault from secretCrypto alone (production worker wiring)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // NO explicit opentofuConnectionVault — only env-backed crypto, exactly the
  // worker_service production wiring. Bootstrap must build the default
  // StaticSecretConnectionVault over the shared store; otherwise connection
  // register (and run credential mint) fail closed with "vault is not configured".
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    opentofuControlStore: store,
    secretCrypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "vault-wiring-e2e-passphrase-0123456789",
    }),
    ...REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  });

  const spaceRes = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "vaultwire",
      displayName: "vaultwire",
      type: "personal",
      ownerUserId: "user_test00000002",
    }),
  });
  expect(spaceRes.status).toBe(201);
  const workspaceId = (await spaceRes.json()).workspace.id as string;

  // Registering a ProviderConnection requires the vault to seal its secret values; a 201
  // proves bootstrap wired a working vault from secretCrypto with no explicit
  // vault injected.
  const createGenericEnvProviderRes = await app.request(
    `/internal/v1/connections/setups/generic-env`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        workspaceId,
        provider: "registry.opentofu.org/vercel/vercel",
        displayName: "Vercel",
        values: { VERCEL_API_TOKEN: "vercel_secret" },
      }),
    },
  );
  expect(createGenericEnvProviderRes.status).toBe(201);
});

test("Credential Recipe discovery and generic-env connection routes round-trip", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let connectionCounter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "generic-env-provider-e2e-passphrase-0123456789",
    }),
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: () =>
      `conn_genenv${(connectionCounter += 1).toString().padStart(10, "0")}`,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuConnectionVault: vault,
    ...REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  });

  const spaceRes = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "providers",
      displayName: "providers",
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(spaceRes.status).toBe(201);
  const workspaceId = (await spaceRes.json()).workspace.id as string;

  const providersRes = await app.request("/internal/v1/credential-recipes", {
    headers: headers(),
  });
  expect(providersRes.status).toBe(200);
  const recipesBody =
    (await providersRes.json()) as ListCredentialRecipesResponse;
  expect(recipesBody.recipes.map((recipe) => recipe.id)).toContain(
    "generic-env",
  );
  expect(recipesBody.recipes).toContainEqual(
    expect.objectContaining({
      id: "cloudflare",
      envNames: expect.arrayContaining([
        "CF_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_EMAIL",
        "CLOUDFLARE_ZONE_ID",
      ]),
      terraformSource: [
        "cloudflare/cloudflare",
        "registry.opentofu.org/cloudflare/cloudflare",
      ],
    }),
  );
  expect(
    recipesBody.recipes.find((recipe) => recipe.id === "generic-env")
      ?.terraformSource,
  ).toBe("*");
  for (const id of [
    "aws",
    "github",
    "kubernetes",
    "digitalocean",
    "hcloud",
    "vultr",
    "scaleway",
    "openstack",
  ]) {
    expect(recipesBody.recipes.map((recipe) => recipe.id)).toContain(id);
  }
  expect(recipesBody.recipes).toContainEqual(
    expect.objectContaining({
      id: "google",
      terraformSource: expect.arrayContaining(["hashicorp/google"]),
    }),
  );
  expect(
    recipesBody.recipes.find((recipe) => recipe.id === "google")?.authModes
      .impersonation,
  ).toBeUndefined();
  expect(
    recipesBody.recipes.find((recipe) => recipe.id === "aws")?.authModes
      .assume_role,
  ).toBeDefined();

  const createGenericEnvProviderRes = await app.request(
    `/internal/v1/connections/setups/generic-env`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        workspaceId,
        provider: "registry.opentofu.org/vercel/vercel",
        displayName: "Vercel",
        values: {
          VERCEL_API_TOKEN: "vercel_secret",
        },
      }),
    },
  );
  expect(createGenericEnvProviderRes.status).toBe(201);
  const genericEnvProviderBody = await createGenericEnvProviderRes.json();
  expect(genericEnvProviderBody.connection).toMatchObject({
    provider: "registry.opentofu.org/vercel/vercel",
    providerSource: "registry.opentofu.org/vercel/vercel",
    scope: "workspace",
    envNames: ["VERCEL_API_TOKEN"],
    credentialRecipe: expect.objectContaining({
      id: "generic-env",
      authMode: "env",
    }),
  });
  expect(JSON.stringify(genericEnvProviderBody)).not.toContain("vercel_secret");
});

test("Credential Recipe discovery exposes the service-installed open catalog", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: new InMemoryOpenTofuControlStore(),
    credentialRecipes: [
      {
        id: "example-provider",
        displayName: "Example provider",
        terraformSource: ["example/example"],
        envNames: ["EXAMPLE_TOKEN"],
        requiredEnvGroups: [["EXAMPLE_TOKEN"]],
        authModes: {
          token: {
            env: {
              EXAMPLE_TOKEN: { from: "secret", name: "token" },
            },
          },
        },
      },
    ],
  });

  const response = await app.request("/internal/v1/credential-recipes", {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as ListCredentialRecipesResponse;
  expect(body.recipes.map((recipe) => recipe.id)).toEqual(["example-provider"]);
});

test("Core exposes no Credential Recipes when the host installs no catalog", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: new InMemoryOpenTofuControlStore(),
  });

  const response = await app.request("/internal/v1/credential-recipes", {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ recipes: [] });
});

/**
 * Stands up a service over a known in-memory store, then walks the new
 * Workspace-direct Capsule model end-to-end through the internal routes:
 *   POST /internal/v1/workspaces -> POST /internal/v1/sources -> seed InstallConfig (operations
 *   facade) -> POST /internal/v1/workspaces/:id/capsules -> seed a SourceSnapshot for
 *   the source (so the Capsule plan does not 409 source_sync_required).
 *
 * Returns the wired app plus the seeded ids so the caller can drive the
 * Capsule-driven plan / approve / apply roundtrip.
 */
async function seedCapsuleViaRoutes(
  runner: OpenTofuRunner,
  options: {
    readonly environment?: string;
    readonly releaseActivator?: ReleaseActivator;
  } = {},
): Promise<{
  app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  capsuleId: string;
  store: InMemoryOpenTofuControlStore;
  workspaceId: string;
}> {
  const store = new InMemoryOpenTofuControlStore();
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    mountInternalLedgerRoutes: true,
    opentofuControlStore: store,
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    ...(options.releaseActivator
      ? { releaseActivator: options.releaseActivator }
      : {}),
  });

  const spaceRes = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "acme",
      displayName: "acme",
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(spaceRes.status).toBe(201);
  const workspaceId = (await spaceRes.json()).workspace.id as string;

  const sourceRes = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      workspaceId,
      name: "repo",
      url: "https://github.com/acme/repo.git",
      defaultRef: "main",
      defaultPath: ".",
    }),
  });
  expect(sourceRes.status).toBe(201);
  const sourceId = (await sourceRes.json()).source.id as string;

  // Seed a deterministic Workspace-owned InstallConfig through the in-process
  // operations facade instead of using the shared boot-seeded defaults.
  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: "cfg_test00000001",
    workspaceId,
    name: "test-module",
    variableMapping: {},
    outputAllowlist: {
      launch_url: { from: "launch_url", type: "url" },
    },
    ...(options.releaseActivator
      ? {
          lifecycleActions: [
            {
              apiVersion: "takosumi.dev/v1alpha1",
              kind: "command",
              id: "publish",
              phase: "post_apply",
              executor: "runner",
              command: ["bun", "run", "publish"],
              runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
            },
          ],
          policy: {
            lifecycleActions: {
              allowedExecutors: ["runner"],
              allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
            },
          },
        }
      : { policy: {} }),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await operations.capsules.putInstallConfig(config);

  const installRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "web",
        environment: options.environment ?? "production",
        sourceId,
        installConfigId: config.id,
      }),
    },
  );
  expect(installRes.status).toBe(201);
  const capsuleId = (await installRes.json()).capsule.id as string;

  // After the credential-model collapse the Provider ProviderConnection row IS the
  // resolver record (the former separate ProviderEnv projection is gone), so the
  // binding points directly at the connection id.
  const providerConnection: ProviderConnection = {
    id: "conn_e2ecloudflare0001",
    workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
      declaredEnv: true,
    },
    secretPartition: "provider-credentials",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    verifiedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await store.putConnection(providerConnection);
  await operations.capsules.putProviderBindingSet({
    id: "ipcset_e2ecloudflare0001",
    workspaceId,
    capsuleId,
    environment: options.environment ?? "production",
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: providerConnection.id,
      },
    ],
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  // Seed the SourceSnapshot directly so the Capsule-driven plan resolves a
  // pinned snapshot (the real source_sync runs in the runner; the fake runner
  // here only implements plan/apply).
  const snapshot: SourceSnapshot = {
    id: "snap_e2e000001",
    origin: "git",
    workspaceId,
    sourceId,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_e2e000001/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "ssr_e2e000001",
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: "caprep_e2e000001",
    sourceId,
    capsuleId,
    sourceSnapshotId: snapshot.id,
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: nowIso,
  };
  await store.putCapsuleCompatibilityReport(compatibilityReport);
  await store.patchCapsule(capsuleId, {
    compatibilityReportId: compatibilityReport.id,
    compatibilityStatus: compatibilityReport.level,
    updatedAt: nowIso,
  });

  return { app, capsuleId, store, workspaceId };
}

test("deployControl e2e exposes OpenTofu plan and apply runs", async () => {
  const { app, capsuleId, store } = await seedCapsuleViaRoutes(fakeRunner());

  // Capsule-driven plan (spec §23): resolves the latest SourceSnapshot and
  // dispatches with Capsule state scope.
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  expect(planRes.status).toEqual(201);
  const planRun = ((await planRes.json()) as { run: Run }).run;
  expect(planRun.status).toEqual("waiting_approval");
  expect(planRun.planDigest).toEqual(PLAN_DIGEST);
  const plan = await readInternalPlanRun(app, planRun.id);
  expect(plan.planRun.status).toEqual("succeeded");
  expect(plan.planRun.planArtifact?.digest).toEqual(PLAN_DIGEST);

  // The plan introduces a delete/replace change, so the §25 action policy flags
  // it requiresApproval and the §19 Run projects waiting_approval; approve
  // before the apply.
  const runRes = await app.request(`/internal/v1/runs/${planRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  expect(((await runRes.json()) as { run: Run }).run.status).toEqual(
    "waiting_approval",
  );
  const approveRes = await app.request(
    `/internal/v1/runs/${planRun.id}/approve`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
    },
  );
  expect(approveRes.status).toEqual(200);

  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  expect(applyRes.status).toEqual(201);
  const apply = (await applyRes.json()) as ApplyRunResponse;
  expect(apply.applyRun.status).toEqual("succeeded");
  // New Capsule status after a successful apply is "active" (§5 / §27).
  expect(apply.capsule?.status).toEqual("active");
  // A successful apply advances the Capsule to a durable StateVersion.
  expect(apply.capsule?.currentStateVersionId).toBeTruthy();

  const capsule = await store.getCapsule(capsuleId);
  const output = capsule?.currentOutputId
    ? await store.getOutput(capsule.currentOutputId)
    : undefined;
  expect(output?.publicOutputs).toEqual({
    launch_url: "https://app.example.test",
  });
});

test("capsule plan route honors a compatibilityReportId body hint", async () => {
  const { app, capsuleId, store } = await seedCapsuleViaRoutes(fakeRunner());
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  const hintedReport: CapsuleCompatibilityReport = {
    id: "caprep_routehint0001",
    sourceId: capsule!.sourceId,
    sourceSnapshotId: "snap_e2e000001",
    capsuleId,
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: new Date(0).toISOString(),
  };
  await store.putCapsuleCompatibilityReport(hintedReport);

  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ compatibilityReportId: hintedReport.id }),
  });

  const planText = await planRes.text();
  if (planRes.status !== 201) {
    throw new Error(planText);
  }
  const planRun = (JSON.parse(planText) as { run: Run }).run;
  expect(planRun.compatibilityReportId).toEqual(hintedReport.id);
  const persisted = await readInternalPlanRun(app, planRun.id);
  expect(persisted.planRun.compatibilityReportId).toEqual(hintedReport.id);
  expect((await store.getCapsule(capsuleId))?.compatibilityReportId).toEqual(
    hintedReport.id,
  );
});

test("bootstrap wires host release activator into apply lifecycle", async () => {
  const activations: ReleaseActivationInput[] = [];
  const { app, capsuleId, store, workspaceId } = await seedCapsuleViaRoutes(
    fakeRunner(),
    {
      releaseActivator: {
        activate: (input) => {
          activations.push(input);
          return Promise.resolve({
            status: "succeeded",
            kind: "takos.cloudflare.worker",
            healthUrl: "https://app.example.test/health",
          });
        },
      },
    },
  );

  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  const planRun = ((await planRes.json()) as { run: Run }).run;
  const plan = await readInternalPlanRun(app, planRun.id);
  await app.request(`/internal/v1/runs/${planRun.id}/approve`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
  });

  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  const apply = (await applyRes.json()) as ApplyRunResponse;

  expect(apply.applyRun.status).toEqual("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.nonSensitiveOutputs).toEqual({
    launch_url: "https://app.example.test",
  });
  const activity = (await store.listActivityEvents(workspaceId)).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(activity).toBeDefined();
  expect(activity?.metadata).toMatchObject({
    capsuleId,
    applyRunId: apply.applyRun.id,
    activationKind: "takos.cloudflare.worker",
    hasHealthUrl: true,
  });
  expect(JSON.stringify(activity)).not.toContain(
    "https://app.example.test/health",
  );
});

test("run logs/events expose diagnostics + audit trail (§30)", async () => {
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  const planRun = ((await planRes.json()) as { run: Run }).run;
  const plan = await readInternalPlanRun(app, planRun.id);

  const logsRes = await app.request(`/internal/v1/runs/${planRun.id}/logs`, {
    headers: headers(),
  });
  expect(logsRes.status).toEqual(200);
  const logs = await logsRes.json();
  expect(Array.isArray(logs.diagnostics)).toBe(true);
  expect(Array.isArray(logs.auditEvents)).toBe(true);
  // The plan recorded at least a plan.requested / plan.completed audit event.
  expect(logs.auditEvents.length).toBeGreaterThan(0);

  const eventsRes = await app.request(
    `/internal/v1/runs/${planRun.id}/events`,
    {
      headers: headers(),
    },
  );
  expect(eventsRes.status).toEqual(200);
  const events = await eventsRes.json();
  expect(Array.isArray(events.auditEvents)).toBe(true);
  expect(events.auditEvents.length).toBeGreaterThan(0);
  // events is the audit-only subset; it carries no diagnostics field.
  expect(events.diagnostics).toBeUndefined();

  const costRes = await app.request(`/internal/v1/runs/${planRun.id}/cost`, {
    headers: headers(),
  });
  expect(costRes.status).toEqual(200);
  const cost = (await costRes.json()) as {
    cost: {
      runId: string;
      billingMode: string;
      estimatedUsdMicros: number;
      ratingStatus: string;
      blocked: boolean;
      reasons: readonly string[];
    };
  };
  expect(cost.cost.runId).toEqual(plan.planRun.id);
  expect(typeof cost.cost.estimatedUsdMicros).toBe("number");
  expect(typeof cost.cost.ratingStatus).toBe("string");
  expect(typeof cost.cost.blocked).toBe("boolean");
  expect(Array.isArray(cost.cost.reasons)).toBe(true);
});

test("run logs for a missing run is 404", async () => {
  const { app } = await seedCapsuleViaRoutes(fakeRunner());
  const res = await app.request("/internal/v1/runs/plan_missing00000001/logs", {
    headers: headers(),
  });
  expect(res.status).toEqual(404);
});

test("StateVersion get + rollback-plan happy path; missing StateVersion is 404 (§30)", async () => {
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());

  // Drive a full plan -> approve -> apply so a StateVersion exists.
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  const planRun = ((await planRes.json()) as { run: Run }).run;
  const plan = await readInternalPlanRun(app, planRun.id);
  await app.request(`/internal/v1/runs/${planRun.id}/approve`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
  });
  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  const apply = (await applyRes.json()) as ApplyRunResponse;
  expect(apply.applyRun.status).toBe("succeeded");

  // Public §30 Capsule read + StateVersion list.
  const instRes = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    headers: headers(),
  });
  expect(instRes.status).toEqual(200);
  expect((await instRes.json()).capsule.id).toEqual(capsuleId);

  const stateVersionsRes = await app.request(
    `/internal/v1/capsules/${capsuleId}/state-versions`,
    { headers: headers() },
  );
  expect(stateVersionsRes.status).toEqual(200);
  const stateVersions = (await stateVersionsRes.json()).stateVersions;
  expect(stateVersions.length).toBeGreaterThan(0);
  const stateVersionId = stateVersions[0].id as string;

  // GET /internal/v1/state-versions/:id.
  const getRes = await app.request(
    `/internal/v1/state-versions/${stateVersionId}`,
    {
      headers: headers(),
    },
  );
  expect(getRes.status).toEqual(200);
  const got = await getRes.json();
  expect(got.stateVersion.id).toEqual(stateVersionId);
  expect(got.stateVersion.capsuleId).toEqual(capsuleId);

  // POST /internal/v1/state-versions/:id/rollback-plan creates a NEW plan run pinned to the
  // source snapshot that produced the StateVersion; it flows through the normal plan lifecycle.
  const rollbackRes = await app.request(
    `/internal/v1/state-versions/${stateVersionId}/rollback-plan`,
    { method: "POST", headers: headers() },
  );
  expect(rollbackRes.status).toEqual(201);
  const rollbackRun = ((await rollbackRes.json()) as { run: Run }).run;
  expect(rollbackRun.id).not.toEqual(plan.planRun.id);
  expect(rollbackRun.sourceSnapshotId).toEqual(plan.planRun.sourceSnapshotId);

  // Missing StateVersion is a typed 404.
  const missing = await app.request(
    "/internal/v1/state-versions/state_missing0001",
    {
      headers: headers(),
    },
  );
  expect(missing.status).toEqual(404);
  const missingRollback = await app.request(
    "/internal/v1/state-versions/state_missing0001/rollback-plan",
    { method: "POST", headers: headers() },
  );
  expect(missingRollback.status).toEqual(404);
});

test("workspace PATCH updates displayName (§30 MVP)", async () => {
  const { app, capsuleId, store } = await seedCapsuleViaRoutes(fakeRunner());
  // Recover the Workspace id via the public Capsule read.
  const instRes = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    headers: headers(),
  });
  const workspaceId = (await instRes.json()).capsule.workspaceId as string;

  const patchRes = await app.request(`/internal/v1/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ displayName: "Acme Renamed" }),
  });
  expect(patchRes.status).toEqual(200);
  expect((await patchRes.json()).workspace.displayName).toEqual("Acme Renamed");
  const [activity] = await store.listActivityEvents(workspaceId, { limit: 1 });
  expect(activity).toMatchObject({
    workspaceId,
    action: "workspace.updated",
    targetType: "workspace",
    targetId: workspaceId,
    metadata: { fields: ["displayName"] },
  });

  // An unknown field is rejected (the allowlist is displayName-only for MVP).
  const badRes = await app.request(`/internal/v1/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ handle: "renamed" }),
  });
  expect(badRes.status).toEqual(400);
});

/**
 * Seeds a consumer Workspace and a latest Output for the producer
 * Capsule directly into the store, so the OutputShare routes can validate a
 * grant of `bucket_name` from the producer's `fromSpace` to a separate
 * consumer Workspace.
 */
async function seedOutputShareScenario(): Promise<{
  app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  fromWorkspaceId: string;
  toWorkspaceId: string;
  producerCapsuleId: string;
}> {
  const { app, store, workspaceId, capsuleId } =
    await seedCapsuleViaRoutes(fakeRunner());
  const toWorkspaceId = "ws_consumer0001";
  const consumer: Workspace = {
    id: toWorkspaceId,
    handle: "consumer",
    displayName: "Consumer",
    type: "personal",
    ownerUserId: "user_test00000002",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await store.putWorkspace(consumer);
  const snapshot: Output = {
    id: "out_e2e000001",
    workspaceId,
    capsuleId,
    stateGeneration: 1,
    rawArtifactRef: `artifact://outputs/${capsuleId}/r1`,
    publicOutputs: {},
    workspaceOutputs: { bucket_name: "my-bucket", region: "auto" },
    outputDigest: "sha256:oute2e",
    createdAt: new Date(0).toISOString(),
  };
  await store.putOutput(snapshot);
  return {
    app,
    fromWorkspaceId: workspaceId,
    toWorkspaceId,
    producerCapsuleId: capsuleId,
  };
}

test("output-shares create / approve / list / revoke happy path (§18)", async () => {
  const { app, fromWorkspaceId, toWorkspaceId, producerCapsuleId } =
    await seedOutputShareScenario();

  // Create: a grant of bucket_name from the producer's Workspace to the consumer.
  const createRes = await app.request("/internal/v1/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromWorkspaceId,
      toWorkspaceId,
      producerCapsuleId,
      outputs: [{ name: "bucket_name", alias: "bucket" }],
    }),
  });
  expect(createRes.status).toEqual(201);
  const created = (await createRes.json()).share as OutputShare;
  expect(created.status).toEqual("pending");
  expect(created.outputs).toEqual([
    { name: "bucket_name", alias: "bucket", sensitive: false },
  ]);

  const approveRes = await app.request(
    `/internal/v1/output-shares/${created.id}/approve`,
    { method: "POST", headers: headers() },
  );
  expect(approveRes.status).toEqual(200);
  const approved = (await approveRes.json()).share as OutputShare;
  expect(approved.status).toEqual("active");
  expect(approved.acceptedAt).toBeDefined();

  // List from the granting Workspace surfaces the share.
  const listFrom = await app.request(
    `/internal/v1/output-shares?workspaceId=${fromWorkspaceId}`,
    { headers: headers() },
  );
  expect(listFrom.status).toEqual(200);
  expect(
    ((await listFrom.json()).shares as OutputShare[]).map((s) => s.id),
  ).toEqual([created.id]);

  // List from the consumer Workspace surfaces the same share (received side).
  const listTo = await app.request(
    `/internal/v1/output-shares?workspaceId=${toWorkspaceId}`,
    {
      headers: headers(),
    },
  );
  expect(listTo.status).toEqual(200);
  expect(
    ((await listTo.json()).shares as OutputShare[]).map((s) => s.id),
  ).toEqual([created.id]);

  // Revoke moves it to revoked.
  const revokeRes = await app.request(
    `/internal/v1/output-shares/${created.id}/revoke`,
    { method: "POST", headers: headers() },
  );
  expect(revokeRes.status).toEqual(200);
  expect(((await revokeRes.json()).share as OutputShare).status).toEqual(
    "revoked",
  );
});

test("output-shares create 409 when a name is absent from the producer's outputs (§18)", async () => {
  const { app, fromWorkspaceId, toWorkspaceId, producerCapsuleId } =
    await seedOutputShareScenario();
  const res = await app.request("/internal/v1/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromWorkspaceId,
      toWorkspaceId,
      producerCapsuleId,
      outputs: [{ name: "not_a_real_output" }],
    }),
  });
  // failed_precondition maps to HTTP 409.
  expect(res.status).toEqual(409);
  expect((await res.json()).error.code).toEqual("failed_precondition");
});

test("output-shares create 404 when the consumer Workspace is missing (§18)", async () => {
  const { app, fromWorkspaceId, producerCapsuleId } =
    await seedOutputShareScenario();
  const res = await app.request("/internal/v1/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromWorkspaceId,
      toWorkspaceId: "ws_missing00001",
      producerCapsuleId,
      outputs: [{ name: "bucket_name" }],
    }),
  });
  expect(res.status).toEqual(404);
});

test("output-shares revoke 404 for a missing share (§18)", async () => {
  const { app } = await seedOutputShareScenario();
  const res = await app.request(
    "/internal/v1/output-shares/oshare_missing00001/revoke",
    { method: "POST", headers: headers() },
  );
  expect(res.status).toEqual(404);
});

test("Capsule PATCH safely updates status only (§30)", async () => {
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());
  const patch = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ status: "stale" }),
  });
  expect(patch.status).toEqual(200);
  expect((await patch.json()).capsule.status).toEqual("stale");

  const rejectedDestroyState = await app.request(
    `/internal/v1/capsules/${capsuleId}`,
    {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "destroyed" }),
    },
  );
  expect(rejectedDestroyState.status).toEqual(400);
  expect((await rejectedDestroyState.json()).error.message).toContain(
    "destroy flow",
  );

  const rejectedField = await app.request(
    `/internal/v1/capsules/${capsuleId}`,
    {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ installConfigId: "cfg_other" }),
    },
  );
  expect(rejectedField.status).toEqual(400);
  expect((await rejectedField.json()).error.message).toContain("unknown_field");
});

test("Capsule DELETE creates a destroy-plan run instead of deleting state (§30 / §23)", async () => {
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  expect(planRes.status).toEqual(201);
  const initialPlanRun = ((await planRes.json()) as { run: Run }).run;
  const internalPlan = await readInternalPlanRun(app, initialPlanRun.id);
  const approveRes = await app.request(
    `/internal/v1/runs/${initialPlanRun.id}/approve`,
    { method: "POST", headers: headers() },
  );
  expect(approveRes.status).toEqual(200);
  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: internalPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(internalPlan.planRun),
    }),
  });
  expect(applyRes.status).toEqual(201);

  const del = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(del.status).toEqual(202);
  const payload = ((await del.json()) as { run: Run }).run;
  expect(payload.capsuleId).toEqual(capsuleId);
  expect(payload.type).toEqual("destroy_plan");
  expect(payload.status).toEqual("waiting_approval");

  const runRes = await app.request(`/internal/v1/runs/${payload.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  const run = ((await runRes.json()) as { run: Run }).run;
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");
});

test("deployControl e2e rejects mismatched plan digest guard", async () => {
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());

  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  expect(planRes.status).toEqual(201);
  const planRun = ((await planRes.json()) as { run: Run }).run;
  const plan = await readInternalPlanRun(app, planRun.id);

  // Approve so the apply is gated only by the plan-digest guard under test.
  const approveRes = await app.request(
    `/internal/v1/runs/${planRun.id}/approve`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
    },
  );
  expect(approveRes.status).toEqual(200);

  const res = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(plan.planRun),
        planDigest: "sha256:not-a-real-digest",
      },
    }),
  });
  expect(res.status).toEqual(409);
});

test("POST /internal/v1/capsules/:id/drift-check creates a drift_check run that is never waiting_approval and cannot be applied", async () => {
  // The fake runner reports a delete+create change (the §25 action policy would
  // normally park a plan waiting_approval). A drift check must NOT park.
  const { app, capsuleId } = await seedCapsuleViaRoutes(fakeRunner());

  const driftRes = await app.request(
    `/internal/v1/capsules/${capsuleId}/drift-check`,
    { method: "POST", headers: headers() },
  );
  expect(driftRes.status).toEqual(201);
  const driftRun = ((await driftRes.json()) as { run: Run }).run;
  const drift = await readInternalPlanRun(app, driftRun.id);
  expect(drift.planRun.driftCheck).toBe(true);
  expect(drift.planRun.status).toEqual("succeeded");

  // The §19 Run projects type drift_check and succeeded (NOT waiting_approval).
  const runRes = await app.request(`/internal/v1/runs/${driftRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  const run = ((await runRes.json()) as { run: Run }).run;
  expect(run.type).toEqual("drift_check");
  expect(run.status).toEqual("succeeded");

  // A drift check can never be applied.
  const applyRes = await app.request("/internal/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: drift.planRun.id,
      expected: applyExpectedGuardFromPlanRun(drift.planRun),
    }),
  });
  expect(applyRes.status).toEqual(409);
});

function fakeRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_e2e/tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: true,
            installationMethod: "filesystem_mirror",
            attested: true,
            attestationMethod: "forced_filesystem_mirror_init",
            mirrorPath:
              "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
          },
        ],
        // A replace (delete+create) change so the §25 action policy flags the
        // plan requiresApproval (parks waiting_approval), exercising the
        // approve -> apply roundtrip below. Approval is no longer gated by the
        // environment alone — it is driven by the plan's actual changes.
        planResourceChanges: [
          {
            address: "module.child.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions: ["delete", "create"],
          },
        ],
      }),
    apply: () =>
      Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://app.example.test",
          },
        },
      }),
  };
}
