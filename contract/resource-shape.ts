// Resource Shape API public vocabulary (`takosumi.dev/v1alpha1`).
//
// The Resource object mirrors the Kubernetes-style shape mandated by
// `docs/final-plan.md` §4 (Resource Object Model) and §5 (Resource Shapes):
// a desired `spec`, an observed `status`, the `resolution` decision, and
// `conditions`. Kinds in this file are only public when they have a planner and
// adapter path; future shapes should be added when they can actually materialize.

import type { Condition, IsoTimestamp, JsonObject } from "./types.ts";
import { TAKOSUMI_API_VERSION } from "./capabilities.ts";

/** Resource shape kinds the Resource Shape API can host. */
export type ResourceShapeKind =
  | "ObjectStore"
  | "HttpService";

export const RESOURCE_SHAPE_KINDS: readonly ResourceShapeKind[] = [
  "ObjectStore",
  "HttpService",
] as const;

/**
 * Entry point that produced/owns a resource. `managedBy` gates field ownership
 * across the multiple authoring surfaces (`docs/final-plan.md` §15): an
 * OpenTofu-managed resource is not directly mutable from the console.
 */
export type ResourceManagedBy = "opentofu" | "console" | "api" | "compat";

/** `metadata` keys are verbatim from `docs/final-plan.md` §4. */
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

/** Condition type enum from `docs/final-plan.md` §4 / `core-spec.md`. */
export type ResourceConditionType =
  | "Ready"
  | "Reconciling"
  | "Drifted"
  | "Degraded"
  | "Blocked";

/**
 * Portability score reported alongside the resolution. `locked_in` marks a
 * resolution that cannot be re-targeted without an explicit migration.
 */
export type ResourcePortability =
  | "portable"
  | "mostly_portable"
  | "partial"
  | "locked_in";

/** `status.resolution` keys are verbatim from `docs/final-plan.md` §4. */
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
 * Generic Resource object. `TKind`/`TSpec` are narrowed by concrete shapes
 * (e.g. {@link ObjectStoreResource}); the untyped fallback keeps the API and
 * store layers shape-agnostic.
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

// --- Data-resource deletion policy (general, `docs/final-plan.md` §7.3) -------

/** Allowed `lifecycle_policy.delete` values, verbatim from §7.3. */
export type ResourceDeletePolicy =
  | "delete"
  | "retain"
  | "snapshot_then_delete"
  | "block";

export interface ResourceLifecyclePolicy {
  readonly delete: ResourceDeletePolicy;
}

// --- Connection / grant / projection vocabulary (`docs/final-plan.md` §10) ---

export type ResourceConnectionPermission =
  | "read"
  | "write"
  | "connect"
  | "publish"
  | "consume";

export type ResourceProjectionKind =
  | "env"
  | "database_url"
  | "runtime_binding"
  | "volume_mount"
  | "sdk_client";

export interface ResourceConnectionSpec {
  readonly resource: string;
  readonly permissions: readonly ResourceConnectionPermission[];
  readonly projection: ResourceProjectionKind;
}

// --- ObjectStore shape (`docs/final-plan.md` §5 / §10.2) ----------------------

/**
 * ObjectStore interface surfaces. The spec defines only `s3_api` and
 * `signed_url`; `object_events` appears in the §10.2 HCL example. No `access`
 * or `durability` field exists in the spec — do not invent them.
 */
export type ObjectStoreInterface = "s3_api" | "signed_url" | "object_events";

export interface ObjectStoreSpec {
  readonly name: string;
  readonly interfaces: readonly ObjectStoreInterface[];
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type ObjectStoreResource = ResourceObject<"ObjectStore", ObjectStoreSpec>;

// --- HttpService shape (`docs/final-plan.md` §5 / §10.1) ---------------------

export type HttpServiceRuntimeInterface =
  | "web_fetch"
  | "node_http"
  | "container_http";

export type HttpServiceProfile =
  | "workers_bindings"
  | "node_compat"
  | "lambda_handler"
  | "python_asgi";

export interface HttpServiceRuntimeSource {
  /**
   * OpenTofu-runner-local path for modules that upload a prebuilt artifact
   * through `file(...)`. This keeps Takosumi out of the build/fetch path.
   */
  readonly artifactPath?: string;
}

export interface HttpServiceRuntimeSpec {
  readonly interface: HttpServiceRuntimeInterface;
  readonly language?: string;
  readonly profiles?: readonly HttpServiceProfile[];
  readonly source?: HttpServiceRuntimeSource;
}

export interface HttpServiceExposureSpec {
  readonly publicHttp?: boolean;
}

export interface HttpServiceSpec {
  readonly name: string;
  readonly runtime: HttpServiceRuntimeSpec;
  readonly exposure?: HttpServiceExposureSpec;
  readonly lifecyclePolicy?: ResourceLifecyclePolicy;
}

export type HttpServiceResource = ResourceObject<"HttpService", HttpServiceSpec>;
