// Persisted record shapes for the Resource Shape flow (`takosumi.dev/v1alpha1`).
//
// These are the durable projections of the public contract objects
// (`takosumi-contract` Resource / ResolutionLock / TargetPool / SpacePolicy).
// They live on the deploy-control persistence plane (D1 + Postgres) alongside
// the shared Run ledger, because `docs/internal/final-plan.md` §10 mandates that
// resolution locks, native resource refs, and observed status are durable.
//
// Complex sub-objects (spec, conditions, outputs, native resources, target
// lists, policy bodies) are persisted as JSON columns to keep the SQL schema
// small and the D1/Postgres/Drizzle three-way mirror parity tractable.

import type {
  Condition,
  InstalledFormReference,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
  isResourceShapeKind,
} from "takosumi-contract";
import type { ResourceOperation } from "takosumi-contract/runs";
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
  /**
   * Exact immutable portable definition selected for this Resource.
   * Missing only on pre-FormRef compatibility rows awaiting explicit backfill.
   */
  readonly form?: InstalledFormReference;
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
  /** Latest successful OpenTofu execution owned by this Resource. */
  readonly execution?: ResourceShapeExecutionRecord;
  /**
   * Core-minted direct-adapter Run currently fencing this lifecycle phase.
   * Internal only: public Resource status remains phase/conditions based.
   */
  readonly pendingOperation?: ResourceShapePendingOperation;
  /** Latest direct-adapter Run whose Resource projection was finalized. */
  readonly lastOperationRunId?: string;
  /**
   * Operator-confirmed, one-shot restore descriptor for state created by the
   * retired backing-Capsule implementation. This is never discovered at run
   * time: the migration report and confirmation service persist the exact
   * StateVersion pointer, and the first successful Resource apply consumes it.
   */
  readonly stateAdoption?: ResourceShapeStateAdoptionDescriptor;
  readonly conditions?: readonly Condition[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ResourceShapePendingOperation {
  readonly runId: string;
  readonly operation: ResourceOperation;
  readonly operationKey: string;
}

export interface ResourceShapeExecutionRecord {
  readonly runId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest?: string;
  readonly rawOutputRef?: string;
  readonly updatedAt: IsoTimestamp;
}

export interface ResourceShapeStateAdoptionDescriptor {
  readonly kind: "legacy_backing_capsule_state";
  readonly sourceWorkspaceId: string;
  readonly sourceCapsuleId: string;
  readonly sourceEnvironment: string;
  readonly sourceStateVersionId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly confirmedBy: string;
  readonly confirmedAt: IsoTimestamp;
}

/** The pinned resolution decision for one resource (`final-plan.md` §3.5). */
export interface ResolutionLockRecord {
  readonly resourceId: ResourceShapeRecordId;
  /**
   * Exact form identity used to produce this resolution evidence.
   * Missing only on pre-FormRef compatibility locks awaiting explicit backfill.
   */
  readonly form?: InstalledFormReference;
  readonly selectedImplementation: string;
  /** Missing only on pre-fingerprint legacy records. */
  readonly targetPool?: string;
  readonly target: string;
  /** Missing only on pre-fingerprint legacy records. */
  readonly targetSnapshot?: TargetPoolEntry;
  /** Complete immutable execution descriptor for every current lock. */
  readonly implementationSnapshot?: TargetImplementationDescriptor;
  /** @deprecated Historical dispatch columns kept for read normalization only. */
  readonly selectedImplementationPlugin?: string;
  /** @deprecated Historical dispatch columns kept for read normalization only. */
  readonly selectedImplementationOptions?: JsonObject;
  /** Canonical v1 identity of the selected target + implementation tuple. */
  readonly implementationFingerprint?: string;
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

/**
 * Split a canonical resource id back into its parts. Returns undefined for
 * anything that is not exactly `tkrn:{space}:{kind}:{name}`, so a malformed or
 * foreign id never resolves to a Resource by accident.
 */
export function parseResourceShapeId(
  id: ResourceShapeRecordId,
): { spaceId: SpaceId; kind: ResourceShapeKind; name: string } | undefined {
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== "tkrn") return undefined;
  const [, spaceId, kind, name] = parts;
  if (!spaceId || !kind || !name || !isResourceShapeKind(kind))
    return undefined;
  return { spaceId, kind, name };
}

/** Validate one optional exact identity against the compatibility kind token. */
export function assertResourceFormIdentity(
  form: InstalledFormReference | undefined,
  kind: ResourceShapeKind,
): void {
  if (form === undefined) return;
  if (!isInstalledFormReference(form)) {
    throw new Error("Resource form identity is not an exact installed FormRef");
  }
  if (form.formRef.kind !== kind) {
    throw new Error(
      `Resource kind ${kind} does not match FormRef kind ${form.formRef.kind}`,
    );
  }
}

export function resourceFormIdentitiesEqual(
  left: InstalledFormReference | undefined,
  right: InstalledFormReference | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return installedFormReferenceKey(left) === installedFormReferenceKey(right);
}

/**
 * NativeResource evidence this Resource's lifecycle may destroy.
 *
 * `operator` marks shared operator backing the Resource only borrows
 * (`contract/resolution.ts`), so handing it to a delete plugin would let one
 * Resource's teardown destroy infrastructure other Resources still depend on.
 * It is withheld from the adapter's delete/observe input entirely.
 */
export function deletableNativeResources(
  nativeResources: readonly NativeResourceRef[] | undefined,
): readonly NativeResourceRef[] {
  return (nativeResources ?? []).filter(
    (nativeResource) => nativeResource.ownership !== "operator",
  );
}

/**
 * Attach the owning exact Form identity to canonical NativeResource evidence.
 * Adapters may omit the repeated identity because Core already supplied the
 * pinned form in their input, but they may never substitute another identity.
 */
export function bindNativeResourceFormIdentity(
  nativeResources: readonly NativeResourceRef[] | undefined,
  form: InstalledFormReference | undefined,
): readonly NativeResourceRef[] | undefined {
  if (nativeResources === undefined) return undefined;
  return nativeResources.map((nativeResource) => {
    if (form === undefined) {
      if (nativeResource.form !== undefined) {
        throw new Error(
          `NativeResource ${nativeResource.type}/${nativeResource.id} carries Form evidence for an unpinned Resource`,
        );
      }
      return nativeResource;
    }
    if (
      nativeResource.form !== undefined &&
      !resourceFormIdentitiesEqual(nativeResource.form, form)
    ) {
      throw new Error(
        `NativeResource ${nativeResource.type}/${nativeResource.id} substitutes the Resource Form identity`,
      );
    }
    return { ...nativeResource, form };
  });
}

/** Fail closed when persisted NativeResource replay evidence is incomplete. */
export function assertNativeResourceFormIdentity(
  nativeResources: readonly NativeResourceRef[] | undefined,
  form: InstalledFormReference | undefined,
): void {
  for (const nativeResource of nativeResources ?? []) {
    if (form === undefined) {
      if (nativeResource.form !== undefined) {
        throw new Error(
          `NativeResource ${nativeResource.type}/${nativeResource.id} carries unexpected Form evidence`,
        );
      }
      continue;
    }
    if (
      nativeResource.form === undefined ||
      !resourceFormIdentitiesEqual(nativeResource.form, form)
    ) {
      throw new Error(
        `NativeResource ${nativeResource.type}/${nativeResource.id} is missing or mismatches the Resource Form identity`,
      );
    }
  }
}
