/**
 * Explicit migration from the retired Resource Shape backing-Capsule state.
 *
 * This module is deliberately absent from Resource execution. `report()` is a
 * read-only operator aid; `confirm()` accepts the exact candidate fields the
 * operator reviewed and persists one descriptor behind a timestamp fence.
 * The runner receives only that descriptor and never scans Capsule records or
 * guesses a legacy owner at run time.
 */

import type { Capsule } from "takosumi-contract/capsules";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type {
  ResourceShapeRecord,
  ResourceShapeStateAdoptionDescriptor,
} from "./records.ts";
import type { ResourceShapeStores } from "./stores.ts";

export const LEGACY_RESOURCE_BACKING_INSTALL_CONFIG_ID =
  "cfg-internal-resource-shape-backing-capsule";
export const LEGACY_RESOURCE_BACKING_ENVIRONMENT = "resource-shape";

export interface LegacyResourceStateCandidate {
  readonly resourceId: string;
  readonly resourceUpdatedAt: string;
  readonly expectedLegacyCapsuleName: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest: string;
}

export type LegacyResourceStateReportIssueReason =
  | "resource_state_already_owned"
  | "adoption_already_pending"
  | "legacy_capsule_not_found"
  | "legacy_capsule_ambiguous"
  | "legacy_capsule_destroyed"
  | "legacy_state_version_missing"
  | "legacy_state_pointer_invalid";

export interface LegacyResourceStateReportIssue {
  readonly resourceId: string;
  readonly expectedLegacyCapsuleName: string;
  readonly reason: LegacyResourceStateReportIssueReason;
  readonly capsuleIds?: readonly string[];
  readonly detail: string;
}

export interface LegacyResourceStateAdoptionReport {
  readonly workspaceId: string;
  readonly candidates: readonly LegacyResourceStateCandidate[];
  readonly issues: readonly LegacyResourceStateReportIssue[];
}

/** Exact, stale-safe values copied from one reviewed report candidate. */
export interface ConfirmLegacyResourceStateAdoptionInput extends LegacyResourceStateCandidate {
  readonly confirmedBy: string;
}

export type LegacyResourceStateAdoptionErrorCode =
  | "candidate_not_found"
  | "candidate_changed"
  | "resource_state_already_owned"
  | "adoption_already_pending"
  | "confirmation_conflict";

export class LegacyResourceStateAdoptionError extends Error {
  constructor(
    readonly code: LegacyResourceStateAdoptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyResourceStateAdoptionError";
  }
}

export class LegacyResourceStateAdoptionService {
  constructor(
    private readonly stores: ResourceShapeStores,
    private readonly opentofu: OpenTofuControlStore,
    private readonly now: () => string,
  ) {}

