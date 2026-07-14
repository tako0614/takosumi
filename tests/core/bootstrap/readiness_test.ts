import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInMemoryAppContext } from "../../../core/app_context.ts";
import { createRoleReadinessProbes } from "../../../core/bootstrap/readiness.ts";

test("API readiness checks the real service prerequisites without a fake worker task", async () => {
  const probes = createRoleReadinessProbes({
    role: "takosumi-api",
    context: createInMemoryAppContext(),
    runtimeConfig: { processRole: "takosumi-api" },
    runtimeEnv: {},
  });

  const ready = await probes.ready();

  assert.equal(ready.ok, false);
  assert.equal(ready.state, "not-ready");
  assert.match(
    String(ready.reason),
    /internalApiSecret: TAKOSUMI_INTERNAL_API_SECRET is required/,
  );
  assert.equal((ready.checks as Record<string, unknown>).observability, "configured");
});
