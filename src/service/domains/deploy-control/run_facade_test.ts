import { expect, test } from "bun:test";

import {
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "./mod.ts";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

function succeedingRunner() {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local" as const,
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
        },
      }),
    apply: () => Promise.resolve({}),
  };
}

test("getRun projects a queued plan run as the unified Run", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 1,
    newId: deterministicIds(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const run = await controller.getRun(planRun.id);
  expect(run.id).toBe(planRun.id);
  expect(run.type).toBe("plan");
  expect(run.status).toBe("queued");
  expect(run.policyStatus).toBe("pass");
});

test("getRun projects a succeeded plan + its apply run", async () => {
  const controller = new OpenTofuDeploymentController({
    now: sequenceNow(1),
    newId: deterministicIds(),
    runner: succeedingRunner(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const planView = await controller.getRun(planRun.id);
  expect(planView.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedFrom(planRun),
  });
  const applyView = await controller.getRun(applyRun.id);
  expect(applyView.type).toBe("apply");
  expect(applyView.status).toBe("succeeded");
});

test("getRun throws not_found for an unknown id", async () => {
  const controller = new OpenTofuDeploymentController({ now: () => 1 });
  await expect(controller.getRun("plan_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

test("cancelRun cancels a queued plan run and is rejected once running/terminal", async () => {
  const controller = new OpenTofuDeploymentController({
    now: () => 1,
    newId: deterministicIds(),
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: "space_test",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const cancelled = await controller.cancelRun(planRun.id);
  expect(cancelled.status).toBe("cancelled");

  // A second cancel of the now-terminal run is rejected.
  await expect(controller.cancelRun(planRun.id)).rejects.toMatchObject({
    code: "failed_precondition",
  });
});

// Reconstruct the expected guard the apply needs from the reviewed plan.
function applyExpectedFrom(planRun: {
  readonly id: string;
  readonly runnerProfileId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest?: string;
}) {
  return {
    planRunId: planRun.id,
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest!,
    planArtifactDigest: PLAN_DIGEST,
  };
}
