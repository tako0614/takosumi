// Resource Shape API public vocabulary (`takosumi.dev/v1alpha1`).
//
// The Resource object mirrors the Kubernetes-style shape mandated by
// `docs/internal/final-plan.md` §4 (Resource Object Model) and §5 (Resource Shapes):
// a desired `spec`, an observed `status`, the `resolution` decision, and
// `conditions`. Kinds in this file are only public when they have a planner and
// adapter path; future shapes should be added when they can actually materialize.

import type { Condition, JsonObject } from "./types.ts";
import { TAKOSUMI_API_VERSION } from "./capabilities.ts";

/** Resource shape kinds the Resource Shape API can host. */
export type ResourceShapeKind =
  | "EdgeWorker"
  | "ObjectBucket"
  | "KVStore"
  | "Queue"
  | "SQLDatabase"
  | "ContainerService";

export const RESOURCE_SHAPE_KINDS: readonly ResourceShapeKind[] = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
] as const;

/**
 * Entry point that produced/owns a resource. `managedBy` gates field ownership
 * across the multiple authoring surfaces (`docs/internal/final-plan.md` §15): an
 * OpenTofu-managed resource is not directly mutable from the console.
 */
export type ResourceManagedBy = "opentofu" | "console" | "api" | "compat";

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
 * Generic Resource object. `TKind`/`TSpec` are narrowed by concrete shapes; the
 * untyped fallback keeps the API and store layers shape-agnostic.
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

// --- Data-resource deletion policy (general, `docs/internal/final-plan.md` §7.3) -------

/** Allowed `lifecycle_policy.delete` values, verbatim from §7.3. */
export type ResourceDeletePolicy =
  "delete" | "retain" | "snapshot_then_delete" | "block";

export interface ResourceLifecyclePolicy {
  readonly delete: ResourceDeletePolicy;
}

// --- Connection / grant / projection vocabulary (`docs/internal/final-plan.md` §10) ---

export type ResourceConnectionPermission =
  "read" | "write" | "connect" | "publish" | "consume";

export type ResourceProjectionKind =
  "env" | "database_url" | "runtime_binding" | "volume_mount" | "sdk_client";

export interface ResourceConnectionSpec {
  readonly resource: string;
  readonly permissions: readonly ResourceConnectionPermission[];
  readonly projection: ResourceProjectionKind;
}

// --- EdgeWorker shape (`docs/internal/final-plan.md` §5 / §10.1) ---------------------

/**
 * Endpoint-defined Worker capability/profile token. Standard examples include
 * `workers_bindings`, `node_compat`, `service_bindings`, and `static_assets`,
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
  /** Expected artifact digest as a hex SHA-256 string, optionally prefixed with `sha256:`. */
  readonly artifactSha256?: string;
}

export interface EdgeWorkerSpec {
  readonly name: string;
  readonly source: EdgeWorkerSource;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly profiles?: readonly EdgeWorkerProfile[];
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
  readonly engine?: "sqlite" | "postgres" | "mysql";
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
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type ContainerServiceResource = ResourceObject<
  "ContainerService",
  ContainerServiceSpec
>;
