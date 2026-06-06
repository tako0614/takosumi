import { expect, test } from "bun:test";
import type { OpenTofuRunner } from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  createDefaultRunnerProfiles,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "./mod.ts";
import type { RunnerProfile } from "takosumi-contract/deploy-control-api";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("plan run stays queued when no OpenTofu runner is injected", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 1,
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  expect(planRun.id).toEqual("plan_0001");
  expect(planRun.status).toEqual("queued");
  expect(planRun.policy.status).toEqual("passed");
});

test("PlanRun stores variable digest without retaining variable values", async () => {
  let runnerVariables: Readonly<Record<string, unknown>> | undefined;
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(2),
    newId: deterministicIds(),
    runner: {
      plan: (job) => {
        runnerVariables = job.variables;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("variables"),
          providerLockDigest: LOCK_DIGEST,
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    variables: {
      account_id: "acct_123",
      token: "super-secret-plan-token",
    },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const persisted = await controller.getPlanRun(planRun.id);
  const payload = JSON.stringify({
    create: planRun,
    get: persisted.planRun,
  });

  expect(runnerVariables).toEqual({
    account_id: "acct_123",
    token: "super-secret-plan-token",
  });
  expect(planRun.variablesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect("variables" in planRun).toEqual(false);
  expect("variables" in persisted.planRun).toEqual(false);
  expect(payload).not.toContain("super-secret-plan-token");
  expect(payload).not.toContain("acct_123");
});

test("plan/apply records Installation, Deployment, and non-sensitive well-known outputs", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(10),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.planDigest).toEqual(PLAN_DIGEST);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applied.applyRun.status).toEqual("succeeded");
  expect(applied.installation?.status).toEqual("ready");
  expect(applied.deployment?.status).toEqual("succeeded");
  expect(applied.deployment?.outputs).toEqual([
    {
      name: "launch_url",
      kind: "launch_url",
      value: "https://app.example.test",
      sensitive: false,
    },
  ]);
  expect(applied.applyRun.stateBackend.kind).toEqual("operator-managed");
  expect(applied.applyRun.stateLock.status).toEqual("recorded");
  expect(applied.applyRun.stateLock.backendRef).toEqual(
    "state://takosumi/cloudflare-default",
  );
  expect(applied.applyRun.outputs?.some((output) =>
    output.name === "secret_value"
  )).toEqual(false);
  expect(applied.applyRun.auditEvents.map((event) => event.type)).toContain(
    "apply.completed",
  );

  const deployments = await controller.listDeployments(
    applied.installation!.id,
  );
  expect(deployments.deployments.map((deployment) => deployment.id)).toEqual([
    applied.deployment!.id,
  ]);
});

test("PlanRun rejects installation operations outside the requested space", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(20),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const created = await controller.createPlanRun({
    spaceId: "space_a",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const applied = await controller.createApplyRun({
    planRunId: created.planRun.id,
    expected: applyExpectedGuardFromPlanRun(created.planRun),
  });

  await expect(controller.createPlanRun({
    spaceId: "space_b",
    installationId: applied.installation!.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/belongs to space space_a/);
});

test("PlanRun operation and installationId shape is explicit", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(30),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    operation: "update",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/update PlanRun requires installationId/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    operation: "destroy",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/destroy PlanRun requires installationId/);
});

test("update and destroy PlanRuns stay bound to the Installation source and runner profile", async () => {
  const defaultProfile = createDefaultRunnerProfiles(60)[0]!;
  const otherProfile: RunnerProfile = {
    ...defaultProfile,
    id: "other-cloudflare",
    name: "Other Cloudflare",
    stateBackend: {
      ...defaultProfile.stateBackend,
      ref: "state://takosumi/other-cloudflare",
    },
  };
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(60),
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [defaultProfile, otherProfile],
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    installationId: applied.installation!.id,
    operation: "update",
    source: SOURCE,
    runnerProfileId: otherProfile.id,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/uses runner profile cloudflare-default/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    installationId: applied.installation!.id,
    operation: "update",
    source: {
      kind: "git",
      url: "https://github.com/example/other.git",
      ref: "main",
    },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/source identity does not match/);

  const { planRun: updatePlan } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId: applied.installation!.id,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(updatePlan.status).toEqual("succeeded");
  expect(updatePlan.installationCurrentDeploymentId).toEqual(
    applied.deployment!.id,
  );
});