  /** Read-only inventory. It never writes a Resource or Capsule record. */
  async report(
    workspaceId: string,
  ): Promise<LegacyResourceStateAdoptionReport> {
    const resources = await this.stores.resources.listBySpace(workspaceId);
    const capsules = await this.opentofu.listCapsules(workspaceId);
    const candidates: LegacyResourceStateCandidate[] = [];
    const issues: LegacyResourceStateReportIssue[] = [];

    for (const resource of resources) {
      const expectedLegacyCapsuleName = legacyBackingCapsuleName(resource);
      if (resource.execution) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "resource_state_already_owned",
          detail: "Resource already records Resource-owned execution state",
        });
        continue;
      }
      if (resource.stateAdoption) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "adoption_already_pending",
          capsuleIds: [resource.stateAdoption.sourceCapsuleId],
          detail: "Resource already has an operator-confirmed adoption pending",
        });
        continue;
      }

      const matches = capsules.filter((capsule) =>
        isDeterministicLegacyBackingCapsule(
          capsule,
          resource,
          expectedLegacyCapsuleName,
        ),
      );
      if (matches.length === 0) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "legacy_capsule_not_found",
          detail: "No exact retired backing-Capsule identity was found",
        });
        continue;
      }
      if (matches.length !== 1) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "legacy_capsule_ambiguous",
          capsuleIds: matches.map((capsule) => capsule.id).sort(),
          detail:
            "More than one Capsule matches the retired deterministic identity",
        });
        continue;
      }
      const capsule = matches[0]!;
      if (capsule.status === "destroyed") {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "legacy_capsule_destroyed",
          capsuleIds: [capsule.id],
          detail: "The exact legacy Capsule is already destroyed",
        });
        continue;
      }
      const stateVersion = capsule.currentStateVersionId
        ? await this.opentofu.getStateVersion(capsule.currentStateVersionId)
        : undefined;
      if (!stateVersion) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "legacy_state_version_missing",
          capsuleIds: [capsule.id],
          detail:
            "The exact legacy Capsule has no readable current StateVersion",
        });
        continue;
      }
      if (!validLegacyStatePointer(resource, capsule, stateVersion)) {
        issues.push({
          resourceId: resource.id,
          expectedLegacyCapsuleName,
          reason: "legacy_state_pointer_invalid",
          capsuleIds: [capsule.id],
          detail:
            "StateVersion ownership or opaque reference does not match the exact legacy Capsule",
        });
        continue;
      }
      candidates.push({
        resourceId: resource.id,
        resourceUpdatedAt: resource.updatedAt,
        expectedLegacyCapsuleName,
        capsuleId: capsule.id,
        stateVersionId: stateVersion.id,
        stateGeneration: stateVersion.generation,
        stateRef: stateVersion.stateRef,
        stateDigest: stateVersion.digest,
      });
    }

    return {
      workspaceId,
      candidates: candidates.sort((a, b) =>
        a.resourceId.localeCompare(b.resourceId),
      ),
      issues: issues.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    };
  }

  /**
   * Persists only the exact candidate the operator reviewed. A changed report,
   * existing Resource state, or concurrent confirmation fails closed.
   */
  async confirm(
    input: ConfirmLegacyResourceStateAdoptionInput,
  ): Promise<ResourceShapeStateAdoptionDescriptor> {
    const workspaceId = workspaceIdFromResourceId(input.resourceId);
    const resource = await this.stores.resources.get(input.resourceId);
    if (!resource || resource.spaceId !== workspaceId) {
      throw new LegacyResourceStateAdoptionError(
        "candidate_not_found",
        `Resource ${input.resourceId} was not found`,
      );
    }
    if (resource.execution) {
      throw new LegacyResourceStateAdoptionError(
        "resource_state_already_owned",
        `Resource ${input.resourceId} already has Resource-owned state`,
      );
    }
    if (resource.stateAdoption) {
      throw new LegacyResourceStateAdoptionError(
        "adoption_already_pending",
        `Resource ${input.resourceId} already has an adoption pending`,
      );
    }

    const report = await this.report(workspaceId);
    const candidate = report.candidates.find(
      (entry) => entry.resourceId === input.resourceId,
    );
    if (!candidate) {
      throw new LegacyResourceStateAdoptionError(
        "candidate_not_found",
        `Resource ${input.resourceId} has no unambiguous adoption candidate`,
      );
    }
    if (!sameCandidate(candidate, input)) {
      throw new LegacyResourceStateAdoptionError(
        "candidate_changed",
        `Resource ${input.resourceId} candidate changed after operator review; generate a new report`,
      );
    }

    const confirmedAt = this.now();
    const descriptor: ResourceShapeStateAdoptionDescriptor = {
      kind: "legacy_backing_capsule_state",
      sourceWorkspaceId: workspaceId,
      sourceCapsuleId: candidate.capsuleId,
      sourceEnvironment: LEGACY_RESOURCE_BACKING_ENVIRONMENT,
      sourceStateVersionId: candidate.stateVersionId,
      stateGeneration: candidate.stateGeneration,
      stateRef: candidate.stateRef,
      stateDigest: candidate.stateDigest,
      confirmedBy: input.confirmedBy,
      confirmedAt,
    };
    const claimed = await this.stores.resources.confirmStateAdoption(
      input.resourceId,
      descriptor,
      candidate.resourceUpdatedAt,
    );
    if (claimed.status !== "confirmed") {
      const code =
        claimed.status === "not_found"
          ? "candidate_not_found"
          : claimed.record.execution
            ? "resource_state_already_owned"
            : claimed.record.stateAdoption
              ? "adoption_already_pending"
              : "confirmation_conflict";
      throw new LegacyResourceStateAdoptionError(
        code,
        `Resource ${input.resourceId} changed while adoption was being confirmed`,
      );
    }
    return descriptor;
  }
}

export function legacyBackingCapsuleName(
  resource: Pick<ResourceShapeRecord, "id" | "kind" | "name">,
): string {
  const prefix = slugPart(`rs-${resource.kind}-${resource.name}`);
  const suffix = stableHash(resource.id);
  return `${prefix.slice(0, 44).replace(/-+$/u, "")}-${suffix}`;
}

function isDeterministicLegacyBackingCapsule(
  capsule: Capsule,
  resource: ResourceShapeRecord,
  expectedName: string,
): boolean {
  return (
    capsule.workspaceId === resource.spaceId &&
    capsule.name === expectedName &&
    capsule.environment === LEGACY_RESOURCE_BACKING_ENVIRONMENT &&
    capsule.installConfigId === LEGACY_RESOURCE_BACKING_INSTALL_CONFIG_ID
  );
}

function validLegacyStatePointer(
  resource: ResourceShapeRecord,
  capsule: Capsule,
  state: StateVersion,
): boolean {
  if (
    state.workspaceId !== resource.spaceId ||
    state.capsuleId !== capsule.id ||
    state.environment !== LEGACY_RESOURCE_BACKING_ENVIRONMENT ||
    state.id !== capsule.currentStateVersionId ||
    !Number.isInteger(state.generation) ||
    state.generation < 0 ||
    state.digest.length === 0
  ) {
    return false;
  }
  return state.stateRef.trim().length > 0;
}

function sameCandidate(
  candidate: LegacyResourceStateCandidate,
  input: ConfirmLegacyResourceStateAdoptionInput,
): boolean {
  return (
    candidate.resourceUpdatedAt === input.resourceUpdatedAt &&
    candidate.expectedLegacyCapsuleName === input.expectedLegacyCapsuleName &&
    candidate.capsuleId === input.capsuleId &&
    candidate.stateVersionId === input.stateVersionId &&
    candidate.stateGeneration === input.stateGeneration &&
    candidate.stateRef === input.stateRef &&
    candidate.stateDigest === input.stateDigest
  );
}

function workspaceIdFromResourceId(resourceId: string): string {
  const parts = resourceId.split(":");
  if (parts.length < 4 || parts[0] !== "tkrn" || !parts[1]) {
    throw new LegacyResourceStateAdoptionError(
      "candidate_not_found",
      `Resource id ${resourceId} is not a canonical tkrn`,
    );
  }
  return parts[1];
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  return slug.length > 0 ? slug : "rs-resource";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
