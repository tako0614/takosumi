import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "./mod.ts";
import type {
  PlanResourceChange,
  TestConnectionResponse,
} from "takosumi-contract/deploy-control-api";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Templates are baked into the runner image; the dispatch source is irrelevant
// to the OpenTofu surface (user source is a build input only). A trivial git
// source keeps validateSource happy.
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
        ...(options?.planResourceChanges
          ? { planResourceChanges: options.planResourceChanges }
          : {}),
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: (options?.outputs ?? {
          bucket_name: { sensitive: false, value: "my-bucket" },
          location: { sensitive: false, value: "weur" },
        }) as never,
      });
    },
    destroy: () => Promise.resolve({}),
  };
}

// A minimal Vault so the controller mints (and the dispatch carries) credentials.
function fakeVault() {
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () =>
      Promise.resolve({ status: "verified" } satisfies TestConnectionResponse),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve({ env: { CLOUDFLARE_API_TOKEN: "tok-secret" } }),
  };
}

test("template plan dispatch carries template ref, generated root, and build; never credentials in build", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_workers_script.this",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
      {
        address: "module.app.cloudflare_workers_script_subdomain.this[0]",
        type: "cloudflare_workers_script_subdomain",
        actions: ["create"],
      },
    ],
  });
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
    vault: fakeVault() as never,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    templateId: "cloudflare-worker-hono",
    templateVersion: "1.0.0",
    inputs: { appName: "my-worker", accountId: "acct_123" },
  });

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.templateBinding?.templateId).toEqual("cloudflare-worker-hono");
  expect(planRun.templateBinding?.requiresConfirmation).toEqual(false);
  // requiredProviders derived + canonicalized from the template policy.
  expect(planRun.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);

  expect(runner.planJobs).toHaveLength(1);
  const planJob = runner.planJobs[0]!;
  expect(planJob.template).toEqual({
    id: "cloudflare-worker-hono",
    version: "1.0.0",
    localModulePath: "/app/templates/cloudflare-worker-hono/module",
  });
  expect(Object.keys(planJob.generatedRoot!.files).sort()).toEqual([
    "main.tf",
    "outputs.tf",
    "versions.tf",
  ]);
  expect(planJob.generatedRoot!.files["main.tf"]).toContain(
    'appName = "my-worker"',
  );
  expect(planJob.build).toEqual({
    runtime: "bun",
    commands: ["bun install --frozen-lockfile", "bun run build"],
    artifactPath: "dist/index.js",
  });
  // Credentials are minted for the tofu phase and attached to the dispatch only.
  expect(planJob.credentials).toEqual({ CLOUDFLARE_API_TOKEN: "tok-secret" });
});

test("template plan is blocked when the plan introduces a disallowed resource type", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_r2_bucket.this",
        type: "cloudflare_r2_bucket",
        actions: ["create"],
      },
      // Not in the r2 template allowlist.
      {
        address: "module.app.cloudflare_workers_script.x",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
    ],
  });
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    templateId: "cloudflare-r2-bucket",
    templateVersion: "1.0.0",
    inputs: { bucketName: "b", accountId: "a" },
  });

  expect(planRun.status).toEqual("blocked");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toMatch(
    /cloudflare_workers_script is not allowed/,
  );
});

test("destructive template plan requires confirmDestructive at apply", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_r2_bucket.this",
        type: "cloudflare_r2_bucket",
        actions: ["delete", "create"],
      },
    ],
  });
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    templateId: "cloudflare-r2-bucket",
    templateVersion: "1.0.0",
    inputs: { bucketName: "b", accountId: "a" },
  });
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.templateBinding?.requiresConfirmation).toEqual(true);

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
  // Apply dispatch also carries the template + generated root.
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.template?.id).toEqual("cloudflare-r2-bucket");
  expect(runner.applyJobs[0]!.generatedRoot?.files["main.tf"]).toContain(
    'source = "./template-module"',
  );
  expect(runner.applyJobs[0]!.generatedRoot?.files["outputs.tf"]).toContain(
    "module.app.bucket_name",
  );
});

test("output allowlist projects only template public outputs after the sensitive filter", async () => {
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "module.app.cloudflare_r2_bucket.this",
        type: "cloudflare_r2_bucket",
        actions: ["create"],
      },
    ],
    outputs: {
      bucket_name: { sensitive: false, value: "my-bucket" },
      location: { sensitive: false, value: "weur" },
      // Not declared as a public output: must be dropped.
      internal_arn: { sensitive: false, value: "arn:secret" },
      // Declared public name but sensitive: must be dropped.
    },
  });
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    templateId: "cloudflare-r2-bucket",
    templateVersion: "1.0.0",
    inputs: { bucketName: "my-bucket", accountId: "a" },
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const names = (applied.deployment?.outputs ?? []).map((o) => o.name).sort();
  expect(names).toEqual(["bucket_name", "location"]);
});

test("templateVersion/inputs without templateId is rejected", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: recordingRunner(),
  });
  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      source: SOURCE,
      templateVersion: "1.0.0",
    }),
  ).rejects.toThrow(/require templateId/);
});

test("requiredProviders must not be passed alongside a template", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: recordingRunner(),
  });
  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      source: SOURCE,
      templateId: "cloudflare-r2-bucket",
      templateVersion: "1.0.0",
      inputs: { bucketName: "b", accountId: "a" },
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
