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
}

function recordingRunner(
  planResult: Partial<OpenTofuPlanResult> = {},
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
  return (await response!.json()) as T;
}

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
