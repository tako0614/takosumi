/**
 * Tests for the reference runtime-agent loop. Uses the real kernel routes
 * exposed via {@link registerRuntimeAgentRoutes} together with an in-memory
 * registry, so the e2e covers signed-internal-auth, lease distribution,
 * progress reporting, and outcome reporting end-to-end.
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  InMemoryRuntimeAgentRegistry,
  RuntimeAgentGatewayManifestIssuer,
  type RuntimeAgentRegistry,
  type TraceSpanEvent,
} from "takosumi-contract";
import {
  registerRuntimeAgentRoutes,
  TAKOSUMI_RUNTIME_AGENT_PATHS,
} from "takosumi-contract";
import type { TakosumiActorContext } from "takosumi-contract";
import {
  GatewayManifestVerificationError,
  GatewayResponseSignatureError,
  RuntimeAgentHttpClient,
  RuntimeAgentRpcError,
} from "./client.ts";
import {
  executorFromProviderCall,
  type RuntimeAgentExecutor,
  RuntimeAgentLoop,
  type RuntimeAgentLoopEvent,
} from "./loop.ts";
import type {
  RuntimeAgentTraceContext,
  RuntimeAgentTraceSink,
} from "./tracing.ts";

const SECRET = "agent-test-secret";
const ACTOR: TakosumiActorContext = {
  actorAccountId: "acct_runtime_agent",
  roles: ["service"],
  requestId: "req_test",
  principalKind: "service",
  serviceId: "runtime-agent",
};

Deno.test("RuntimeAgentLoop enrolls, leases, executes, and reports completion", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_1",
  });
  await setup.registry.enqueueLongRunningOperation({
    provider: "aws",
    descriptor: "rds.create",
    desiredStateId: "desired_rds_1",
    targetId: "primary",
    payload: { engine: "postgres" },
    idempotencyKey: "aws-rds-primary",
    enqueuedAt: "2026-04-27T00:00:00.000Z",
  });
  const events: RuntimeAgentLoopEvent[] = [];
  const executors: Record<string, RuntimeAgentExecutor> = {
    "provider.aws.rds.create": executorFromProviderCall(
      (payload) =>
        Promise.resolve({
          ok: true,
          desiredStateId: payload.payload.desiredStateId as string,
        }),
    ),
  };
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_aws_1",
    provider: "aws",
    capabilities: { providers: ["aws"], maxConcurrentLeases: 2 },
    hostKeyDigest: "digest-aws-1",
    executors,
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 1_000,
    telemetry: { onEvent: (event) => events.push(event) },
  });

  await loop.enroll();
  const processed = await loop.runOnce();
  assert.equal(processed, true);

  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 2), ["gateway-manifest-loaded", "enrolled"]);
  assert.ok(kinds.includes("leased"));
  assert.ok(kinds.includes("executed"));
  const leased = events.find((event) => event.kind === "leased");
  assert.ok(leased && leased.kind === "leased");
  assert.equal(leased.lease.work.kind, "provider.aws.rds.create");
  const executed = events.find((event) => event.kind === "executed");
  assert.ok(executed && executed.kind === "executed");
  assert.equal(executed.outcome.status, "completed");

  const [work] = await setup.registry.listWork();
  assert.equal(work.status, "completed");
});

Deno.test("RuntimeAgentLoop reports failures with retry on transient errors", async () => {
  const setup = await setupHarness({
    providerKind: "gcp",
    agentId: "agent_gcp_flaky",
  });
  await setup.registry.enqueueWork({
    workId: "work_flaky",
    kind: "provider.gcp.cloud-sql.create",
    provider: "gcp",
    payload: {},
  });
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_gcp_flaky",
    provider: "gcp",
    capabilities: { providers: ["gcp"] },
    executors: {
      "provider.gcp.cloud-sql.create": executorFromProviderCall(() => {
        const err = Object.assign(new Error("rate-limited"), {
          status: "RESOURCE_EXHAUSTED",
        });
        throw err;
      }),
    },
  });
  await loop.enroll();
  await loop.runOnce();
  const work = await setup.registry.getWork("work_flaky");
  assert.equal(work?.status, "queued");
  assert.equal(work?.failureReason, "rate-limited");
  assert.equal(work?.attempts, 1);
});

Deno.test("RuntimeAgentLoop uses the default executor when no kind matches", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_unknown",
  });
  await setup.registry.enqueueWork({
    workId: "work_unknown",
    kind: "provider.aws.unknown",
    provider: "aws",
    payload: {},
  });
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_aws_unknown",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {},
  });
  await loop.enroll();
  await loop.runOnce();
  const work = await setup.registry.getWork("work_unknown");
  assert.equal(work?.status, "failed");
  assert.match(
    work?.failureReason ?? "",
    /no executor registered for kind provider.aws.unknown/,
  );
});

Deno.test("RuntimeAgentLoop emits idle when there is no work", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_idle",
  });
  const events: RuntimeAgentLoopEvent[] = [];
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_idle",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {},
    telemetry: { onEvent: (event) => events.push(event) },
  });
  await loop.enroll();
  const processed = await loop.runOnce();
  assert.equal(processed, false);
  assert.ok(events.some((event) => event.kind === "idle"));
});

Deno.test("RuntimeAgentLoop reports progress and extends the lease", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_long",
  });
  await setup.registry.enqueueWork({
    workId: "work_long",
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });

  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_aws_long",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    leaseTtlMs: 10_000,
    executors: {
      "provider.aws.rds.create": async (ctx) => {
        await ctx.reportProgress({
          progress: { stage: "creating-instance" },
          extendUntil: new Date(
            Date.parse(ctx.lease.expiresAt) + 60_000,
          ).toISOString(),
        });
        return { status: "completed", result: { ok: true } };
      },
    },
  });
  await loop.enroll();
  await loop.runOnce();

  const work = await setup.registry.getWork("work_long");
  assert.equal(work?.status, "completed");
  assert.deepEqual(work?.lastProgress, { stage: "creating-instance" });
});

Deno.test("RuntimeAgentLoop surfaces RPC errors via telemetry without crashing", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_rpc_err",
  });
  await setup.registry.enqueueWork({
    workId: "work_rpc_err",
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const events: RuntimeAgentLoopEvent[] = [];
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_rpc_err",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {
      "provider.aws.rds.create": () => {
        throw Object.assign(new Error("boom"), { httpStatus: 504 });
      },
    },
    telemetry: { onEvent: (event) => events.push(event) },
  });
  await loop.enroll();
  await loop.runOnce();
  assert.ok(events.some((event) => event.kind === "executed"));
  const work = await setup.registry.getWork("work_rpc_err");
  assert.equal(work?.failureReason, "boom");
});

Deno.test("RuntimeAgentHttpClient throws RuntimeAgentRpcError on failure status", async () => {
  // Stub fetch returning a 401 — no Hono server required. The test exercises
  // failure-path before any manifest is loaded so trustedManifestPubkey is a
  // placeholder.
  const fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: "unauthenticated", message: "no" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    )) as unknown as typeof globalThis.fetch;
  const client = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.local",
    internalServiceSecret: "secret",
    actor: ACTOR,
    trustedManifestPubkey: "AAAA",
    providerKind: "aws",
    agentId: "agent_a",
    fetch,
  });
  await assert.rejects(
    () =>
      client.heartbeat({
        agentId: "agent_a",
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeAgentRpcError);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

Deno.test("RuntimeAgentHttpClient propagates trace context and records RPC spans", async () => {
  const spans: TraceSpanEvent[] = [];
  const requests: Request[] = [];
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_trace_rpc",
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "1111111111111111",
      correlationId: "corr_runtime_agent",
    },
    traceSink: {
      recordTrace(event) {
        spans.push(event);
        return Promise.resolve(event);
      },
    },
    spanIdFactory: sequence([
      "2222222222222222",
      "3333333333333333",
    ]),
    onRequest: (request) => requests.push(request),
  });

  await setup.client.loadGatewayManifest();
  await setup.client.heartbeat({ agentId: "agent_trace_rpc" });

  const manifestRequest = requests.find((request) =>
    request.url.includes("gateway-manifest")
  );
  const heartbeatRequest = requests.find((request) =>
    request.url.includes("heartbeat")
  );
  assert.equal(
    manifestRequest?.headers.get("traceparent"),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01",
  );
  assert.equal(
    heartbeatRequest?.headers.get("traceparent"),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-3333333333333333-01",
  );
  assert.equal(heartbeatRequest?.headers.get("x-request-id"), "req_test");
  assert.equal(
    heartbeatRequest?.headers.get("x-correlation-id"),
    "corr_runtime_agent",
  );

  assert.deepEqual(spans.map((span) => span.name), [
    "takosumi.runtime_agent.rpc.gateway_manifest",
    "takosumi.runtime_agent.rpc.heartbeat",
  ]);
  assert.equal(spans[0].parentSpanId, "1111111111111111");
  assert.equal(spans[1].attributes?.["http.response.status_code"], 200);
  assert.equal(
    spans[1].attributes?.["takosumi.runtime_agent.rpc"],
    "heartbeat",
  );
});

Deno.test("RuntimeAgentLoop records work execution trace spans", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_trace_loop",
  });
  await setup.registry.enqueueWork({
    workId: "work_trace_loop",
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const spans: TraceSpanEvent[] = [];
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_trace_loop",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {
      "provider.aws.rds.create": () =>
        Promise.resolve({ status: "completed", result: { ok: true } }),
    },
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "aaaaaaaaaaaaaaaa",
      requestId: "req_loop",
      correlationId: "corr_loop",
    },
    traceSink: {
      recordTrace(event) {
        spans.push(event);
        return Promise.resolve(event);
      },
    },
    spanIdFactory: sequence(["bbbbbbbbbbbbbbbb"]),
  });

  await loop.enroll();
  await loop.runOnce();

  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.equal(span.name, "takosumi.runtime_agent.execute");
  assert.equal(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(span.spanId, "bbbbbbbbbbbbbbbb");
  assert.equal(span.parentSpanId, "aaaaaaaaaaaaaaaa");
  assert.equal(span.requestId, "req_loop");
  assert.equal(span.correlationId, "corr_loop");
  assert.equal(span.status, "ok");
  assert.equal(
    span.attributes?.["takosumi.runtime_agent.work_id"],
    "work_trace_loop",
  );
  assert.equal(
    span.attributes?.["takosumi.runtime_agent.outcome"],
    "completed",
  );
});

Deno.test("RuntimeAgentLoop runForever loops until aborted", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_forever",
  });
  await setup.registry.enqueueWork({
    workId: "w1",
    kind: "provider.aws.x",
    provider: "aws",
    payload: {},
  });
  const ac = new AbortController();
  const sleep = (_ms: number) => Promise.resolve();
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_forever",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {
      "provider.aws.x": () => {
        ac.abort();
        return Promise.resolve({ status: "completed" });
      },
    },
    sleep,
  });
  await loop.runForever(ac.signal);
  assert.equal((await setup.registry.getWork("w1"))?.status, "completed");
});

/* ─── Phase 18: Gateway-identity verification tests ────────────────────── */

