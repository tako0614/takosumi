import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CoreBindingResolutionInput } from "takosumi-contract/reference/compat";
import { structureDigest } from "./_binding_resolution.ts";

const baseInput: CoreBindingResolutionInput = {
  bindingName: "claims.db",
  source: "resource",
  sourceAddress: "resource:resource_db",
  injection: { mode: "runtime-binding", target: "claims.db" },
  sensitivity: "credential",
  enforcement: "required",
};

test("structureDigest emits sha256-prefixed hex through the shared digest helper", async () => {
  const digest = await structureDigest([baseInput]);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    digest,
    "sha256:8d883dca2392d9b9c8e10a7c5db3f549ca3c279250fb84ec3d0076e52cc7be17",
  );
});

test("structureDigest omits undefined-valued optional fields", async () => {
  // The local normalization intentionally drops undefined-valued keys so an
  // absent optional `access` ref does not change the persisted digest. This
  // diverges from the canonical stableStringify, so the normalization stays
  // local while only the hashing routes through the shared digest helper.
  const withUndefinedAccess: CoreBindingResolutionInput = {
    ...baseInput,
    access: undefined,
  };
  assert.equal(
    await structureDigest([withUndefinedAccess]),
    await structureDigest([baseInput]),
  );
});
