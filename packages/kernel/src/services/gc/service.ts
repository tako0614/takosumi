import type {
  PreparedArtifact,
  ProtectedReferenceStore,
} from "../../domains/supply-chain/mod.ts";
import type { RetainedDeployArtifact } from "../../domains/deploy/mod.ts";
import type { ResourceInstance } from "../../domains/resources/mod.ts";
import type { Digest } from "../../domains/supply-chain/mod.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export type GcRefType =
  | "PreparedArtifact"
  | "WorkloadRevision"
  | "ResourceInstance"
  | "ProviderPackage"
  | "MirroredArtifact"
  | "RetainedDeployArtifact";

export type GcRetentionReasonCode =
  | "protected-reference"
  | "current-activation"
  | "rollback-window"
  | "ttl-not-expired"
  | "active-binding"
  | "active-materialization"
  | "rollback-materialization"
  | "provider-resource-active"
  | "expired-unreferenced";

export interface GcRetentionReason {
  readonly code: GcRetentionReasonCode;
  readonly message: string;
  readonly until?: IsoTimestamp;
  readonly referenceIds?: readonly string[];
}

export interface GcDeleteOperation {
  readonly refType: GcRefType;
  readonly refId: string;
  readonly action: "delete";
  readonly dryRun: true;
  readonly reason: GcRetentionReason;
}

export interface GcRetentionDecision {
  readonly refType: GcRefType;
  readonly refId: string;
  readonly retain: boolean;
  readonly reasons: readonly GcRetentionReason[];
  readonly deleteOperation?: GcDeleteOperation;
}

export interface WorkloadRevisionRetentionCandidate {
  readonly id: string;
  readonly active?: boolean;
  readonly createdAt?: IsoTimestamp;
  readonly supersededAt?: IsoTimestamp;
  readonly rollbackWindowExpiresAt?: IsoTimestamp;
}

export interface ResourceRetentionCandidate {
  readonly id: string;
  readonly activeBindingCount?: number;
  readonly providerResourceActive?: boolean;
  readonly rollbackWindowExpiresAt?: IsoTimestamp;
  readonly instance?: ResourceInstance;
}

export interface ProviderPackageRetentionCandidate {
  readonly digest: Digest;
  readonly activeMaterializationIds?: readonly string[];
  readonly rollbackMaterializations?: readonly {
    readonly id: string;
    readonly rollbackWindowExpiresAt: IsoTimestamp;
  }[];
}

export interface MirroredArtifactRetentionCandidate {
  readonly ref: string;
  readonly digest: Digest;
  readonly retentionDeadline?: IsoTimestamp;
}

export interface GcDryRunPlanInput {
  readonly now?: IsoTimestamp;
  readonly preparedArtifacts?: readonly PreparedArtifact[];
  readonly workloadRevisions?: readonly WorkloadRevisionRetentionCandidate[];
  readonly resources?: readonly ResourceRetentionCandidate[];
  readonly providerPackages?: readonly ProviderPackageRetentionCandidate[];
  readonly mirroredArtifacts?: readonly MirroredArtifactRetentionCandidate[];
  readonly retainedDeployArtifacts?: readonly RetainedDeployArtifact[];
}

export interface GcDryRunPlan {
  readonly now: IsoTimestamp;
  readonly decisions: readonly GcRetentionDecision[];
  readonly deleteOperations: readonly GcDeleteOperation[];
}

export interface GcRetentionServiceOptions {
  readonly protectedReferences: ProtectedReferenceStore;
  readonly clock?: () => Date;
}

export class GcRetentionService {
  readonly #protectedReferences: ProtectedReferenceStore;
  readonly #clock: () => Date;

  constructor(options: GcRetentionServiceOptions) {
    this.#protectedReferences = options.protectedReferences;
    this.#clock = options.clock ?? (() => new Date());
  }

  async planDryRun(input: GcDryRunPlanInput = {}): Promise<GcDryRunPlan> {
    const now = input.now ?? this.#clock().toISOString();
    const decisions: GcRetentionDecision[] = [];

    for (const artifact of input.preparedArtifacts ?? []) {
      decisions.push(await this.decidePreparedArtifact(artifact, now));
    }
    for (const revision of input.workloadRevisions ?? []) {
      decisions.push(await this.decideWorkloadRevision(revision, now));
    }
    for (const resource of input.resources ?? []) {
      decisions.push(await this.decideResource(resource, now));
    }
    for (const providerPackage of input.providerPackages ?? []) {
      decisions.push(await this.decideProviderPackage(providerPackage, now));
    }
    for (const mirror of input.mirroredArtifacts ?? []) {
      decisions.push(await this.decideMirroredArtifact(mirror, now));
    }
    for (const artifact of input.retainedDeployArtifacts ?? []) {
      decisions.push(await this.decideRetainedDeployArtifact(artifact, now));
    }

    const deleteOperations = decisions.flatMap((decision) =>
      decision.deleteOperation ? [decision.deleteOperation] : []
    );
    return deepFreeze({ now, decisions, deleteOperations });
  }