Deno.test("RuntimeAgentLoop fetches and pins a signed gateway manifest before enroll", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_pinned",
  });
  const events: RuntimeAgentLoopEvent[] = [];
  const loop = new RuntimeAgentLoop({
    client: setup.client,
    agentId: "agent_aws_pinned",
    provider: "aws",
    capabilities: { providers: ["aws"] },
    executors: {},
    telemetry: { onEvent: (event) => events.push(event) },
  });
  await loop.enroll();
  const manifestEvent = events.find((event) =>
    event.kind === "gateway-manifest-loaded"
  );
  assert.ok(manifestEvent && manifestEvent.kind === "gateway-manifest-loaded");
  assert.equal(manifestEvent.manifest.gatewayUrl, "http://kernel.test");
  assert.equal(manifestEvent.manifest.agentId, "agent_aws_pinned");
  assert.deepEqual(
    [...manifestEvent.manifest.allowedProviderKinds],
    ["aws"],
  );
  // Pinned manifest is reused for subsequent RPCs (no second fetch).
  assert.ok(setup.client.pinnedManifest);
  assert.equal(
    setup.client.pinnedManifest?.gatewayUrl,
    "http://kernel.test",
  );
});

Deno.test("RuntimeAgentLoop fail-closed when an injected gateway URL is not allow-listed", async () => {
  // Operator pre-registered `http://kernel.test` as the only legitimate
  // gateway URL. An attacker tricks the agent into talking to a different
  // URL — the kernel refuses to issue a manifest, and the bootstrap fails.
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_fakeurl",
    baseUrl: "http://kernel.test",
    allowedGatewayUrls: ["http://kernel.test"],
  });
  // A second client that points at a different URL but reuses the same
  // backing app (simulating MITM / DNS rebinding).
  const fakeClient = new RuntimeAgentHttpClient({
    baseUrl: "https://attacker-gateway.example.com",
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: setup.trustedPubkeyBase64,
    providerKind: "aws",
    agentId: "agent_aws_fakeurl",
    fetch: ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const path = url.replace(/^https:\/\/attacker-gateway\.example\.com/, "");
      return Promise.resolve(setup.app.request(path, init));
    }) as unknown as typeof globalThis.fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () => fakeClient.loadGatewayManifest(),
    // The kernel refuses to mint with `conflict`, surfaced as RuntimeAgentRpcError.
    (error: unknown) => {
      assert.ok(error instanceof RuntimeAgentRpcError);
      assert.equal(error.status, 409);
      return true;
    },
  );
});

