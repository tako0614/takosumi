import { expect, test } from "bun:test";
import {
  APPLY_RUN_PATH,
  APPLY_RUNS_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_DEPLOYMENT_OUTPUTS_PATH,
  INSTALLATION_PATH,
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
    INSTALLATION_PATH("{id}"),
    INSTALLATION_DEPLOYMENTS_PATH("{id}"),
    INSTALLATION_DEPLOYMENT_OUTPUTS_PATH("{id}"),
  ]).toEqual([
    "/internal/v1/runner-profiles",
    "/internal/v1/plan-runs",
    "/internal/v1/plan-runs/%7Bid%7D",
    "/internal/v1/apply-runs",
    "/internal/v1/apply-runs/%7Bid%7D",
    "/internal/v1/installations/%7Bid%7D",
    "/internal/v1/installations/%7Bid%7D/deployments",
    "/internal/v1/installations/%7Bid%7D/deployment-outputs",
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
  expect(Object.keys(fixtures.planRunResponse)).toEqual([
    "planRun",
  ]);
  expect(Object.keys(fixtures.createApplyRunRequest)).toEqual([
    "planRunId",
    "expected",
  ]);
  expect(Object.keys(fixtures.applyRunResponse)).toEqual([
    "applyRun",
    "capsule",
    "deployment",
  ]);
  expect(Object.keys(fixtures.getCapsuleResponse)).toEqual([
    "capsule",
  ]);
  expect(Object.keys(fixtures.listDeploymentsResponse)).toEqual([
    "deployments",
  ]);
  expect(Object.keys(fixtures.listDeploymentOutputsResponse)).toEqual([
    "outputs",
  ]);
  expect(Object.keys(fixtures.errorEnvelope)).toEqual(["error"]);
  expect(Object.keys(fixtures.errorEnvelope.error)).toEqual([
    "code",
    "message",
    "requestId",
    "details",
  ]);
});

test("RunnerProfile fixture exposes Cloudflare tenant runtime and secret exposure boundaries", () => {
  const profile = DEPLOY_CONTROL_API_CONTRACT_FIXTURES
    .listRunnerProfilesResponse.runnerProfiles[0];

  expect(Object.keys(profile)).toEqual([
    "id",
    "name",
    "substrate",
    "tofuVersion",
    "stateBackend",
    "allowedProviders",
    "credentialRefs",
    "resourceLimits",
    "networkPolicy",
    "cloudflareContainer",
    "secretExposurePolicy",
    "createdAt",
  ]);
  expect(profile.substrate).toEqual("cloudflare-containers");
  expect(profile.cloudflareWorkersForPlatforms).toBeUndefined();
  expect(profile.secretExposurePolicy).toEqual({
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  });
});
