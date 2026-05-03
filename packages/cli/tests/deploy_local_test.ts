import assert from "node:assert/strict";
import { applyLocal } from "../src/local_runner.ts";

Deno.test("applyLocal materializes a single object-store resource", async () => {
  const outcome = await applyLocal([
    {
      shape: "object-store@v1",
      name: "smoke-bucket",
      provider: "@takos/selfhost-filesystem",
      spec: { name: "smoke-bucket" },
    },
  ]);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].name, "smoke-bucket");
  assert.equal(outcome.applied[0].providerId, "@takos/selfhost-filesystem");
});

Deno.test("applyLocal threads ${ref:...} between resources", async () => {
  const outcome = await applyLocal([
    {
      shape: "object-store@v1",
      name: "primary",
      provider: "@takos/selfhost-filesystem",
      spec: { name: "primary" },
    },
    {
      shape: "object-store@v1",
      name: "mirror",
      provider: "@takos/selfhost-filesystem",
      spec: {
        name: "mirror",
        region: "${ref:primary.region}",
      },
    },
  ]);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.applied.length, 2);
});
