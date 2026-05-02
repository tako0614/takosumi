import assert from "node:assert/strict";
import type { KernelPluginPortKind } from "takosumi-contract";
import { loadRuntimeConfigFromEnv, RuntimeConfigError } from "./mod.ts";

const requiredPorts = [
  "auth",
  "coordination",
  "notification",
  "operator-config",
  "storage",
  "source",
  "provider",
  "queue",
  "object-storage",
  "kms",
  "secret-store",
  "router-config",
  "observability",
  "runtime-agent",
] as const satisfies readonly KernelPluginPortKind[];

Deno.test("runtime config loader reads explicit plugin selection map", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOS_ENVIRONMENT: "development",
      TAKOS_PROCESS_ROLE: "takosumi-worker",
      TAKOS_KERNEL_PLUGIN_SELECTIONS: JSON.stringify({
        storage: "takos.storage.memory",
        provider: "takos.provider.test",
      }),
      TAKOS_SOURCE_PLUGIN: "takos.source.manifest",
      TAKOS_PUBLIC_ROUTES_ENABLED: "true",
    },
  });

  assert.equal(config.environment, "development");
  assert.equal(config.processRole, "takosumi-worker");
  assert.equal(config.plugins.storage, "takos.storage.memory");
  assert.equal(config.plugins.provider, "takos.provider.test");
  assert.equal(config.plugins.source, "takos.source.manifest");
  assert.equal(config.routes.publicRoutesEnabled, true);
  assert.deepEqual(config.diagnostics, []);
});

Deno.test("runtime config loader prefers canonical process role key", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOS_PAAS_PROCESS_ROLE: "takosumi-runtime-agent",
    },
  });

  assert.equal(config.processRole, "takosumi-runtime-agent");
});

Deno.test("runtime config loader rejects conflicting process role aliases", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_PAAS_PROCESS_ROLE: "takosumi-worker",
          TAKOS_PROCESS_ROLE: "takosumi-api",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["conflicting_process_role_env"],
      );
      return true;
    },
  );
});

Deno.test("runtime config loader reads operator-owned plugin config JSON", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOS_KERNEL_PLUGIN_CONFIG: JSON.stringify({
        "external.self-hosted": {
          dataDir: "/var/lib/takos-paas",
          internalServiceSecret: "secret",
        },
      }),
    },
  });
  const selfHostedConfig = config.pluginConfig["external.self-hosted"];

  assert.equal(
    selfHostedConfig && typeof selfHostedConfig === "object" &&
      !Array.isArray(selfHostedConfig)
      ? selfHostedConfig.dataDir
      : undefined,
    "/var/lib/takos-paas",
  );
});

Deno.test("runtime config loader rejects invalid plugin config JSON", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_KERNEL_PLUGIN_CONFIG: "[]",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["invalid_kernel_plugin_config_json"],
      );
      return true;
    },
  );
});

Deno.test("runtime config loader rejects stale backend selectors", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_STORAGE_BACKEND: "postgres",
          TAKOS_PROVIDER: "local-docker",
          TAKOS_QUEUE_BACKEND: "redis",
          TAKOS_OBJECT_STORAGE_BACKEND: "s3",
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

Deno.test("runtime config loader rejects generic backend URLs", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_ENVIRONMENT: "local",
          TAKOS_STORAGE_PLUGIN: "takos.kernel.reference",
          TAKOS_PROVIDER_PLUGIN: "takos.kernel.reference",
          DATABASE_URL: "postgresql://takos:takos@postgres:5432/takos",
          REDIS_URL: "redis://redis:6379",
          S3_ENDPOINT: "http://minio:9000",
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
        ],
      );
      return true;
    },
  );
});

Deno.test("runtime config loader rejects production without required plugin ports", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_ENVIRONMENT: "production",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        requiredPorts.map(() => "kernel_plugin_port_missing"),
      );
      return true;
    },
  );
});

Deno.test("runtime config loader rejects production missing ports even when unsafe defaults are allowed", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_ENVIRONMENT: "production",
          TAKOSUMI_DEV_MODE: "1",
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        requiredPorts.map(() => "kernel_plugin_port_missing"),
      );
      return true;
    },
  );
});

Deno.test("runtime config loader allows production when every kernel port selects a non-reference plugin", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOS_ENVIRONMENT: "production",
      TAKOS_PUBLIC_ROUTES_ENABLED: "1",
      ...Object.fromEntries(
        requiredPorts.map((port) => [
          envKeyForPort(port),
          `takos.${port}.cloud`,
        ]),
      ),
    },
  });

  assert.equal(config.environment, "production");
  assert.equal(config.routes.publicRoutesEnabled, true);
  for (const port of requiredPorts) {
    assert.equal(config.plugins[port], `takos.${port}.cloud`);
  }
});

Deno.test("runtime config loader rejects reference/noop plugins in staging and production", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_ENVIRONMENT: "staging",
          ...Object.fromEntries(
            requiredPorts.map((port) => [
              envKeyForPort(port),
              port === "storage"
                ? "takos.kernel.reference"
                : `takos.${port}.cloud`,
            ]),
          ),
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["unsafe_kernel_plugin_selected"],
      );
      return true;
    },
  );
});

Deno.test("runtime config loader rejects reference plugins in staging even when unsafe defaults are allowed", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOS_ENVIRONMENT: "staging",
          TAKOSUMI_DEV_MODE: "1",
          ...Object.fromEntries(
            requiredPorts.map((port) => [
              envKeyForPort(port),
              port === "queue" ? "takos.queue.noop" : `takos.${port}.cloud`,
            ]),
          ),
        },
      }),
    (error) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["unsafe_kernel_plugin_selected"],
      );
      return true;
    },
  );
});

function envKeyForPort(port: KernelPluginPortKind): string {
  return `TAKOS_${port.toUpperCase().replaceAll("-", "_")}_PLUGIN`;
}
