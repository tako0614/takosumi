import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  canonicalTakosumiInternalRequest,
  encodeActorContext,
  EnvTakosumiServiceDirectory,
  signTakosumiInternalRequest,
  TAKOSUMI_CORRELATION_ID_HEADER,
  TAKOSUMI_INTERNAL_AUDIENCE_HEADER,
  TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER,
  TAKOSUMI_INTERNAL_CALLER_HEADER,
  TAKOSUMI_INTERNAL_CAPABILITIES_HEADER,
  TAKOSUMI_INTERNAL_NONCE_HEADER,
  TAKOSUMI_INTERNAL_PROTOCOL_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_RPC_VERSION,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_REQUEST_ID_HEADER,
  TAKOSUMI_TRACEPARENT_HEADER,
  type TakosumiActorContext,
  TakosumiInternalClient,
  type TakosumiInternalTraceSpanEvent,
  verifyTakosumiInternalRequestFromHeaders,
} from "../../contract/internal-rpc.ts";

const actor: TakosumiActorContext = {
  actorAccountId: "acct_owner",
  roles: ["owner"],
  requestId: "req_internal",
  principalKind: "account",
  spaceId: "space_1",
};

test("signTakosumiInternalRequest emits canonical internal envelope headers", async () => {
  const body = '{"repositoryId":"repo_1"}';
  const signed = await signTakosumiInternalRequest({
    method: "post",
    path: "/internal/source/resolve",
    query: "?trace=1",
    body,
    timestamp: "2026-05-01T00:00:00.000Z",
    requestId: "req_internal",
    nonce: "nonce_1",
    caller: "caller-app",
    audience: "audience-git",
    capabilities: ["repo.read", "repo.read"],
    actor,
    secret: "test-secret",
  });

  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_PROTOCOL_HEADER],
    TAKOSUMI_INTERNAL_RPC_VERSION,
  );
  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_REQUEST_ID_HEADER],
    "req_internal",
  );
  assert.equal(signed.headers[TAKOSUMI_INTERNAL_NONCE_HEADER], "nonce_1");
  assert.equal(signed.headers[TAKOSUMI_INTERNAL_CALLER_HEADER], "caller-app");
  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_AUDIENCE_HEADER],
    "audience-git",
  );
  assert.equal(
    signed.headers[TAKOSUMI_INTERNAL_CAPABILITIES_HEADER],
    "repo.read",
  );
  assert.match(
    signed.headers[TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    signed.headers[TAKOSUMI_INTERNAL_SIGNATURE_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    signed.headers["x-takosumi-actor-context"],
    encodeActorContext(actor),
  );

  const verified = await verifyTakosumiInternalRequestFromHeaders({
    method: "POST",
    path: "/internal/source/resolve",
    query: "?trace=1",
    body,
    secret: "test-secret",
    headers: new Headers(signed.headers),
    expectedCaller: "caller-app",
    expectedAudience: "audience-git",
    requiredCapabilities: ["repo.read"],
    now: () => new Date("2026-05-01T00:01:00.000Z"),
  });

  assert.equal(verified?.actor.actorAccountId, "acct_owner");
  assert.equal(verified?.caller, "caller-app");
  assert.deepEqual(verified?.capabilities, ["repo.read"]);
});

test("verifyTakosumiInternalRequestFromHeaders rejects tamper and policy mismatch", async () => {
  const signed = await signTakosumiInternalRequest({
    method: "GET",
    path: "/internal/repositories",
    body: "",
    timestamp: "2026-05-01T00:00:00.000Z",
    caller: "caller-app",
    audience: "audience-git",
    capabilities: ["repo.read"],
    actor,
    secret: "test-secret",
  });

  assert.equal(
    await verifyTakosumiInternalRequestFromHeaders({
      method: "GET",
      path: "/internal/repositories",
      body: "tampered",
      secret: "test-secret",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-05-01T00:01:00.000Z"),
    }),
    undefined,
  );
  assert.equal(
    await verifyTakosumiInternalRequestFromHeaders({
      method: "GET",
      path: "/internal/repositories",
      body: "",
      secret: "test-secret",
      headers: new Headers(signed.headers),
      expectedAudience: "audience-deploy-control",
      now: () => new Date("2026-05-01T00:01:00.000Z"),
    }),
    undefined,
  );
  assert.equal(
    await verifyTakosumiInternalRequestFromHeaders({
      method: "GET",
      path: "/internal/repositories",
      body: "",
      secret: "test-secret",
      headers: new Headers(signed.headers),
      requiredCapabilities: ["repo.write"],
      now: () => new Date("2026-05-01T00:01:00.000Z"),
    }),
    undefined,
  );
  assert.equal(
    await verifyTakosumiInternalRequestFromHeaders({
      method: "GET",
      path: "/internal/repositories",
      body: "",
      secret: "test-secret",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-05-01T00:06:00.000Z"),
    }),
    undefined,
  );
});

