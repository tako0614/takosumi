import { expect, test } from "bun:test";
import {
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
  INSTALLER_ERROR_CODES,
  INSTALLER_ERROR_HTTP_STATUS_BY_CODE,
} from "./installer-api.ts";
import { INSTALLER_API_CONTRACT_FIXTURES } from "./installer-api_contract.ts";

test("Installer API v1 exposes exactly five write endpoint templates", () => {
  expect([
    INSTALLATIONS_DRY_RUN_PATH,
    INSTALLATIONS_PATH,
    INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH("{id}"),
    INSTALLATION_DEPLOYMENTS_PATH("{id}"),
    INSTALLATION_ROLLBACK_PATH("{id}"),
  ]).toEqual([
    "/v1/installations/dry-run",
    "/v1/installations",
    "/v1/installations/%7Bid%7D/deployments/dry-run",
    "/v1/installations/%7Bid%7D/deployments",
    "/v1/installations/%7Bid%7D/rollback",
  ]);
});

test("Installer API v1 error code and HTTP status table is frozen", () => {
  expect(INSTALLER_ERROR_CODES).toEqual([
    "invalid_argument",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "failed_precondition",
    "resource_exhausted",
    "not_implemented",
    "internal_error",
  ]);
  expect(INSTALLER_ERROR_HTTP_STATUS_BY_CODE).toEqual({
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

test("Installer API v1 request and response DTO top-level shapes are frozen", () => {
  const fixtures = INSTALLER_API_CONTRACT_FIXTURES;

  expect(Object.keys(fixtures.installationDryRunRequest)).toEqual([
    "spaceId",
    "source",
    "profile",
    "bindings",
  ]);
  expect(Object.keys(fixtures.installationDryRunResponse)).toEqual([
    "source",
    "installPlan",
    "planSnapshotDigest",
    "changes",
    "expected",
  ]);
  expect(Object.keys(fixtures.installationApplyRequest)).toEqual([
    "spaceId",
    "source",
    "profile",
    "bindings",
    "expected",
  ]);
  expect(Object.keys(fixtures.installationApplyResponse)).toEqual([
    "installation",
    "deployment",
  ]);
  expect(Object.keys(fixtures.deploymentDryRunRequest)).toEqual([
    "source",
    "profile",
    "bindings",
  ]);
  expect(Object.keys(fixtures.deploymentDryRunResponse)).toEqual([
    "source",
    "installPlan",
    "planSnapshotDigest",
    "changes",
    "expected",
  ]);
  expect(Object.keys(fixtures.deploymentApplyRequest)).toEqual([
    "source",
    "profile",
    "bindings",
    "expected",
  ]);
  expect(Object.keys(fixtures.deploymentApplyResponse)).toEqual([
    "deployment",
  ]);
  expect(Object.keys(fixtures.rollbackRequest)).toEqual(["deploymentId"]);
  expect(Object.keys(fixtures.rollbackResponse)).toEqual([
    "installation",
    "deployment",
    "rollback",
  ]);
  expect(Object.keys(fixtures.errorEnvelope)).toEqual(["error"]);
  expect(Object.keys(fixtures.errorEnvelope.error)).toEqual([
    "code",
    "message",
    "requestId",
    "details",
  ]);
});
