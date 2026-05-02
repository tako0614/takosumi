import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import {
  type GatewayManifest,
  TAKOS_GATEWAY_IDENTITY_NONCE_HEADER,
  TAKOS_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
  TAKOS_GATEWAY_IDENTITY_SIGNATURE_HEADER,
  TAKOS_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
  TAKOS_INTERNAL_REQUEST_ID_HEADER,
  type TakosActorContext,
  verifyGatewayResponseSignature,
} from "takosumi-contract";
import { signTakosInternalRequest } from "takosumi-contract/internal-rpc";
import { InMemoryRuntimeAgentRegistry } from "../agents/registry.ts";
import type { RuntimeAgentRegistry } from "../agents/types.ts";
import {
  InMemoryRuntimeNetworkPolicyStore,
  InMemoryServiceGrantStore,
  InMemoryWorkloadIdentityStore,
} from "../domains/network/mod.ts";
import {
  WorkerAuthzService,
  type WorkerAuthzStores,
} from "../services/security/mod.ts";
import {
  registerRuntimeAgentRoutes,
  type RuntimeAgentAuthResult,
  TAKOS_PAAS_RUNTIME_AGENT_PATHS,
} from "./runtime_agent_routes.ts";

Deno.test("runtime agent routes enroll, heartbeat, lease, complete, and drain", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("a", "lease"),
  });
  await registry.enqueueWork({
    workId: "work_1",
    kind: "deploy.apply",
    provider: "local",
    priority: 10,
    payload: { activationId: "act_1" },
  });
  const app = createApp(registry);

  const enroll = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({
      agentId: "agent_1",
      provider: "local",
      endpoint: "http://agent.local",
      capabilities: { providers: ["local"], labels: { region: "test" } },
      metadata: { version: "1.0.0" },
    }),
  });
  assert.equal(enroll.status, 201);
  assert.equal((await enroll.json()).agent.id, "agent_1");

  const heartbeat = await app.request(agentPath("heartbeat", "agent_1"), {
    method: "POST",
    body: JSON.stringify({ metadata: { load: 1 } }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).agent.metadata.load, 1);

  const lease = await app.request(agentPath("lease", "agent_1"), {
    method: "POST",
    body: JSON.stringify({ leaseTtlMs: 60_000 }),
  });
  assert.equal(lease.status, 200);
  const leaseBody = await lease.json();
  assert.equal(leaseBody.lease.workId, "work_1");
  assert.equal(leaseBody.lease.agentId, "agent_1");

  const report = await app.request(agentPath("report", "agent_1"), {
    method: "POST",
    body: JSON.stringify({
      leaseId: leaseBody.lease.id,
      status: "completed",
      result: { operationId: "op_1", providerId: "local" },
    }),
  });
  assert.equal(report.status, 200);
  assert.equal((await report.json()).work.status, "completed");
  const completed = await registry.getWork("work_1");
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.result, {
    operationId: "op_1",
    providerId: "local",
  });

  const drain = await app.request(agentPath("drain", "agent_1"), {
    method: "POST",
    body: JSON.stringify({ drainRequestedAt: "2026-04-27T00:01:00.000Z" }),
  });
  assert.equal(drain.status, 200);
  const drained = await drain.json();
  assert.equal(drained.agent.status, "draining");
  assert.equal(drained.agent.drainRequestedAt, "2026-04-27T00:01:00.000Z");
});

