import assert from "node:assert/strict";
import {
  getArtifactKind,
  isArtifactKindRegistered,
  listArtifactKinds,
  registerArtifactKind,
  type RegisteredArtifactKind,
  unregisterArtifactKind,
} from "./runtime-agent-lifecycle.ts";

const SAMPLE: RegisteredArtifactKind = {
  kind: "test-kind-basic",
  description: "test fixture",
  contentTypeHint: "application/x-test",
};

Deno.test("registerArtifactKind stores and getArtifactKind retrieves", () => {
  try {
    assert.equal(registerArtifactKind(SAMPLE), undefined);
    assert.equal(isArtifactKindRegistered("test-kind-basic"), true);
    assert.deepEqual(getArtifactKind("test-kind-basic"), SAMPLE);
    assert.ok(listArtifactKinds().some((k) => k.kind === "test-kind-basic"));
  } finally {
    unregisterArtifactKind("test-kind-basic");
  }
});

Deno.test("unregisterArtifactKind returns true on hit and false on miss", () => {
  registerArtifactKind({ kind: "test-kind-unreg", description: "x" });
  assert.equal(unregisterArtifactKind("test-kind-unreg"), true);
  assert.equal(unregisterArtifactKind("test-kind-unreg"), false);
  assert.equal(isArtifactKindRegistered("test-kind-unreg"), false);
});

Deno.test(
  "registerArtifactKind warns on differing-value collision",
  () => {
    const first: RegisteredArtifactKind = {
      kind: "test-kind-warn",
      description: "first description",
    };
    const second: RegisteredArtifactKind = {
      kind: "test-kind-warn",
      description: "second description",
    };
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));
    try {
      registerArtifactKind(first);
      registerArtifactKind(second);
      assert.equal(captured.length, 1);
      assert.match(
        captured[0],
        /artifact kind "test-kind-warn" overwritten/,
      );
    } finally {
      console.warn = original;
      unregisterArtifactKind("test-kind-warn");
    }
  },
);

Deno.test(
  "registerArtifactKind stays silent for structurally-identical re-registration",
  () => {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));
    try {
      registerArtifactKind({
        kind: "test-kind-idempotent",
        description: "same",
        contentTypeHint: "application/x-test",
      });
      // Different object identity but identical metadata: no warning.
      registerArtifactKind({
        kind: "test-kind-idempotent",
        description: "same",
        contentTypeHint: "application/x-test",
      });
      assert.equal(captured.length, 0);
    } finally {
      console.warn = original;
      unregisterArtifactKind("test-kind-idempotent");
    }
  },
);

Deno.test(
  "registerArtifactKind with allowOverride suppresses the warning",
  () => {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));
    try {
      registerArtifactKind({
        kind: "test-kind-allow",
        description: "first",
      });
      registerArtifactKind(
        { kind: "test-kind-allow", description: "second" },
        { allowOverride: true },
      );
      assert.equal(captured.length, 0);
    } finally {
      console.warn = original;
      unregisterArtifactKind("test-kind-allow");
    }
  },
);
