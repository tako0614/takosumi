import type { JsonObject, JsonValue } from "./types.ts";
import type {
  kms,
  objectStorage,
  ObservabilitySink,
  secretStore,
} from "./plugin-sdk.ts";

export interface ShapeRef {
  readonly id: string;
  readonly version: string;
}

export interface ProviderValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ResourceHandle = string;

export interface ApplyDiagnostic {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: JsonObject;
}

export interface ApplyResult<Outputs = JsonObject> {
  readonly handle: ResourceHandle;
  readonly outputs: Outputs;
  readonly diagnostics?: readonly ApplyDiagnostic[];
}

export type ResourceStatusKind =
  | "pending"
  | "ready"
  | "degraded"
  | "failed"
  | "deleted";

export interface ResourceStatus<Outputs = JsonObject> {
  readonly kind: ResourceStatusKind;
  readonly outputs?: Outputs;
  readonly reason?: string;
  readonly observedAt: string;
}

export interface RefResolver {
  resolve(expression: string): JsonValue;
}

export interface PlatformContext {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly secrets: secretStore.SecretStorePort;
  readonly observability: ObservabilitySink;
  readonly kms: kms.KmsPort;
  readonly objectStorage: objectStorage.ObjectStoragePort;
  readonly refResolver: RefResolver;
  readonly resolvedOutputs: ReadonlyMap<string, JsonObject>;
}

/**
 * A provider plugin implements one shape (`implements`) with a chosen
 * cloud / runtime backend. Operators register plugins via
 * {@link registerProvider} and reference them from manifest `provider:`
 * fields by `id`.
 *
 * The `Capability` type parameter pins the capability vocabulary to the
 * shape's published union (e.g. `WebServiceCapability`). Plugins that
 * type-parameterize this generic catch capability typos at compile time;
 * untyped plugins fall back to `string` for back-compat.
 */
export interface ProviderPlugin<
  Spec = JsonObject,
  Outputs = JsonObject,
  Capability extends string = string,
> {
  readonly id: string;
  readonly version: string;
  readonly implements: ShapeRef;
  readonly capabilities: readonly Capability[];
  validate?(spec: Spec, issues: ProviderValidationIssue[]): void;
  apply(spec: Spec, ctx: PlatformContext): Promise<ApplyResult<Outputs>>;
  destroy(handle: ResourceHandle, ctx: PlatformContext): Promise<void>;
  status(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<ResourceStatus<Outputs>>;
}

const PROVIDER_REGISTRY = new Map<string, ProviderPlugin>();

/**
 * Options for {@link registerProvider}. Pass `allowOverride: true` to
 * suppress the collision warning when re-registering a provider with a
 * different value (e.g. tests that intentionally swap implementations).
 */
export interface RegisterProviderOptions {
  readonly allowOverride?: boolean;
}

export function registerProvider(
  provider: ProviderPlugin,
  options?: RegisterProviderOptions,
): ProviderPlugin | undefined {
  const previous = PROVIDER_REGISTRY.get(provider.id);
  // Same-value re-registration (idempotent boot) is silent — only warn
  // when the new entry differs from the prior. Reference equality is the
  // cheapest comparison and good enough: the bundled-shapes path passes
  // the same `Shape` / `ProviderPlugin` instance every time.
  if (
    previous !== undefined &&
    previous !== provider &&
    options?.allowOverride !== true
  ) {
    console.warn(
      `[takosumi-registry] provider "${provider.id}" overwritten ` +
        `(was ${describeProvider(previous)}, now ${
          describeProvider(provider)
        })`,
    );
  }
  PROVIDER_REGISTRY.set(provider.id, provider);
  return previous;
}

function describeProvider(provider: ProviderPlugin): string {
  return `${provider.id}@${provider.version}`;
}

export function unregisterProvider(id: string): boolean {
  return PROVIDER_REGISTRY.delete(id);
}

export function getProvider(id: string): ProviderPlugin | undefined {
  return PROVIDER_REGISTRY.get(id);
}

export function listProviders(): readonly ProviderPlugin[] {
  return Array.from(PROVIDER_REGISTRY.values());
}

export function listProvidersForShape(
  shapeId: string,
  shapeVersion: string,
): readonly ProviderPlugin[] {
  const matches: ProviderPlugin[] = [];
  for (const plugin of PROVIDER_REGISTRY.values()) {
    if (
      plugin.implements.id === shapeId &&
      plugin.implements.version === shapeVersion
    ) {
      matches.push(plugin);
    }
  }
  return matches;
}

export function isProviderRegistered(id: string): boolean {
  return PROVIDER_REGISTRY.has(id);
}

export function capabilitySubsetIssues(
  required: readonly string[],
  provided: readonly string[],
  path: string,
): readonly ProviderValidationIssue[] {
  const providedSet = new Set(provided);
  const issues: ProviderValidationIssue[] = [];
  for (const cap of required) {
    if (!providedSet.has(cap)) {
      issues.push({
        path,
        message: `provider does not declare required capability: ${cap}`,
      });
    }
  }
  return issues;
}
