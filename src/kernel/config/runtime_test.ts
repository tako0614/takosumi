import { test } from "bun:test";
import assert from "node:assert/strict";
import { loadRuntimeConfigFromEnv, RuntimeConfigError } from "./mod.ts";

test("runtime config loader defaults to local + takosumi-api when env empty", async () => {
  const config = await loadRuntimeConfigFromEnv({ env: {} });

  assert.equal(config.environment, "local");
  assert.equal(config.processRole, "takosumi-api");
  assert.equal(config.allowUnsafeProductionDefaults, false);
  assert.deepEqual(config.diagnostics, []);
});

test("runtime config loader reads explicit environment + process role", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_PROCESS_ROLE: "takosumi-worker",
    },
  });

  assert.equal(config.environment, "production");
  assert.equal(config.processRole, "takosumi-worker");
  assert.deepEqual(config.diagnostics, []);
});

test("runtime config loader prefers canonical process role key", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOSUMI_PROCESS_ROLE: "takosumi-runtime-agent",
    },
  });

  assert.equal(config.processRole, "takosumi-runtime-agent");
});

test("runtime config loader rejects invalid process role", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_PROCESS_ROLE: "takosumi-paused",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["invalid_process_role"],
      );
      return true;
    },
  );
});

test("runtime config loader rejects stale backend selectors", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_STORAGE_BACKEND: "postgres",
          TAKOSUMI_PROVIDER: "local-docker",
          TAKOSUMI_QUEUE_BACKEND: "redis",
          TAKOSUMI_OBJECT_STORAGE_BACKEND: "s3",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        [
          "stale_runtime_selector",
          "stale_runtime_selector",
          "stale_runtime_selector",
          "stale_runtime_selector",
        ],
      );
      return true;
    },
  );
});

test("runtime config loader rejects retired port-based plugin selectors", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_STORAGE_PLUGIN: "takos.storage.test",
          TAKOSUMI_PROVIDER_PLUGIN: "takos.provider.test",
          TAKOSUMI_KERNEL_PLUGIN_SELECTIONS: '{"storage":"foo"}',
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      const codes = error.diagnostics.map((diagnostic) => diagnostic.code);
      assert.ok(codes.every((code) => code === "stale_runtime_selector"));
      assert.equal(codes.length, 3);
      return true;
    },
  );
});

test("runtime config loader accepts dev mode flag", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOSUMI_DEV_MODE: "1",
    },
  });

  assert.equal(config.allowUnsafeProductionDefaults, true);
});

test("runtime config loader rejects invalid environment", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_ENVIRONMENT: "weird",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["invalid_environment"],
      );
      return true;
    },
  );
});
