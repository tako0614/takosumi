// Resource Shape API public vocabulary (`takosumi.dev/v1alpha1`).
//
// The Resource object mirrors the Kubernetes-style shape mandated by
// `docs/internal/final-plan.md` §4 (Resource Object Model) and §5 (Resource Shapes):
// a desired `spec`, an observed `status`, the `resolution` decision, and
// `conditions`. Ten typed schemas ship with the provider, while an operator may
// register additional shape tokens with an explicit schema and adapter/plugin.

import type { Condition, JsonObject } from "./types.ts";
import { TAKOSUMI_API_VERSION } from "./capabilities.ts";

/** Resource shapes bundled with this Takosumi build and its typed provider. */
export type BundledResourceShapeKind =
  | "EdgeWorker"
  | "ObjectBucket"
  | "KVStore"
  | "Queue"
  | "SQLDatabase"
  | "ContainerService"
  | "VectorIndex"
  | "DurableWorkflow"
  | "StatefulActorNamespace"
  | "Schedule";

/**
 * Open Resource Shape token carried by the API and plugin seam. The bundled
 * provider still exposes only {@link BundledResourceShapeKind}; another token
 * is executable only when the host explicitly registers its schema and
 * adapter/plugin. Merely choosing a string never grants execution authority.
 */
export type ResourceShapeKind = string;

/** Complete typed shape set implemented by this API version. */
export const RESOURCE_SHAPE_KINDS: readonly BundledResourceShapeKind[] = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
  "VectorIndex",
  "DurableWorkflow",
  "StatefulActorNamespace",
  "Schedule",
] as const;

