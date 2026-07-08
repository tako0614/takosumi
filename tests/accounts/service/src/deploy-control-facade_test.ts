import { expect, test } from "bun:test";

import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  GetCapsuleResponse,
  InstallConfig,
  ListDeploymentsResponse,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import {
  type DeployControlOperations,
  requestDeploymentApply,
  requestDeploymentPlanRun,
  requestCapsuleApply,
  requestCapsulePlanRun,
} from "../../../../accounts/service/src/mod.ts";

function planRun(overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_inproc",
    workspaceId: "space_1",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "main",
    },
    sourceDigest: "sha256:source",
    operation: "create",
    runnerProfileId: "cloudflare-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: "sha256:plan",
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://plan_inproc/tfplan",
      digest: "sha256:plan-artifact",
    },
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    finishedAt: 1,
    ...overrides,
  } as PlanRun;
}

function operationsStub(
  overrides: Partial<DeployControlOperations> = {},
): DeployControlOperations {
  const reject = (name: string) => () =>
    Promise.reject(new Error(`unexpected ${name} call`));
  return {
    createPlanRun: reject(
      "createPlanRun",
    ) as DeployControlOperations["createPlanRun"],
    getPlanRun: reject("getPlanRun") as DeployControlOperations["getPlanRun"],
    createApplyRun: reject(
      "createApplyRun",
    ) as DeployControlOperations["createApplyRun"],
    getCapsule: reject("getCapsule") as DeployControlOperations["getCapsule"],
    listDeployments: reject(
      "listDeployments",
    ) as DeployControlOperations["listDeployments"],
    ...overrides,
  };
}

test("requestCapsulePlanRun dispatches through typed operations, not fetch", async () => {
  let createPlanRunArg: CreatePlanRunRequest | undefined;
  const operations = operationsStub({
    createPlanRun: (request) => {
      createPlanRunArg = request;
      return Promise.resolve<PlanRunResponse>({ planRun: planRun() });
    },
  });

  const result = await requestCapsulePlanRun({
    deployControl: {
      operations,
    },
    body: {
      workspaceId: "space_1",
      source: {
        kind: "git",
        url: "https://github.com/example/hello",
        ref: "main",
      },
    },
  });

  expect(result.status).toEqual(201);
  expect(createPlanRunArg?.workspaceId).toEqual("space_1");
  expect(createPlanRunArg?.operation).toEqual("create");
  const payload = result.payload as {
    kind?: string;
    planRunId?: string;
    expected?: { resolvedProviderEnvBindingsDigest?: string };
  };
  expect(payload.kind).toEqual("takosumi.deploy-control.plan-run@v1");
  expect(payload.planRunId).toEqual("plan_inproc");
  expect(payload.expected?.resolvedProviderEnvBindingsDigest).toBeUndefined();
});

test("requestCapsulePlanRun preserves provider env binding digest in expected guard", async () => {
  const operations = operationsStub({
    createPlanRun: () =>
      Promise.resolve<PlanRunResponse>({
        planRun: planRun({
          resolvedProviderEnvBindingsDigest: "sha256:provider-env-bindings",
        }),
      }),
  });

  const result = await requestCapsulePlanRun({
    deployControl: {
      operations,
    },
    body: {
      workspaceId: "space_1",
      source: {
        kind: "git",
        url: "https://github.com/example/hello",
        ref: "main",
      },
    },
  });

  expect(result.status).toEqual(201);
  const payload = result.payload as {
    expected?: { resolvedProviderEnvBindingsDigest?: string };
  };
  expect(payload.expected?.resolvedProviderEnvBindingsDigest).toEqual(
    "sha256:provider-env-bindings",
  );
});

