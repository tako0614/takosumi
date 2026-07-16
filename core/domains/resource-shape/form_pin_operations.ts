import type {
  FormActivation,
  FormPackage,
  InstalledFormReference,
  ResourceShapeKind,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
  isResourceShapeKind,
} from "takosumi-contract";
import type { ResourceFormPinBackupEntry } from "takosumi-contract/backups";
import {
  clampPageLimit,
  pageSortedBy,
  type PageParams,
} from "takosumi-contract/pagination";
import type { ActivityLedger } from "../activity/mod.ts";
import type { FormRegistryService } from "../service-forms/mod.ts";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import type { SpaceId } from "../../shared/ids.ts";
import type { ResourceShapeRecord, ResourceShapeRecordId } from "./records.ts";
import { resourceFormIdentitiesEqual } from "./records.ts";
import type { ResourceShapeStores } from "./stores.ts";

const MAX_ACTIVATION_CANDIDATES = 32;

export type ResourceFormPinEvidenceReason =
  | "eligible"
  | "activation_missing"
  | "activation_inactive"
  | "activation_kind_mismatch"
  | "activation_scope_mismatch"
  | "activation_audience_mismatch"
  | "activation_ambiguous"
  | "definition_missing_or_mismatched"
  | "package_missing"
  | "package_deprecated"
  | "package_revoked"
  | "resolution_lock_missing"
  | "resolution_lock_already_pinned"
  | "concurrent_conflict"
  | "backup_entry_invalid"
  | "backup_scope_mismatch"
  | "retained_package_unverifiable";

export interface ResourceFormPinEvidence {
  readonly resourceId: ResourceShapeRecordId;
  readonly kind: ResourceShapeKind;
  readonly outcome: "would_pin" | "pinned" | "already_pinned" | "refused";
  readonly reason: ResourceFormPinEvidenceReason;
  readonly activationId?: string;
  readonly installedFormReferenceKey?: string;
}

export interface ResourceFormPinOperationReport {
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly wouldPin: number;
  readonly pinned: number;
  readonly alreadyPinned: number;
  readonly refused: number;
  readonly evidence: readonly ResourceFormPinEvidence[];
  readonly nextCursor?: string;
}

export interface BackfillResourceFormPinsRequest extends PageParams {
  readonly workspaceId: string;
  readonly spaceId: SpaceId;
  readonly kind: ResourceShapeKind;
  readonly activationIds: readonly string[];
  readonly actorId: string;
  readonly actorRoles?: readonly string[];
  readonly dryRun?: boolean;
}

export interface RestoreResourceFormPinsRequest extends PageParams {
  readonly workspaceId: string;
  readonly spaceId: SpaceId;
  readonly entries: readonly ResourceFormPinBackupEntry[];
  readonly actorId: string;
}

export interface ResourceFormPinOperationsOptions {
  readonly stores: ResourceShapeStores;
  readonly forms: FormRegistryService;
  readonly activity: ActivityLedger;
  readonly now?: () => string;
}

export async function collectResourceFormPinBackupEntries(
  stores: Pick<ResourceShapeStores, "resources" | "locks">,
  resourceScopeId: string,
) {
  const resources = await stores.resources.listBySpace(
    resourceScopeId as SpaceId,
  );
  const entries: ResourceFormPinBackupEntry[] = [];
  for (const resource of resources) {
    const lock = await stores.locks.get(resource.id);
    if (resource.form === undefined && lock?.form === undefined) continue;
    if (
      resource.form === undefined ||
      lock?.form === undefined ||
      !resourceFormIdentitiesEqual(resource.form, lock.form)
    ) {
      return { status: "incoherent", resourceId: resource.id } as const;
    }
    entries.push({
      resourceId: resource.id,
      resourceScopeId: resource.spaceId,
      kind: resource.kind,
      identity: resource.form,
    });
  }
  return {
    status: "ready",
    entries: entries.sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
  } as const;
}