Deno.test("RuntimeAgentLoop fail-closed when the manifest binds a different URL than the agent expects", async () => {
  // Even if a malicious gateway returns a manifest signed by the trusted
  // key but bound to a *different* gatewayUrl, the agent's verification
  // step (expectedGatewayUrl) must reject it. Build the manifest manually
  // and serve it.
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_url_swap",
    baseUrl: "http://kernel.test",
  });
  const trustedPubkey = setup.trustedPubkeyBase64;
  // Hand-craft a fetch stub that returns a manifest where gatewayUrl is the
  // attacker's URL; we'll re-serve it under the agent's expected URL. The
  // signature is real (re-mint via the real kernel), but the URL inside
  // doesn't match what the client expected.
  const realManifest = await setup.client.loadGatewayManifest();
  // mutate gatewayUrl in a *fresh* signed manifest that the test reissues
  // by hitting the kernel under a different URL — easier path: hand-tamper
  // and confirm verifyGatewayManifest rejects.
  const tampered = {
    manifest: { ...realManifest, gatewayUrl: "https://attacker.example" },
    signature: "AAAA",
  };
  const fakeClient = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.test",
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: trustedPubkey,
    providerKind: "aws",
    agentId: "agent_aws_url_swap",
    fetch: ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(tampered), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof globalThis.fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () => fakeClient.loadGatewayManifest(),
    (error: unknown) => {
      assert.ok(error instanceof GatewayManifestVerificationError);
      assert.match(error.message, /url|signature/i);
      return true;
    },
  );
});

