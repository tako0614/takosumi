import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TakosumiKernelPluginManifest } from "takosumi-contract";
import {
  installKernelPluginMarketplacePackages,
  type KernelPluginMarketplaceIndex,
  TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION,
} from "./marketplace.ts";
import {
  canonicalTrustedKernelPluginManifest,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
  type TrustedKernelPluginPublisherKey,
} from "./trusted_install.ts";

Deno.test("plugin marketplace installs a digest-pinned signed remote kernel plugin", async () => {
  const moduleSpecifier = "https://market.example/plugins/provider.js";
  const manifest = manifestFixture({
    id: "takos.provider.remote",
    metadata: {
      implementationProvenance: {
        moduleSpecifier,
      },
    },
  });
  const moduleSource = new TextEncoder().encode(
    `export const plugin = { manifest: ${
      JSON.stringify(manifest)
    }, createAdapters() { return {}; } };`,
  );
  const moduleDigest = sha256Digest(moduleSource);
  const signedManifest = {
    ...manifest,
    metadata: {
      implementationProvenance: {
        moduleSpecifier,
        moduleDigest,
      },
    },
  };
  const fixture = await signedEnvelope(signedManifest);

  const result = await installKernelPluginMarketplacePackages({
    indexes: [indexFixture({
      packageRef: signedManifest.id,
      kind: "kernel-plugin",
      version: signedManifest.version,
      manifestEnvelope: fixture.envelope,
      module: { specifier: moduleSpecifier, digest: moduleDigest },
    })],
    packageRefs: [signedManifest.id],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [signedManifest.id],
      trustedKeyIds: [fixture.trustedKey.keyId],
      allowedPublisherIds: [fixture.trustedKey.publisherId],
      allowedPorts: ["provider"],
      allowedExternalIo: ["network"],
      allowedModuleSpecifierPrefixes: ["https://market.example/plugins/"],
      requireImplementationProvenance: true,
      requireRemoteModuleDigest: true,
    },
    environment: "production",
    fetch: fetchFixture(new Map([[moduleSpecifier, moduleSource]])),
  });

  assert.deepEqual(
    result.plugins.map((plugin) => plugin.manifest.id),
    [signedManifest.id],
  );
  assert.equal(result.packages[0].moduleDigest, moduleDigest);
});

Deno.test("plugin marketplace rejects module digest mismatch before install", async () => {
  const moduleSpecifier = "https://market.example/plugins/provider.js";
  const moduleSource = new TextEncoder().encode(
    `export const plugin = { manifest: {}, createAdapters() { return {}; } };`,
  );
  const digest = sha256Digest(moduleSource);
  const manifest = manifestFixture({
    id: "takos.provider.bad-digest",
    metadata: {
      implementationProvenance: {
        moduleSpecifier,
        moduleDigest: digest,
      },
    },
  });
  const fixture = await signedEnvelope(manifest);

  await assert.rejects(
    () =>
      installKernelPluginMarketplacePackages({
        indexes: [indexFixture({
          packageRef: manifest.id,
          kind: "kernel-plugin",
          version: manifest.version,
          manifestEnvelope: fixture.envelope,
          module: {
            specifier: moduleSpecifier,
            digest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        })],
        packageRefs: [manifest.id],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [manifest.id],
          allowedPorts: ["provider"],
          allowedExternalIo: ["network"],
          allowedModuleSpecifierPrefixes: ["https://market.example/plugins/"],
          requireImplementationProvenance: true,
          requireRemoteModuleDigest: true,
        },
        environment: "production",
        fetch: fetchFixture(new Map([[moduleSpecifier, moduleSource]])),
      }),
    /signed moduleDigest does not match marketplace module/,
  );
});

Deno.test("plugin marketplace installs executable catalog hook packages", async () => {
  const moduleSpecifier = "https://market.example/hooks/risk.js";
  const manifest = manifestFixture({
    id: "takos.hook.risk-gate",
    capabilities: [{
      port: "catalog-hook",
      kind: "catalog-release-wal-hook",
      externalIo: ["network"],
    }],
  });
  const moduleSource = new TextEncoder().encode(`
    export const catalogHookPackage = {
      id: "takos.hook.risk-gate",
      version: "1.0.0",
      stages: ["pre-commit"],
      run() {
        return Promise.resolve({ ok: true, message: "accepted" });
      },
    };
  `);
  const moduleDigest = sha256Digest(moduleSource);
  const signedManifest = {
    ...manifest,
    metadata: {
      implementationProvenance: {
        moduleSpecifier,
        moduleDigest,
      },
    },
  };
  const fixture = await signedEnvelope(signedManifest);

  const result = await installKernelPluginMarketplacePackages({
    indexes: [indexFixture({
      packageRef: signedManifest.id,
      kind: "executable-hook-package",
      version: signedManifest.version,
      manifestEnvelope: fixture.envelope,
      module: { specifier: moduleSpecifier, digest: moduleDigest },
    })],
    packageRefs: [signedManifest.id],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [signedManifest.id],
      allowedPorts: ["catalog-hook"],
      allowedExternalIo: ["network"],
      allowedModuleSpecifierPrefixes: ["https://market.example/hooks/"],
      requireImplementationProvenance: true,
      requireRemoteModuleDigest: true,
    },
    environment: "production",
    fetch: fetchFixture(new Map([[moduleSpecifier, moduleSource]])),
  });

  assert.deepEqual(
    result.hookPackages.map((hookPackage) => hookPackage.id),
    [signedManifest.id],
  );
  const hookResult = await result.hookPackages[0].run({
    spaceId: "space:test",
    stage: "pre-commit",
    operationPlanDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    desiredSnapshotDigest:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    operations: [],
  });
  assert.deepEqual(hookResult, { ok: true, message: "accepted" });
});

function manifestFixture(
  overrides: Partial<TakosumiKernelPluginManifest> = {},
): TakosumiKernelPluginManifest {
  return {
    id: "takos.provider.remote",
    name: "Remote Provider",
    version: "1.0.0",
    kernelApiVersion: "2026-04-29",
    capabilities: [{
      port: "provider",
      kind: "provider-control-plane",
      externalIo: ["network"],
    }],
    ...overrides,
  };
}

function indexFixture(
  packageRecord: KernelPluginMarketplaceIndex["packages"][number],
): KernelPluginMarketplaceIndex {
  return {
    schemaVersion: TAKOSUMI_PLUGIN_MARKETPLACE_SCHEMA_VERSION,
    marketplaceId: "market:test",
    generatedAt: "2026-05-05T00:00:00.000Z",
    packages: [packageRecord],
  };
}

async function signedEnvelope(manifest: TakosumiKernelPluginManifest): Promise<{
  readonly trustedKey: TrustedKernelPluginPublisherKey;
  readonly envelope: KernelPluginMarketplaceIndex["packages"][number][
    "manifestEnvelope"
  ];
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(canonicalTrustedKernelPluginManifest(manifest)),
  );
  return {
    trustedKey: {
      keyId: "publisher-key:test",
      publisherId: "publisher:test",
      publicKeyJwk,
    },
    envelope: {
      manifest,
      signature: {
        alg: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
        keyId: "publisher-key:test",
        value: encodeBase64Url(new Uint8Array(signature)),
      },
    },
  };
}

function fetchFixture(
  sources: ReadonlyMap<string, Uint8Array>,
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    const source = sources.get(url);
    if (!source) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    return Promise.resolve(
      new Response(toArrayBuffer(source), { status: 200 }),
    );
  }) as typeof fetch;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}
