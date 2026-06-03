import { expect, test } from "bun:test";
import type { ApplyRunResponse, PlanRunResponse } from "takosumi-contract/deploy-control-api";
import type { OpenTofuRunner } from "../domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../domains/deploy-control/mod.ts";
import { createTakosumiService } from "../bootstrap.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("deployControl e2e exposes OpenTofu plan and apply runs", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
    },
    opentofuRunner: fakeRunner(),
    startWorkerDaemon: false,
  });

  const planRes = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
        ref: "main",
      },
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  });
  expect(planRes.status).toEqual(201);
  const plan = await planRes.json() as PlanRunResponse;
  expect(plan.planRun.status).toEqual("succeeded");
  expect(plan.planRun.planDigest).toEqual(PLAN_DIGEST);
  expect(plan.planRun.planArtifact?.digest).toEqual(PLAN_DIGEST);

  const applyRes = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  expect(applyRes.status).toEqual(201);
  const apply = await applyRes.json() as ApplyRunResponse;
  expect(apply.applyRun.status).toEqual("succeeded");
  expect(apply.installation?.status).toEqual("ready");
  expect(apply.deployment?.outputs[0]?.kind).toEqual("launch_url");

  const outputsRes = await app.request(
    `/v1/installations/${apply.installation!.id}/deployment-outputs`,
    {
      headers: {
        authorization: "Bearer deploy-control-token",
      },
    },
  );
  expect(outputsRes.status).toEqual(200);
  expect((await outputsRes.json()).outputs).toEqual(apply.deployment?.outputs);
});

test("deployControl e2e rejects mismatched plan digest guard", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
    },
    opentofuRunner: fakeRunner(),
    startWorkerDaemon: false,
  });

  const planRes = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
      },
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  });
  const plan = await planRes.json() as PlanRunResponse;

  const res = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(plan.planRun),
        planDigest: "sha256:not-a-real-digest",
      },
    }),
  });
  expect(res.status).toEqual(409);
});

function fakeRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_e2e/tfplan",
          digest: PLAN_DIGEST,
        },
      }),
    apply: () =>
      Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://app.example.test",
          },
        },
      }),
  };
}