Deno.test("runtime agent routes report failed leases with retry", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    idGenerator: sequence("x"),
  });
  await registry.register({ agentId: "agent_1", provider: "local" });
  await registry.enqueueWork({
    workId: "work_1",
    kind: "runtime.restart",
    provider: "local",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_1" });
  assert.ok(lease);
  const app = createApp(registry);

  const response = await app.request(agentPath("report", "agent_1"), {
    method: "POST",
    body: JSON.stringify({
      leaseId: lease.id,
      status: "failed",
      reason: "temporary capacity",
      retry: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).work.status, "queued");
  const work = await registry.getWork("work_1");
  assert.equal(work?.failureReason, "temporary capacity");
  assert.equal(work?.leaseId, undefined);
});

Deno.test("runtime agent routes return auth and registry errors", async () => {
  const denied = createApp(new InMemoryRuntimeAgentRegistry(), () => ({
    ok: false,
    status: 403,
    error: "forbidden",
  }));
  const deniedResponse = await denied.request(
    TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll,
    {
      method: "POST",
      body: JSON.stringify({ provider: "local" }),
    },
  );
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), {
    error: {
      code: "permission_denied",
      message: "forbidden",
    },
  });

  const app = createApp(new InMemoryRuntimeAgentRegistry());
  const invalidEnroll = await app.request(
    TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  assert.equal(invalidEnroll.status, 400);
  assert.deepEqual(await invalidEnroll.json(), {
    error: {
      code: "invalid_argument",
      message: "provider is required",
    },
  });

  const missingAgent = await app.request(agentPath("heartbeat", "missing"), {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(missingAgent.status, 404);
  assert.equal((await missingAgent.json()).error.code, "not_found");
});

Deno.test("runtime agent routes fail closed without signed auth or explicit authenticator", async () => {
  const app: HonoApp = new Hono();
  registerRuntimeAgentRoutes(app, {
    registry: new InMemoryRuntimeAgentRegistry(),
  });

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({ provider: "local" }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "unauthenticated",
      message: "internal service secret missing",
    },
  });
});

Deno.test("runtime agent routes accept progress reports and extend the lease", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("a", "b", "c"),
    defaultLeaseTtlMs: 30_000,
  });
  await registry.register({ agentId: "agent_progress", provider: "aws" });
  await registry.enqueueWork({
    workId: "work_progress",
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_progress" });
  assert.ok(lease);
  const app = createApp(registry);

  const response = await app.request(agentPath("report", "agent_progress"), {
    method: "POST",
    body: JSON.stringify({
      leaseId: lease.id,
      status: "progress",
      progress: { stage: "rds.creating", percent: 25 },
      extendUntil: "2026-04-27T01:00:00.000Z",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.work.status, "leased");
  const work = await registry.getWork("work_progress");
  assert.deepEqual(work?.lastProgress, {
    stage: "rds.creating",
    percent: 25,
  });
  assert.equal(work?.leaseExpiresAt, "2026-04-27T00:15:00.000Z");
});

Deno.test("runtime agent routes reject path agent identity mismatches", async () => {
  const registry = new InMemoryRuntimeAgentRegistry();
  await registry.register({ agentId: "agent_a", provider: "aws" });
  const app = createApp(registry, () => ({
    ok: true,
    actor: {
      actorAccountId: "acct_test_agent",
      spaceId: "space_test",
      principalKind: "agent",
      agentId: "agent_b",
    },
    workloadIdentityId: "agent_b",
  }));

  const response = await app.request(agentPath("heartbeat", "agent_a"), {
    method: "POST",
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "permission_denied");
});

Deno.test("runtime agent routes ignore agent-supplied clocks and cap lease TTLs", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: sequence("l"),
  });
  await registry.register({ agentId: "agent_clock", provider: "aws" });
  await registry.enqueueWork({
    workId: "work_clock",
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const app = createApp(registry);

  const heartbeat = await app.request(agentPath("heartbeat", "agent_clock"), {
    method: "POST",
    body: JSON.stringify({
      heartbeatAt: "2099-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(
    (await heartbeat.json()).agent.lastHeartbeatAt,
    "2026-04-27T00:00:00.000Z",
  );

  const lease = await app.request(agentPath("lease", "agent_clock"), {
    method: "POST",
    body: JSON.stringify({
      now: "2099-01-01T00:00:00.000Z",
      leaseTtlMs: 24 * 60 * 60 * 1000,
    }),
  });
  assert.equal(lease.status, 200);
  const body = await lease.json();
  assert.equal(body.lease.leasedAt, "2026-04-27T00:00:00.000Z");
  assert.equal(body.lease.expiresAt, "2026-04-27T00:15:00.000Z");
});

Deno.test("runtime agent routes reject reports with unknown status", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    idGenerator: sequence("a", "b", "c"),
  });
  await registry.register({ agentId: "agent_x", provider: "aws" });
  await registry.enqueueWork({
    workId: "work_x",
    kind: "provider.aws.x",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_x" });
  assert.ok(lease);
  const app = createApp(registry);
  const response = await app.request(agentPath("report", "agent_x"), {
    method: "POST",
    body: JSON.stringify({
      leaseId: lease.id,
      status: "weird",
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
});

Deno.test("runtime agent routes return renewAfterMs on enroll", async () => {
  const app = createApp(new InMemoryRuntimeAgentRegistry());
  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({ provider: "aws" }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(typeof body.renewAfterMs === "number");
  assert.ok(body.renewAfterMs > 0);
});

Deno.test("runtime agent routes return common envelope for uncaught errors", async () => {
  class ThrowingRegistry extends InMemoryRuntimeAgentRegistry {
    override register(): never {
      throw new Error("registry failed");
    }
  }
  const app = createApp(new ThrowingRegistry());

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({ provider: "local" }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });
});

Deno.test("runtime agent routes bind gateway response signatures to request id and nonce", async () => {
  const keypair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keypair.publicKey),
  );
  const publicKeyBase64 = bytesToBase64(publicKey);
  const manifest: GatewayManifest = {
    gatewayUrl: "https://gateway.example.test",
    issuer: "test",
    agentId: "agent_1",
    issuedAt: "2026-04-30T00:00:00.000Z",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["local"],
    pubkey: publicKeyBase64,
    pubkeyFingerprint: await sha256Hex(publicKey),
  };
  const app: HonoApp = new Hono();
  const registry = new InMemoryRuntimeAgentRegistry();
  await registry.register({ agentId: "agent_1", provider: "local" });
  registerRuntimeAgentRoutes(app, {
    registry,
    authenticate: testRuntimeAgentAuthenticator,
    gatewayResponseSigner: {
      privateKey: keypair.privateKey,
      clock: () => new Date("2026-04-30T00:30:00.000Z"),
    },
  });

  const response = await app.request(agentPath("heartbeat", "agent_1"), {
    method: "POST",
    headers: { [TAKOS_INTERNAL_REQUEST_ID_HEADER]: "req_gateway_response" },
    body: JSON.stringify({}),
  });
  const body = await response.clone().text();
  const signature = response.headers.get(
    TAKOS_GATEWAY_IDENTITY_SIGNATURE_HEADER,
  );
  const timestamp = response.headers.get(
    TAKOS_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
  );
  const requestId = response.headers.get(
    TAKOS_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
  );
  const nonce = response.headers.get(TAKOS_GATEWAY_IDENTITY_NONCE_HEADER);

  assert.equal(response.status, 200);
  assert.equal(requestId, "req_gateway_response");
  assert.ok(signature);
  assert.ok(timestamp);
  assert.ok(nonce);
  assert.equal(
    await verifyGatewayResponseSignature({
      manifest,
      method: "POST",
      path: agentPath("heartbeat", "agent_1"),
      body,
      signature,
      timestamp,
      requestId,
      nonce,
      now: () => new Date("2026-04-30T00:30:30.000Z"),
    }),
    true,
  );
});

Deno.test("runtime agent routes require signed workload identity service grants when wired", async () => {
  const secret = "agent-secret";
  const stores: WorkerAuthzStores = {
    workloadIdentities: new InMemoryWorkloadIdentityStore(),
    serviceGrants: new InMemoryServiceGrantStore(),
    runtimeNetworkPolicies: new InMemoryRuntimeNetworkPolicyStore(),
  };
  await stores.workloadIdentities.put({
    id: "wi_agent",
    spaceId: "space_agent",
    groupId: "runtime",
    componentName: "runtime-agent",
    subject: "agent:runtime-agent",
    claims: { aud: "takosumi" },
    issuedAt: "2026-04-27T00:00:00.000Z",
  });
  const app: HonoApp = new Hono();
  registerRuntimeAgentRoutes(app, {
    registry: new InMemoryRuntimeAgentRegistry(),
    getInternalServiceSecret: () => secret,
    security: new WorkerAuthzService({
      stores,
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    }),
  });
  const body = JSON.stringify({
    agentId: "agent_1",
    provider: "local",
    spaceId: "space_agent",
    groupId: "runtime",
  });

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll,
      body,
      actor: {
        actorAccountId: "acct_runtime",
        roles: ["admin"],
        requestId: "req_agent_enroll",
        principalKind: "agent",
        agentId: "wi_agent",
        spaceId: "space_agent",
      },
    }),
    body,
  });

  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error.message,
    "Service grant is required",
  );
});

function createApp(
  registry: RuntimeAgentRegistry,
  authenticate?: (request: Request) => RuntimeAgentAuthResult,
): HonoApp {
  const app: HonoApp = new Hono();
  registerRuntimeAgentRoutes(app, {
    registry,
    authenticate: authenticate ?? testRuntimeAgentAuthenticator,
  });
  return app;
}

function testRuntimeAgentAuthenticator(
  request: Request,
): RuntimeAgentAuthResult {
  const path = request ? new URL(request.url).pathname : "";
  const agentId = path.match(/\/runtime\/agents\/([^/]+)\//)?.[1];
  return {
    ok: true,
    actor: {
      actorAccountId: "acct_test_agent",
      spaceId: "space_test",
      principalKind: agentId ? "agent" : "service",
      ...(agentId ? { agentId } : { serviceId: "test_operator" }),
    },
    ...(agentId ? { workloadIdentityId: agentId } : {}),
  };
}

function agentPath(
  kind: "heartbeat" | "lease" | "report" | "drain",
  agentId: string,
): string {
  return TAKOS_PAAS_RUNTIME_AGENT_PATHS[kind].replace(":agentId", agentId);
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated_${index}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function signedHeaders(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly actor: TakosActorContext;
}): Promise<Headers> {
  const signed = await signTakosInternalRequest({
    ...input,
    timestamp: new Date().toISOString(),
    caller: input.actor.serviceId ?? input.actor.agentId ?? "takos-test",
    audience: "takosumi",
  });
  return new Headers({
    ...signed.headers,
    "content-type": "application/json",
  });
}