  async decidePreparedArtifact(
    artifact: PreparedArtifact,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    return await this.#decideBase({
      refType: "PreparedArtifact",
      refId: artifact.id,
      now,
      reasons: artifact.expiresAt > now
        ? [{
          code: "ttl-not-expired",
          message: "PreparedArtifact policy TTL has not expired.",
          until: artifact.expiresAt,
        }]
        : [],
    });
  }

  async decideWorkloadRevision(
    revision: WorkloadRevisionRetentionCandidate,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    const reasons: GcRetentionReason[] = [];
    if (revision.active) {
      reasons.push({
        code: "current-activation",
        message: "Workload revision is part of the current activation.",
      });
    }
    if (
      revision.rollbackWindowExpiresAt && revision.rollbackWindowExpiresAt > now
    ) {
      reasons.push({
        code: "rollback-window",
        message: "Workload revision is still inside the rollback window.",
        until: revision.rollbackWindowExpiresAt,
      });
    }
    return await this.#decideBase({
      refType: "WorkloadRevision",
      refId: revision.id,
      now,
      reasons,
    });
  }

  async decideResource(
    resource: ResourceRetentionCandidate,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    const reasons: GcRetentionReason[] = [];
    if ((resource.activeBindingCount ?? 0) > 0) {
      reasons.push({
        code: "active-binding",
        message: "Resource has active bindings.",
      });
    }
    if (resource.providerResourceActive) {
      reasons.push({
        code: "provider-resource-active",
        message: "Provider resource is still active.",
      });
    }
    if (resource.instance && resource.instance.lifecycle.status !== "deleted") {
      reasons.push({
        code: "provider-resource-active",
        message: "ResourceInstance lifecycle is not deleted.",
      });
    }
    if (
      resource.rollbackWindowExpiresAt && resource.rollbackWindowExpiresAt > now
    ) {
      reasons.push({
        code: "rollback-window",
        message:
          "Resource is retained for rollback-window restore or migration resume.",
        until: resource.rollbackWindowExpiresAt,
      });
    }
    return await this.#decideBase({
      refType: "ResourceInstance",
      refId: resource.id,
      now,
      reasons,
    });
  }

  async decideProviderPackage(
    providerPackage: ProviderPackageRetentionCandidate,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    const reasons: GcRetentionReason[] = [];
    if ((providerPackage.activeMaterializationIds ?? []).length > 0) {
      reasons.push({
        code: "active-materialization",
        message:
          "ProviderPackage digest is referenced by active materialization.",
        referenceIds: providerPackage.activeMaterializationIds,
      });
    }
    const rollbackIds = (providerPackage.rollbackMaterializations ?? [])
      .filter((materialization) =>
        materialization.rollbackWindowExpiresAt > now
      );
    if (rollbackIds.length > 0) {
      reasons.push({
        code: "rollback-materialization",
        message:
          "ProviderPackage digest is referenced by rollback-window materialization.",
        until: maxIso(
          rollbackIds.map((materialization) =>
            materialization.rollbackWindowExpiresAt
          ),
        ),
        referenceIds: rollbackIds.map((materialization) => materialization.id),
      });
    }
    return await this.#decideBase({
      refType: "ProviderPackage",
      refId: providerPackage.digest,
      now,
      reasons,
    });
  }

  async decideMirroredArtifact(
    mirror: MirroredArtifactRetentionCandidate,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    return await this.#decideBase({
      refType: "MirroredArtifact",
      refId: mirror.digest,
      now,
      reasons: mirror.retentionDeadline && mirror.retentionDeadline > now
        ? [{
          code: "rollback-window",
          message:
            "Mirrored external artifact is retained through rollback window.",
          until: mirror.retentionDeadline,
        }]
        : [],
    });
  }

  async decideRetainedDeployArtifact(
    artifact: RetainedDeployArtifact,
    now: IsoTimestamp = this.#clock().toISOString(),
  ): Promise<GcRetentionDecision> {
    return await this.#decideBase({
      refType: "RetainedDeployArtifact",
      refId: artifact.id,
      now,
      reasons: artifact.retainedUntil === undefined ||
          artifact.retainedUntil > now
        ? [{
          code: "rollback-window",
          message:
            "Deploy retained artifact is required for activation rollback.",
          until: artifact.retainedUntil,
          referenceIds: artifact.sourceActivationId
            ? [artifact.sourceActivationId]
            : undefined,
        }]
        : [],
    });
  }

  async #decideBase(input: {
    readonly refType: GcRefType;
    readonly refId: string;
    readonly now: IsoTimestamp;
    readonly reasons: readonly GcRetentionReason[];
  }): Promise<GcRetentionDecision> {
    const protectedReferences = await this.#protectedReferences.listForRef(
      input.refType,
      input.refId,
    );
    const activeProtectedReferences = protectedReferences.filter((reference) =>
      reference.expiresAt === undefined || reference.expiresAt > input.now
    );
    const protectionReasons: GcRetentionReason[] =
      activeProtectedReferences.length
        ? [{
          code: "protected-reference",
          message: "Object has active ProtectedReference entries.",
          until: maxIso(
            activeProtectedReferences.map((reference) => reference.expiresAt)
              .filter((value): value is string => value !== undefined),
          ),
          referenceIds: activeProtectedReferences.map((reference) =>
            reference.id
          ),
        }]
        : [];
    const reasons = [...protectionReasons, ...input.reasons];
    if (reasons.length > 0) {
      return deepFreeze({
        refType: input.refType,
        refId: input.refId,
        retain: true,
        reasons,
      });
    }
    const reason: GcRetentionReason = {
      code: "expired-unreferenced",
      message:
        "Object has no active ProtectedReference, current activation, rollback-window, or TTL retention.",
    };
    return deepFreeze({
      refType: input.refType,
      refId: input.refId,
      retain: false,
      reasons: [reason],
      deleteOperation: {
        refType: input.refType,
        refId: input.refId,
        action: "delete",
        dryRun: true,
        reason,
      },
    });
  }
}

function maxIso(values: readonly IsoTimestamp[]): IsoTimestamp | undefined {
  if (values.length === 0) return undefined;
  return [...values].sort().at(-1);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
