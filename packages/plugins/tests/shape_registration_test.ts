import assert from "node:assert/strict";
import {
  getShape,
  isShapeRegistered,
  unregisterShape,
} from "takosumi-contract";
import {
  registerTakosumiReferenceKinds,
  TAKOSUMI_REFERENCE_KINDS,
} from "../src/kinds/mod.ts";

Deno.test("registerTakosumiReferenceKinds registers all reference shapes", () => {
  for (const shape of TAKOSUMI_REFERENCE_KINDS) {
    unregisterShape(shape.id, shape.version);
  }
  try {
    registerTakosumiReferenceKinds();
    for (const shape of TAKOSUMI_REFERENCE_KINDS) {
      assert.equal(
        isShapeRegistered(shape.id, shape.version),
        true,
        `${shape.id}@${shape.version} should be registered`,
      );
      assert.equal(getShape(shape.id, shape.version), shape);
    }
  } finally {
    for (const shape of TAKOSUMI_REFERENCE_KINDS) {
      unregisterShape(shape.id, shape.version);
    }
  }
});

Deno.test("TAKOSUMI_REFERENCE_KINDS exposes the external reference kind set", () => {
  const ids = TAKOSUMI_REFERENCE_KINDS.map((s) => `${s.id}@${s.version}`)
    .sort();
  assert.deepEqual(ids, [
    "custom-domain@v1",
    "database-postgres@v1",
    "object-store@v1",
    "web-service@v1",
    "worker@v1",
  ]);
});
