import { expect, test } from "bun:test";
import {
  APPLY_RUN_PATH,
  APPLY_RUNS_PATH,
  CAPSULE_OUTPUTS_PATH,
  CAPSULE_PATH,
  CAPSULE_STATE_VERSIONS_PATH,
  DEPLOY_CONTROL_ERROR_CODES,
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
  PLAN_RUN_PATH,
  PLAN_RUNS_PATH,
  RUNNER_PROFILES_PATH,
} from "../../contract/internal-deploy-control-api.ts";
import { DEPLOY_CONTROL_API_CONTRACT_FIXTURES } from "../../contract/internal-deploy-control-api_contract.ts";

test("Deploy Control API v1 exposes the OpenTofu deploy-control endpoint templates", () => {
  expect([
    RUNNER_PROFILES_PATH,
    PLAN_RUNS_PATH,
    PLAN_RUN_PATH("{id}"),
    APPLY_RUNS_PATH,
    APPLY_RUN_PATH("{id}"),
    CAPSULE_PATH("{id}"),
    CAPSULE_STATE_VERSIONS_PATH("{id}"),
    CAPSULE_OUTPUTS_PATH("{id}"),
  ]).toEqual([
    "/internal/v1/runner-profiles",
    "/internal/v1/plan-runs",
    "/internal/v1/plan-runs/%7Bid%7D",
    "/internal/v1/apply-runs",
    "/internal/v1/apply-runs/%7Bid%7D",
    "/internal/v1/capsules/%7Bid%7D",
    "/internal/v1/capsules/%7Bid%7D/state-versions",
    "/internal/v1/capsules/%7Bid%7D/outputs",
  ]);
});

test("Deploy Control API v1 error code and HTTP status table is frozen", () => {
  expect(DEPLOY_CONTROL_ERROR_CODES).toEqual([
    "invalid_argument",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "failed_precondition",
    "resource_exhausted",
    "not_implemented",
    "internal_error",
  ]);
  expect(DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE).toEqual({
    invalid_argument: 400,
    unauthenticated: 401,
    permission_denied: 403,
    not_found: 404,
    failed_precondition: 409,
    resource_exhausted: 413,
    not_implemented: 501,
    internal_error: 500,
  });
});

test("Deploy Control API v1 request and response DTO top-level shapes are frozen", () => {
  const fixtures = DEPLOY_CONTROL_API_CONTRACT_FIXTURES;

  expect(Object.keys(fixtures.listRunnerProfilesResponse)).toEqual([
    "runnerProfiles",
  ]);
  expect(Object.keys(fixtures.createPlanRunRequest)).toEqual([
    "workspaceId",
    "source",
    "runnerProfileId",
    "variables",
    "requiredProviders",
  ]);
  expect(Object.keys(fixtures.planRunResponse)).toEqual(["planRun"]);
  expect(Object.keys(fixtures.createApplyRunRequest)).toEqual([
    "planRunId",
    "expected",
  ]);
  expect(Object.keys(fixtures.applyRunResponse)).toEqual([
    "applyRun",
    "capsule",
  ]);
  expect(Object.keys(fixtures.getCapsuleResponse)).toEqual(["capsule"]);
  expect(Object.keys(fixtures.listStateVersionsResponse)).toEqual([
    "stateVersions",
  ]);
  expect(Object.keys(fixtures.outputResponse)).toEqual(["output"]);
  expect("rawArtifactRef" in fixtures.outputResponse.output).toBe(false);
  expect(Object.keys(fixtures.errorEnvelope)).toEqual(["error"]);
  expect(Object.keys(fixtures.errorEnvelope.error)).toEqual([
    "code",
    "message",
    "requestId",
    "details",
  ]);
});

test("RunnerProfile fixture is operator-composed and provider-neutral", () => {
  const profile =
    DEPLOY_CONTROL_API_CONTRACT_FIXTURES.listRunnerProfilesResponse
      .runnerProfiles[0];

  expect(Object.keys(profile)).toEqual([
    "id",
    "name",
    "substrate",
    "executorId",
    "lifecycle",
    "availability",
    "tofuVersion",
    "stateBackend",
    "allowedProviders",
    "resourceLimits",
    "networkPolicy",
    "secretExposurePolicy",
    "createdAt",
  ]);
  expect(profile.substrate).toEqual("operator-managed");
  expect(profile.executorId).toEqual("opentofu.default");
  expect(profile.lifecycle).toEqual({ state: "active" });
  expect(profile.availability).toEqual({ state: "available" });
  expect(profile.allowedProviders).toEqual(["*"]);
  expect(profile.networkPolicy).toEqual({ mode: "operator-managed" });
  expect(profile.secretExposurePolicy).toEqual({
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  });
});