Deno.test("RuntimeAgentLoop rejects an expired gateway manifest", async () => {
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_expired",
  });
  // Force the client clock far in the future so the issued manifest looks
  // expired by the time it lands.
  const expiredClient = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.test",
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: setup.trustedPubkeyBase64,
    providerKind: "aws",
    agentId: "agent_aws_expired",
    fetch: ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const path = url.replace(/^http:\/\/kernel\.test/, "");
      return Promise.resolve(setup.app.request(path, init));
    }) as unknown as typeof globalThis.fetch,
    clock: () => new Date("2027-01-01T00:00:00.000Z"),
  });
  await assert.rejects(
    () => expiredClient.loadGatewayManifest(),
    (error: unknown) => {
      assert.ok(error instanceof GatewayManifestVerificationError);
      assert.match(error.message, /expired/);
      return true;
    },
  );
});

Deno.test("RuntimeAgentLoop rejects a manifest signed with a key the agent does not trust", async () => {
  // Issue a legitimate manifest, but install a *different* trusted pubkey
  // on the agent. Verification must reject.
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_keymismatch",
  });
  const otherKeypair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const otherPubkeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", otherKeypair.publicKey),
  );
  const wrongPubkey = bytesToBase64(otherPubkeyBytes);
  const wrongClient = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.test",
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: wrongPubkey,
    providerKind: "aws",
    agentId: "agent_aws_keymismatch",
    fetch: ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const path = url.replace(/^http:\/\/kernel\.test/, "");
      return Promise.resolve(setup.app.request(path, init));
    }) as unknown as typeof globalThis.fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () => wrongClient.loadGatewayManifest(),
    (error: unknown) => {
      assert.ok(error instanceof GatewayManifestVerificationError);
      assert.match(error.message, /signature/i);
      return true;
    },
  );
});

