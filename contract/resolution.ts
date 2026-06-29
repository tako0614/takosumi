// Resolver I/O + ResolutionLock + NativeResource vocabulary
// (`takosumi.dev/v1alpha1`).
//
// The Resolver turns a desired Resource shape into a concrete implementation on
// a concrete Target (`docs/final-plan.md` §8). The decision is frozen as a
// ResolutionLock (§3.5, §10): once a resource is created, its implementation is
// pinned and never silently re-targeted — migration is an explicit operation.

import type { IsoTimestamp } from "./types.ts";
import type { ResourceObject, ResourcePortability } from "./resource-shape.ts";
import type { SpacePolicy, TargetPool, TargetType } from "./target.ts";

/**
 * How well a Target satisfies an interface (`docs/final-plan.md` §8):
 * `native` (provided directly), `shim` (adapter/runtime shim), `emulated`
 * (Takosumi substitutes), `unsupported`.
 */
export type CapabilityLevel = "native" | "shim" | "emulated" | "unsupported";

/** A native resource the implementation will create on the Target. */
export interface NativeResourceRef {
  /** e.g. `cloudflare.r2_bucket`, `aws.s3_bucket`. */
  readonly type: string;
  readonly id: string;
}

/** Per-interface capability score for the selected implementation. */
export interface InterfaceCapabilityScore {
  readonly interface: string;
  readonly level: CapabilityLevel;
}

/**
 * Capability of one implementation candidate. The Resolver scores a resource's
 * required interfaces against this matrix to pick an implementation/Target.
 */
export interface ImplementationCapability {
  /** e.g. `cloudflare_r2`, `aws_s3`. */
  readonly implementation: string;
  readonly targetType: TargetType;
  readonly shape: string;
  readonly interfaces: Readonly<Record<string, CapabilityLevel>>;
}

export type TargetCapabilityMatrix = readonly ImplementationCapability[];

/** Rough cost estimate attached to a resolution. */
export interface ResourceCostEstimate {
  readonly monthly: string;
}

/**
 * The pinned resolution decision (`docs/final-plan.md` §3.5). Stored durably;
 * `locked` resolutions are not re-targeted without an explicit migration.
 */
export interface ResolutionLock {
  readonly resourceId: string;
  readonly selectedImplementation: string;
  readonly target: string;
  readonly locked: boolean;
  readonly reason: readonly string[];
  readonly portability?: ResourcePortability;
  readonly nativeResources?: readonly NativeResourceRef[];
  readonly lockedAt?: IsoTimestamp;
}

/** Resolver inputs, verbatim from `docs/final-plan.md` §8. */
export interface ResolverInput {
  readonly resource: ResourceObject;
  readonly interfaces: readonly string[];
  readonly profiles?: readonly string[];
  readonly spacePolicy?: SpacePolicy;
  readonly targetPool: TargetPool;
  readonly existingLock?: ResolutionLock;
  readonly targetCapabilities?: TargetCapabilityMatrix;
}

/** Resolver outputs, verbatim from `docs/final-plan.md` §8. */
export interface ResolverOutput {
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly capabilityScores: readonly InterfaceCapabilityScore[];
  readonly portability: ResourcePortability;
  readonly costEstimate?: ResourceCostEstimate;
  readonly riskNotes: readonly string[];
  readonly resolutionLock: ResolutionLock;
}
