import assert from "node:assert/strict";
import {
  EnvOperatorConfig,
  LocalOperatorConfig,
} from "../../adapters/operator-config/mod.ts";
import { LocalActorAdapter } from "../../adapters/auth/mod.ts";
import { NoopProviderMaterializer } from "../../adapters/provider/mod.ts";
import { StandaloneBootstrapService } from "./mod.ts";

const fixedClock = () => new Date("2026-04-27T00:00:00.000Z");

Deno.test("standalone bootstrap selects explicit local adapters and redacts config", async () => {
  const config = new LocalOperatorConfig({
    clock: fixedClock,
    values: {
      TAKOSUMI_ENVIRONMENT: "local",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "local",
      TAKOSUMI_BOOTSTRAP_SOURCE_ADAPTER: "manifest",
      TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER: "memory",
      TAKOSUMI_BOOTSTRAP_PROVIDER_ADAPTER: "noop",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_INTERNAL_API_SECRET: "super-secret",
      DATABASE_SECRET_REF: { name: "DATABASE_URL", version: "v1" },
    },
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.selectedAdapters.map(({ family, kind, defaulted }) => ({
      family,
      kind,
      defaulted,
    })),
    [
      { family: "auth", kind: "local", defaulted: false },
      { family: "source", kind: "manifest", defaulted: false },
      { family: "secret", kind: "memory", defaulted: false },
      { family: "provider", kind: "noop", defaulted: false },
      { family: "observability", kind: "memory", defaulted: true },
    ],
  );
  assert.ok(report.adapters.auth instanceof LocalActorAdapter);
  assert.ok(report.adapters.provider instanceof NoopProviderMaterializer);
  assert.equal(
    report.config.values.find((value) =>
      value.key === "TAKOSUMI_INTERNAL_API_SECRET"
    )?.value,
    "[REDACTED]",
  );
  const serviceSecretSnapshotValue = report.operatorConfigSnapshot.values.find((
    value,
  ) => value.key === "TAKOSUMI_INTERNAL_API_SECRET");
  assert.equal(serviceSecretSnapshotValue?.kind, "plain");
  assert.equal(
    serviceSecretSnapshotValue.kind === "plain"
      ? serviceSecretSnapshotValue.value
      : undefined,
    "[REDACTED]",
  );
  const environmentSnapshotValue = report.operatorConfigSnapshot.values.find((
    value,
  ) => value.key === "TAKOSUMI_ENVIRONMENT");
  assert.equal(environmentSnapshotValue?.kind, "plain");
  assert.equal(
    environmentSnapshotValue.kind === "plain"
      ? environmentSnapshotValue.value
      : undefined,
    "local",
  );
  assert.deepEqual(
    report.config.values.find((value) => value.key === "DATABASE_SECRET_REF"),
    {
      key: "DATABASE_SECRET_REF",
      source: "local",
      kind: "secret-ref",
      ref: { name: "DATABASE_URL", version: "v1" },
      redacted: true,
    },
  );
});

Deno.test("standalone bootstrap reports unsafe default adapters in production", async () => {
  const config = new EnvOperatorConfig({
    clock: fixedClock,
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_INTERNAL_API_SECRET: "replace-me",
    },
    include: ["TAKOSUMI_ENVIRONMENT", "TAKOSUMI_INTERNAL_API_SECRET"],
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.warnings.some((warning) =>
      warning.code === "adapter_selector_defaulted"
    ),
  );
  assert.ok(
    report.errors.some((error) =>
      error.code === "production_provider_bootstrap_forbidden" &&
      error.message.includes("noop")
    ),
  );
  assert.ok(
    report.errors.some((error) =>
      error.code === "unsafe_secret_value" &&
      error.key === "TAKOSUMI_INTERNAL_API_SECRET"
    ),
  );
});

Deno.test("standalone bootstrap keeps legacy internal service secret alias for service auth", async () => {
  const config = new LocalOperatorConfig({
    clock: fixedClock,
    values: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "service",
      TAKOSUMI_INTERNAL_SERVICE_SECRET: "legacy-service-secret-value",
    },
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.ok(
    !report.errors.some((error) =>
      error.code === "auth_service_secret_missing"
    ),
    `unexpected auth_service_secret_missing: ${JSON.stringify(report.errors)}`,
  );
});

Deno.test("standalone bootstrap reports the primary internal API secret name", async () => {
  const config = new LocalOperatorConfig({
    clock: fixedClock,
    values: {
      TAKOSUMI_ENVIRONMENT: "local",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "service",
    },
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.ok(
    report.errors.some((error) =>
      error.code === "auth_service_secret_missing" &&
      error.key === "TAKOSUMI_INTERNAL_API_SECRET"
    ),
  );
});

Deno.test("standalone bootstrap rejects production local Docker provider", async () => {
  const report = await new StandaloneBootstrapService({
    operatorConfig: new EnvOperatorConfig({
      clock: fixedClock,
      env: {
        TAKOSUMI_ENVIRONMENT: "production",
        TAKOSUMI_BOOTSTRAP_PROVIDER_ADAPTER: "local-docker",
      },
      include: ["TAKOSUMI_ENVIRONMENT", "TAKOSUMI_BOOTSTRAP_PROVIDER_ADAPTER"],
    }),
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) =>
      error.code === "unsupported_adapter" &&
      error.message.includes("local-docker")
    ),
  );
});

Deno.test("standalone bootstrap does not downgrade production unsafe adapters with unsafe flag", async () => {
  const report = await new StandaloneBootstrapService({
    operatorConfig: new EnvOperatorConfig({
      clock: fixedClock,
      env: {
        TAKOSUMI_ENVIRONMENT: "production",
        TAKOSUMI_DEV_MODE: "1",
      },
      include: ["TAKOSUMI_ENVIRONMENT", "TAKOSUMI_DEV_MODE"],
    }),
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.code === "unsafe_adapter_selected"),
  );
});

Deno.test("standalone bootstrap rejects production memory secret store without encryption key", async () => {
  const config = new EnvOperatorConfig({
    clock: fixedClock,
    env: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER: "memory",
    },
    include: ["TAKOSUMI_ENVIRONMENT", "TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER"],
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) =>
      error.code === "secret_store_encryption_key_missing" &&
      /production/.test(error.message) &&
      /TAKOSUMI_SECRET_STORE_PASSPHRASE/.test(error.message)
    ),
  );
});

Deno.test("standalone bootstrap accepts memory secret store when production key supplied", async () => {
  const config = new LocalOperatorConfig({
    clock: fixedClock,
    values: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "service",
      TAKOSUMI_BOOTSTRAP_SECRET_ADAPTER: "memory",
      TAKOSUMI_BOOTSTRAP_SOURCE_ADAPTER: "manifest",
      TAKOSUMI_INTERNAL_API_SECRET: "production-service-secret-value",
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "production-secret-passphrase-32-byte",
    },
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    clock: fixedClock,
  }).bootstrap();

  assert.ok(
    !report.errors.some((error) =>
      error.code === "secret_store_encryption_key_missing"
    ),
    `unexpected secret_store_encryption_key_missing: ${
      JSON.stringify(report.errors)
    }`,
  );
});

Deno.test("standalone bootstrap rejects removed adapter selectors", async () => {
  const report = await new StandaloneBootstrapService({
    operatorConfig: new EnvOperatorConfig({
      clock: fixedClock,
      env: {
        TAKOSUMI_ENVIRONMENT: "staging",
        TAKOSUMI_PROVIDER_ADAPTER: "local-docker",
      },
      include: ["TAKOSUMI_ENVIRONMENT", "TAKOSUMI_PROVIDER_ADAPTER"],
    }),
    clock: fixedClock,
  }).bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) =>
      error.code === "stale_bootstrap_selector" &&
      error.key === "TAKOSUMI_PROVIDER_ADAPTER"
    ),
  );
});