/** Runtime guard for a portable, path-safe Resource Shape token. */
export function isResourceShapeKind(
  value: unknown,
): value is ResourceShapeKind {
  return (
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}

/** True only for one of the ten schemas compiled into this contract version. */
export function isBundledResourceShapeKind(
  value: unknown,
): value is BundledResourceShapeKind {
  return (
    typeof value === "string" &&
    (RESOURCE_SHAPE_KINDS as readonly string[]).includes(value)
  );
}

/** Parse a persisted/wire token; schema admission happens in the host registry. */
export function parseResourceShapeKind(value: unknown): ResourceShapeKind {
  if (!isResourceShapeKind(value)) {
    throw new TypeError(`invalid Resource Shape kind token: ${String(value)}`);
  }
  return value;
}

/**
 * Entry point that produced/owns a resource. `managedBy` gates field ownership
 * across the multiple authoring surfaces (`docs/internal/final-plan.md` §15): an
 * OpenTofu-managed resource is not directly mutable from the console.
 */
export type ResourceManagedBy = string;

/** `metadata` keys are verbatim from `docs/internal/final-plan.md` §4. */
export interface ResourceMetadata {
  readonly name: string;
  readonly space: string;
  readonly project?: string;
  readonly environment?: string;
  readonly owner?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly managedBy: ResourceManagedBy;
}

/** Observed lifecycle phase surfaced in `status.phase`. */
export type ResourcePhase =
  | "Pending"
  | "Resolving"
  | "Planning"
  | "Applying"
  | "Ready"
  | "Degraded"
  | "Failed"
  | "Deleting"
  | "Deleted";

/** Condition type enum from `docs/internal/final-plan.md` §4 / `core-spec.md`. */
export type ResourceConditionType =
  "Ready" | "Reconciling" | "Drifted" | "Degraded" | "Blocked";

/**
 * Portability score reported alongside the resolution. `locked_in` marks a
 * resolution that cannot be re-targeted without an explicit migration.
 */
export type ResourcePortability =
  "portable" | "mostly_portable" | "partial" | "locked_in";

/** `status.resolution` keys are verbatim from `docs/internal/final-plan.md` §4. */
export interface ResourceResolutionStatus {
  readonly selectedImplementation: string;
  readonly target: string;
  readonly locked: boolean;
  readonly portability: ResourcePortability;
}

export interface ResourceStatus {
  readonly phase: ResourcePhase;
  readonly observedGeneration: number;
  readonly resolution?: ResourceResolutionStatus;
  readonly outputs?: JsonObject;
  readonly conditions?: readonly Condition[];
}

/**
 * Base object shared by bundled and explicitly registered Resource Shape
 * schemas. Shape-agnostic control-plane code carries an open token and JSON
 * object; schema-specific callers should use one of the typed aliases below.
 */
export interface ResourceObject<
  TKind extends ResourceShapeKind = ResourceShapeKind,
  TSpec extends object = JsonObject,
> {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: TKind;
  readonly metadata: ResourceMetadata;
  readonly spec: TSpec;
  readonly status?: ResourceStatus;
}

/**
 * One non-secret event in a Resource's public history.
 *
 * This is a read-only Resource-shaped projection of the shared Activity / Run
 * audit ledger, not a second lifecycle or state authority. `action` remains an
 * open dotted token so adapters and future Resource operations can add evidence
 * without changing the envelope. Metadata carries identifiers, phases, and
 * counts only; credentials, raw errors, specs, state, and Output values are not
 * part of this contract.
 */
export interface ResourceEvent {
  readonly id: string;
  readonly space: string;
  readonly resourceId: string;
  readonly action: string;
  readonly actorId?: string;
  readonly runId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** Newest-first cursor page returned by a Resource event listing. */
export interface ListResourceEventsResponse {
  readonly events: readonly ResourceEvent[];
  readonly nextCursor?: string;
}

// --- Data-resource deletion policy (general, `docs/internal/final-plan.md` §7.3) -------

/** Allowed `lifecycle_policy.delete` values, verbatim from §7.3. */
export type ResourceDeletePolicy =
  "delete" | "retain" | "snapshot_then_delete" | "block";

export interface ResourceLifecyclePolicy {
  readonly delete: ResourceDeletePolicy;
}

// --- Connection / grant / projection vocabulary (`docs/internal/final-plan.md` §10) ---

/**
 * Adapter-owned permission and projection tokens. Common built-in examples are
 * `read`, `write`, `runtime_binding`, and `database_url`; Core deliberately
 * does not make that starter vocabulary a global allow-list. The selected
 * Target implementation must advertise every requested token before a plan is
 * executable.
 */
export type ResourceConnectionPermission = string;
export type ResourceProjectionKind = string;

export interface ResourceConnectionSpec {
  readonly resource: string;
  readonly permissions: readonly ResourceConnectionPermission[];
  readonly projection: ResourceProjectionKind;
}

// --- EdgeWorker shape (`docs/internal/final-plan.md` §5 / §10.1) ---------------------

/**
 * Endpoint-defined Worker capability/profile token. Standard examples include
 * `workers_bindings`, `node_compat`, `runtime_bindings`, and `static_assets`,
 * but operators/adapters can advertise additional tokens through TargetPool
 * capability evidence and the Resolver.
 */
export type EdgeWorkerProfile = string;

export interface EdgeWorkerSource {
  /**
   * OpenTofu-runner-local path for modules that upload a prebuilt artifact
   * through `file(...)`. This keeps Takosumi out of the build/fetch path.
   */
  readonly artifactPath?: string;
  /**
   * HTTPS URL for a CI/release-produced Worker artifact. The generated
   * OpenTofu module fetches this URL through the mirrored `hashicorp/http`
   * provider and verifies `artifactSha256` before uploading it.
   */
  readonly artifactUrl?: string;
  /**
   * Host-allocated opaque reference to an immutable Worker artifact. This is
   * used by in-process compatibility/import paths that already received the
   * bytes and must not publish a temporary URL or credential in Resource
   * desired state. Only the selected host adapter interprets the reference.
   */
  readonly artifactRef?: string;
  /** Expected artifact digest as a hex SHA-256 string, optionally prefixed with `sha256:`. */
  readonly artifactSha256?: string;
}

export interface EdgeWorkerSpec {
  readonly name: string;
  readonly source: EdgeWorkerSource;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly profiles?: readonly EdgeWorkerProfile[];
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type EdgeWorkerResource = ResourceObject<"EdgeWorker", EdgeWorkerSpec>;

// --- Data / runtime shapes ---------------------------------------------------

/**
 * Endpoint-defined ObjectBucket interface token. Standard examples include
 * `s3_api`, `signed_url`, and `object_events`.
 */
export type ObjectBucketInterface = string;

export interface ObjectBucketSpec {
  readonly name: string;
  readonly interfaces?: readonly ObjectBucketInterface[];
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type ObjectBucketResource = ResourceObject<
  "ObjectBucket",
  ObjectBucketSpec
>;

export interface KVStoreSpec {
  readonly name: string;
  readonly consistency?: "eventual" | "strong";
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type KVStoreResource = ResourceObject<"KVStore", KVStoreSpec>;

export interface QueueSpec {
  readonly name: string;
  readonly delivery?: {
    readonly maxRetries?: number;
    readonly maxBatchSize?: number;
  };
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type QueueResource = ResourceObject<"Queue", QueueSpec>;

export interface SQLDatabaseSpec {
  readonly name: string;
  /** Open engine capability token; execution still requires Target evidence. */
  readonly engine?: string;
  readonly migrationsPath?: string;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type SQLDatabaseResource = ResourceObject<
  "SQLDatabase",
  SQLDatabaseSpec
>;

export interface ContainerServiceSpec {
  readonly name: string;
  readonly image: string;
  readonly ports?: readonly number[];
  readonly publicHttp?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type ContainerServiceResource = ResourceObject<
  "ContainerService",
  ContainerServiceSpec
>;

// --- Portable service shapes ------------------------------------------------

export interface VectorIndexSpec {
  readonly name: string;
  readonly dimensions: number;
  /** Open similarity metric token; the selected Target must advertise it. */
  readonly metric?: string;
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type VectorIndexResource = ResourceObject<
  "VectorIndex",
  VectorIndexSpec
>;

/** DurableWorkflow reuses the same immutable artifact contract as EdgeWorker. */
export type DurableWorkflowSource = EdgeWorkerSource;

export interface DurableWorkflowRetryPolicy {
  readonly maxAttempts?: number;
  readonly initialBackoffSeconds?: number;
}

export interface DurableWorkflowSpec {
  readonly name: string;
  readonly source: DurableWorkflowSource;
  readonly entrypoint: string;
  readonly retry?: DurableWorkflowRetryPolicy;
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type DurableWorkflowResource = ResourceObject<
  "DurableWorkflow",
  DurableWorkflowSpec
>;

/**
 * Namespace-level lifecycle for durable actors. Individual actor instances are
 * runtime state addressed inside the namespace and are never Resource objects.
 */
export interface StatefulActorNamespaceSpec {
  readonly name: string;
  readonly className: string;
  /** Open persistence capability token; defaults to `durable_sqlite`. */
  readonly storageProfile?: string;
  readonly migrationTag?: string;
  readonly connections?: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type StatefulActorNamespaceResource = ResourceObject<
  "StatefulActorNamespace",
  StatefulActorNamespaceSpec
>;

export interface ScheduleSpec {
  readonly name: string;
  /** Five-field cron expression in the declared timezone. */
  readonly cron: string;
  /** Open timezone token; v1alpha1 defaults to `UTC`. */
  readonly timezone?: string;
  /** Exactly one `schedule_trigger` connection with `invoke` permission. */
  readonly connections: Readonly<Record<string, ResourceConnectionSpec>>;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type ScheduleResource = ResourceObject<"Schedule", ScheduleSpec>;
