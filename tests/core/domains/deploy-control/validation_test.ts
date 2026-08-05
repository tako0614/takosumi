import { expect, test } from "bun:test";
import {
  normalizeVariablePathRecord,
  normalizeVariables,
  validatePlannedCapsuleCurrent,
} from "../../../../core/domains/deploy-control/validation.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { Capsule } from "../../../../contract/capsules.ts";
import type { PlanRun } from "../../../../contract/internal-deploy-control-api.ts";

test("normalizes dotted OpenTofu variable paths into nested objects", () => {
  expect(
    normalizeVariablePathRecord({
      "cloudflare.workers_subdomain": "team",
      cloudflare: { account_id: "acct_123" },
    }),
  ).toEqual({
    cloudflare: {
      account_id: "acct_123",
      workers_subdomain: "team",
    },
  });
});

test("rejects prototype-reserved OpenTofu variable path segments", () => {
  for (const key of [
    "__proto__",
    "constructor",
    "prototype",
    "cloudflare.__proto__",
    "cloudflare.constructor",
    "cloudflare.prototype",
  ]) {
    expect(() => normalizeVariablePathRecord({ [key]: true })).toThrow(
      /dot-separated OpenTofu variable identifier segments/,
    );
  }

  expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
});

test("rejects prototype-reserved JSON object keys inside variable values", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    expect(() =>
      normalizeVariables({
        cloudflare: { [key]: { polluted: true } },
      }),
    ).toThrow(/must be a JSON value/);
  }

  expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
});

test("rejects a queued apply whose planned Capsule was destroyed after abandon", () => {
  const planRun = {
    id: "plan_queued_before_abandon",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    capsuleCurrentStateVersionId: null,
  } as PlanRun;
  const destroyedCapsule = {
    id: "capsule_1",
    workspaceId: "workspace_1",
    status: "destroyed",
    currentStateVersionId: undefined,
  } as Capsule;

  let thrown: unknown;
  try {
    validatePlannedCapsuleCurrent({
      planRun,
      capsule: destroyedCapsule,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(OpenTofuControllerError);
  expect((thrown as OpenTofuControllerError).code).toBe("failed_precondition");
  expect((thrown as Error).message).toContain("capsule capsule_1 is destroyed");
});

test("keeps non-destroyed Capsule lifecycle statuses eligible for the existing guards", () => {
  const planRun = {
    id: "plan_pending",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    capsuleCurrentStateVersionId: null,
  } as PlanRun;

  for (const status of ["pending", "active", "stale", "error", "disabled"] as const) {
    expect(() =>
      validatePlannedCapsuleCurrent({
        planRun,
        capsule: {
          id: "capsule_1",
          workspaceId: "workspace_1",
          status,
          currentStateVersionId: undefined,
        } as Capsule,
      }),
    ).not.toThrow();
  }
});