test("apply rejects a stale update PlanRun after the current Deployment changes", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(80),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const { planRun: staleUpdate } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId: applied.installation!.id,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const { planRun: freshUpdate } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId: applied.installation!.id,
    operation: "update",
    source: { ...SOURCE, ref: "release-3" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  await controller.createApplyRun({
    planRunId: freshUpdate.id,
    expected: applyExpectedGuardFromPlanRun(freshUpdate),
  });

  await expect(controller.createApplyRun({
    planRunId: staleUpdate.id,
    expected: applyExpectedGuardFromPlanRun(staleUpdate),
  })).rejects.toThrow(/current Deployment changed/);
});

test("prepared source digest must be a canonical sha256 digest", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(90),
    newId: deterministicIds(),
  });

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "prepared",
      url: "https://example.test/module.tar.gz",
      digest: "sha256:not-a-real-digest",
    },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/prepared source digest/);
});

test("git source is restricted to safe HTTPS source URLs", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(91),
    newId: deterministicIds(),
  });
  const requiredProviders = ["registry.opentofu.org/cloudflare/cloudflare"];

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "file:///etc/passwd",
      ref: "main",
    },
    requiredProviders,
  })).rejects.toThrow(/git source url must use https/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "https://token@example.com/private.git",
      ref: "main",
    },
    requiredProviders,
  })).rejects.toThrow(/must not embed credentials/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "https://127.0.0.1/private.git",
      ref: "main",
    },
    requiredProviders,
  })).rejects.toThrow(/git source url host is not allowed/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "https://github.com/example/app.git",
      ref: "--upload-pack=/bin/sh",
    },
    requiredProviders,
  })).rejects.toThrow(/source\.ref must not start/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "https://github.com/example/app.git",
      commit: "main",
    },
    requiredProviders,
  })).rejects.toThrow(/source\.commit must be a full git object id/);

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: {
      kind: "git",
      url: "https://github.com/example/app.git",
      modulePath: "../other",
    },
    requiredProviders,
  })).rejects.toThrow(/source\.modulePath must stay inside/);
});

test("local source requires runner profile opt-in", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(40),
    newId: deterministicIds(),
  });

  await expect(controller.createPlanRun({
    spaceId: "space_test",
    source: { kind: "local", path: "/workspace/module" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  })).rejects.toThrow(/does not allow local source paths/);

  const localProfile: RunnerProfile = {
    ...createDefaultRunnerProfiles(40)[0],
    id: "local-dev",
    name: "Local dev",
    sourcePolicy: { allowLocalSource: true },
  };
  const localController = new OpenTofuDeploymentController({
    now: sequenceNow(50),
    newId: deterministicIds(),
    runnerProfiles: [localProfile],
    defaultRunnerProfileId: "local-dev",
  });
  const { planRun } = await localController.createPlanRun({
    spaceId: "space_test",
    source: { kind: "local", path: "/workspace/module" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(planRun.status).toEqual("queued");
});

test("runner diagnostics are redacted before PlanRun and ApplyRun persistence", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(15),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("diagnostics"),
          diagnostics: [{
            severity: "warning",
            message: "provider returned Authorization: Bearer cf-plan-secret",
            detail: "token=cf-plan-token",
          }],
        }),
      apply: () =>
        Promise.resolve({
          diagnostics: [{
            severity: "warning",
            message: "apply used Authorization: Bearer cf-apply-secret",
            detail: "client_secret=cf-apply-token",
          }],
        }),
    },
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const persistedPlan = await controller.getPlanRun(planRun.id);
  const persistedApply = await controller.getApplyRun(applied.applyRun.id);
  const payload = JSON.stringify({
    plan: persistedPlan.diagnostics,
    apply: persistedApply.applyRun.diagnostics,
  });
  expect(payload).not.toContain("cf-plan-secret");
  expect(payload).not.toContain("cf-plan-token");
  expect(payload).not.toContain("cf-apply-secret");
  expect(payload).not.toContain("cf-apply-token");
  expect(payload).toContain("[REDACTED]");
});

