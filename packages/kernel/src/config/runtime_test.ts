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
      TAKOSUMI_ENVIRONMENT: "development",
      TAKOSUMI_PROCESS_ROLE: "takosumi-worker",
      TAKOSUMI_KERNEL_PLUGIN_SELECTIONS: JSON.stringify({
        storage: "takos.storage.memory",
        provider: "takos.provider.test",
      }),
      TAKOSUMI_SOURCE_PLUGIN: "takos.source.manifest",
      TAKOSUMI_PUBLIC_ROUTES_ENABLED: "true",
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
      TAKOSUMI_PROCESS_ROLE: "takosumi-runtime-agent",
    },
  });

  assert.equal(config.processRole, "takosumi-runtime-agent");
});

Deno.test("runtime config loader rejects invalid process role", async () => {
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

Deno.test("runtime config loader reads operator-owned plugin config JSON", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOSUMI_KERNEL_PLUGIN_CONFIG: JSON.stringify({
        "external.self-hosted": {
          dataDir: "/var/lib/takosumi",
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
    "/var/lib/takosumi",
  );
});

Deno.test("runtime config loader rejects invalid plugin config JSON", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_KERNEL_PLUGIN_CONFIG: "[]",
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

Deno.test("runtime config loader accepts database URLs used by boot storage", async () => {
  const config = await loadRuntimeConfigFromEnv({
    env: {
      TAKOSUMI_DATABASE_URL: "postgresql://takos:takos@postgres:5432/takos",
      DATABASE_URL: "postgresql://fallback:fallback@postgres:5432/takos",
    },
  });

  assert.equal(config.environment, "local");
  assert.deepEqual(config.diagnostics, []);
});

Deno.test("runtime config loader rejects non-database generic backend URLs", async () => {
  await assert.rejects(
    () =>
      loadRuntimeConfigFromEnv({
        env: {
          TAKOSUMI_ENVIRONMENT: "local",
          TAKOSUMI_STORAGE_PLUGIN: "takos.kernel.reference",
          TAKOSUMI_PROVIDER_PLUGIN: "takos.kernel.reference",
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
          TAKOSUMI_ENVIRONMENT: "production",
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
          TAKOSUMI_ENVIRONMENT: "production",
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
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_PUBLIC_ROUTES_ENABLED: "1",
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
          TAKOSUMI_ENVIRONMENT: "staging",
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
          TAKOSUMI_ENVIRONMENT: "staging",
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
  return `TAKOSUMI_${port.toUpperCase().replaceAll("-", "_")}_PLUGIN`;
}
