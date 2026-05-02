import {
  type ManifestResource,
  type PlatformContext,
  registerProvider,
  registerShape,
} from "takosumi-contract";
import { applyV2, type ApplyV2Outcome } from "@takos/takosumi-kernel/apply";
import { TAKOSUMI_BUNDLED_SHAPES } from "@takos/takosumi-plugins/shapes";
import { createInMemoryTakosumiProviders } from "@takos/takosumi-plugins/shape-providers";

export async function applyLocal(
  resources: readonly ManifestResource[],
): Promise<ApplyV2Outcome> {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
  for (const provider of createInMemoryTakosumiProviders()) {
    registerProvider(provider);
  }
  const context = createMinimalContext();
  return await applyV2({ resources, context });
}

function createMinimalContext(): PlatformContext {
  return {
    tenantId: "local",
    spaceId: "local",
    secrets: createNoopSecrets(),
    observability: createNoopObservability(),
    kms: createNoopKms(),
    objectStorage: createNoopObjectStorage(),
    refResolver: { resolve: (expr: string) => expr },
    resolvedOutputs: new Map(),
  } as unknown as PlatformContext;
}

function createNoopSecrets(): unknown {
  return {
    putSecret: () => Promise.resolve(),
    getSecret: () => Promise.resolve(undefined),
    deleteSecret: () => Promise.resolve(),
  };
}

function createNoopObservability(): unknown {
  return {
    appendAudit: (event: unknown) =>
      Promise.resolve({ sequence: 0, event, previousHash: "0", hash: "0" }),
    listAudit: () => Promise.resolve([]),
    verifyAuditChain: () => Promise.resolve(true),
    recordMetric: (event: unknown) => Promise.resolve(event),
    listMetrics: () => Promise.resolve([]),
  };
}

function createNoopKms(): unknown {
  return {
    activeKeyRef: () => Promise.resolve("noop:key"),
    encrypt: (input: { plaintext: Uint8Array }) =>
      Promise.resolve({ ciphertext: input.plaintext, keyRef: "noop:key" }),
    decrypt: (input: { ciphertext: Uint8Array }) =>
      Promise.resolve({ plaintext: input.ciphertext }),
    rotate: () => Promise.resolve("noop:key"),
  };
}

function createNoopObjectStorage(): unknown {
  return {
    putObject: () =>
      Promise.resolve({
        bucket: "",
        key: "",
        contentLength: 0,
        digest: { algorithm: "sha256", value: "" },
      }),
    getObject: () => Promise.resolve(undefined),
    headObject: () => Promise.resolve(undefined),
    deleteObject: () => Promise.resolve(false),
    listBuckets: () => Promise.resolve([]),
  };
}
