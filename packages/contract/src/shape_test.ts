import assert from "node:assert/strict";
import {
  formatShapeRef,
  getShape,
  getShapeByRef,
  isShapeRegistered,
  listShapes,
  parseShapeRef,
  registerShape,
  type Shape,
  type ShapeValidationIssue,
  unregisterShape,
} from "./shape.ts";

function fakeShape(id: string, version = "v1"): Shape {
  return {
    id,
    version,
    capabilities: ["a", "b"],
    outputFields: ["url"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "spec must be object" });
      }
    },
    validateOutputs(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "outputs must be object" });
      }
    },
  };
}

Deno.test("parseShapeRef parses valid id@version", () => {
  assert.deepEqual(parseShapeRef("web-service@v1"), {
    id: "web-service",
    version: "v1",
  });
  assert.deepEqual(parseShapeRef("database.postgres@v2"), {
    id: "database.postgres",
    version: "v2",
  });
});

Deno.test("parseShapeRef rejects malformed input", () => {
  assert.equal(parseShapeRef(""), undefined);
  assert.equal(parseShapeRef("no-version"), undefined);
  assert.equal(parseShapeRef("@v1"), undefined);
  assert.equal(parseShapeRef("id@"), undefined);
});

Deno.test("formatShapeRef round-trips with parseShapeRef", () => {
  const ref = formatShapeRef("web-service", "v1");
  assert.equal(ref, "web-service@v1");
  assert.deepEqual(parseShapeRef(ref), { id: "web-service", version: "v1" });
});

Deno.test("registerShape stores and listShapes returns registered shapes", () => {
  const shape = fakeShape("test-shape-list");
  try {
    assert.equal(registerShape(shape), undefined);
    assert.equal(isShapeRegistered("test-shape-list", "v1"), true);
    assert.equal(getShape("test-shape-list", "v1"), shape);
    assert.equal(getShapeByRef("test-shape-list@v1"), shape);
    assert.ok(listShapes().includes(shape));
  } finally {
    unregisterShape("test-shape-list", "v1");
  }
});

Deno.test("registerShape returns previous on replace", () => {
  const first = fakeShape("test-shape-replace");
  const second = fakeShape("test-shape-replace");
  try {
    registerShape(first);
    assert.equal(registerShape(second, { allowOverride: true }), first);
    assert.equal(getShape("test-shape-replace", "v1"), second);
  } finally {
    unregisterShape("test-shape-replace", "v1");
  }
});

Deno.test("unregisterShape returns true on hit, false on miss", () => {
  const shape = fakeShape("test-shape-unreg");
  registerShape(shape);
  assert.equal(unregisterShape("test-shape-unreg", "v1"), true);
  assert.equal(unregisterShape("test-shape-unreg", "v1"), false);
  assert.equal(isShapeRegistered("test-shape-unreg", "v1"), false);
});

Deno.test("shape versions are independent registry entries", () => {
  const v1 = fakeShape("test-shape-versions", "v1");
  const v2 = fakeShape("test-shape-versions", "v2");
  try {
    registerShape(v1);
    registerShape(v2);
    assert.equal(getShape("test-shape-versions", "v1"), v1);
    assert.equal(getShape("test-shape-versions", "v2"), v2);
  } finally {
    unregisterShape("test-shape-versions", "v1");
    unregisterShape("test-shape-versions", "v2");
  }
});

Deno.test("registerShape warns on differing-value collision", () => {
  const first = fakeShape("test-shape-warn");
  const second = fakeShape("test-shape-warn");
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    registerShape(first);
    registerShape(second); // different reference -> must warn
    assert.equal(captured.length, 1);
    assert.match(captured[0], /shape "test-shape-warn@v1" overwritten/);
  } finally {
    console.warn = original;
    unregisterShape("test-shape-warn", "v1");
  }
});

Deno.test("registerShape with allowOverride suppresses the warning", () => {
  const first = fakeShape("test-shape-allow");
  const second = fakeShape("test-shape-allow");
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    registerShape(first);
    registerShape(second, { allowOverride: true });
    assert.equal(captured.length, 0);
  } finally {
    console.warn = original;
    unregisterShape("test-shape-allow", "v1");
  }
});

Deno.test("validateSpec / validateOutputs accumulate issues", () => {
  const shape = fakeShape("test-shape-validate");
  const specIssues: ShapeValidationIssue[] = [];
  shape.validateSpec("not-an-object", specIssues);
  assert.equal(specIssues.length, 1);
  assert.equal(specIssues[0].message, "spec must be object");

  const outputIssues: ShapeValidationIssue[] = [];
  shape.validateOutputs(null, outputIssues);
  assert.equal(outputIssues.length, 1);
});
