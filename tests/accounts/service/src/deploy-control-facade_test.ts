import { expect, test } from "bun:test";

import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  GetCapsuleResponse,
  ListDeploymentsResponse,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import {
  type DeployControlOperations,
  requestDeploymentApply,
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
    getCapsule: reject(
      "getCapsule",
    ) as DeployControlOperations["getCapsule"],
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
