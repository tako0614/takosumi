import assert from "node:assert/strict";
import { LocalOperatorConfig } from "../../adapters/operator-config/mod.ts";
import { BootstrapMigrationService } from "./mod.ts";

const fixedClock = () => new Date("2026-04-27T00:00:00.000Z");

Deno.test("BootstrapMigrationService treats storage migrations as plugin-owned", async () => {
  const report = await new BootstrapMigrationService({
    operatorConfig: new LocalOperatorConfig({
      clock: fixedClock,
      values: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_STORAGE_PLUGIN: "takos.storage.test",
      },
    }),
    clock: fixedClock,
  }).run();

  assert.equal(report.ok, true);
  assert.equal(report.storageBackend, "plugin");
  assert.equal(report.skipped, true);
  assert.equal(report.skipReason, "plugin-owned");
  assert.equal(report.migrations, undefined);
});

Deno.test("BootstrapMigrationService reports hard-break stale selector errors", async () => {
  const report = await new BootstrapMigrationService({
    operatorConfig: new LocalOperatorConfig({
      clock: fixedClock,
      values: {
        TAKOSUMI_ENVIRONMENT: "production",
        TAKOSUMI_STORAGE_BACKEND: "memory",
      },
    }),
    clock: fixedClock,
  }).run();

  assert.equal(report.ok, false);
  assert.equal(report.runtimeConfig, undefined);
  assert.ok(
    report.diagnostics.some((diagnostic) =>
      diagnostic.code === "stale_runtime_selector"
    ),
  );
});
