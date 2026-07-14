// Resolver I/O + ResolutionLock + NativeResource vocabulary
// (`takosumi.dev/v1alpha1`).
//
// The Resolver turns a desired Resource shape into a concrete implementation on
// a concrete Target (`docs/internal/final-plan.md` §8). The decision is frozen as a
// ResolutionLock (§3.5, §10): once a resource is created, its implementation is
// pinned and never silently re-targeted — migration is an explicit operation.

import type { IsoTimestamp } from "./types.ts";
import type { ResourceObject, ResourcePortability } from "./resource-shape.ts";
import type {
  SpacePolicy,
  TargetImplementationDescriptor,
  TargetPool,
  TargetPoolEntry,
} from "./target.ts";

/** Capability level is declared on the selected implementation descriptor. */
export type CapabilityLevel =
  TargetImplementationDescriptor["interfaces"][string];

/** A native resource the implementation will create on the Target. */
export interface NativeResourceRef {
  /** Opaque adapter-owned native resource type token. */
  readonly type: string;
  readonly id: string;
}

/** Per-interface capability score for the selected implementation. */
export interface InterfaceCapabilityScore {
  readonly interface: string;
  readonly level: CapabilityLevel;
}

/** Rough cost estimate attached to a resolution. */
export interface ResourceCostEstimate {
  readonly monthly: string;
}

/**
 * The pinned resolution decision (`docs/internal/final-plan.md` §3.5). Stored durably;
 * `locked` resolutions are not re-targeted without an explicit migration.
 */
export interface ResolutionLock {
  readonly resourceId: string;
  readonly selectedImplementation: string;
  /** TargetPool whose concrete entry was selected. Optional only for legacy locks. */
  readonly targetPool?: string;
  readonly target: string;
  /**
   * Immutable non-secret execution snapshot. Re-apply/delete use this value,
   * never a mutable TargetPool lookup, so credentials references and adapter
   * dispatch cannot silently drift after the first successful resolution.
   */
  readonly targetSnapshot?: TargetPoolEntry;
  /** Complete selected descriptor snapshot. Required for every new lock. */
  readonly implementationSnapshot?: TargetImplementationDescriptor;
  /** Canonical v1 identity of the selected target + implementation tuple. */
  readonly implementationFingerprint?: string;
  readonly locked: boolean;
  readonly reason: readonly string[];
  readonly portability?: ResourcePortability;
  readonly nativeResources?: readonly NativeResourceRef[];
  readonly lockedAt?: IsoTimestamp;
}

/** Resolver inputs, verbatim from `docs/internal/final-plan.md` §8. */
export interface ResolverInput {
  readonly resource: ResourceObject;
  readonly interfaces: readonly string[];
  readonly profiles?: readonly string[];
  readonly spacePolicy?: SpacePolicy;
  readonly targetPool: TargetPool;
  readonly existingLock?: ResolutionLock;
}

/** Resolver outputs, verbatim from `docs/internal/final-plan.md` §8. */
export interface ResolverOutput {
  readonly selectedImplementation: string;
  readonly selectedImplementationDescriptor: TargetImplementationDescriptor;
  readonly selectedTarget: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly capabilityScores: readonly InterfaceCapabilityScore[];
  readonly portability: ResourcePortability;
  readonly costEstimate?: ResourceCostEstimate;
  readonly riskNotes: readonly string[];
  readonly resolutionLock: ResolutionLock;
}
