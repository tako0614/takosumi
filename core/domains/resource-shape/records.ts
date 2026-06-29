// Persisted record shapes for the Resource Shape flow (`takosumi.dev/v1alpha1`).
//
// These are the durable projections of the public contract objects
// (`takosumi-contract` Resource / ResolutionLock / TargetPool / SpacePolicy).
// They live on the deploy-control persistence plane (D1 + Postgres) alongside
// the Flow A ledger, because `docs/final-plan.md` §10 mandates that resolution
// locks, native resource refs, and observed status are stored durably.
//
// Complex sub-objects (spec, conditions, outputs, native resources, target
// lists, policy bodies) are persisted as JSON columns to keep the SQL schema
// small and the D1/Postgres/Drizzle three-way mirror parity tractable.

import type {
  Condition,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
} from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";

/** Canonical resource id, formatted `tkrn:{space}:{kind}:{name}`. */
export type ResourceShapeRecordId = string;
export type TargetPoolRecordId = string;
export type SpacePolicyRecordId = string;

/** A resolved/desired Resource Shape instance and its observed status. */
export interface ResourceShapeRecord {
  readonly id: ResourceShapeRecordId;
  readonly spaceId: SpaceId;
  readonly project?: string;
  readonly environment?: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly managedBy: ResourceManagedBy;
  /** Desired state (`spec`) as authored. */
  readonly spec: JsonObject;
  readonly phase: ResourcePhase;
  /** Bumped on every desired-state change. */
  readonly generation: number;
  /** Last generation the controller observed/applied. */
  readonly observedGeneration: number;
  readonly outputs?: JsonObject;
  readonly conditions?: readonly Condition[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** The pinned resolution decision for one resource (`final-plan.md` §3.5). */
export interface ResolutionLockRecord {
  readonly resourceId: ResourceShapeRecordId;
  readonly selectedImplementation: string;
  readonly target: string;
  readonly locked: boolean;
  readonly reason: readonly string[];
  readonly portability?: ResourcePortability;
  readonly nativeResources?: readonly NativeResourceRef[];
  readonly lockedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** A ranked TargetPool for a Space (`final-plan.md` §7.2). */
export interface TargetPoolRecord {
  readonly id: TargetPoolRecordId;
  readonly spaceId: SpaceId;
  readonly name: string;
  /** Serialized `TargetPoolSpec` (the `targets` list). */
  readonly spec: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** A SpacePolicy body for a Space (`final-plan.md` §7.3 / §14.1). */
export interface SpacePolicyRecord {
  readonly id: SpacePolicyRecordId;
  readonly spaceId: SpaceId;
  readonly name: string;
  /** Serialized `SpacePolicySpec`. */
  readonly spec: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Format the canonical resource id for a shape instance. */
export function formatResourceShapeId(
  spaceId: SpaceId,
  kind: ResourceShapeKind,
  name: string,
): ResourceShapeRecordId {
  return `tkrn:${spaceId}:${kind}:${name}`;
}