test("verifyTakosumiInternalRequestFromHeaders enforces single-use nonce when recordNonce is supplied", async () => {
  const body = '{"repositoryId":"repo_1"}';
  const signed = await signTakosumiInternalRequest({
    method: "POST",
    path: "/internal/source/resolve",
    body,
    timestamp: "2026-05-01T00:00:00.000Z",
    nonce: "nonce-replay",
    caller: "caller-app",
    audience: "audience-git",
    capabilities: ["repo.read"],
    actor,
    secret: "test-secret",
  });

  const seen = new Map<string, number>();
  const recordNonce = (nonce: string, expiresAtEpochMs: number) => {
    if (seen.has(nonce)) return Promise.resolve(false);
    seen.set(nonce, expiresAtEpochMs);
    return Promise.resolve(true);
  };

  // First presentation is accepted and records the nonce.
  const first = await verifyTakosumiInternalRequestFromHeaders({
    method: "POST",
    path: "/internal/source/resolve",
    body,
    secret: "test-secret",
    headers: new Headers(signed.headers),
    now: () => new Date("2026-05-01T00:01:00.000Z"),
    recordNonce,
  });
  assert.equal(first?.nonce, "nonce-replay");
  // Expiry is timestamp + default 5-minute skew window.
  assert.equal(
    seen.get("nonce-replay"),
    Date.parse("2026-05-01T00:05:00.000Z"),
  );

  // Replay within the skew window is rejected because the nonce was seen.
  const replay = await verifyTakosumiInternalRequestFromHeaders({
    method: "POST",
    path: "/internal/source/resolve",
    body,
    secret: "test-secret",
    headers: new Headers(signed.headers),
    now: () => new Date("2026-05-01T00:02:00.000Z"),
    recordNonce,
  });
  assert.equal(replay, undefined);
});

test("verifyTakosumiInternalRequestFromHeaders does not consult recordNonce for a forged signature", async () => {
  const signed = await signTakosumiInternalRequest({
    method: "POST",
    path: "/internal/source/resolve",
    body: "{}",
    timestamp: "2026-05-01T00:00:00.000Z",
    nonce: "nonce-forged",
    caller: "caller-app",
    audience: "audience-git",
    actor,
    secret: "test-secret",
  });
  const headers = new Headers(signed.headers);
  headers.set(TAKOSUMI_INTERNAL_SIGNATURE_HEADER, "0".repeat(64));

  let recorderCalls = 0;
  const result = await verifyTakosumiInternalRequestFromHeaders({
    method: "POST",
    path: "/internal/source/resolve",
    body: "{}",
    secret: "test-secret",
    headers,
    now: () => new Date("2026-05-01T00:01:00.000Z"),
    recordNonce: () => {
      recorderCalls += 1;
      return Promise.resolve(true);
    },
  });
  assert.equal(result, undefined);
  assert.equal(recorderCalls, 0);
});

test("internal RPC signing verifies binary request bodies", async () => {
  const body = new Uint8Array([0, 255, 1, 2, 128, 10]);
  const signed = await signTakosumiInternalRequest({
    method: "POST",
    path: "/repo.git/git-receive-pack",
    body,
    timestamp: "2026-05-01T00:00:00.000Z",
    caller: "caller-app",
    audience: "audience-git",
    capabilities: ["repo.write"],
    actor,
    secret: "test-secret",
  });

  const verified = await verifyTakosumiInternalRequestFromHeaders({
    method: "POST",
    path: "/repo.git/git-receive-pack",
    body,
    secret: "test-secret",
    headers: new Headers(signed.headers),
    expectedAudience: "audience-git",
    requiredCapabilities: ["repo.write"],
    now: () => new Date("2026-05-01T00:01:00.000Z"),
  });
  assert.equal(verified?.caller, "caller-app");

  const tampered = new Uint8Array(body);
  tampered[1] = 254;
  assert.equal(
    await verifyTakosumiInternalRequestFromHeaders({
      method: "POST",
      path: "/repo.git/git-receive-pack",
      body: tampered,
      secret: "test-secret",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-05-01T00:01:00.000Z"),
    }),
    undefined,
  );
});