Deno.test("RuntimeAgentLoop enforces optional cert pinning via verifyConnectionPin", async () => {
  const seenPin: string[] = [];
  const setup = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_pinned_cert",
    tlsPubkeySha256: "Yp9fSwWlx9zX/example/=",
    verifyConnectionPin: ({ tlsPubkeySha256 }) => {
      seenPin.push(tlsPubkeySha256);
    },
  });
  await setup.client.loadGatewayManifest();
  assert.deepEqual(seenPin, ["Yp9fSwWlx9zX/example/="]);

  // Now wire a verifier that throws — the loadGatewayManifest must surface
  // the failure (fail-closed cert pin).
  const failing = await setupHarness({
    providerKind: "aws",
    agentId: "agent_aws_pinned_fail",
    tlsPubkeySha256: "Yp9fSwWlx9zX/example/=",
    verifyConnectionPin: () => {
      throw new Error("tls pin mismatch");
    },
  });
  await assert.rejects(
    () => failing.client.loadGatewayManifest(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /tls pin mismatch/);
      return true;
    },
  );
});

Deno.test("RuntimeAgentHttpClient fails closed when the gateway omits the response identity signature", async () => {
  // The kernel-side middleware is disabled here — the agent must refuse to
  // trust the response.
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({
    agentId: "agent_no_sig",
    provider: "aws",
    capabilities: { providers: ["aws"] },
  });
  const keypair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const pubkeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keypair.publicKey),
  );
  const trustedPubkey = bytesToBase64(pubkeyBytes);
  const fingerprint = await sha256Hex(pubkeyBytes);
  const issuer = new RuntimeAgentGatewayManifestIssuer({
    registry,
    signingKey: keypair.privateKey,
    publicKeyBase64: trustedPubkey,
    publicKeyFingerprint: fingerprint,
    issuer: "operator-control-plane",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const app = new Hono();
  registerRuntimeAgentRoutes(app as never, {
    registry,
    authenticate: () => ({ ok: true, actor: { actorAccountId: "a" } }),
    gatewayManifestIssuer: issuer,
    // gatewayResponseSigner intentionally omitted.
  });
  const fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const path = url.replace(/^http:\/\/kernel\.test/, "");
    return Promise.resolve(app.request(path, init));
  }) as unknown as typeof globalThis.fetch;
  const client = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.test",
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: trustedPubkey,
    providerKind: "aws",
    agentId: "agent_no_sig",
    fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  await client.loadGatewayManifest();
  await assert.rejects(
    () =>
      client.heartbeat({
        agentId: "agent_no_sig",
      }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayResponseSignatureError);
      return true;
    },
  );
});