/**
 * Internal operator operation for exact Form identity migration and backup
 * replay. It is intentionally not mounted as a customer HTTP route.
 */
export class ResourceFormPinOperations {
  readonly #stores: ResourceShapeStores;
  readonly #forms: FormRegistryService;
  readonly #activity: ActivityLedger;
  readonly #now: () => string;

  constructor(options: ResourceFormPinOperationsOptions) {
    this.#stores = options.stores;
    this.#forms = options.forms;
    this.#activity = options.activity;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async backfill(
    request: BackfillResourceFormPinsRequest,
  ): Promise<ResourceFormPinOperationReport> {
    validateCommonRequest(request);
    if (!isResourceShapeKind(request.kind)) {
      throw new TypeError("backfill kind must be an installed Resource kind");
    }
    const activationIds = uniqueNonEmpty(request.activationIds);
    if (
      activationIds.length === 0 ||
      activationIds.length > MAX_ACTIVATION_CANDIDATES
    ) {
      throw new TypeError(
        `backfill requires 1..${MAX_ACTIVATION_CANDIDATES} explicit FormActivation ids`,
      );
    }
    const activations = await Promise.all(
      activationIds.map(async (id) => ({
        id,
        activation: await this.#forms.getActivation(id),
      })),
    );
    const page = await this.#stores.resources.listUnpinnedBySpaceKindPage(
      request.spaceId,
      request.kind,
      { limit: request.limit, cursor: request.cursor },
    );
    const evidence: ResourceFormPinEvidence[] = [];
    for (const resource of page.items) {
      evidence.push(await this.#backfillOne(resource, request, activations));
    }
    return report(request.dryRun === true, evidence, page.nextCursor);
  }

  async restore(
    request: RestoreResourceFormPinsRequest,
  ): Promise<ResourceFormPinOperationReport> {
    validateCommonRequest(request);
    const sorted = [...request.entries].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    );
    const page = pageSortedBy(
      sorted,
      { limit: request.limit, cursor: request.cursor },
      (entry) => ({ createdAt: "", id: entry.resourceId }),
    );
    const evidence: ResourceFormPinEvidence[] = [];
    for (const entry of page.items) {
      evidence.push(await this.#restoreOne(entry, request));
    }
    return report(false, evidence, page.nextCursor);
  }

