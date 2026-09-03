/**
 * Shared, dialect-independent row-mapper / normalizer / validator helpers for the
 * OpenTofu deployment-control ledger (core-spec.md §27).
 *
 * Every function here takes PLAIN row objects / domain inputs (never Drizzle
 * query-builder values), so it carries no Postgres/SQLite dialect type and is
 * byte-identical between the Postgres-backed `SqlOpenTofuControlStore`
 * (`store_sql.ts`) and the D1/SQLite-backed `CloudflareD1OpenTofuControlStore`
 * (`worker/src/d1_opentofu_store.ts`). Both stores import these instead of keeping
 * local duplicates; the dialect-specific query builders, upsert/guard statement
 * builders, error sniffers, raw-SQL plumbing, and DDL/migration code stay in each
 * store.
 *
 * Physical legacy column names are confined to row inputs. Returned domain
 * records always use the current Workspace/Capsule contract.
 */
import type {
  ApplyRun,
  Capsule,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import { coerceRunStatus } from "@takosumi/internal/deploy-control-api";
import type { ArtifactRecord } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { UsageEvent } from "takosumi-contract/billing";
import { usageEventUsdMicros } from "takosumi-contract/billing";
import type {
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from "takosumi-contract/workspaces";

export function workspaceKeyOf(scope: {
  readonly workspaceId: string;
}): string {
  return scope.workspaceId;
}

export function normalizeOptionalCapsuleRecord(
  capsule: Capsule | undefined,
): Capsule | undefined {
  return capsule ? normalizeCapsuleRecord(capsule) : undefined;
}

export function normalizeCapsuleRecord(capsule: Capsule): Capsule {
  return capsule;
}

export function normalizeOptionalSourceSnapshotRecord(
  snapshot: SourceSnapshot | undefined,
): SourceSnapshot | undefined {
  return snapshot ? normalizeSourceSnapshotRecord(snapshot) : undefined;
}

export function normalizeSourceSnapshotRecord(
  snapshot: SourceSnapshot,
): SourceSnapshot {
  if (snapshot.origin !== "git" || !snapshot.sourceId?.trim()) {
    throw new TypeError(
      "SourceSnapshot must originate from a registered Git Source",
    );
  }
  const persisted = snapshot as SourceSnapshot & {
    readonly archiveObjectKey?: unknown;
  };
  const archiveRef =
    typeof persisted.archiveRef === "string" && persisted.archiveRef.trim()
      ? persisted.archiveRef
      : typeof persisted.archiveObjectKey === "string" &&
          persisted.archiveObjectKey.trim()
        ? persisted.archiveObjectKey
        : undefined;
  if (!archiveRef) {
    throw new TypeError("SourceSnapshot must carry an immutable archiveRef");
  }
  const { archiveObjectKey: retiredArchiveObjectKey, ...canonical } = persisted;
  void retiredArchiveObjectKey;
  return { ...canonical, archiveRef };
}

/**
 * Read-coerces a persisted PlanRun / ApplyRun's `status` to the unified
 * {@link RunStatus} (RunStatus unify, S2). A legacy row written before the
 * `blocked` → `failed` collapse stored `status: "blocked"`; this maps it to
 * `failed` on read so old rows read back in the new model. Undefined passes
 * through.
 */
export function coerceRunRowStatus<R extends PlanRun | ApplyRun>(
  run: R | undefined,
): R | undefined {
  if (!run || run.status !== ("blocked" as unknown as R["status"])) return run;
  return { ...run, status: coerceRunStatus(run.status) } as R;
}

export function normalizeUsageEvent(event: UsageEvent): UsageEvent {
  const usdMicros = usageEventUsdMicros(event);
  return {
    ...event,
    usdMicros,
  };
}

export function usageEventFromRow(row: {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string | null;
  readonly runId: string | null;
  readonly meterId?: string | null;
  readonly resourceFamily?: string | null;
  readonly resourceId?: string | null;
  readonly operation?: string | null;
  readonly resourceMetadataJson?: unknown;
  readonly kind: string;
  readonly quantity: number;
  readonly usdMicros: number;
  readonly ratingStatus: string;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}): UsageEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.meterId ? { meterId: row.meterId } : {}),
    ...(row.resourceFamily ? { resourceFamily: row.resourceFamily } : {}),
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    ...(row.operation ? { operation: row.operation } : {}),
    ...usageResourceMetadataFromRow(row.resourceMetadataJson),
    kind: row.kind as UsageEvent["kind"],
    quantity: row.quantity,
    usdMicros: row.usdMicros,
    ratingStatus: usageRatingStatusFromRow(row.ratingStatus, row.usdMicros),
    source: row.source as UsageEvent["source"],
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

function usageRatingStatusFromRow(
  value: string,
  usdMicros: number,
): UsageEvent["ratingStatus"] {
  if (value !== "rated" && value !== "unrated") {
    throw new TypeError("usage event rating_status must be rated or unrated");
  }
  if (value === "unrated" && usdMicros !== 0) {
    throw new TypeError("unrated usage event must have zero usd_micros");
  }
  return value;
}

export function usageResourceMetadataFromRow(
  value: unknown,
): Pick<UsageEvent, "resourceMetadata"> {
  if (typeof value === "string") {
    if (value === "") return {};
    try {
      return usageResourceMetadataFromRow(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (Object.keys(value).length === 0) return {};
  return { resourceMetadata: value as UsageEvent["resourceMetadata"] };
}

export function artifactRecordFromRow(row: {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    ref: row.ref,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/**
 * The one decoder from a persisted `workspace_members` row to the domain
 * {@link WorkspaceMember}.
 *
 * WHY it is here. The row carries the same identity twice — as indexed columns
 * and inside the record JSON — and three readers used to decode it
 * independently: the bounded PAT authority reader validated both halves and
 * cross-checked them, while both stores cast the record straight to the domain
 * type. The strict half is the correct one; a membership decision made from a
 * row whose columns and record disagree is not a decision anybody can defend.
 * One decoder means one answer to "is this row a membership", and a widened
 * `WorkspaceRole` or `WorkspaceMemberStatus` has exactly one place to be taught
 * about.
 */
export interface WorkspaceMemberRowIdentity {
  readonly id: unknown;
  readonly workspaceId: unknown;
  readonly accountId: unknown;
  readonly status: unknown;
  readonly recordJson: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export class WorkspaceMemberRowError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceMemberRowError";
  }
}

/**
 * Decode one row against the identity it was selected by.
 *
 * `expected` is the query's own predicate. Passing it in is what turns the
 * decode into evidence: a row that came back for a different Workspace or
 * account is corruption, not a membership.
 */
export function workspaceMemberFromRow(
  row: WorkspaceMemberRowIdentity,
  expected: { readonly workspaceId: string; readonly accountId: string },
): WorkspaceMember {
  if (
    typeof row.id !== "string" ||
    row.workspaceId !== expected.workspaceId ||
    row.accountId !== expected.accountId ||
    !isWorkspaceMemberStatus(row.status) ||
    !isCanonicalMemberTimestamp(row.createdAt) ||
    !isCanonicalMemberTimestamp(row.updatedAt)
  ) {
    throw new WorkspaceMemberRowError(
      "Workspace membership evidence identity is invalid",
    );
  }
  const record = parseWorkspaceMemberRecord(row.recordJson);
  if (
    record.workspaceId !== expected.workspaceId ||
    record.accountId !== expected.accountId ||
    record.id !== row.id ||
    record.status !== row.status ||
    record.createdAt !== row.createdAt ||
    record.updatedAt !== row.updatedAt
  ) {
    throw new WorkspaceMemberRowError(
      "Workspace membership evidence identity is invalid",
    );
  }
  return {
    id: record.id,
    workspaceId: expected.workspaceId,
    accountId: expected.accountId,
    status: record.status,
    roles: record.roles,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Decode the persisted record half alone, for a caller that selects only it. */
export function parseWorkspaceMemberRecord(value: unknown): WorkspaceMember {
  let parsed: unknown;
  try {
    parsed =
      typeof value === "string"
        ? JSON.parse(value)
        : isWorkspaceMemberRecord(value)
          ? value
          : undefined;
  } catch {
    throw new WorkspaceMemberRowError(
      "Workspace membership evidence is malformed",
    );
  }
  if (
    !isWorkspaceMemberRecord(parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id.length === 0 ||
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.accountId !== "string" ||
    !isWorkspaceMemberStatus(parsed.status) ||
    !Array.isArray(parsed.roles) ||
    !parsed.roles.every(isWorkspaceRole) ||
    new Set(parsed.roles).size !== parsed.roles.length ||
    !isCanonicalMemberTimestamp(parsed.createdAt) ||
    !isCanonicalMemberTimestamp(parsed.updatedAt)
  ) {
    throw new WorkspaceMemberRowError(
      "Workspace membership evidence is malformed",
    );
  }
  return {
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    accountId: parsed.accountId,
    status: parsed.status,
    roles: parsed.roles as WorkspaceRole[],
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

function isWorkspaceMemberRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "viewer"
  );
}

function isWorkspaceMemberStatus(
  value: unknown,
): value is WorkspaceMemberStatus {
  return value === "active" || value === "invited" || value === "suspended";
}

function isCanonicalMemberTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
