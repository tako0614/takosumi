import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type TakosumiActorContext,
} from "takosumi-contract/reference/compat";
import { signTakosumiInternalRequest } from "takosumi-contract/internal/rpc";
import { readInternalAuth } from "./internal_auth.ts";
import { InMemoryReplayProtectionStore } from "../adapters/replay-protection/mod.ts";

const actor: TakosumiActorContext = {
  actorAccountId: "acct_internal",
  principalKind: "service",
  roles: ["owner"],
  requestId: "req_internal_auth_replay",
  serviceId: "svc_internal",
};

test("readInternalAuth rejects stale and replayed signed requests", async () => {
  const stale = await signedRequest({
    requestId: "req_internal_auth_stale",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  assert.deepEqual(
    await readInternalAuth(stale, {
      secret: "secret",
      clock: () => new Date("2026-04-27T00:06:00.000Z"),
    }),
    { ok: false, error: "invalid internal signature", status: 401 },
  );

  const fresh = await signedRequest({
    requestId: "req_internal_auth_fresh",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  const options = {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.000Z"),
  };
  assert.equal((await readInternalAuth(fresh.clone(), options)).ok, true);
  assert.deepEqual(
    await readInternalAuth(fresh.clone(), options),
    { ok: false, error: "replayed internal request", status: 401 },
  );
});

test("readInternalAuth verifies signatures against the query string", async () => {
  const signed = await signedRequest({
    requestId: "req_internal_auth_query",
    timestamp: "2026-04-27T00:00:00.000Z",
    query: "?spaceId=space_a",
  });
  const options = {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.000Z"),
  };
  const accepted = await readInternalAuth(signed, options);
  assert.equal(accepted.ok, true);

  const tampered = await signedRequest({
    requestId: "req_internal_auth_query_tamper",
    timestamp: "2026-04-27T00:00:00.000Z",
    query: "?spaceId=space_a",
    requestQuery: "?spaceId=space_b",
  });
  assert.deepEqual(await readInternalAuth(tampered, options), {
    ok: false,
    error: "invalid internal signature",
    status: 401,
  });
});

test("readInternalAuth replay store admits a fresh request once per process", async () => {
  const store = new InMemoryReplayProtectionStore();
  const signed = await signedRequest({
    requestId: "req_internal_auth_store",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  const accepted = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.000Z"),
    replayProtectionStore: store,
  });
  assert.equal(accepted.ok, true);

  const replayed = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.500Z"),
    replayProtectionStore: store,
  });
  assert.deepEqual(replayed, {
    ok: false,
    error: "replayed internal request",
    status: 401,
  });
});

async function signedRequest(input: {
  readonly requestId: string;
  readonly timestamp: string;
  readonly query?: string;
  readonly requestQuery?: string;
}): Promise<Request> {
  const body = JSON.stringify({ ok: true });
  const path = "/internal/v1/test";
  const signed = await signTakosumiInternalRequest({
    method: "POST",
    path,
    query: input.query,
    body,
    timestamp: input.timestamp,
    secret: "secret",
    caller: "svc_internal",
    audience: "takosumi",
    actor: { ...actor, requestId: input.requestId },
  });
  return new Request(
    `https://takosumi.test${path}${input.requestQuery ?? input.query ?? ""}`,
    {
      method: "POST",
      headers: signed.headers,
      body,
    },
  );
}
