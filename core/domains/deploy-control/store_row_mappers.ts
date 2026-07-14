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
  return snapshot;
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
