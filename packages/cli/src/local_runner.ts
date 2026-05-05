import {
  type ManifestResource,
  type PlatformContext,
  registerProvider,
  registerShape,
} from "takosumi-contract";
import {
  applyV2,
  type ApplyV2Outcome,
  destroyV2,
  type DestroyV2Outcome,
} from "@takos/takosumi-kernel/apply";
import { expandManifestResourcesV1 } from "@takos/takosumi-kernel/manifest-v1";
import { TAKOSUMI_BUNDLED_SHAPES } from "@takos/takosumi-plugins/shapes";
import { createInMemoryTakosumiProviders } from "@takos/takosumi-plugins/shape-providers";
import { TAKOSUMI_BUNDLED_TEMPLATES } from "@takos/takosumi-plugins/templates";

export async function applyLocal(
  resources: readonly ManifestResource[],
): Promise<ApplyV2Outcome> {
  registerLocalRegistry();
  const context = createMinimalContext();
  return await applyV2({ resources, context });
}

export async function planLocal(
  resources: readonly ManifestResource[],
): Promise<ApplyV2Outcome> {
  registerLocalRegistry();
  const context = createMinimalContext();
  return await applyV2({ resources, context, dryRun: true });
}

/**
 * Tear down resources in reverse DAG order against the in-memory bundled
 * providers. Mirrors {@link applyLocal}: same registry / same noop platform
 * context. Local mode does not persist apply records, so destroy operates
 * "by computed handle" — for the bundled in-memory and filesystem providers
 * the handle is derived from the resource name, so passing the resource name
 * as the handle reaches the same record that {@link applyLocal} created.
 */
export async function destroyLocal(
  resources: readonly ManifestResource[],
): Promise<DestroyV2Outcome> {
  registerLocalRegistry();
  const context = createMinimalContext();
  return await destroyV2({ resources, context });
}

/**
 * Resolve a manifest down to the concrete resource list that
 * {@link applyLocal} / {@link destroyLocal} consume.
 *
 * Accepts either:
 *  - `{ resources: ManifestResource[] }` — returned as-is.
 *  - `{ template: { template: "id@version", inputs?: {} } }` — canonical
 *    manifest v1 template invocation.
 *  - both of the above — explicit resources append after template expansion.
 *  - `{ template: { name: "id", inputs?: {} } }` — friendlier alternate
 *    shape: looks up `name` against the bundled templates by id (matching
 *    the latest version that is bundled).
 *
 * Throws a descriptive `Error` listing the bundled template ids when the
 * manifest matches none of the above.
 */
export function expandManifestLocal(
  manifest: unknown,
): readonly ManifestResource[] {
  return expandManifestResourcesV1(manifest, {
    templates: TAKOSUMI_BUNDLED_TEMPLATES,
    allowTemplateName: true,
  });
}

function registerLocalRegistry(): void {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
  for (const provider of createInMemoryTakosumiProviders()) {
    registerProvider(provider, { allowOverride: true });
  }
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
