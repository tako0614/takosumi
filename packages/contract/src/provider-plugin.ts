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

export interface PlatformOperationIdempotencyKey {
  readonly spaceId: string;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
}

export type PlatformOperationRecoveryMode =
  | "normal"
  | "continue"
  | "compensate"
  | "inspect";

export type PlatformOperationWalStage =
  | "prepare"
  | "pre-commit"
  | "commit"
  | "post-commit"
  | "observe"
  | "finalize"
  | "abort"
  | "skip";

export interface PlatformOperationRequest {
  readonly spaceId: string;
  readonly operationId: string;
  readonly operationAttempt: number;
  readonly journalCursor: string;
  readonly idempotencyKey: string;
  readonly desiredGeneration?: number;
  readonly desiredSnapshotId: string;
  readonly resolutionSnapshotId?: string;
  readonly operationKind: string;
  readonly inputRefs: readonly string[];
  readonly preRecordedGeneratedObjectIds: readonly string[];
  readonly expectedExternalIdempotencyKeys: readonly string[];
  readonly approvedEffects: readonly JsonObject[];
  readonly recoveryMode: PlatformOperationRecoveryMode;
  readonly walStage: PlatformOperationWalStage;
  readonly deadline?: string;
}

export interface PlatformOperationContext {
  readonly phase: "apply" | "destroy" | "compensate";
  readonly walStage: PlatformOperationWalStage;
  readonly operationId: string;
  readonly operationAttempt?: number;
  readonly resourceName: string;
  readonly providerId: string;
  readonly op: "create" | "delete";
  readonly desiredDigest: `sha256:${string}`;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly idempotencyKey: PlatformOperationIdempotencyKey;
  readonly idempotencyKeyString: string;
  readonly recoveryMode?: PlatformOperationRecoveryMode;
  readonly approvedEffects?: readonly JsonObject[];
  readonly deadline?: string;
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
   * Operation metadata attached by the kernel while executing a public WAL
   * commit. Providers should forward `idempotencyKeyString` to external APIs
   * that support request tokens and use the tuple to dedupe local side effects.
   * Absent outside WAL-backed apply / destroy paths.
   */
  readonly operation?: PlatformOperationContext;
  /**
   * Active trace context attached by the kernel when a provider operation is
   * executed under an HTTP request or another operation span.
   */
  readonly trace?: PlatformTraceContext;
}

export function formatPlatformOperationIdempotencyKey(
  key: PlatformOperationIdempotencyKey,
): string {
  return `${key.spaceId}:${key.operationPlanDigest}:${key.journalEntryId}`;
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
  compensate?(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<CompensateResult>;
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