test("requestDeploymentPlanRun carries existing install config variables and providers", async () => {
  let createPlanRunArg: CreatePlanRunRequest | undefined;
  const installConfig: InstallConfig = {
    id: "cfg_yurucommu",
    workspaceId: "space_1",
    name: "yurucommu",
    installType: "app_source",
    trustLevel: "space",
    variableMapping: {
      project_name: "yurucommu",
      worker_bundle_url: "https://example.test/old-worker.js",
      worker_bundle_sha256: "oldsha",
    },
    outputAllowlist: {},
    policy: {
      allowedProviders: [
        "registry.opentofu.org/cloudflare/cloudflare",
        "registry.opentofu.org/hashicorp/random",
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const operations = operationsStub({
    getCapsule: (id) =>
      Promise.resolve<GetCapsuleResponse>({
        installation: {
          id,
          workspaceId: "space_1",
          name: "yurucommu",
          slug: "yurucommu",
          sourceId: "src_yurucommu",
          installType: "app_source",
          installConfigId: installConfig.id,
          environment: "prod",
          currentStateGeneration: 1,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      } as unknown as GetCapsuleResponse),
    installations: {
      getInstallConfig: (id) => {
        expect(id).toEqual("cfg_yurucommu");
        return Promise.resolve(installConfig);
      },
    },
    createPlanRun: (request) => {
      createPlanRunArg = request;
      return Promise.resolve<PlanRunResponse>({
        planRun: planRun({
          id: "plan_update",
          workspaceId: "space_1",
          capsuleId: "inst_yurucommu",
          installationId: "inst_yurucommu",
          operation: "update",
          requiredProviders: request.requiredProviders ?? [],
        }),
      });
    },
  });

  const result = await requestDeploymentPlanRun({
    deployControl: {
      operations,
    },
    capsuleId: "inst_yurucommu",
    body: {
      source: {
        kind: "git",
        url: "https://github.com/tako0614/yurucommu.git",
        ref: "main",
      },
      variables: {
        worker_bundle_url: "https://example.test/new-worker.js",
        worker_bundle_sha256: "newsha",
      },
    },
  });

  expect(result.status).toEqual(201);
  expect(createPlanRunArg?.operation).toEqual("update");
  expect(createPlanRunArg?.workspaceId).toEqual("space_1");
  expect(createPlanRunArg?.capsuleId).toEqual("inst_yurucommu");
  expect(createPlanRunArg?.variables).toEqual({
    project_name: "yurucommu",
    worker_bundle_url: "https://example.test/new-worker.js",
    worker_bundle_sha256: "newsha",
  });
  expect(createPlanRunArg?.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/random",
  ]);
});

test("requestCapsuleApply reads the reviewed PlanRun and applies in-process", async () => {
  let appliedRequest: CreateApplyRunRequest | undefined;
  const reviewed = planRun({
    id: "plan_apply",
    resolvedProviderEnvBindingsDigest: "sha256:provider-env-bindings",
  });
  const operations = operationsStub({
    getPlanRun: (id) => {
      expect(id).toEqual("plan_apply");
      return Promise.resolve<PlanRunResponse>({ planRun: reviewed });
    },
    createApplyRun: (request) => {
      appliedRequest = request;
      return Promise.resolve<ApplyRunResponse>({
        applyRun: {
          id: "apply_1",
          planRunId: "plan_apply",
          workspaceId: "space_1",
          operation: "create",
          runnerProfileId: "cloudflare-default",
          status: "succeeded",
          expected: request.expected,
          auditEvents: [],
          createdAt: 2,
          updatedAt: 2,
        } as ApplyRunResponse["applyRun"],
      });
    },
  });

  const result = await requestCapsuleApply({
    deployControl: {
      operations,
    },
    body: {
      planRunId: "plan_apply",
      expected: {
        planRunId: "plan_apply",
        runnerProfileId: "cloudflare-default",
        sourceDigest: "sha256:source",
        variablesDigest: "sha256:variables",
        policyDecisionDigest: "sha256:policy",
        planDigest: "sha256:plan",
        planArtifactDigest: "sha256:plan-artifact",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        resolvedProviderEnvBindingsDigest: "sha256:provider-env-bindings",
      },
    },
  });

  expect(result.status).toEqual(201);
  expect(appliedRequest?.planRunId).toEqual("plan_apply");
  expect(appliedRequest?.expected.resolvedProviderEnvBindingsDigest).toEqual(
    "sha256:provider-env-bindings",
  );
  const payload = result.payload as { kind?: string };
  expect(payload.kind).toEqual("takosumi.deploy-control.apply-run@v1");
});

test("in-process controller errors map to the contract HTTP status + envelope", async () => {
  // requestDeploymentApply resolves the reviewed PlanRun first via getPlanRun;
  // a not_found-coded controller error must surface as the 404 deploy-control
  // error envelope, identical to what the HTTP route's runHandler would emit.
  const operations = operationsStub({
    getPlanRun: () =>
      Promise.reject(
        Object.assign(new Error("plan run plan_missing not found"), {
          code: "not_found",
        }),
      ),
  });

  const result = await requestDeploymentApply({
    deployControl: {
      operations,
    },
    capsuleId: "inst_1",
    body: { planRunId: "plan_missing" },
  });

  expect(result.status).toEqual(404);
  const payload = result.payload as {
    error?: { code?: string; message?: string };
  };
  expect(payload.error?.code).toEqual("not_found");
  expect(payload.error?.message).toContain("plan_missing");
});
