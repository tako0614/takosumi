import assert from "node:assert/strict";
import {
  getShape,
  isShapeRegistered,
  unregisterShape,
} from "takosumi-contract";
import {
  registerTakosumiKinds,
  TAKOSUMI_BUNDLED_KINDS,
} from "../src/kinds/mod.ts";

Deno.test("registerTakosumiKinds registers all bundled shapes", () => {
  for (const shape of TAKOSUMI_BUNDLED_KINDS) {
    unregisterShape(shape.id, shape.version);
  }
  try {
    registerTakosumiKinds();
    for (const shape of TAKOSUMI_BUNDLED_KINDS) {
      assert.equal(
        isShapeRegistered(shape.id, shape.version),
        true,
        `${shape.id}@${shape.version} should be registered`,
      );
      assert.equal(getShape(shape.id, shape.version), shape);
    }
  } finally {
    for (const shape of TAKOSUMI_BUNDLED_KINDS) {
      unregisterShape(shape.id, shape.version);
    }
  }
});

Deno.test("TAKOSUMI_BUNDLED_KINDS exposes the expected initial set", () => {
  const ids = TAKOSUMI_BUNDLED_KINDS.map((s) => `${s.id}@${s.version}`).sort();
  assert.deepEqual(ids, [
    "custom-domain@v1",
    "database-postgres@v1",
    "object-store@v1",
    "oidc@v1",
    "web-service@v1",
    "worker@v1",
  ]);
});
