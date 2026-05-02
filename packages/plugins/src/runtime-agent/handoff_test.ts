/**
 * E2e tests for the provider runtime-agent handoff bridge. Exercises the
 * kernel registry → handoff hook → remote agent loop path for AWS, GCP, and
 * k8s style work items.
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  InMemoryRuntimeAgentRegistry,
  RuntimeAgentGatewayManifestIssuer,
} from "takosumi-contract";
import { registerRuntimeAgentRoutes } from "takosumi-contract";
import type { TakosumiActorContext } from "takosumi-contract";
import { RuntimeAgentHttpClient } from "./client.ts";
import { createProviderHandoff, shouldHandoff } from "./handoff.ts";
import {
  executorFromProviderCall,
  type RuntimeAgentExecutor,
  RuntimeAgentLoop,
} from "./loop.ts";

const ACTOR: TakosumiActorContext = {
  actorAccountId: "acct_handoff_e2e",
  roles: ["service"],
  requestId: "req_handoff_e2e",
  principalKind: "service",
  serviceId: "runtime-agent",
};

Deno.test("createProviderHandoff routes AWS RDS create through the kernel queue", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const handoff = createProviderHandoff({ registry, provider: "aws" });
  const workId = await handoff.enqueue({
    descriptor: "rds.create",
    desiredStateId: "desired_rds_1",
    targetId: "primary",
    idempotencyKey: "aws-rds-primary",
    payload: { engine: "postgres", version: "16" },
  });
  const work = await registry.getWork(workId);
  assert.equal(work?.kind, "provider.aws.rds.create");
  assert.equal(work?.provider, "aws");
  assert.equal(work?.payload.engine, "postgres");
  assert.equal(work?.idempotencyKey, "aws-rds-primary");
});

Deno.test("createProviderHandoff dedupes by idempotencyKey", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const handoff = createProviderHandoff({ registry, provider: "gcp" });
  const a = await handoff.enqueue({
    descriptor: "cloud-sql.create",
    desiredStateId: "ds_1",
    idempotencyKey: "gcp-csql-ds_1",
  });
  const b = await handoff.enqueue({
    descriptor: "cloud-sql.create",
    desiredStateId: "ds_1",
    idempotencyKey: "gcp-csql-ds_1",
  });
  assert.equal(a, b);
});

Deno.test("shouldHandoff returns true beyond the threshold", () => {
  assert.equal(shouldHandoff(31_000), true);
  assert.equal(shouldHandoff(29_000), false);
  assert.equal(shouldHandoff(60_000, 45_000), true);
  assert.equal(shouldHandoff(Number.NaN), false);
});

Deno.test("AWS handoff e2e: kernel enqueues, agent leases and reports completion", async () => {
  await runProviderHandoffE2e({
    provider: "aws",
    descriptor: "rds.create",
    expectedKind: "provider.aws.rds.create",
    payload: { engine: "postgres" },
    expectedResult: { ok: true, descriptor: "rds.create" },
  });
});

Deno.test("GCP handoff e2e: kernel enqueues, agent leases and reports completion", async () => {
  await runProviderHandoffE2e({
    provider: "gcp",
    descriptor: "cloud-run.deploy",
    expectedKind: "provider.gcp.cloud-run.deploy",
    payload: { service: "web" },
    expectedResult: { ok: true, descriptor: "cloud-run.deploy" },
  });
});

Deno.test("k8s handoff e2e: kernel enqueues, agent leases and reports completion", async () => {
  await runProviderHandoffE2e({
    provider: "k8s",
    descriptor: "deployment.apply",
    expectedKind: "provider.k8s.deployment.apply",
    payload: { namespace: "tenant-123" },
    expectedResult: { ok: true, descriptor: "deployment.apply" },
  });
});

interface ProviderHandoffE2eInput {
  readonly provider: string;
  readonly descriptor: string;
  readonly expectedKind: string;
  readonly payload: Record<string, unknown>;
  readonly expectedResult: Record<string, unknown>;
}

async function runProviderHandoffE2e(
  input: ProviderHandoffE2eInput,
): Promise<void> {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    defaultLeaseTtlMs: 60_000,
  });
  const agentId = `agent_${input.provider}`;
  await registry.register({
    agentId,
    provider: input.provider,
    capabilities: { providers: [input.provider] },
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
  const fetch = ((
    requestInput: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof requestInput === "string"
      ? requestInput
      : requestInput instanceof URL
      ? requestInput.toString()
      : requestInput.url;
    const path = url.replace(/^http:\/\/kernel\.test/, "");
    return Promise.resolve(app.request(path, init));
  }) as unknown as typeof globalThis.fetch;
  const client = new RuntimeAgentHttpClient({
    baseUrl: "http://kernel.test",
    internalServiceSecret: "secret",
    actor: ACTOR,
    trustedManifestPubkey: trustedPubkey,
    providerKind: input.provider,
    agentId,
    fetch,
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  // 1. provider plugin hits its long-running threshold and hands off.
  const handoff = createProviderHandoff({ registry, provider: input.provider });
  const workId = await handoff.enqueue({
    descriptor: input.descriptor,
    desiredStateId: "desired_1",
    targetId: "target_1",
    payload: input.payload,
    idempotencyKey: `${input.provider}-${input.descriptor}-target_1`,
  });

  // 2. remote agent enrolls and pulls the lease.
  const executors: Record<string, RuntimeAgentExecutor> = {
    [input.expectedKind]: executorFromProviderCall((payload) =>
      Promise.resolve({
        ok: true,
        descriptor: payload.payload.descriptor as string,
      })
    ),
  };
  const loop = new RuntimeAgentLoop({
    client,
    agentId: `agent_${input.provider}`,
    provider: input.provider,
    capabilities: { providers: [input.provider] },
    executors,
  });
  await loop.enroll();
  const processed = await loop.runOnce();
  assert.equal(processed, true, `agent did not process ${input.provider} work`);

  const work = await registry.getWork(workId);
  assert.equal(work?.kind, input.expectedKind);
  assert.equal(work?.status, "completed");
  assert.deepEqual(work?.result, undefined); // completion does not record result on the registry but report does carry it.
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
