import assert from "node:assert/strict";
import { loadKernelPluginsFromEnv } from "./loader.ts";

Deno.test("kernel plugin loader ignores module env unless reference loader is enabled", async () => {
  const plugins = await loadKernelPluginsFromEnv({
    TAKOSUMI_KERNEL_PLUGIN_MODULES: "file:///tmp/not-loaded.ts",
  });

  assert.deepEqual(plugins, []);
});

Deno.test("kernel plugin loader imports operator-provided modules when reference loader is enabled", async () => {
  const dir = await Deno.makeTempDir();
  const modulePath = `${dir}/plugin.ts`;
  await Deno.writeTextFile(
    modulePath,
    `
      export default {
        manifest: {
          id: "takos.test.loaded",
          name: "Loaded Test Plugin",
          version: "1.0.0",
          kernelApiVersion: "2026-04-29",
          capabilities: [],
        },
        createAdapters() {
          return {};
        },
      };
    `,
  );

  const plugins = await loadKernelPluginsFromEnv({
    TAKOSUMI_KERNEL_PLUGIN_MODULES: new URL(`file://${modulePath}`).href,
    TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES: "1",
  });

  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.id),
    ["takos.test.loaded"],
  );
});

Deno.test("kernel plugin loader rejects dynamic module loading in staging", async () => {
  await assert.rejects(
    () =>
      loadKernelPluginsFromEnv({
        TAKOSUMI_ENVIRONMENT: "staging",
        TAKOSUMI_KERNEL_PLUGIN_MODULES: "file:///tmp/not-loaded.ts",
        TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES: "1",
      }),
    /staging cannot use reference dynamic kernel plugin module loading/,
  );
});

Deno.test("kernel plugin loader rejects dynamic module loading in production", async () => {
  await assert.rejects(
    () =>
      loadKernelPluginsFromEnv({
        TAKOSUMI_ENVIRONMENT: "production",
        TAKOSUMI_KERNEL_PLUGIN_MODULES: "file:///tmp/not-loaded.ts",
        TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES: "1",
      }),
    /production cannot use reference dynamic kernel plugin module loading/,
  );
});

Deno.test("kernel plugin loader treats prod and stage aliases as strict environments", async () => {
  await assert.rejects(
    () =>
      loadKernelPluginsFromEnv({
        TAKOSUMI_ENVIRONMENT: "prod",
        TAKOSUMI_KERNEL_PLUGIN_MODULES: "file:///tmp/not-loaded.ts",
        TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES: "1",
      }),
    /production cannot use reference dynamic kernel plugin module loading/,
  );
  await assert.rejects(
    () =>
      loadKernelPluginsFromEnv({
        TAKOSUMI_ENVIRONMENT: "stage",
        TAKOSUMI_KERNEL_PLUGIN_MODULES: "file:///tmp/not-loaded.ts",
        TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES: "1",
      }),
    /staging cannot use reference dynamic kernel plugin module loading/,
  );
});
