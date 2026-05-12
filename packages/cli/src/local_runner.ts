import {
  InMemoryObservabilitySink,
  kms,
  type ManifestResource,
  objectStorage,
  type PlatformContext,
  registerProvider,
  registerShape,
  secretStore,
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
 * Accepts only compiled Shape manifests with concrete `resources[]`.
 * Template expansion is an installer/compiler concern that must run before
 * invoking either CLI local mode or the remote kernel route.
 */
export function expandManifestLocal(
  manifest: unknown,
): readonly ManifestResource[] {
  return expandManifestResourcesV1(manifest);
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
    secrets: new secretStore.MemoryEncryptedSecretStore(),
    observability: new InMemoryObservabilitySink(),
    kms: new kms.NoopTestKms(),
    objectStorage: new objectStorage.MemoryObjectStorage(),
    refResolver: { resolve: (expr: string) => expr },
    resolvedOutputs: new Map(),
  };
}