  async #backfillOne(
    resource: ResourceShapeRecord,
    request: BackfillResourceFormPinsRequest,
    activations: readonly {
      readonly id: string;
      readonly activation: FormActivation | undefined;
    }[],
  ): Promise<ResourceFormPinEvidence> {
    const lock = await this.#stores.locks.get(resource.id);
    if (!lock) return refused(resource, "resolution_lock_missing");
    if (lock.form !== undefined) {
      return refused(resource, "resolution_lock_already_pinned");
    }
    if (activations.some(({ activation }) => activation === undefined)) {
      return refused(resource, "activation_missing");
    }

    const eligible = activations.filter(({ activation }) =>
      activationEligible(activation, resource, request),
    );
    if (eligible.length !== 1) {
      return refused(
        resource,
        eligible.length > 1
          ? "activation_ambiguous"
          : activationRefusalReason(activations, resource, request),
      );
    }
    const selected = eligible[0]!;
    const identity = selected.activation!.identity;
    const [definition, formPackage] = await Promise.all([
      this.#forms.getDefinition(identity.formRef),
      this.#forms.getPackage(identity.packageDigest),
    ]);
    if (
      !definition ||
      !resourceFormIdentitiesEqual(definition.identity, identity)
    ) {
      return refused(resource, "definition_missing_or_mismatched", selected.id);
    }
    if (!formPackage || formPackage.packageDigest !== identity.packageDigest) {
      return refused(resource, "package_missing", selected.id);
    }
    const unavailable = unavailablePackageReason(formPackage);
    if (unavailable) return refused(resource, unavailable, selected.id);

    const identityKey = installedFormReferenceKey(identity);
    if (request.dryRun === true) {
      return {
        resourceId: resource.id,
        kind: resource.kind,
        outcome: "would_pin",
        reason: "eligible",
        activationId: selected.id,
        installedFormReferenceKey: identityKey,
      };
    }
    const result = await this.#stores.pinExactFormIdentity({
      resourceId: resource.id,
      form: identity,
      expectedResource: versionOf(resource),
      expectedLock: lock,
    });
    if (result.status === "pinned" || result.status === "already_pinned") {
      await this.#auditPin(
        request.workspaceId,
        request.actorId,
        resource,
        identity,
        selected.id,
        "backfill",
      );
      return {
        resourceId: resource.id,
        kind: resource.kind,
        outcome: result.status,
        reason: "eligible",
        activationId: selected.id,
        installedFormReferenceKey: identityKey,
      };
    }
    return refused(resource, "concurrent_conflict", selected.id);
  }

  async #restoreOne(
    entry: ResourceFormPinBackupEntry,
    request: RestoreResourceFormPinsRequest,
  ): Promise<ResourceFormPinEvidence> {
    const kind = isResourceShapeKind(entry.kind) ? entry.kind : undefined;
    const fallback = {
      id: entry.resourceId as ResourceShapeRecordId,
      kind: (kind ?? "Stack") as ResourceShapeKind,
    };
    if (
      !kind ||
      !isInstalledFormReference(entry.identity) ||
      entry.identity.formRef.kind !== kind
    ) {
      return refused(fallback, "backup_entry_invalid");
    }
    if (entry.resourceScopeId !== request.spaceId) {
      return refused(fallback, "backup_scope_mismatch");
    }
    try {
      await this.#forms.verifyRetainedIdentity(entry.identity);
    } catch {
      return refused(fallback, "retained_package_unverifiable");
    }
    const [resource, lock] = await Promise.all([
      this.#stores.resources.get(entry.resourceId as ResourceShapeRecordId),
      this.#stores.locks.get(entry.resourceId as ResourceShapeRecordId),
    ]);
    if (!resource || !lock) {
      return refused(fallback, "resolution_lock_missing");
    }
    if (resource.spaceId !== request.spaceId || resource.kind !== kind) {
      return refused(resource, "backup_scope_mismatch");
    }
    const result = await this.#stores.pinExactFormIdentity({
      resourceId: resource.id,
      form: entry.identity,
      expectedResource: versionOf(resource),
      expectedLock: lock,
    });
    if (result.status !== "pinned" && result.status !== "already_pinned") {
      return refused(resource, "concurrent_conflict");
    }
    await this.#auditPin(
      request.workspaceId,
      request.actorId,
      resource,
      entry.identity,
      undefined,
      "backup_restore",
    );
    return {
      resourceId: resource.id,
      kind: resource.kind,
      outcome: result.status,
      reason: "eligible",
      installedFormReferenceKey: installedFormReferenceKey(entry.identity),
    };
  }

  async #auditPin(
    workspaceId: string,
    actorId: string,
    resource: ResourceShapeRecord,
    identity: InstalledFormReference,
    activationId: string | undefined,
    source: "backfill" | "backup_restore",
  ): Promise<void> {
    const identityKey = installedFormReferenceKey(identity);
    const digest = await sha256HexOfStringAsync(
      `${resource.id}\u0000${identityKey}\u0000${source}`,
    );
    await this.#activity.recordIdempotent(
      `act_form_pin_${digest.slice(0, 32)}`,
      this.#now(),
      {
        workspaceId,
        actorId,
        action:
          source === "backfill"
            ? "resource.form_pin.backfilled"
            : "resource.form_pin.restored",
        targetType: "resource",
        targetId: resource.id,
        metadata: {
          source,
          kind: resource.kind,
          formRefKey: identityKey,
          packageDigest: identity.packageDigest,
          ...(activationId ? { activationId } : {}),
        },
      },
    );
  }
}

