import { expect, test } from "bun:test";
import { deployControlServiceOptions } from "../../../worker/src/deploy_control_seam.ts";
import { platformResourceCapsuleOwnerResolver } from "../../../worker/src/deploy_control_seam.ts";
import { managedProviderCredentialIssuerFromEnv } from "../../../worker/src/worker_service.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { createManagedProviderRunToken } from "../../../core/shared/managed_provider_tokens.ts";
import { ResourceCapsuleOwnerAuthorityError } from "../../../core/api/form_host_routes.ts";
import {
  createDefaultRunnerProfiles,
  type OpenTofuRunner,
} from "../../../core/domains/deploy-control/mod.ts";

test("Worker composition accepts explicit host RunnerProfiles and executors", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  const privateNetworkRunner = {} as OpenTofuRunner;
  const options = deployControlServiceOptions({
    TAKOSUMI_ENABLED_RUNNER_PROFILES: "private-network,opentofu-default",
    TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID: "private-network",
    TAKOSUMI_RUNNER_HOST_COMPOSITION: {
      profiles: [
        {
          ...reference,
          id: "private-network",
          name: "Private network",
          executorId: "operator.private-network",
          lifecycle: { state: "candidate" },
        },
      ],
      executors: new Map([["operator.private-network", privateNetworkRunner]]),
    },
  } as unknown as CloudflareWorkerEnv);

  expect(options.runnerProfiles.map((profile) => profile.id)).toEqual([
    "private-network",
    "opentofu-default",
  ]);
  expect(options.runnerProfiles[0]?.lifecycle.state).toBe("active");
  expect(options.defaultRunnerProfileId).toBe("private-network");
  expect(options.runnerExecutors?.get("operator.private-network")).toBe(
    privateNetworkRunner,
  );
});

test("Worker composition rejects duplicate built-in profile ids", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: { profiles: [reference] },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("duplicate profile opentofu-default");
});

test("Worker composition rejects a text RunnerProfile catalog", () => {
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: JSON.stringify({ profiles: [] }),
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code runtime object");
});

test("Worker composition accepts only a host-code Interface OAuth resource authorizer", async () => {
  const authorizer = async () => true;
  const options = deployControlServiceOptions({
    TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: authorizer,
  } as unknown as CloudflareWorkerEnv);
  expect(options.interfaceOAuth2ResourceAuthorizer).toBe(authorizer);
  await expect(
    options.interfaceOAuth2ResourceAuthorizer!({
      workspaceId: "workspace_1",
      interfaceId: "interface_1",
      ownerRef: { kind: "Resource", id: "tkrn:workspace_1:KVStore:cache" },
      resource: "https://app.takosumi.com/v1/cloud/resources",
    }),
  ).resolves.toBeTrue();

  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: "true",
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code function");
});

test("Worker composition mounts ledger HTTP routes only for explicit private ingress", () => {
  expect(
    deployControlServiceOptions({} as unknown as CloudflareWorkerEnv)
      .mountInternalLedgerRoutes,
  ).toBeUndefined();
  expect(
    deployControlServiceOptions({
      LOCAL_SUBSTRATE_TEST_BED: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
  expect(
    deployControlServiceOptions({
      TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
});

test("managed provider credential mint refuses a destroyed Capsule", async () => {
  let destroyed = false;
  const issuer = managedProviderCredentialIssuerFromEnv(
    {
      TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret",
    } as unknown as CloudflareWorkerEnv,
    {
      getCapsule: async () =>
        destroyed
          ? {
              id: "capsule_1",
              workspaceId: "workspace_1",
              projectId: "project_1",
              name: "capsule",
              slug: "capsule",
              sourceId: "source_1",
              installConfigId: "config_1",
              installingPrincipalId: "principal_1",
              environment: "production",
              currentStateGeneration: 0,
              status: "destroyed" as const,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }
          : {
              id: "capsule_1",
              workspaceId: "workspace_1",
              projectId: "project_1",
              name: "capsule",
              slug: "capsule",
              sourceId: "source_1",
              installConfigId: "config_1",
              installingPrincipalId: "principal_1",
              environment: "production",
              currentStateGeneration: 0,
              status: "active" as const,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
    },
  );
  expect(issuer).toBeDefined();
  const connection: ProviderConnection = {
    id: "connection_1",
    provider: "registry.example/provider",
    providerSource: "registry.example/provider",
    scope: "operator",
    status: "verified",
    materialization: "env",
    envNames: ["PROVIDER_TOKEN"],
    scopeHints: {
      managedProvider: true,
      managedProviderProfile: "operator.example.provider.v1",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const request = {
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    runId: "run_1",
    managedProviderProfile: "operator.example.provider.v1",
    connection,
    phase: "apply" as const,
  };
  expect((await issuer!(request))?.issuer).toBe(
    "takosumi_managed_provider_token",
  );
  destroyed = true;
  await expect(issuer!(request)).resolves.toBeUndefined();
});

test("managed DELETE owner resolution accepts only the live destroy ApplyRun", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace",
    displayName: "Workspace",
    type: "personal",
    ownerUserId: "principal_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "capsule_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    name: "capsule",
    slug: "capsule",
    sourceId: "source_1",
    installConfigId: "config_1",
    installingPrincipalId: "principal_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.putApplyRun({
    id: "destroy_run",
    planRunId: "destroy_plan",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    operation: "destroy",
    runnerProfileId: "opentofu-default",
    status: "running",
    expected: {
      planRunId: "destroy_plan",
      capsuleId: "capsule_1",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
  });
  const env = {
    TAKOSUMI_CONTROL_DB: db,
    TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret",
  } as unknown as CloudflareWorkerEnv;
  const resolver = platformResourceCapsuleOwnerResolver(env);
  const token = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "operator.example.provider.v1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    runId: "destroy_run",
    installingPrincipalId: "principal_1",
    connectionId: "connection_1",
    provider: "registry.example/provider",
    phase: "destroy",
    scopes: ["write"],
  });
  await expect(
    resolver({
      actor: {
        actorAccountId: "principal_1",
        workspaceId: "workspace_1",
        roles: ["owner"],
        scopes: ["resources:*"] ,
        requestId: "request_1",
      },
      request: new Request(
        "https://app.takosumi.test/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets",
        {
          method: "DELETE",
          headers: {
            "x-takosumi-internal-managed-provider-run-token": token.token,
            "x-takosumi-internal-managed-provider-profile":
              "operator.example.provider.v1",
          },
        },
      ),
      space: "workspace_1",
      kind: "ObjectBucket",
      name: "assets",
    }),
  ).resolves.toMatchObject({ id: "capsule_1" });

  const applyToken = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "operator.example.provider.v1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    runId: "destroy_run",
    installingPrincipalId: "principal_1",
    connectionId: "connection_1",
    provider: "registry.example/provider",
    phase: "apply",
    scopes: ["write"],
  });
  await expect(
    resolver({
      actor: {
        actorAccountId: "principal_1",
        workspaceId: "workspace_1",
        roles: ["owner"],
        scopes: ["resources:*"] ,
        requestId: "request_1",
      },
      request: new Request(
        "https://app.takosumi.test/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets",
        {
          method: "DELETE",
          headers: {
            "x-takosumi-internal-managed-provider-run-token":
              applyToken.token,
            "x-takosumi-internal-managed-provider-profile":
              "operator.example.provider.v1",
          },
        },
      ),
      space: "workspace_1",
      kind: "ObjectBucket",
      name: "assets",
    }),
  ).rejects.toBeInstanceOf(ResourceCapsuleOwnerAuthorityError);
});