test("apply expected guard compares against the succeeded PlanRun", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(20),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(planRun),
        planDigest: "sha256:bad",
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("apply requires the full reviewed PlanRun guard", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(25),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(planRun),
        variablesDigest:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("runner profile policy blocks unsupported providers before execution", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 30,
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
  });

  expect(planRun.status).toEqual("blocked");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons[0]).toContain("not allowed");
});

test("runner profile policy requires declared providers before execution", async () => {
  let runnerCalled = false;
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(31),
    newId: deterministicIds(),
    runner: {
      plan: () => {
        runnerCalled = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("observed-provider"),
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: [],
  });

  expect(planRun.status).toEqual("blocked");
  expect(runnerCalled).toEqual(false);
  expect(planRun.requiredProviders).toEqual([]);
  expect(planRun.policy.reasons.join("\n")).toContain("requires requiredProviders");
  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        planRunId: planRun.id,
        runnerProfileId: planRun.runnerProfileId,
        sourceDigest: planRun.sourceDigest,
        variablesDigest: planRun.variablesDigest,
        policyDecisionDigest: planRun.policyDecisionDigest,
        planDigest: PLAN_DIGEST,
        planArtifactDigest: PLAN_DIGEST,
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("runner profile policy blocks denied providers and missing credential refs", async () => {
  const profile: RunnerProfile = {
    id: "strict-cloudflare",
    name: "Strict Cloudflare",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://strict",
      lock: { kind: "operator", ref: "lock://strict" },
    },
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    deniedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requireCredentialRefs: true,
    credentialRefs: [],
    createdAt: 1,
  };
  const controller = new OpenTofuDeploymentController({
    now: () => 35,
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  expect(planRun.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain("denied");
});

test("runner profile policy blocks required providers without credential refs", async () => {
  const profile: RunnerProfile = {
    id: "credential-required",
    name: "Credential required",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://credential-required",
    },
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requireCredentialRefs: true,
    credentialRefs: [],
    createdAt: 1,
  };
  const controller = new OpenTofuDeploymentController({
    now: () => 36,
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });

  expect(planRun.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain("credential reference");
});

test("default Cloudflare runner keeps Workers for Platforms separate from OpenTofu secrets", () => {
  const cloudflare = createDefaultRunnerProfiles(123).find((profile) =>
    profile.id === "cloudflare-default"
  );

  expect(cloudflare?.substrate).toEqual("cloudflare-containers");
  expect(cloudflare?.cloudflareContainer?.queueName).toEqual(
    "takosumi-runs",
  );
  expect(cloudflare?.resourceLimits).toEqual({
    maxRunSeconds: 900,
    maxSourceArchiveBytes: 104857600,
    maxSourceDecompressedBytes: 1048576000,
    cpu: "1",
    memoryMb: 1024,
  });
  expect(cloudflare?.cloudflareWorkersForPlatforms).toEqual({
    dispatchNamespace: "takosumi-tenants",
    dispatchWorkerBinding: "TAKOSUMI_TENANT_DISPATCH",
    outboundWorker: {
      serviceBinding: "TAKOSUMI_OUTBOUND_WORKER",
      enforceNetworkPolicy: true,
    },
    userWorkerBindings: {
      mode: "tenant-scoped-only",
      allowedBindingKinds: [
        "kv_namespace",
        "durable_object_namespace",
        "queue",
        "r2_bucket",
        "d1_database",
      ],
    },
  });
  expect(cloudflare?.secretExposurePolicy).toEqual({
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  });
});

test("default runner profiles cover common OpenTofu provider targets", () => {
  const profiles = createDefaultRunnerProfiles(123);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  expect(Array.from(byId.keys())).toEqual([
    "cloudflare-default",
    "aws-default",
    "gcp-default",
    "azure-default",
    "kubernetes-default",
    "github-default",
    "digitalocean-default",
    "docker-local",
  ]);
  expect(byId.get("azure-default")?.allowedProviders).toEqual([
    "registry.opentofu.org/hashicorp/azurerm",
  ]);
  expect(byId.get("kubernetes-default")?.allowedProviders).toEqual([
    "registry.opentofu.org/hashicorp/kubernetes",
    "registry.opentofu.org/hashicorp/helm",
  ]);
  expect(byId.get("github-default")?.allowedProviders).toEqual([
    "registry.opentofu.org/integrations/github",
  ]);
  expect(byId.get("digitalocean-default")?.allowedProviders).toEqual([
    "registry.opentofu.org/digitalocean/digitalocean",
  ]);
  expect(byId.get("docker-local")?.substrate).toEqual("local");
  expect(byId.get("docker-local")?.cloudflareContainer).toEqual(undefined);
  expect(byId.get("cloudflare-default")?.labels?.["takosumi.com/profile-state"])
    .toEqual(undefined);
  for (
    const id of [
      "aws-default",
      "gcp-default",
      "azure-default",
      "kubernetes-default",
      "github-default",
      "digitalocean-default",
      "docker-local",
    ]
  ) {
    expect(byId.get(id)?.labels?.["takosumi.com/profile-state"]).toEqual(
      "template",
    );
  }
});

test("default runner profiles record provider network policy patterns", () => {
  const profiles = createDefaultRunnerProfiles(123);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  expect(byId.get("aws-default")?.networkPolicy?.allowedHostPatterns).toContain(
    "*.amazonaws.com",
  );
  expect(byId.get("gcp-default")?.networkPolicy?.allowedHostPatterns).toContain(
    "*.googleapis.com",
  );
  expect(
    byId.get("azure-default")?.networkPolicy?.allowedHosts,
  ).toContain("management.azure.com");
  expect(
    byId.get("azure-default")?.networkPolicy?.allowedHostPatterns,
  ).toContain("*.microsoftonline.com");
  expect(byId.get("kubernetes-default")?.networkPolicy?.mode).toEqual(
    "operator-managed",
  );
  expect(
    byId.get("digitalocean-default")?.networkPolicy?.allowedHosts,
  ).toContain("api.digitalocean.com");
});

test("template runner profiles are blocked until operator validation enables them", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 38,
    newId: deterministicIds(),
    runner: fakeRunner(),
    defaultRunnerProfileId: "aws-default",
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
  });

  expect(planRun.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain("disabled template");
});

test("operator-enabled template runner profiles can pass provider policy", async () => {
  const profile = createDefaultRunnerProfiles(123).find((candidate) =>
    candidate.id === "aws-default"
  )!;
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(39),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("enabled-template"),
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
        }),
      apply: () => Promise.resolve({}),
    },
    runnerProfiles: [{
      ...profile,
      labels: {
        ...profile.labels,
        "takosumi.com/profile-enabled": "true",
      },
    }],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
  });

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("destroy is recorded as an ApplyRun when the runner succeeds", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(40),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const installation = applied.installation!;

  const { planRun: destroyPlan } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    source: SOURCE,
    operation: "destroy",
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const destroyed = await controller.createApplyRun({
    planRunId: destroyPlan.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan),
  });

  expect(destroyed.applyRun.operation).toEqual("destroy");
  expect(destroyed.applyRun.status).toEqual("succeeded");
  expect(destroyed.installation?.status).toEqual("destroyed");
  expect(destroyed.installation?.currentDeploymentId).toEqual(null);
  expect(destroyed.applyRun.auditEvents.map((event) => event.type)).toContain(
    "destroy.completed",
  );
});

test("not found surfaces the closed controller error code", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 50,
    newId: deterministicIds(),
  });

  await expect(controller.getPlanRun("plan_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

function fakeRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: testPlanArtifact("fake"),
        sourceCommit: "abc123",
        providerLockDigest: LOCK_DIGEST,
        summary: { add: 1, change: 0, destroy: 0 },
      }),
    apply: () =>
      Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://app.example.test",
          },
          ignored_value: {
            sensitive: false,
            value: "not published",
          },
          secret_value: {
            sensitive: true,
            value: "do-not-publish",
          },
        },
      }),
    destroy: () => Promise.resolve({}),
  };
}

function testPlanArtifact(label: string) {
  return {
    kind: "runner-local",
    ref: `runner-local://plan_${label}/tfplan`,
    digest: PLAN_DIGEST,
    contentType: "application/vnd.opentofu.plan",
  } as const;
}

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}
