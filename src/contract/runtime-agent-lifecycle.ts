/**
 * Runtime-agent lifecycle protocol.
 *
 * Service-side reference adapters are paper-thin HTTP clients. They post these
 * envelopes to a runtime-agent service which dispatches to an operator-owned
 * runtime handler. Credentials live ONLY on the runtime-agent host.
 *
 * Endpoints (runtime-agent HTTP API):
 *   POST /v1/lifecycle/apply
 *   POST /v1/lifecycle/destroy
 *   POST /v1/lifecycle/compensate
 *   POST /v1/lifecycle/describe
 *   GET  /v1/health
 *
 * Auth: bearer token shared between service and runtime-agent.
 */

import type { JsonObject, JsonValue } from "./types.ts";

/**
 * DataAsset descriptor carried over the compatibility `artifact` wire
 * namespace — a discriminated union over `kind` (open string).
 *
 * - `kind: "oci-image"` typically uses `uri` (e.g. `ghcr.io/me/api:v1`)
 * - operator-owned bundle kinds may use `hash`
 *   pointing at a `takosumi artifact push`-uploaded blob
 *
 * DataAsset / artifact handling is an optional operator extension, not an
 * public Installer API concept. `kind` is intentionally open: operator handlers
 * can introduce new DataAsset metadata kinds while keeping the same wire shape.
 */
export interface Artifact {
  readonly kind: string;
  /** Content-addressed hash returned by `POST /v1/artifacts` (e.g. `sha256:abc…`). */
  readonly hash?: string;
  /** External pointer (OCI registry URI, https URL, etc). */
  readonly uri?: string;
  /** DataAsset-backed handler metadata (handler / mime / abi / compatibility-date / ...). */
  readonly metadata?: JsonObject;
}

/**
 * DataAsset reference in implementation-specific specs.
 *
 * Source-backed reference components receive a prepared source snapshot.
 * DataAsset-backed implementations can carry an external pointer or a
 * content-addressed object through this compatibility alias.
 */
export type ArtifactReference = string | Artifact;

/** Response shape for optional DataAsset upload / inspect endpoints. */
export interface ArtifactStored {
  readonly hash: string;
  readonly kind: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly metadata?: JsonObject;
}

/**
 * Locator for an operator DataAsset endpoint. Reference dispatchers include
 * this only when the optional DataAsset extension is enabled and the handler
 * may need to fetch uploaded bytes by hash. Token is scoped to read-only
 * DataAsset access.
 */
