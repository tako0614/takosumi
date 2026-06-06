import { expect, test } from "bun:test";

import { createTakosumiService } from "../bootstrap.ts";

const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function service() {
  return await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    startWorkerDaemon: false,
  });
}

async function createSource(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
): Promise<string> {
  const res = await app.request("/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId: "space_test",
      name: "repo",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).source.id;
}

test("lanes e2e: create App + Environment + DeploymentProfile", async () => {
  const { app } = await service();
  const sourceId = await createSource(app);

  const appRes = await app.request("/v1/apps", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId: "space_test",
      name: "shop",
      sourceId,
      installType: "opentofu_module",
    }),
  });
  expect(appRes.status).toBe(201);
  const appId = (await appRes.json()).app.id as string;

  const envRes = await app.request(`/v1/apps/${appId}/environments`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ name: "production" }),
  });
  expect(envRes.status).toBe(201);
  const env = (await envRes.json()).environment;
  expect(env.requireApproval).toBe(true);
  expect(env.autoApply).toBe(false);
  const envId = env.id as string;

  // No profile yet -> 404.
  const noProfile = await app.request(
    `/v1/environments/${envId}/deployment-profile`,
    { headers: headers() },
  );
  expect(noProfile.status).toBe(404);

  const putRes = await app.request(
    `/v1/environments/${envId}/deployment-profile`,
    {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        bindings: { compute: { mode: "service", connectionId: "conn_cf" } },
      }),
    },
  );
  expect(putRes.status).toBe(200);
  const getProfile = await app.request(
    `/v1/environments/${envId}/deployment-profile`,
    { headers: headers() },
  );
  expect(getProfile.status).toBe(200);
  expect((await getProfile.json()).deploymentProfile.bindings.compute.connectionId)
    .toBe("conn_cf");
});

test("lanes e2e: install profiles are seeded from the template catalog", async () => {
  const { app } = await service();
  const res = await app.request("/v1/install-profiles", { headers: headers() });
  expect(res.status).toBe(200);
  const profiles = (await res.json()).installProfiles as Array<
    { trustLevel: string }
  >;
  expect(profiles.length).toBeGreaterThan(0);
  expect(profiles.every((p) => p.trustLevel === "official")).toBe(true);
});

test("run facade e2e: GET /v1/runs/{id} projects a queued plan run", async () => {
  const { app } = await service();
  const planRes = await app.request("/v1/plan-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
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
  expect(planRes.status).toBe(201);
  const planId = (await planRes.json()).planRun.id as string;

  const runRes = await app.request(`/v1/runs/${planId}`, { headers: headers() });
  expect(runRes.status).toBe(200);
  const run = (await runRes.json()).run;
  expect(run.id).toBe(planId);
  expect(run.type).toBe("plan");
  expect(run.status).toBe("queued");

  // Cancel it via the unified facade.
  const cancelRes = await app.request(`/v1/runs/${planId}/cancel`, {
    method: "POST",
    headers: headers(),
  });
  expect(cancelRes.status).toBe(200);
  expect((await cancelRes.json()).run.status).toBe("cancelled");
});

test("run facade e2e: approve route accepts an empty body and is space-gated", async () => {
  const { app } = await service();
  // Approving a non-existent run is a not_found, not a 401/500, proving the
  // route is wired and accepts an empty body.
  const res = await app.request("/v1/runs/plan_doesnotexist01/approve", {
    method: "POST",
    headers: headers(),
  });
  expect(res.status).toBe(404);
});

test("lanes e2e: unauthorized without the deploy-control bearer", async () => {
  const { app } = await service();
  const res = await app.request("/v1/install-profiles");
  expect(res.status).toBe(401);
});
