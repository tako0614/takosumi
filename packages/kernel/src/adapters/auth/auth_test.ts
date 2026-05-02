import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract";
import { LocalActorAdapter, ServiceActorAuthAdapter } from "./mod.ts";

Deno.test("local actor adapter returns configured actor", async () => {
  const actor = actorContext("acct_local", "req_local");
  const adapter = new LocalActorAdapter({ actor });

  const result = await adapter.authenticate(
    new Request("http://localhost/test"),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("auth failed");
  assert.equal(result.actor.actorAccountId, "acct_local");
});

Deno.test("service actor adapter verifies signed internal request", async () => {
  const actor = actorContext("acct_service", "req_service");
  const adapter = new ServiceActorAuthAdapter({
    secret: "test-secret",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const body = JSON.stringify({ ok: true });
  const headers = await adapter.signRequest({
    method: "POST",
    path: "/internal/test",
    body,
    actor,
  });

  const result = await adapter.authenticate(
    new Request("http://localhost/internal/test", {
      method: "POST",
      headers,
      body,
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("auth failed");
  assert.equal(result.actor.requestId, "req_service");
});

Deno.test("service actor adapter binds signed requests to the query string", async () => {
  const actor = actorContext("acct_service", "req_service_query");
  const adapter = new ServiceActorAuthAdapter({
    secret: "test-secret",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const body = JSON.stringify({ ok: true });
  const headers = await adapter.signRequest({
    method: "POST",
    path: "/internal/test",
    query: "?spaceId=space_a",
    body,
    actor,
  });

  const accepted = await adapter.authenticate(
    new Request("http://localhost/internal/test?spaceId=space_a", {
      method: "POST",
      headers,
      body,
    }),
  );
  assert.equal(accepted.ok, true);

  const rejected = await adapter.authenticate(
    new Request("http://localhost/internal/test?spaceId=space_b", {
      method: "POST",
      headers,
      body,
    }),
  );
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error("auth unexpectedly succeeded");
  assert.equal(rejected.error, "invalid internal signature");
});

function actorContext(
  actorAccountId: string,
  requestId: string,
): TakosumiActorContext {
  return { actorAccountId, requestId, roles: ["owner"] };
}