export interface ArtifactStoreLocator {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Locator for the already-prepared source snapshot used by source-backed
 * handlers. `workingDirectory` is for co-located service/agent setups;
 * `url` + `digest` is the portable form for remote agents.
 */
export interface PreparedSourceLocator {
  readonly url?: string;
  readonly digest?: string;
  readonly workingDirectory?: string;
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

export function formatPlatformOperationIdempotencyKey(
  key: PlatformOperationIdempotencyKey,
): string {
  return `${key.spaceId}:${key.operationPlanDigest}:${key.journalEntryId}`;
}

export interface LifecycleApplyRequest {
  /**
   * Runtime-handler-local shape selector (e.g. `object-store@v1`), derived by
   * the operator adapter from the component kind/materializer mapping.
   */
  readonly shape: string;
  /**
   * Runtime-handler-local provider selector (e.g. `aws-s3`, `filesystem`).
   * This is runtime-agent dispatch metadata, not a public Installer API field.
   */
  readonly provider: string;
  readonly resourceName: string;
  /**
   * Runtime-handler-local lifecycle input projected by the operator-selected
   * implementation adapter. It may be the public kind spec unchanged, or the
   * validated kind spec plus binding-derived runtime fields such as env or
   * gateway targets. It is not an open public Installer API extension point.
   */
  readonly spec: JsonValue;
  readonly spaceId: string;
  readonly tenantId?: string;
  /**
   * @internal service ↔ runtime-agent RPC only. WAL-derived request token
   * forwarded to external cloud APIs that accept their own idempotency
   * keys (= AWS S3 / GCP / etc). This is separate from the retired public
   * `X-Idempotency-Key` HTTP header: installer replay protection is via source
   * pin + expected digest, while handler-level idempotency belongs to this
   * service ↔ runtime-agent RPC envelope.
   */
  readonly idempotencyKey?: string;
  /** WAL / recovery envelope projected from the service OperationPlan. */
  readonly operationRequest?: PlatformOperationRequest;
  /** Optional metadata forwarded by service (audit trail, request id). */
  readonly metadata?: JsonObject;
  /** Where the handler can fetch DataAsset bytes by hash, when spec carries
   *  `artifact.hash`. Absent for pure pointer-based deploys. */
  readonly artifactStore?: ArtifactStoreLocator;
  /** Prepared source snapshot locator for source-backed handlers. */
  readonly preparedSource?: PreparedSourceLocator;
}

export interface LifecycleApplyResponse {
  /** Stable handle (e.g. AWS ARN, Docker container id). Used for destroy/describe. */
  readonly handle: string;
  /** Outputs recorded as Deployment evidence for material projection. */
  readonly outputs: JsonObject;
}

export interface LifecycleDestroyRequest {
  /** Runtime-handler-local shape selector for runtime-agent dispatch. */
  readonly shape: string;
  /** Runtime-handler-local provider selector for runtime-agent dispatch. */
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
  readonly tenantId?: string;
  /**
   * @internal service ↔ runtime-agent RPC only. WAL-derived request token
   * forwarded to external cloud APIs that accept their own idempotency
   * keys (= AWS S3 / GCP / etc). This is separate from the retired public
   * `X-Idempotency-Key` HTTP header: installer replay protection is via source
   * pin + expected digest, while handler-level idempotency belongs to this
   * service ↔ runtime-agent RPC envelope.
   */
  readonly idempotencyKey?: string;
  /** WAL / recovery envelope projected from the service OperationPlan. */
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject;
}

export interface LifecycleDestroyResponse {
  readonly ok: boolean;
  /** Optional reason on partial / soft failures. */
  readonly note?: string;
}

export interface LifecycleCompensateRequest {
  /** Runtime-handler-local shape selector for runtime-agent dispatch. */
  readonly shape: string;
  /** Runtime-handler-local provider selector for runtime-agent dispatch. */
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
  readonly tenantId?: string;
  /** WAL-derived request token for the compensating operation. */
  readonly idempotencyKey?: string;
  /** WAL / recovery envelope projected from the service OperationPlan. */
  readonly operationRequest?: PlatformOperationRequest;
  readonly metadata?: JsonObject;
  /** Recorded effect detail from the WAL, when available. */
  readonly effect?: JsonObject;
}

export interface LifecycleCompensateResponse {
  readonly ok: boolean;
  readonly note?: string;
  /**
   * True when the handler could not fully reverse the effect and the service
   * must keep or open RevokeDebt for operator-visible cleanup.
   */
  readonly revokeDebtRequired?: boolean;
  readonly detail?: JsonObject;
}

export interface LifecycleDescribeRequest {
  /** Runtime-handler-local shape selector for runtime-agent dispatch. */
  readonly shape: string;
  /** Runtime-handler-local provider selector for runtime-agent dispatch. */
  readonly provider: string;
  readonly handle: string;
  readonly spaceId: string;
  readonly tenantId?: string;
}

export type LifecycleStatus =
  | "running"
  | "stopped"
  | "missing"
  | "error"
  | "unknown";

export interface LifecycleDescribeResponse {
  readonly status: LifecycleStatus;
  readonly outputs?: JsonObject;
  readonly note?: string;
}

/** Standard error envelope returned by runtime-agent HTTP responses (4xx / 5xx). */
export interface LifecycleErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}

/** HTTP path constants — single source of truth for service client + agent server. */
export const LIFECYCLE_APPLY_PATH = "/v1/lifecycle/apply" as const;
export const LIFECYCLE_DESTROY_PATH = "/v1/lifecycle/destroy" as const;
export const LIFECYCLE_COMPENSATE_PATH = "/v1/lifecycle/compensate" as const;
export const LIFECYCLE_DESCRIBE_PATH = "/v1/lifecycle/describe" as const;
export const LIFECYCLE_HEALTH_PATH = "/v1/health" as const;

/** Optional operator DataAsset/artifact extension endpoint base path. */
export const ARTIFACTS_BASE_PATH = "/v1/artifacts" as const;

/** Auth header convention (Bearer <token>). Token is shared via TAKOSUMI_AGENT_TOKEN env. */
export const LIFECYCLE_AUTH_HEADER = "authorization" as const;
export const LIFECYCLE_AGENT_TOKEN_ENV = "TAKOSUMI_AGENT_TOKEN" as const;
export const LIFECYCLE_AGENT_URL_ENV = "TAKOSUMI_AGENT_URL" as const;

/**
 * Central registry for {@link Artifact.kind} DataAsset metadata values. The
 * optional operator artifact extension can expose the resulting set on
 * `GET /v1/artifacts/kinds` so CLIs and operators can discover which kinds the
 * deployed distribution understands.
 *
 * `kind` is intentionally an open string at the protocol level; this
 * registry is purely a discovery / documentation layer. Runtime handlers do
 * not have to consult it before producing or consuming an artifact —
 * but registering a kind makes it visible to operators and lets the
 * optional operator artifact extension apply per-kind size overrides.
 */
export interface RegisteredArtifactKind {
  readonly kind: string;
  readonly description: string;
  readonly contentTypeHint?: string;
  /** Override the service's TAKOSUMI_ARTIFACT_MAX_BYTES on a per-kind basis. */
  readonly maxSize?: number;
}

const ARTIFACT_KINDS = new Map<string, RegisteredArtifactKind>();

/**
 * Options for {@link registerArtifactKind}. Pass `allowOverride: true`
 * to suppress the collision warning when re-registering an existing
 * kind with different metadata.
 */
export interface RegisterArtifactKindOptions {
  readonly allowOverride?: boolean;
}

export function registerArtifactKind(
  kind: RegisteredArtifactKind,
  options?: RegisterArtifactKindOptions,
): RegisteredArtifactKind | undefined {
  const previous = ARTIFACT_KINDS.get(kind.kind);
  // Same-instance re-registration is silent. We also treat
  // structurally-identical metadata as silent because
  // `registerBundledArtifactKinds` rebuilds its objects on every
  // call; the kind list is short and shape-cheap to deep-compare.
  if (
    previous !== undefined &&
    previous !== kind &&
    !areArtifactKindsEqual(previous, kind) &&
    options?.allowOverride !== true
  ) {
    console.warn(
      `[takosumi-registry] artifact kind "${kind.kind}" overwritten ` +
        `(was ${describeArtifactKind(previous)}, now ${
          describeArtifactKind(kind)
        })`,
    );
  }
  ARTIFACT_KINDS.set(kind.kind, kind);
  return previous;
}

export function listArtifactKinds(): readonly RegisteredArtifactKind[] {
  return Array.from(ARTIFACT_KINDS.values());
}

export function getArtifactKind(
  kind: string,
): RegisteredArtifactKind | undefined {
  return ARTIFACT_KINDS.get(kind);
}

export function unregisterArtifactKind(kind: string): boolean {
  return ARTIFACT_KINDS.delete(kind);
}

export function isArtifactKindRegistered(kind: string): boolean {
  return ARTIFACT_KINDS.has(kind);
}

function areArtifactKindsEqual(
  a: RegisteredArtifactKind,
  b: RegisteredArtifactKind,
): boolean {
  return a.kind === b.kind &&
    a.description === b.description &&
    a.contentTypeHint === b.contentTypeHint &&
    a.maxSize === b.maxSize;
}

function describeArtifactKind(kind: RegisteredArtifactKind): string {
  const hint = kind.contentTypeHint ? ` (${kind.contentTypeHint})` : "";
  return `${kind.kind}${hint}`;
}
