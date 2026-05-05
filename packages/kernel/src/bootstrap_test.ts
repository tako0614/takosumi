import assert from "node:assert/strict";
import { TAKOSUMI_INTERNAL_PATHS } from "takosumi-contract";
import { TAKOSUMI_DEPLOY_PUBLIC_PATH } from "./api/deploy_public_routes.ts";
import { TAKOSUMI_PAAS_PUBLIC_PATHS } from "./api/public_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./api/readiness_routes.ts";
import { createPaaSApp } from "./bootstrap.ts";

Deno.test("createPaaSApp uses validated runtime config role and keeps worker internal API unmounted", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-worker",
    },
    startWorkerDaemon: false,
  });

  assert.equal(created.role, "takosumi-worker");
  assert.equal(created.workerDaemon, undefined);

  const internal = await created.app.request(TAKOSUMI_INTERNAL_PATHS.spaces);
  assert.equal(internal.status, 404);
});

Deno.test("createPaaSApp readiness fails closed when API internal secret is missing", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-api",
    },
  });

  const ready = await created.app.request(TAKOSUMI_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  assert.match((await ready.json()).error.message, /internalApiSecret/);
});

Deno.test("createPaaSApp readiness accepts TAKOSUMI_INTERNAL_API_SECRET", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-api",
      TAKOSUMI_INTERNAL_API_SECRET: "api-secret",
    },
  });

  const ready = await created.app.request(TAKOSUMI_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).checks.internalApiSecret, "configured");
});

Deno.test("createPaaSApp mounts deploy CLI route from deploy token without public API flag", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-api",
      TAKOSUMI_DEPLOY_TOKEN: "deploy-token",
    },
  });

  const deploy = await created.app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH);
  assert.equal(deploy.status, 401);

  const publicSpaces = await created.app.request(
    TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
  );
  assert.equal(publicSpaces.status, 404);
});

Deno.test("createPaaSApp mounts metrics route from scrape token", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-api",
      TAKOSUMI_METRICS_SCRAPE_TOKEN: "metrics-token",
    },
  });

  const metrics = await created.app.request("/metrics", {
    headers: { authorization: "Bearer metrics-token" },
  });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /takosumi_metrics_scrape_info 1/);
});

Deno.test("createPaaSApp readiness fails closed when worker daemon is disabled", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_PAAS_PROCESS_ROLE: "takosumi-worker",
    },
    startWorkerDaemon: false,
  });

  const ready = await created.app.request(TAKOSUMI_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  assert.match((await ready.json()).error.message, /workerDaemon/);
});