test("TakosumiInternalClient signs routed service requests", async () => {
  const calls: Request[] = [];
  const client = new TakosumiInternalClient({
    caller: "caller-app",
    audience: "audience-git",
    baseUrl: "https://git.internal",
    secret: "test-secret",
    clock: () => new Date("2026-05-01T00:00:00.000Z"),
    fetch: (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const response = await client.request({
    method: "POST",
    path: "/internal/source/resolve",
    search: "trace=1",
    body: "{}",
    actor,
    capabilities: ["ref.resolve"],
  });

  assert.equal(response.status, 200);
  assert.equal(
    calls[0].url,
    "https://git.internal/internal/source/resolve?trace=1",
  );
  assert.equal(
    calls[0].headers.get(TAKOSUMI_INTERNAL_CALLER_HEADER),
    "caller-app",
  );
  assert.equal(
    calls[0].headers.get(TAKOSUMI_INTERNAL_AUDIENCE_HEADER),
    "audience-git",
  );
  assert.equal(
    calls[0].headers.get(TAKOSUMI_INTERNAL_CAPABILITIES_HEADER),
    "ref.resolve",
  );
});

test("TakosumiInternalClient propagates trace context and records client spans", async () => {
  const calls: Request[] = [];
  const spans: TakosumiInternalTraceSpanEvent[] = [];
  const client = new TakosumiInternalClient({
    caller: "caller-app",
    audience: "audience-git",
    baseUrl: "https://git.internal",
    secret: "test-secret",
    clock: () => new Date("2026-05-01T00:00:00.000Z"),
    spanIdFactory: () => "2222222222222222",
    traceSink: {
      recordTrace(event) {
        spans.push(event);
        return Promise.resolve(event);
      },
    },
    fetch: (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  await client.request({
    method: "POST",
    path: "/internal/source/resolve",
    body: "{}",
    actor,
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "1111111111111111",
      correlationId: "corr_internal",
    },
  });

  assert.equal(
    calls[0].headers.get(TAKOSUMI_TRACEPARENT_HEADER),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01",
  );
  assert.equal(
    calls[0].headers.get(TAKOSUMI_REQUEST_ID_HEADER),
    "req_internal",
  );
  assert.equal(
    calls[0].headers.get(TAKOSUMI_CORRELATION_ID_HEADER),
    "corr_internal",
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "takosumi.internal_rpc.client");
  assert.equal(spans[0].kind, "client");
  assert.equal(spans[0].traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(spans[0].parentSpanId, "1111111111111111");
  assert.equal(spans[0].requestId, "req_internal");
  assert.equal(spans[0].correlationId, "corr_internal");
  assert.equal(spans[0].attributes?.["http.response.status_code"], 200);
});

test("EnvTakosumiServiceDirectory resolves operator-namespaced env URLs", () => {
  const directory = new EnvTakosumiServiceDirectory({
    TAKOSUMI_DEPLOY_CONTROL_INTERNAL_URL: "https://deploy-control.internal",
    TAKOSUMI_ACCOUNTS_INTERNAL_URL: "https://accounts.internal",
    TAKOSUMI_RUNTIME_AGENT_INTERNAL_URL: "https://runtime-agent.internal",
  });

  assert.deepEqual(directory.resolve("deploy-control"), {
    serviceId: "deploy-control",
    audience: "deploy-control",
    url: "https://deploy-control.internal",
  });
  assert.deepEqual(directory.resolve("accounts"), {
    serviceId: "accounts",
    audience: "accounts",
    url: "https://accounts.internal",
  });
  assert.deepEqual(directory.resolve("runtime-agent"), {
    serviceId: "runtime-agent",
    audience: "runtime-agent",
    url: "https://runtime-agent.internal",
  });
  assert.equal(directory.resolve("git"), undefined);
});

test("EnvTakosumiServiceDirectory respects custom envPrefix", () => {
  const directory = new EnvTakosumiServiceDirectory(
    {
      MYORG_BILLING_INTERNAL_URL: "https://billing.internal",
    },
    "MYORG",
  );

  assert.deepEqual(directory.resolve("billing"), {
    serviceId: "billing",
    audience: "billing",
    url: "https://billing.internal",
  });
  assert.equal(directory.resolve("missing"), undefined);
});

test("EnvTakosumiServiceDirectory normalizes hyphenated service ids", () => {
  const directory = new EnvTakosumiServiceDirectory({
    TAKOSUMI_LOG_WORKER_INTERNAL_URL: "https://log.internal",
  });

  assert.deepEqual(directory.resolve("log-worker"), {
    serviceId: "log-worker",
    audience: "log-worker",
    url: "https://log.internal",
  });
});

test("canonicalTakosumiInternalRequest binds query and digest", () => {
  const canonical = canonicalTakosumiInternalRequest({
    method: "get",
    path: "/internal/repositories",
    query: "?spaceId=space_1",
    bodyDigest: "digest",
    actorContextHeader: "actor",
    caller: "caller-app",
    audience: "audience-git",
    capabilities: ["repo.read"],
    requestId: "req",
    nonce: "nonce",
    timestamp: "2026-05-01T00:00:00.000Z",
  });

  assert.equal(
    canonical,
    [
      TAKOSUMI_INTERNAL_RPC_VERSION,
      "GET",
      "/internal/repositories?spaceId=space_1",
      "2026-05-01T00:00:00.000Z",
      "req",
      "nonce",
      "caller-app",
      "audience-git",
      "repo.read",
      "digest",
      "actor",
    ].join("\n"),
  );
});
