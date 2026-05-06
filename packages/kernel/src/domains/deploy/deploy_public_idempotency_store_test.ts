import assert from "node:assert/strict";
import { InMemoryDeployPublicIdempotencyStore } from "./deploy_public_idempotency_store.ts";

Deno.test("InMemoryDeployPublicIdempotencyStore keys tenant and idempotency key as a tuple", async () => {
  const store = new InMemoryDeployPublicIdempotencyStore();
  const first = await store.save({
    tenantId: "tenant a",
    key: "key",
    requestDigest: "sha256:first",
    responseStatus: 200,
    responseBody: { status: "first" },
    now: "2026-05-02T00:00:00.000Z",
  });
  const second = await store.save({
    tenantId: "tenant",
    key: "a key",
    requestDigest: "sha256:second",
    responseStatus: 200,
    responseBody: { status: "second" },
    now: "2026-05-02T00:00:01.000Z",
  });

  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    await store.get("tenant a", "key"),
    first,
  );
  assert.deepEqual(
    await store.get("tenant", "a key"),
    second,
  );
});
