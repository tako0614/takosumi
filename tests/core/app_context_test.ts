import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createAppContext,
  createConfiguredAppContext,
  createInMemoryAppContext,
} from "../../core/app_context.ts";
import {
  InMemoryObservabilitySink,
  OtlpObservabilitySink,
} from "../../core/domains/observability/mod.ts";

test("createInMemoryAppContext wires only cross-cutting observability", () => {
  const context = createInMemoryAppContext();

  assert.ok(context.adapters.observability instanceof InMemoryObservabilitySink);
  assert.deepEqual(Object.keys(context.adapters), ["observability"]);
  assert.deepEqual(Object.keys(context), ["adapters"]);
});

test("createConfiguredAppContext returns local adapters in development", async () => {
  const context = await createConfiguredAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });

  assert.ok(context.adapters.observability instanceof InMemoryObservabilitySink);
});

test("createAppContext uses explicitly injected production adapters", async () => {
  const observability = new InMemoryObservabilitySink();
  const context = await createAppContext({
    adapters: { observability },
    runtimeConfig: { environment: "production" },
  });

  assert.equal(context.adapters.observability, observability);
});

test("createAppContext rejects production runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "production" },
      }),
    /production runtime requires an explicit/,
  );
});

test("createAppContext rejects staging runtime without explicit adapters", async () => {
  await assert.rejects(
    () =>
      createAppContext({
        runtimeConfig: { environment: "staging" },
      }),
    /staging runtime requires an explicit/,
  );
});

test("createInMemoryAppContext wraps observability with OTLP metrics exporter", () => {
  const context = createInMemoryAppContext({
    runtimeEnv: {
      TAKOSUMI_OTLP_METRICS_ENDPOINT: "http://collector.local/v1/metrics",
      TAKOSUMI_DEV_MODE: "1",
    },
  });

  assert.ok(context.adapters.observability instanceof OtlpObservabilitySink);
});
