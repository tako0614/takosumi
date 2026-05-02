import assert from "node:assert/strict";
import type { TakosPaaSKernelPluginManifest } from "takosumi-contract";
import {
  canonicalTrustedKernelPluginManifest,
  installTrustedKernelPlugins,
  TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
} from "./trusted_install.ts";
import type { TakosPaaSKernelPlugin } from "./types.ts";

Deno.test("trusted kernel plugin install verifies signed manifest and policy before enabling implementation", async () => {
  const fixture = await signedFixture();
  const installed = await installTrustedKernelPlugins({
    envelopes: [fixture.envelope],
    availablePlugins: [fixture.plugin],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [fixture.plugin.manifest.id],
      trustedKeyIds: [fixture.trustedKey.keyId],
      allowedPublisherIds: [fixture.trustedKey.publisherId],
      allowedPorts: ["provider"],
      allowedExternalIo: ["network", "provider-control-plane"],
    },
    environment: "production",
  });

  assert.equal(installed[0]?.manifest, fixture.plugin.manifest);
  assert.deepEqual(installed[0]?.trustedInstall, {
    source: "trusted-signed-manifest",
    keyId: fixture.trustedKey.keyId,
    publisherId: fixture.trustedKey.publisherId,
    signatureAlgorithm: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
  });
});

Deno.test("trusted kernel plugin install rejects tampered signed manifests", async () => {
  const fixture = await signedFixture();

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [{
          ...fixture.envelope,
          manifest: {
            ...fixture.envelope.manifest,
            name: "Tampered Plugin",
          },
        }],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /manifest signature is invalid/,
  );
});

Deno.test("trusted kernel plugin install rejects plugins outside enablement policy", async () => {
  const fixture = await signedFixture();

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: ["takos.other.plugin"],
        },
        environment: "production",
      }),
    /not enabled by install policy/,
  );
});

Deno.test("trusted kernel plugin install rejects incompatible kernel API manifests", async () => {
  const fixture = await signedFixture({
    kernelApiVersion: "2026-01-01",
  });

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /unsupported kernel API 2026-01-01/,
  );
});

Deno.test("trusted kernel plugin install rejects mismatched available implementation", async () => {
  const fixture = await signedFixture();
  const mismatchedPlugin = plugin({
    ...fixture.plugin.manifest,
    version: "9.9.9",
  });

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [mismatchedPlugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /manifest does not match available implementation/,
  );
});

Deno.test("trusted kernel plugin install verifies implementation provenance metadata", async () => {
  const fixture = await signedFixture({
    metadata: {
      implementationProvenance: {
        artifactDigest: "sha256:plugin-artifact",
        provenanceRef: "prov://plugin-artifact",
      },
    },
  });

  const installed = await installTrustedKernelPlugins({
    envelopes: [fixture.envelope],
    availablePlugins: [fixture.plugin],
    trustedKeys: [fixture.trustedKey],
    policy: {
      enabledPluginIds: [fixture.plugin.manifest.id],
      requireImplementationProvenance: true,
    },
    environment: "production",
  });

  assert.equal(installed.length, 1);
});

Deno.test("trusted kernel plugin install rejects missing or unsigned implementation provenance", async () => {
  const fixture = await signedFixture();
  const pluginWithUnsignedProvenance = {
    ...fixture.plugin,
    implementationProvenance: {
      artifactDigest: "sha256:plugin-artifact",
    },
  };

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [fixture.plugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
          requireImplementationProvenance: true,
        },
        environment: "production",
      }),
    /requires implementation provenance metadata/,
  );

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [pluginWithUnsignedProvenance],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /implementation provenance is not covered by signed manifest/,
  );
});

Deno.test("trusted kernel plugin install rejects mismatched implementation provenance", async () => {
  const fixture = await signedFixture({
    metadata: {
      implementationProvenance: {
        artifactDigest: "sha256:plugin-artifact",
      },
    },
  });
  const mismatchedPlugin = {
    ...fixture.plugin,
    implementationProvenance: {
      artifactDigest: "sha256:other-artifact",
    },
  };

  await assert.rejects(
    () =>
      installTrustedKernelPlugins({
        envelopes: [fixture.envelope],
        availablePlugins: [mismatchedPlugin],
        trustedKeys: [fixture.trustedKey],
        policy: {
          enabledPluginIds: [fixture.plugin.manifest.id],
        },
        environment: "production",
      }),
    /implementation provenance does not match signed manifest/,
  );
});

async function signedFixture(
  overrides: Partial<TakosPaaSKernelPluginManifest> = {},
) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const manifest: TakosPaaSKernelPluginManifest = {
    id: "takos.provider.trusted",
    name: "Trusted Provider",
    version: "1.0.0",
    kernelApiVersion: "2026-04-29",
    capabilities: [{
      port: "provider",
      kind: "provider-control-plane",
      externalIo: ["network", "provider-control-plane"],
    }],
    ...overrides,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(canonicalTrustedKernelPluginManifest(manifest)),
  );
  return {
    plugin: plugin(manifest),
    trustedKey: {
      keyId: "takos-test-root",
      publisherId: "takos-test-publisher",
      publicKeyJwk,
    },
    envelope: {
      manifest,
      signature: {
        alg: TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM,
        keyId: "takos-test-root",
        value: encodeBase64Url(new Uint8Array(signature)),
      },
    },
  };
}

function plugin(
  manifest: TakosPaaSKernelPluginManifest,
): TakosPaaSKernelPlugin {
  return {
    manifest,
    createAdapters() {
      return {};
    },
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}
