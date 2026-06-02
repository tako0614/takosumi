import type { JsonObject, JsonValue } from "./types.ts";
import type {
  PlatformOperationContext,
  PreparedSourceLocator,
} from "./runtime-agent-lifecycle.ts";
export {
  formatPlatformOperationIdempotencyKey,
  type PlatformOperationIdempotencyKey,
  type PlatformOperationRecoveryMode,
  type PlatformOperationRequest,
  type PlatformOperationWalStage,
} from "./runtime-agent-lifecycle.ts";
import type {
  kms,
  objectStorage,
  ObservabilitySink,
  secretStore,
} from "./implementation-sdk.ts";

/**
 * Legacy connector-local selector for shape-based backend adapters.
 *
 * Runtime-agent lifecycle envelopes still carry `(shape, provider)` so older
 * connectors can dispatch work locally. Current operator distributions derive
 * those selectors from their materializer mapping; reference components
 * remain keyed by `Component.kind`, and new reference adapters should implement
 * `OperatorImplementation` directly.
 */
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

export interface CompensateResult {
  readonly ok: boolean;
  readonly note?: string;
  readonly revokeDebtRequired?: boolean;
  readonly detail?: JsonObject;
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

export interface PlatformTraceContext {
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
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
  /**
   * Prepared source snapshot for source-backed providers. Present when the
   * service can expose the Deployment source tree to a materializer or
   * runtime-agent connector.
   */
  readonly preparedSource?: PreparedSourceLocator;
  /**
   * Operation metadata attached by the service while executing a WAL
   * commit. Providers should forward `idempotencyKeyString` to external APIs
   * that support request tokens and use the tuple to dedupe local side effects.
   * Absent outside WAL-backed apply / destroy paths.
   */
  readonly operation?: PlatformOperationContext;
  /**
   * Active trace context attached by the service when a provider operation is
   * executed under an HTTP request or another operation span.
   */
  readonly trace?: PlatformTraceContext;
}

/**
 * A legacy backend adapter implements one shape (`implements`) with a chosen
 * cloud / runtime backend. Operators register adapters via
 * {@link registerProvider} and reference them from implementation-specific
 * `provider:` fields by `id`.
 *
 * The `CapabilityTerm` type parameter pins the capability vocabulary to the
 * shape's published union (e.g. `WebServiceCapabilityTerm`). Adapters that
 * type-parameterize this generic catch capability typos at compile time;
 * untyped adapters fall back to `string`.
 *
 * @deprecated Compatibility bridge for the pre-OperatorImplementation provider surface.
 * The current reference adapter API is `OperatorImplementation` (or the
 * `Materializer = OperatorImplementation | InlineMaterializer` union) from
 * `src/contract/implementation.ts`. `ProviderAdapter` remains as a transitional
 * adapter wrapped by `operatorImplementationFromProviderAdapter()`; new code should
 * implement `OperatorImplementation` directly. First-party native kind implementations use
 * `operatorImplementationFromNativeKindOperations()` instead of this bridge.
 */
export interface ProviderAdapter<
  Spec = JsonObject,
  Outputs = JsonObject,
  CapabilityTerm extends string = string,
> {
  readonly id: string;
  readonly version: string;
  readonly implements: ShapeRef;
  readonly capabilities: readonly CapabilityTerm[];
  validate?(spec: Spec, issues: ProviderValidationIssue[]): void;
  apply(spec: Spec, ctx: PlatformContext): Promise<ApplyResult<Outputs>>;
  destroy(handle: ResourceHandle, ctx: PlatformContext): Promise<void>;
  compensate?(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<CompensateResult>;
  status(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<ResourceStatus<Outputs>>;
}

const PROVIDER_REGISTRY = new Map<string, ProviderAdapter>();

/**
 * Options for {@link registerProvider}. Pass `allowOverride: true` to
 * suppress the collision warning when re-registering a provider with a
 * different value (e.g. tests that intentionally swap implementations).
 */
export interface RegisterProviderOptions {
  readonly allowOverride?: boolean;
}

export function registerProvider(
  provider: ProviderAdapter,
  options?: RegisterProviderOptions,
): ProviderAdapter | undefined {
  const previous = PROVIDER_REGISTRY.get(provider.id);
  // Same-value re-registration (idempotent boot) is silent — only warn
  // when the new entry differs from the prior. Reference equality is the
  // cheapest comparison and good enough: the legacy shape/provider path passes
  // the same `Shape` / `ProviderAdapter` instance every time.
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

function describeProvider(provider: ProviderAdapter): string {
  return `${provider.id}@${provider.version}`;
}

export function unregisterProvider(id: string): boolean {
  return PROVIDER_REGISTRY.delete(id);
}

export function getProvider(id: string): ProviderAdapter | undefined {
  return PROVIDER_REGISTRY.get(id);
}

export function listProviders(): readonly ProviderAdapter[] {
  return Array.from(PROVIDER_REGISTRY.values());
}

export function listProvidersForShape(
  shapeId: string,
  shapeVersion: string,
): readonly ProviderAdapter[] {
  const matches: ProviderAdapter[] = [];
  for (const implementation of PROVIDER_REGISTRY.values()) {
    if (
      implementation.implements.id === shapeId &&
      implementation.implements.version === shapeVersion
    ) {
      matches.push(implementation);
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
