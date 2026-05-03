import assert from "node:assert/strict";
import {
  getShape,
  isShapeRegistered,
  unregisterShape,
} from "takosumi-contract";
import {
  registerTakosumiShapes,
  TAKOSUMI_BUNDLED_SHAPES,
} from "../src/shapes/mod.ts";

Deno.test("registerTakosumiShapes registers all bundled shapes", () => {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) {
    unregisterShape(shape.id, shape.version);
  }
  try {
    registerTakosumiShapes();
    for (const shape of TAKOSUMI_BUNDLED_SHAPES) {
      assert.equal(
        isShapeRegistered(shape.id, shape.version),
        true,
        `${shape.id}@${shape.version} should be registered`,
      );
      assert.equal(getShape(shape.id, shape.version), shape);
    }
  } finally {
    for (const shape of TAKOSUMI_BUNDLED_SHAPES) {
      unregisterShape(shape.id, shape.version);
    }
  }
});

Deno.test("TAKOSUMI_BUNDLED_SHAPES exposes the expected initial set", () => {
  const ids = TAKOSUMI_BUNDLED_SHAPES.map((s) => `${s.id}@${s.version}`).sort();
  assert.deepEqual(ids, [
    "custom-domain@v1",
    "database-postgres@v1",
    "object-store@v1",
    "web-service@v1",
    "worker@v1",
  ]);
});
