import assert from "node:assert/strict";
import {
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  type TakosActorContext,
} from "takosumi-contract";
import { signTakosInternalRequest } from "takosumi-contract/internal-rpc";
import {
  readInternalAuth,
  SignatureVerificationError,
  signInternalResponse,
  verifyInternalResponse,
} from "./internal_auth.ts";
import {
  InMemoryReplayProtectionStore,
  SqlReplayProtectionStore,
} from "../adapters/replay-protection/mod.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../adapters/storage/sql.ts";

const actor: TakosActorContext = {
  actorAccountId: "acct_internal",
  principalKind: "service",
  roles: ["owner"],
  requestId: "req_internal_auth_replay",
  serviceId: "svc_internal",
};

Deno.test("readInternalAuth rejects stale and replayed signed requests", async () => {
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

Deno.test("readInternalAuth verifies signatures against the query string", async () => {
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

Deno.test("verifyInternalResponse accepts a valid Worker -> kernel response", async () => {
  const body = '{"deployment":"dep_pass","status":"applied"}';
  const signed = await signedResponse({
    body,
    status: 201,
    requestId: "req_resp_valid",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const verified = await verifyInternalResponse(signed, {
    secret: "shared",
    method: "POST",
    path: "/api/internal/v1/deploy/applies",
    expectedRequestId: "req_resp_valid",
    clock: () => new Date("2026-04-30T00:00:30.000Z"),
  });
  assert.equal(verified.body, body);
});

Deno.test("verifyInternalResponse rejects tampered response body", async () => {
  const body = '{"deployment":"dep_tamper","status":"applied"}';
  const signed = await signedResponse({
    body,
    status: 201,
    requestId: "req_resp_tamper",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const tamperedBody = body.replace("applied", "rolled-back");
  const tampered = new Response(tamperedBody, {
    status: signed.status,
    headers: signed.headers,
  });
  await assert.rejects(
    () =>
      verifyInternalResponse(tampered, {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        expectedRequestId: "req_resp_tamper",
        clock: () => new Date("2026-04-30T00:00:30.000Z"),
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "signature mismatch",
  );
});

Deno.test("verifyInternalResponse rejects responses missing the signature header", async () => {
  const body = '{"deployment":"dep_missing"}';
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_missing",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const headers = new Headers(signed.headers);
  headers.delete(TAKOS_INTERNAL_SIGNATURE_HEADER);
  const stripped = new Response(body, { status: signed.status, headers });
  await assert.rejects(
    () =>
      verifyInternalResponse(stripped, {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        clock: () => new Date("2026-04-30T00:00:30.000Z"),
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "missing signature header",
  );
});

Deno.test("verifyInternalResponse rejects expired timestamp", async () => {
  const body = '{"deployment":"dep_stale"}';
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_stale",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      verifyInternalResponse(signed, {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        clock: () => new Date("2026-04-30T00:06:00.000Z"),
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "expired timestamp",
  );
});

Deno.test("verifyInternalResponse rejects replayed responses", async () => {
  const body = '{"deployment":"dep_replay"}';
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_replay",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const options = {
    secret: "shared",
    method: "POST",
    path: "/api/internal/v1/deploy/applies",
    clock: () => new Date("2026-04-30T00:00:30.000Z"),
  };
  const verified = await verifyInternalResponse(signed.clone(), options);
  assert.equal(verified.body, body);
  await assert.rejects(
    () => verifyInternalResponse(signed.clone(), options),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "replayed response",
  );
});

Deno.test("verifyInternalResponse rejects mismatched request id", async () => {
  const body = '{"deployment":"dep_mismatch"}';
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_actual",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      verifyInternalResponse(signed, {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        expectedRequestId: "req_resp_other",
        clock: () => new Date("2026-04-30T00:00:30.000Z"),
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "request id mismatch",
  );
});

Deno.test("signInternalResponse + verifyInternalResponse fail-closed on missing timestamp", async () => {
  const body = "{}";
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_no_ts",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const headers = new Headers(signed.headers);
  headers.delete(TAKOS_INTERNAL_TIMESTAMP_HEADER);
  const stripped = new Response(body, { status: signed.status, headers });
  await assert.rejects(
    () =>
      verifyInternalResponse(stripped, {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        clock: () => new Date("2026-04-30T00:00:30.000Z"),
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "missing timestamp header",
  );
});

async function signedResponse(input: {
  readonly body: string;
  readonly status: number;
  readonly requestId: string;
  readonly timestamp: string;
}): Promise<Response> {
  const headers = await signInternalResponse({
    secret: "shared",
    method: "POST",
    path: "/api/internal/v1/deploy/applies",
    status: input.status,
    body: input.body,
    requestId: input.requestId,
    clock: () => new Date(input.timestamp),
  });
  return new Response(input.body, { status: input.status, headers });
}

async function signedRequest(input: {
  readonly requestId: string;
  readonly timestamp: string;
  readonly query?: string;
  readonly requestQuery?: string;
}): Promise<Request> {
  const body = JSON.stringify({ ok: true });
  const path = "/api/internal/v1/test";
  const signed = await signTakosInternalRequest({
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
    `https://paas.test${path}${input.requestQuery ?? input.query ?? ""}`,
    {
      method: "POST",
      headers: signed.headers,
      body,
    },
  );
}

/**
 * Single shared in-memory backend that two `SqlReplayProtectionStore`
 * instances can race against — i.e. the test analogue of two PaaS replicas
 * pointed at the same Postgres database.
 */
class FakeSharedReplayBackend {
  readonly rows = new Map<string, Record<string, unknown>>();

  client(): SqlClient {
    const rows = this.rows;
    return {
      query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ): Promise<SqlQueryResult<Row>> {
        const params = (parameters ?? []) as readonly unknown[];
        const trimmed = sql.trim().toLowerCase();
        if (trimmed.startsWith("insert into")) {
          const [namespace, requestId, timestampMs, expiresAtMs, seenAtMs] =
            params as [string, string, number, number, number];
          const key = `${namespace}:${requestId}`;
          if (rows.has(key)) {
            return Promise.resolve({ rows: [] as Row[], rowCount: 0 });
          }
          rows.set(key, {
            namespace,
            request_id: requestId,
            timestamp_ms: timestampMs,
            expires_at_ms: expiresAtMs,
            seen_at_ms: seenAtMs,
          });
          return Promise.resolve({ rows: [] as Row[], rowCount: 1 });
        }
        if (trimmed.startsWith("delete from")) {
          const [now] = params as [number];
          for (const [key, row] of rows) {
            if ((row.expires_at_ms as number) <= now) rows.delete(key);
          }
          return Promise.resolve({ rows: [] as Row[], rowCount: 0 });
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
  }
}

Deno.test("readInternalAuth uses SqlReplayProtectionStore to reject cross-pod replays", async () => {
  // Two PaaS replicas share the same `internal_request_replay_log` row
  // set (the FakeSharedReplayBackend stands in for Postgres). The same
  // signed request is delivered first to replica A, then replayed to
  // replica B. The shared store must cause B to reject the replay even
  // though B's own in-process cache has never seen the id.
  const backend = new FakeSharedReplayBackend();
  const replicaAStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const replicaBStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const signed = await signedRequest({
    requestId: "req_internal_auth_cross_pod_replay",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  const acceptedOnA = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.000Z"),
    replayProtectionStore: replicaAStore,
  });
  assert.equal(acceptedOnA.ok, true);

  const rejectedOnB = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.500Z"),
    replayProtectionStore: replicaBStore,
  });
  assert.deepEqual(rejectedOnB, {
    ok: false,
    error: "replayed internal request",
    status: 401,
  });
});

Deno.test("readInternalAuth: independent in-memory stores do NOT share state (regression baseline)", async () => {
  // Sanity check that documents the original Phase 18 vulnerability:
  // when each replica owns its own in-memory store, a replayed request
  // is incorrectly accepted by the second replica. This test pins the
  // historical behavior so the SQL-backed test above is meaningful.
  const replicaAStore = new InMemoryReplayProtectionStore();
  const replicaBStore = new InMemoryReplayProtectionStore();
  const signed = await signedRequest({
    requestId: "req_internal_auth_replica_split_brain",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  const acceptedOnA = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.000Z"),
    replayProtectionStore: replicaAStore,
  });
  const acceptedOnB = await readInternalAuth(signed.clone(), {
    secret: "secret",
    clock: () => new Date("2026-04-27T00:00:30.500Z"),
    replayProtectionStore: replicaBStore,
  });
  assert.equal(acceptedOnA.ok, true);
  // Without the SQL-backed shared store, replica B has no knowledge of
  // replica A's observation — this is exactly the failure mode Phase 18.3
  // M4 fixes by injecting a SqlReplayProtectionStore at the host edge.
  assert.equal(acceptedOnB.ok, true);
});

Deno.test("verifyInternalResponse uses SqlReplayProtectionStore to reject cross-pod response replays", async () => {
  const backend = new FakeSharedReplayBackend();
  const replicaAStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const replicaBStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const body = '{"deployment":"dep_cross_pod"}';
  const signed = await signedResponse({
    body,
    status: 200,
    requestId: "req_resp_cross_pod_replay",
    timestamp: "2026-04-30T00:00:00.000Z",
  });
  const verified = await verifyInternalResponse(signed.clone(), {
    secret: "shared",
    method: "POST",
    path: "/api/internal/v1/deploy/applies",
    clock: () => new Date("2026-04-30T00:00:30.000Z"),
    replayProtectionStore: replicaAStore,
  });
  assert.equal(verified.body, body);

  await assert.rejects(
    () =>
      verifyInternalResponse(signed.clone(), {
        secret: "shared",
        method: "POST",
        path: "/api/internal/v1/deploy/applies",
        clock: () => new Date("2026-04-30T00:00:30.500Z"),
        replayProtectionStore: replicaBStore,
      }),
    (error: unknown) =>
      error instanceof SignatureVerificationError &&
      error.code === "replayed response",
  );
});
