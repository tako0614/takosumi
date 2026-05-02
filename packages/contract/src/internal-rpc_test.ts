import assert from "node:assert/strict";
import {
  canonicalTakosumiInternalRequest,
  encodeActorContext,
  EnvTakosumiServiceDirectory,
  signTakosumiInternalRequest,
  TAKOSUMI_INTERNAL_AUDIENCE_HEADER,
  TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER,
  TAKOSUMI_INTERNAL_CALLER_HEADER,
  TAKOSUMI_INTERNAL_CAPABILITIES_HEADER,
  TAKOSUMI_INTERNAL_NONCE_HEADER,
  TAKOSUMI_INTERNAL_PROTOCOL_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_RPC_VERSION,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  type TakosumiActorContext,
  TakosumiInternalClient,
  verifyTakosumiInternalRequestFromHeaders,
} from "./internal-rpc.ts";

const actor: TakosumiActorContext = {
  actorAccountId: "acct_owner",
  roles: ["owner"],
  requestId: "req_internal",
  principalKind: "account",
  spaceId: "space_1",
};

Deno.test("signTakosumiInternalRequest emits canonical internal envelope headers", async () => {
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

Deno.test("verifyTakosumiInternalRequestFromHeaders rejects tamper and policy mismatch", async () => {
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
      expectedAudience: "audience-paas",
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

Deno.test("internal RPC signing verifies binary request bodies", async () => {
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

Deno.test("TakosumiInternalClient signs routed service requests", async () => {
  const calls: Request[] = [];
  const client = new TakosumiInternalClient({
    caller: "caller-app",
    audience: "audience-git",
    baseUrl: "https://git.internal",
    secret: "test-secret",
    clock: () => new Date("2026-05-01T00:00:00.000Z"),
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ ok: true });
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

Deno.test("EnvTakosumiServiceDirectory resolves operator-namespaced env URLs", () => {
  const directory = new EnvTakosumiServiceDirectory({
    TAKOSUMI_PAAS_INTERNAL_URL: "https://paas.internal",
    TAKOSUMI_APP_INTERNAL_URL: "https://app.internal",
    TAKOSUMI_GIT_INTERNAL_URL: "https://git.internal",
    TAKOSUMI_AGENT_INTERNAL_URL: "https://agent.internal",
  });

  assert.deepEqual(directory.resolve("paas"), {
    serviceId: "paas",
    audience: "paas",
    url: "https://paas.internal",
  });
  assert.deepEqual(directory.resolve("app"), {
    serviceId: "app",
    audience: "app",
    url: "https://app.internal",
  });
  assert.deepEqual(directory.resolve("git"), {
    serviceId: "git",
    audience: "git",
    url: "https://git.internal",
  });
  assert.equal(directory.resolve("runtime"), undefined);
});

Deno.test("EnvTakosumiServiceDirectory respects custom envPrefix", () => {
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

Deno.test("EnvTakosumiServiceDirectory normalizes hyphenated service ids", () => {
  const directory = new EnvTakosumiServiceDirectory({
    TAKOSUMI_LOG_WORKER_INTERNAL_URL: "https://log.internal",
  });

  assert.deepEqual(directory.resolve("log-worker"), {
    serviceId: "log-worker",
    audience: "log-worker",
    url: "https://log.internal",
  });
});

Deno.test("canonicalTakosumiInternalRequest binds query and digest", () => {
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
