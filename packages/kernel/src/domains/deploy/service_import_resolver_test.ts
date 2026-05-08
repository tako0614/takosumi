import assert from "node:assert/strict";
import type { ServiceDescriptor } from "takosumi-contract";
import {
  __serviceImportResolverTestHooks,
  resolveManifestServiceImports,
  serviceDescriptorDigest,
  serviceDescriptorSigningBytes,
} from "./service_import_resolver.ts";

const NOW = "2026-05-09T00:00:00.000Z";

Deno.test("service import resolver fetches and verifies signed descriptors", async () => {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const descriptor = await signedDescriptor(keyPair.privateKey, {
    id: "takosumi.account.auth",
    version: "v1",
    contract: "takosumi.account.auth@v1",
    endpoints: [{
      role: "oidc-issuer",
      url: "https://accounts.example.test",
      path: "/",
    }],
    metadata: { pairwiseSubjectMode: true },
    signature: "",
    publishedAt: NOW,
    expiresAt: "2026-05-09T00:05:00.000Z",
    providerInstance: "provider_takosumi_cloud",
  });
  const publicKey = await publicKeyBase64(keyPair.publicKey);
  const calls: Request[] = [];

  const result = await resolveManifestServiceImports({
    apiVersion: "1.0",
    kind: "Manifest",
    serviceResolvers: [{
      kind: "anchor",
      url: "https://anchor.example.test/v1/services/",
      publicKey,
    }],
    imports: [{
      alias: "account-auth",
      service: "takosumi.account.auth@v1",
      refreshPolicy: { kind: "ttl", ttl: "300s" },
    }],
    resources: [{
      shape: "object-store@v1",
      name: "assets",
      provider: "@takos/selfhost-filesystem",
      spec: { name: "assets" },
    }],
  }, {
    now: () => NOW,
    deploymentId: "deployment_1",
    fetch: (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(Response.json(descriptor));
    },
  });

  assert.equal(result.ok, true);
  const resolved = result.ok ? result.value[0] : undefined;
  assert.equal(
    calls[0].url,
    "https://anchor.example.test/v1/services/takosumi.account.auth@v1",
  );
  assert.equal(calls[0].headers.get("accept"), "application/json");
  assert.equal(resolved?.alias, "account-auth");
  assert.equal(resolved?.serviceId, "takosumi.account.auth@v1");
  assert.equal(resolved?.descriptorDigest, serviceDescriptorDigest(descriptor));
  assert.equal(resolved?.share.toDeploymentId, "deployment_1");
  assert.equal(resolved?.share.auditTrail.length, 2);
  assert.equal(
    resolved?.share.auditTrail[1].prevHash,
    resolved?.share.auditTrail[0].hash,
  );
});

Deno.test("service import resolver rejects invalid descriptor signatures", async () => {
  const trusted = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const attacker = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const descriptor = await signedDescriptor(attacker.privateKey, {
    id: "takosumi.account.auth",
    version: "v1",
    contract: "takosumi.account.auth@v1",
    endpoints: [{
      role: "oidc-issuer",
      url: "https://accounts.example.test",
      path: "/",
    }],
    metadata: {},
    signature: "",
    publishedAt: NOW,
    expiresAt: "2026-05-09T00:05:00.000Z",
    providerInstance: "provider_takosumi_cloud",
  });

  const result = await resolveManifestServiceImports({
    imports: [{ alias: "account-auth", service: "takosumi.account.auth@v1" }],
    serviceResolvers: [{
      kind: "anchor",
      url: "https://anchor.example.test/v1/services/",
      publicKey: await publicKeyBase64(trusted.publicKey),
    }],
  }, {
    now: () => NOW,
    fetch: () => Promise.resolve(Response.json(descriptor)),
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /signature invalid/);
});

Deno.test("service import resolver rejects contract mismatches and expired descriptors", async () => {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const publicKey = await publicKeyBase64(keyPair.publicKey);
  const mismatch = await signedDescriptor(keyPair.privateKey, {
    id: "takosumi.account.billing",
    version: "v1",
    contract: "takosumi.account.billing@v1",
    endpoints: [{
      role: "subscription-api",
      url: "https://billing.example.test",
      path: "/",
    }],
    metadata: {},
    signature: "",
    publishedAt: NOW,
    expiresAt: "2026-05-09T00:05:00.000Z",
    providerInstance: "provider_takosumi_cloud",
  });
  const expired = await signedDescriptor(keyPair.privateKey, {
    id: "takosumi.account.auth",
    version: "v1",
    contract: "takosumi.account.auth@v1",
    endpoints: [{
      role: "oidc-issuer",
      url: "https://accounts.example.test",
      path: "/",
    }],
    metadata: {},
    signature: "",
    publishedAt: "2026-05-08T23:50:00.000Z",
    expiresAt: "2026-05-08T23:55:00.000Z",
    providerInstance: "provider_takosumi_cloud",
  });
  const responses = [mismatch, expired];
  const result = await resolveManifestServiceImports({
    imports: [{ alias: "account-auth", service: "takosumi.account.auth@v1" }],
    serviceResolvers: [{
      kind: "anchor",
      url: "https://anchor-a.example.test/v1/services/",
      publicKey,
    }, {
      kind: "anchor",
      url: "https://anchor-b.example.test/v1/services/",
      publicKey,
    }],
  }, {
    now: () => NOW,
    fetch: () => Promise.resolve(Response.json(responses.shift())),
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /does not match import/);
  assert.match(result.ok ? "" : result.error, /descriptor is expired/);
});

async function signedDescriptor(
  privateKey: CryptoKey,
  descriptor: ServiceDescriptor,
): Promise<ServiceDescriptor> {
  const unsigned = { ...descriptor, signature: "" };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toArrayBuffer(serviceDescriptorSigningBytes(unsigned)),
  );
  return {
    ...unsigned,
    signature: __serviceImportResolverTestHooks.bytesToBase64(
      new Uint8Array(signature),
    ),
  };
}

async function publicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return __serviceImportResolverTestHooks.bytesToBase64(new Uint8Array(raw));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
