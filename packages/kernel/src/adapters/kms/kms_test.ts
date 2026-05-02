import assert from "node:assert/strict";
import { NoopTestKms } from "./mod.ts";

const fixedDate = new Date("2026-04-27T00:00:00.000Z");

Deno.test("no-op test KMS preserves the KmsPort envelope contract", async () => {
  const kms = new NoopTestKms({
    clock: () => fixedDate,
    idGenerator: () => "noop",
  });
  const envelope = await kms.encrypt({ plaintext: "test secret" });

  assert.equal(envelope.version, "takos.kms.envelope.v1");
  assert.equal(envelope.algorithm, "TEST-NOOP");
  assert.equal(envelope.keyRef.provider, "test-noop");
  assert.equal(
    new TextDecoder().decode(await kms.decrypt({ envelope })),
    "test secret",
  );
});
