import {
  type KernelPluginIoBoundary,
  type KernelPluginPortKind,
  TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
  type TakosPaaSKernelPluginManifest,
} from "takosumi-contract";
import { stableStringify, toArrayBuffer } from "../adapters/source/digest.ts";
import {
  assertPluginAllowedForEnvironment,
  assertValidPluginManifest,
} from "./registry.ts";
import { markTrustedKernelPlugin } from "./trust_marker.ts";
import type { TakosPaaSKernelPlugin } from "./types.ts";

const textEncoder = new TextEncoder();

export const TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM =
  "ECDSA-P256-SHA256" as const;

export interface TrustedKernelPluginManifestEnvelope {
  readonly manifest: TakosPaaSKernelPluginManifest;
  readonly signature: TrustedKernelPluginManifestSignature;
}

export interface TrustedKernelPluginManifestSignature {
  readonly alg: typeof TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM;
  readonly keyId: string;
  readonly value: string;
}

export interface TrustedKernelPluginPublisherKey {
  readonly keyId: string;
  readonly publisherId: string;
  readonly publicKeyJwk: JsonWebKey;
}

export interface TrustedKernelPluginInstallPolicy {
  readonly enabledPluginIds: readonly string[];
  readonly trustedKeyIds?: readonly string[];
  readonly allowedPublisherIds?: readonly string[];
  readonly allowedPorts?: readonly KernelPluginPortKind[];
  readonly allowedExternalIo?: readonly KernelPluginIoBoundary[];
  readonly requireImplementationProvenance?: boolean;
}

export interface TrustedKernelPluginImplementationProvenance {
  readonly artifactDigest?: string;
  readonly moduleSpecifier?: string;
  readonly provenanceRef?: string;
  readonly artifact?: Record<string, unknown>;
  readonly module?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface TrustedKernelPluginInstallInput {
  readonly envelopes: readonly TrustedKernelPluginManifestEnvelope[];
  readonly availablePlugins: readonly TakosPaaSKernelPlugin[];
  readonly trustedKeys: readonly TrustedKernelPluginPublisherKey[];
  readonly policy: TrustedKernelPluginInstallPolicy;
  readonly environment: string;
}

export async function installTrustedKernelPlugins(
  input: TrustedKernelPluginInstallInput,
): Promise<readonly TakosPaaSKernelPlugin[]> {
  const availableById = new Map(
    input.availablePlugins.map((plugin) => [plugin.manifest.id, plugin]),
  );
  const installed: TakosPaaSKernelPlugin[] = [];
  const seen = new Set<string>();

  for (const envelope of input.envelopes) {
    assertValidPluginManifest(envelope.manifest);
    assertPluginKernelApiCompatible(envelope.manifest);
    assertPluginInstallPolicy(envelope, input.policy);
    const key = trustedKeyForEnvelope(
      envelope,
      input.trustedKeys,
      input.policy,
    );
    await assertManifestSignature(envelope, key);

    const plugin = availableById.get(envelope.manifest.id);
    if (!plugin) {
      throw new Error(
        `trusted kernel plugin implementation is not available: ${envelope.manifest.id}`,
      );
    }
    if (
      stableStringify(plugin.manifest) !== stableStringify(envelope.manifest)
    ) {
      throw new Error(
        `trusted kernel plugin manifest does not match available implementation: ${envelope.manifest.id}`,
      );
    }
    assertImplementationProvenance(envelope, plugin, input.policy);

    const selectedPorts = envelope.manifest.capabilities.map((capability) =>
      capability.port
    );
    assertPluginAllowedForEnvironment(
      envelope.manifest,
      selectedPorts,
      input.environment,
    );
    if (!seen.has(plugin.manifest.id)) {
      installed.push(
        markTrustedKernelPlugin(
          Object.freeze({
            ...plugin,
            trustedInstall: {
              source: "trusted-signed-manifest" as const,
              keyId: envelope.signature.keyId,
              publisherId: key.publisherId,
              signatureAlgorithm: envelope.signature.alg,
            },
          }),
        ),
      );
      seen.add(plugin.manifest.id);
    }
  }

  return Object.freeze(installed);
}

export function canonicalTrustedKernelPluginManifest(
  manifest: TakosPaaSKernelPluginManifest,
): string {
  return [
    "takos-kernel-plugin-manifest-v1",
    stableStringify(manifest),
  ].join("\n");
}

async function assertManifestSignature(
  envelope: TrustedKernelPluginManifestEnvelope,
  key: TrustedKernelPluginPublisherKey,
): Promise<void> {
  if (envelope.signature.alg !== TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM) {
    throw new Error(
      `trusted kernel plugin manifest uses unsupported signature algorithm: ${envelope.signature.alg}`,
    );
  }
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key.publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    decodeBase64Url(envelope.signature.value),
    textEncoder.encode(canonicalTrustedKernelPluginManifest(envelope.manifest)),
  );
  if (!valid) {
    throw new Error(
      `trusted kernel plugin manifest signature is invalid: ${envelope.manifest.id}`,
    );
  }
}

