import assert from "node:assert/strict";
import {
  canonicalGatewayManifest,
  canonicalGatewayResponse,
  type GatewayManifest,
  signGatewayManifest,
  signGatewayResponse,
  verifyGatewayManifest,
  verifyGatewayResponseSignature,
} from "./runtime-agent.ts";

async function generateTrustedKeypair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKeyBase64: string;
  readonly fingerprintHex: string;
}> {
  const keypair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keypair.publicKey),
  );
  const buf = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buf).set(raw);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const fingerprintHex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  let bin = "";
  for (let i = 0; i < raw.length; i += 1) bin += String.fromCharCode(raw[i]);
  return {
    privateKey: keypair.privateKey,
    publicKeyBase64: btoa(bin),
    fingerprintHex,
  };
}

Deno.test("verifyGatewayManifest accepts a freshly signed manifest from the trusted key", async () => {
  const trusted = await generateTrustedKeypair();
  const manifest: GatewayManifest = {
    gatewayUrl: "https://gateway.example.com",
    issuer: "operator-control-plane",
    agentId: "agent_1",
    issuedAt: "2026-04-30T00:00:00.000Z",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["aws.ecs-fargate"],
    pubkey: trusted.publicKeyBase64,
    pubkeyFingerprint: trusted.fingerprintHex,
  };
  const signed = await signGatewayManifest(manifest, trusted.privateKey);
  const result = await verifyGatewayManifest({
    signed,
    trustedPubkey: trusted.publicKeyBase64,
    expectedGatewayUrl: "https://gateway.example.com",
    expectedAgentId: "agent_1",
    expectedProviderKind: "aws.ecs-fargate",
    now: () => new Date("2026-04-30T00:30:00.000Z"),
  });
  assert.equal(result.ok, true);
});

Deno.test("verifyGatewayManifest rejects a manifest with a swapped gatewayUrl", async () => {
  const trusted = await generateTrustedKeypair();
  const manifest: GatewayManifest = {
    gatewayUrl: "https://gateway.example.com",
    issuer: "operator-control-plane",
    agentId: "agent_1",
    issuedAt: "2026-04-30T00:00:00.000Z",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["aws.ecs-fargate"],
    pubkey: trusted.publicKeyBase64,
    pubkeyFingerprint: trusted.fingerprintHex,
  };
  const signed = await signGatewayManifest(manifest, trusted.privateKey);
  // Tamper with the gatewayUrl post-signing.
  const tampered = {
    ...signed,
    manifest: { ...signed.manifest, gatewayUrl: "https://attacker.example" },
  };
  const result = await verifyGatewayManifest({
    signed: tampered,
    trustedPubkey: trusted.publicKeyBase64,
    expectedGatewayUrl: "https://attacker.example",
    now: () => new Date("2026-04-30T00:30:00.000Z"),
  });
  assert.equal(result.ok, false);
});

Deno.test("verifyGatewayResponseSignature round-trips for a freshly signed payload", async () => {
  const trusted = await generateTrustedKeypair();
  const manifest: GatewayManifest = {
    gatewayUrl: "https://gateway.example.com",
    issuer: "operator-control-plane",
    agentId: "agent_1",
    issuedAt: "2026-04-30T00:00:00.000Z",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["aws.ecs-fargate"],
    pubkey: trusted.publicKeyBase64,
    pubkeyFingerprint: trusted.fingerprintHex,
  };
  const sig = await signGatewayResponse({
    privateKey: trusted.privateKey,
    method: "POST",
    path: "/api/internal/v1/runtime/agents/agent_1/heartbeat",
    body: '{"agent":{"id":"agent_1"}}',
    timestamp: "2026-04-30T00:30:00.000Z",
    requestId: "req_agent_heartbeat",
    nonce: "nonce_agent_heartbeat",
  });
  const ok = await verifyGatewayResponseSignature({
    manifest,
    method: "POST",
    path: "/api/internal/v1/runtime/agents/agent_1/heartbeat",
    body: '{"agent":{"id":"agent_1"}}',
    signature: sig,
    timestamp: "2026-04-30T00:30:00.000Z",
    requestId: "req_agent_heartbeat",
    nonce: "nonce_agent_heartbeat",
    now: () => new Date("2026-04-30T00:30:30.000Z"),
  });
  assert.equal(ok, true);

  const replayedForOtherRequest = await verifyGatewayResponseSignature({
    manifest,
    method: "POST",
    path: "/api/internal/v1/runtime/agents/agent_1/heartbeat",
    body: '{"agent":{"id":"agent_1"}}',
    signature: sig,
    timestamp: "2026-04-30T00:30:00.000Z",
    requestId: "req_other",
    nonce: "nonce_agent_heartbeat",
    now: () => new Date("2026-04-30T00:30:30.000Z"),
  });
  assert.equal(replayedForOtherRequest, false);
});

Deno.test("canonicalGatewayResponse binds method/path/body/timestamp/request id/nonce", () => {
  const a = canonicalGatewayResponse({
    method: "POST",
    path: "/x",
    bodySha256: "abc",
    timestamp: "2026-04-30T00:00:00.000Z",
    requestId: "req_1",
    nonce: "nonce_1",
  });
  const b = canonicalGatewayResponse({
    method: "POST",
    path: "/x",
    bodySha256: "abc",
    timestamp: "2026-04-30T00:00:01.000Z", // off-by-1s
    requestId: "req_1",
    nonce: "nonce_1",
  });
  const c = canonicalGatewayResponse({
    method: "POST",
    path: "/x",
    bodySha256: "abc",
    timestamp: "2026-04-30T00:00:00.000Z",
    requestId: "req_2",
    nonce: "nonce_1",
  });
  assert.notEqual(new TextDecoder().decode(a), new TextDecoder().decode(b));
  assert.notEqual(new TextDecoder().decode(a), new TextDecoder().decode(c));
});

Deno.test("canonicalGatewayManifest is deterministic regardless of key order", () => {
  const a = canonicalGatewayManifest({
    gatewayUrl: "https://x",
    issuer: "i",
    agentId: "a",
    issuedAt: "2026-04-30T00:00:00.000Z",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["aws"],
    pubkey: "pk",
    pubkeyFingerprint: "fp",
  });
  // Same fields, different declaration order.
  const b = canonicalGatewayManifest({
    pubkey: "pk",
    issuer: "i",
    issuedAt: "2026-04-30T00:00:00.000Z",
    pubkeyFingerprint: "fp",
    expiresAt: "2026-04-30T01:00:00.000Z",
    allowedProviderKinds: ["aws"],
    agentId: "a",
    gatewayUrl: "https://x",
  });
  assert.equal(
    new TextDecoder().decode(a),
    new TextDecoder().decode(b),
  );
});