interface Harness {
  readonly registry: RuntimeAgentRegistry;
  readonly client: RuntimeAgentHttpClient;
  readonly trustedPubkeyBase64: string;
  readonly app: Hono;
  readonly providerKind: string;
  readonly agentId: string;
}

interface SetupHarnessOptions {
  readonly providerKind?: string;
  readonly agentId?: string;
  readonly baseUrl?: string;
  readonly registerAgent?: boolean;
  readonly verifyConnectionPin?: (input: {
    readonly tlsPubkeySha256: string;
    readonly gatewayUrl: string;
  }) => Promise<void> | void;
  readonly tlsPubkeySha256?: string;
  readonly maxResponseClockSkewMs?: number;
  readonly allowedGatewayUrls?: readonly string[];
  readonly trace?: RuntimeAgentTraceContext;
  readonly traceSink?: RuntimeAgentTraceSink;
  readonly spanIdFactory?: () => string;
  readonly onRequest?: (request: Request) => void;
}

async function setupHarness(
  options: SetupHarnessOptions = {},
): Promise<Harness> {
  const providerKind = options.providerKind ?? "aws";
  const agentId = options.agentId ?? "agent_aws_1";
  const baseUrl = options.baseUrl ?? "http://kernel.test";
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: ((): () => string => {
      let i = 0;
      return () => `gen_${i++}`;
    })(),
    defaultLeaseTtlMs: 60_000,
  });
  if (options.registerAgent !== false) {
    await registry.register({
      agentId,
      provider: providerKind,
      capabilities: { providers: [providerKind] },
    });
  }
  const keypair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const pubkeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keypair.publicKey),
  );
  const trustedPubkeyBase64 = bytesToBase64(pubkeyBytes);
  const fingerprint = await sha256Hex(pubkeyBytes);
  const issuer = new RuntimeAgentGatewayManifestIssuer({
    registry,
    signingKey: keypair.privateKey,
    publicKeyBase64: trustedPubkeyBase64,
    publicKeyFingerprint: fingerprint,
    issuer: "operator-control-plane",
    manifestTtlMs: 60 * 60 * 1000,
    tlsPubkeySha256: options.tlsPubkeySha256,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    allowedGatewayUrls: options.allowedGatewayUrls,
  });
  const app = new Hono();
  registerRuntimeAgentRoutes(app as never, {
    registry,
    authenticate: () => ({
      ok: true,
      actor: { actorAccountId: ACTOR.actorAccountId, spaceId: undefined },
    }),
    gatewayManifestIssuer: issuer,
    gatewayResponseSigner: {
      privateKey: keypair.privateKey,
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    },
  });
  const baseUrlPattern = new RegExp(
    `^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    options.onRequest?.(request);
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const path = url.replace(baseUrlPattern, "");
    return Promise.resolve(app.request(path, init));
  }) as unknown as typeof globalThis.fetch;
  const client = new RuntimeAgentHttpClient({
    baseUrl,
    internalServiceSecret: SECRET,
    actor: ACTOR,
    trustedManifestPubkey: trustedPubkeyBase64,
    providerKind,
    agentId,
    verifyConnectionPin: options.verifyConnectionPin,
    fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    maxResponseClockSkewMs: options.maxResponseClockSkewMs,
    trace: options.trace,
    traceSink: options.traceSink,
    spanIdFactory: options.spanIdFactory,
  });
  return {
    registry,
    client,
    trustedPubkeyBase64,
    app,
    providerKind,
    agentId,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? "0000000000000001";
}

// Ensure the routes constant is reachable so this test file remains tied to
// the kernel surface — silence unused-import lint without import flags.
void TAKOSUMI_RUNTIME_AGENT_PATHS;