function assertPluginKernelApiCompatible(
  manifest: TakosPaaSKernelPluginManifest,
): void {
  if (manifest.kernelApiVersion === TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION) {
    return;
  }
  throw new Error(
    `trusted kernel plugin ${manifest.id} targets unsupported kernel API ${manifest.kernelApiVersion}; expected ${TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION}`,
  );
}

function assertPluginInstallPolicy(
  envelope: TrustedKernelPluginManifestEnvelope,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const manifest = envelope.manifest;
  if (!policy.enabledPluginIds.includes(manifest.id)) {
    throw new Error(
      `trusted kernel plugin is not enabled by install policy: ${manifest.id}`,
    );
  }

  if (policy.allowedPorts) {
    const allowed = new Set(policy.allowedPorts);
    const denied = manifest.capabilities.find((capability) =>
      !allowed.has(capability.port)
    );
    if (denied) {
      throw new Error(
        `trusted kernel plugin ${manifest.id} declares port outside install policy: ${denied.port}`,
      );
    }
  }

  if (policy.allowedExternalIo) {
    const allowed = new Set(policy.allowedExternalIo);
    const denied = manifest.capabilities.find((capability) =>
      capability.externalIo.some((boundary) => !allowed.has(boundary))
    );
    if (denied) {
      throw new Error(
        `trusted kernel plugin ${manifest.id} declares external I/O outside install policy: ${denied.port}`,
      );
    }
  }
}

function assertImplementationProvenance(
  envelope: TrustedKernelPluginManifestEnvelope,
  plugin: TakosPaaSKernelPlugin,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const signed = implementationProvenanceFromManifest(envelope.manifest);
  const implementation = (plugin as {
    readonly implementationProvenance?:
      TrustedKernelPluginImplementationProvenance;
  }).implementationProvenance ?? implementationProvenanceFromManifest(
    plugin.manifest,
  );

  if (policy.requireImplementationProvenance && !signed && !implementation) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} requires implementation provenance metadata`,
    );
  }
  if (!signed && !implementation) return;
  if (!signed) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} implementation provenance is not covered by signed manifest`,
    );
  }
  assertImplementationProvenanceBindsArtifactOrModule(
    envelope.manifest.id,
    signed,
  );
  if (!implementation) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} signed manifest declares implementation provenance that is missing from implementation`,
    );
  }
  assertImplementationProvenanceBindsArtifactOrModule(
    envelope.manifest.id,
    implementation,
  );
  if (stableStringify(implementation) !== stableStringify(signed)) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} implementation provenance does not match signed manifest`,
    );
  }
}

function implementationProvenanceFromManifest(
  manifest: TakosPaaSKernelPluginManifest,
): TrustedKernelPluginImplementationProvenance | undefined {
  const metadata = manifest.metadata;
  if (!metadata) return undefined;
  const direct = metadata.implementationProvenance;
  if (direct !== undefined) {
    return assertImplementationProvenanceRecord(manifest.id, direct);
  }
  const trustedInstall = metadata.trustedInstall;
  if (trustedInstall === undefined) return undefined;
  if (!isRecord(trustedInstall)) {
    throw new Error(
      `trusted kernel plugin ${manifest.id} trustedInstall metadata must be an object`,
    );
  }
  const nested = trustedInstall.implementationProvenance;
  if (nested === undefined) return undefined;
  return assertImplementationProvenanceRecord(manifest.id, nested);
}

function assertImplementationProvenanceRecord(
  pluginId: string,
  value: unknown,
): TrustedKernelPluginImplementationProvenance {
  if (!isRecord(value)) {
    throw new Error(
      `trusted kernel plugin ${pluginId} implementation provenance metadata must be an object`,
    );
  }
  return value;
}

function assertImplementationProvenanceBindsArtifactOrModule(
  pluginId: string,
  provenance: TrustedKernelPluginImplementationProvenance,
): void {
  if (
    nonEmptyString(provenance.artifactDigest) ||
    nonEmptyString(provenance.moduleSpecifier) ||
    isRecord(provenance.artifact) ||
    isRecord(provenance.module)
  ) {
    return;
  }
  throw new Error(
    `trusted kernel plugin ${pluginId} implementation provenance must bind an artifact or module`,
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trustedKeyForEnvelope(
  envelope: TrustedKernelPluginManifestEnvelope,
  keys: readonly TrustedKernelPluginPublisherKey[],
  policy: TrustedKernelPluginInstallPolicy,
): TrustedKernelPluginPublisherKey {
  const key = keys.find((item) => item.keyId === envelope.signature.keyId);
  if (!key) {
    throw new Error(
      `trusted kernel plugin manifest key is not configured: ${envelope.signature.keyId}`,
    );
  }
  if (
    policy.trustedKeyIds &&
    !policy.trustedKeyIds.includes(envelope.signature.keyId)
  ) {
    throw new Error(
      `trusted kernel plugin manifest key is not allowed by install policy: ${envelope.signature.keyId}`,
    );
  }
  if (
    policy.allowedPublisherIds &&
    !policy.allowedPublisherIds.includes(key.publisherId)
  ) {
    throw new Error(
      `trusted kernel plugin publisher is not allowed by install policy: ${key.publisherId}`,
    );
  }
  return key;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - normalized.length % 4) % 4),
    "=",
  );
  return toArrayBuffer(
    Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
  );
}