function activationEligible(
  activation: FormActivation | undefined,
  resource: ResourceShapeRecord,
  request: BackfillResourceFormPinsRequest,
): boolean {
  if (!activation || activation.status !== "active") return false;
  if (activation.identity.formRef.kind !== resource.kind) return false;
  if (!scopeMatches(activation, request)) return false;
  return audienceMatches(activation, request);
}

function scopeMatches(
  activation: FormActivation,
  request: BackfillResourceFormPinsRequest,
): boolean {
  if (activation.scope.type === "operator") return true;
  if (activation.scope.type === "space") {
    return activation.scope.id === request.spaceId;
  }
  return activation.scope.id === request.workspaceId;
}

function audienceMatches(
  activation: FormActivation,
  request: BackfillResourceFormPinsRequest,
): boolean {
  const principals = activation.audience.principalIds ?? [];
  const roles = activation.audience.roles ?? [];
  return (
    (principals.length === 0 || principals.includes(request.actorId)) &&
    (roles.length === 0 ||
      roles.some((role) => request.actorRoles?.includes(role) === true))
  );
}

function activationRefusalReason(
  candidates: readonly {
    readonly id: string;
    readonly activation: FormActivation | undefined;
  }[],
  resource: ResourceShapeRecord,
  request: BackfillResourceFormPinsRequest,
): ResourceFormPinEvidenceReason {
  if (candidates.some(({ activation }) => activation === undefined)) {
    return "activation_missing";
  }
  const existing = candidates.flatMap(({ activation }) =>
    activation ? [activation] : [],
  );
  if (existing.every((activation) => activation.status !== "active")) {
    return "activation_inactive";
  }
  if (
    existing.every(
      (activation) => activation.identity.formRef.kind !== resource.kind,
    )
  ) {
    return "activation_kind_mismatch";
  }
  if (existing.every((activation) => !scopeMatches(activation, request))) {
    return "activation_scope_mismatch";
  }
  return "activation_audience_mismatch";
}

function unavailablePackageReason(
  formPackage: FormPackage,
): "package_deprecated" | "package_revoked" | undefined {
  if (formPackage.status === "deprecated") return "package_deprecated";
  if (formPackage.status === "revoked") return "package_revoked";
  return undefined;
}

function refused(
  resource: Pick<ResourceShapeRecord, "id" | "kind">,
  reason: ResourceFormPinEvidenceReason,
  activationId?: string,
): ResourceFormPinEvidence {
  return {
    resourceId: resource.id,
    kind: resource.kind,
    outcome: "refused",
    reason,
    ...(activationId ? { activationId } : {}),
  };
}

function report(
  dryRun: boolean,
  evidence: readonly ResourceFormPinEvidence[],
  nextCursor?: string,
): ResourceFormPinOperationReport {
  return {
    dryRun,
    scanned: evidence.length,
    wouldPin: evidence.filter((row) => row.outcome === "would_pin").length,
    pinned: evidence.filter((row) => row.outcome === "pinned").length,
    alreadyPinned: evidence.filter((row) => row.outcome === "already_pinned")
      .length,
    refused: evidence.filter((row) => row.outcome === "refused").length,
    evidence,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function versionOf(resource: ResourceShapeRecord) {
  return {
    generation: resource.generation,
    phase: resource.phase,
    updatedAt: resource.updatedAt,
  };
}

function validateCommonRequest(input: {
  readonly workspaceId: string;
  readonly spaceId: SpaceId;
  readonly actorId: string;
  readonly limit?: number;
}): void {
  if (
    input.workspaceId.trim() === "" ||
    input.spaceId.trim() === "" ||
    input.actorId.trim() === ""
  ) {
    throw new TypeError("workspaceId, spaceId, and actorId are required");
  }
  clampPageLimit(input.limit);
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value === "" || value.length > 256)) {
    throw new TypeError("FormActivation ids must be non-empty bounded strings");
  }
  return [...new Set(normalized)].sort();
}
