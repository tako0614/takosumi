import assert from "node:assert/strict";
import { TAKOSUMI_INTERNAL_PATHS } from "takosumi-contract";
import { TAKOS_PAAS_READINESS_PATHS } from "./api/readiness_routes.ts";
import { createPaaSApp } from "./bootstrap.ts";

Deno.test("createPaaSApp uses validated runtime config role and keeps worker internal API unmounted", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_PAAS_PROCESS_ROLE: "takosumi-worker",
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
      TAKOS_PAAS_PROCESS_ROLE: "takosumi-api",
    },
  });

  const ready = await created.app.request(TAKOS_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  assert.match((await ready.json()).error.message, /internalServiceSecret/);
});

Deno.test("createPaaSApp readiness fails closed when worker daemon is disabled", async () => {
  const created = await createPaaSApp({
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOS_PAAS_PROCESS_ROLE: "takosumi-worker",
    },
    startWorkerDaemon: false,
  });

  const ready = await created.app.request(TAKOS_PAAS_READINESS_PATHS.ready);
  assert.equal(ready.status, 503);
  assert.match((await ready.json()).error.message, /workerDaemon/);
});
