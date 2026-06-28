/**
 * Shared, dialect-independent row-mapper / normalizer / validator helpers for the
 * OpenTofu deployment-control ledger (core-spec.md §27).
 *
 * Every function here takes PLAIN row objects / domain inputs (never Drizzle
 * query-builder values), so it carries no Postgres/SQLite dialect type and is
 * byte-identical between the Postgres-backed `SqlOpenTofuDeploymentStore`
 * (`store_sql.ts`) and the D1/SQLite-backed `CloudflareD1OpenTofuDeploymentStore`
 * (`worker/src/d1_opentofu_store.ts`). Both stores import these instead of keeping
 * local duplicates; the dialect-specific query builders, upsert/guard statement
 * builders, error sniffers, raw-SQL plumbing, and DDL/migration code stay in each
 * store.
 *
 * NOTE: `InMemoryOpenTofuDeploymentStore` in `store.ts` keeps its OWN,
 * intentionally divergent copies of some normalizers (extra
 * workspaceId/currentStateVersionId mirroring, undefined overloads, no
 * empty-string fallback). Those are NOT folded into this module.
 */
import type {
  ApplyRun,
  Installation,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import { coerceRunStatus } from "@takosumi/internal/deploy-control-api";
import type { ArtifactRecord } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type {
  BillingAutoRechargeAttempt,
  BillingPlan,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import {
  billingPlanIncludedUsdMicros,
  creditBalanceAvailableUsdMicros,
  creditBalanceMonthlyIncludedUsdMicros,
  creditBalancePurchasedUsdMicros,
  creditBalanceReservedUsdMicros,
  legacyCreditsToUsdMicros,
  usageEventUsdMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type { CreditAmountInput } from "./store.ts";

/**
 * Resolves the Workspace identity key during the Workspace rename: prefer the
 * canonical `workspaceId`, fall back to the deprecated `spaceId`. Billing
 * records always carry one at runtime.
 */
export function workspaceKeyOf(scope: {
  readonly workspaceId?: string;
  readonly spaceId?: string;
}): string {
  return scope.workspaceId ?? scope.spaceId ?? "";
}

export function normalizeOptionalInstallationRecord(
  installation: Installation | undefined,
): Installation | undefined {
  return installation ? normalizeInstallationRecord(installation) : undefined;
}

export function normalizeInstallationRecord(
  installation: Installation,
): Installation {
  const workspaceId = workspaceKeyOf(installation);
  return {
    ...installation,
    workspaceId,
    spaceId: workspaceId,
  };
}

export function normalizeOptionalSourceSnapshotRecord(
  snapshot: SourceSnapshot | undefined,
): SourceSnapshot | undefined {
  return snapshot ? normalizeSourceSnapshotRecord(snapshot) : undefined;
}

export function normalizeSourceSnapshotRecord(
  snapshot: SourceSnapshot,
): SourceSnapshot {
  const workspaceId = workspaceKeyOf(snapshot);
  return {
    ...snapshot,
    workspaceId,
    spaceId: workspaceId,
  };
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

export function normalizeBillingPlan(plan: BillingPlan): BillingPlan {
  const includedUsdMicros = billingPlanIncludedUsdMicros(plan);
  return {
    ...plan,
    includedUsdMicros,
    includedCredits: usdMicrosToLegacyCredits(includedUsdMicros),
  };
}

export function creditAmountUsdMicros(input: CreditAmountInput): number {
  if (input.usdMicros !== undefined) {
    if (
      !Number.isSafeInteger(input.usdMicros) ||
      !Number.isFinite(input.usdMicros) ||
      input.usdMicros <= 0
    ) {
      throw new TypeError("usdMicros must be a positive integer");
    }
    return input.usdMicros;
  }
  if (
    input.credits === undefined ||
    !Number.isFinite(input.credits) ||
    input.credits <= 0
  ) {
    throw new TypeError("usdMicros must be a positive integer");
  }
  return legacyCreditsToUsdMicros(input.credits);
}

export function normalizeCreditBalance(balance: CreditBalance): CreditBalance {
  const availableUsdMicros = creditBalanceAvailableUsdMicros(balance);
  const reservedUsdMicros = creditBalanceReservedUsdMicros(balance);
  const monthlyIncludedUsdMicros =
    creditBalanceMonthlyIncludedUsdMicros(balance);
  const purchasedUsdMicros = creditBalancePurchasedUsdMicros(balance);
  return {
    ...balance,
    availableUsdMicros,
    reservedUsdMicros,
    monthlyIncludedUsdMicros,
    purchasedUsdMicros,
    availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
    reservedCredits: usdMicrosToLegacyCredits(reservedUsdMicros),
    monthlyIncludedCredits: usdMicrosToLegacyCredits(monthlyIncludedUsdMicros),
    purchasedCredits: usdMicrosToLegacyCredits(purchasedUsdMicros),
  };
}

export function creditBalanceFromRow(row: {
  readonly spaceId: string;
  readonly availableUsdMicros?: number | null;
  readonly reservedUsdMicros?: number | null;
  readonly monthlyIncludedUsdMicros?: number | null;
  readonly purchasedUsdMicros?: number | null;
  readonly availableCredits: number;
  readonly reservedCredits: number;
  readonly monthlyIncludedCredits: number;
  readonly purchasedCredits: number;
  readonly updatedAt: string;
}): CreditBalance {
  return normalizeCreditBalance({
    workspaceId: row.spaceId,
    spaceId: row.spaceId,
    ...(row.availableUsdMicros !== null && row.availableUsdMicros !== undefined
      ? { availableUsdMicros: row.availableUsdMicros }
      : {}),
    ...(row.reservedUsdMicros !== null && row.reservedUsdMicros !== undefined
      ? { reservedUsdMicros: row.reservedUsdMicros }
      : {}),
    ...(row.monthlyIncludedUsdMicros !== null &&
    row.monthlyIncludedUsdMicros !== undefined
      ? { monthlyIncludedUsdMicros: row.monthlyIncludedUsdMicros }
      : {}),
    ...(row.purchasedUsdMicros !== null && row.purchasedUsdMicros !== undefined
      ? { purchasedUsdMicros: row.purchasedUsdMicros }
      : {}),
    availableCredits: row.availableCredits,
    reservedCredits: row.reservedCredits,
    monthlyIncludedCredits: row.monthlyIncludedCredits,
    purchasedCredits: row.purchasedCredits,
    updatedAt: row.updatedAt,
  });
}

export function normalizeCreditReservation(
  reservation: CreditReservation,
): CreditReservation {
  const estimatedUsdMicros =
    reservation.estimatedUsdMicros ??
    legacyCreditsToUsdMicros(reservation.estimatedCredits);
  return {
    ...reservation,
    workspaceId: reservation.workspaceId ?? reservation.spaceId ?? "",
    estimatedUsdMicros,
    estimatedCredits: usdMicrosToLegacyCredits(estimatedUsdMicros),
  };
}

export function normalizeBillingAutoRechargeAttempt(
  attempt: BillingAutoRechargeAttempt,
): BillingAutoRechargeAttempt {
  if (
    attempt.status !== "pending" &&
    attempt.status !== "pending_unknown" &&
    attempt.status !== "succeeded" &&
    attempt.status !== "failed"
  ) {
    throw new TypeError("auto recharge status is invalid");
  }
  if (
    !Number.isSafeInteger(attempt.requestedUsdMicros) ||
    attempt.requestedUsdMicros <= 0
  ) {
    throw new TypeError("auto recharge requestedUsdMicros must be positive");
  }
  if (
    attempt.monthlyLimitUsdMicros !== undefined &&
    (!Number.isSafeInteger(attempt.monthlyLimitUsdMicros) ||
      attempt.monthlyLimitUsdMicros <= 0)
  ) {
    throw new TypeError("auto recharge monthlyLimitUsdMicros must be positive");
  }
  if (
    attempt.chargedUsdMicros !== undefined &&
    (!Number.isSafeInteger(attempt.chargedUsdMicros) ||
      attempt.chargedUsdMicros < 0)
  ) {
    throw new TypeError("auto recharge chargedUsdMicros must be non-negative");
  }
  return {
    ...attempt,
    ...(attempt.status === "succeeded"
      ? {
          chargedUsdMicros:
            attempt.chargedUsdMicros ?? attempt.requestedUsdMicros,
        }
      : {}),
  };
}

export function normalizeUsageEvent(event: UsageEvent): UsageEvent {
  const usdMicros = usageEventUsdMicros(event);
  return {
    ...event,
    usdMicros,
    credits: usdMicrosToLegacyCredits(usdMicros),
  };
}

export function legacyStorageCreditsFromUsdMicros(usdMicros: number): number {
  const credits = usdMicrosToLegacyCredits(usdMicros);
  return usdMicros >= 0 ? Math.ceil(credits) : Math.floor(credits);
}

export function usageEventFromRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string | null;
  readonly runId: string | null;
  readonly meterId?: string | null;
  readonly resourceFamily?: string | null;
  readonly resourceId?: string | null;
  readonly operation?: string | null;
  readonly resourceMetadataJson?: unknown;
  readonly kind: string;
  readonly quantity: number;
  readonly usdMicros?: number | null;
  readonly credits: number;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}): UsageEvent {
  return {
    id: row.id,
    workspaceId: row.spaceId,
    spaceId: row.spaceId,
    ...(row.installationId ? { installationId: row.installationId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.meterId ? { meterId: row.meterId } : {}),
    ...(row.resourceFamily ? { resourceFamily: row.resourceFamily } : {}),
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    ...(row.operation ? { operation: row.operation } : {}),
    ...usageResourceMetadataFromRow(row.resourceMetadataJson),
    kind: row.kind as UsageEvent["kind"],
    quantity: row.quantity,
    usdMicros: row.usdMicros ?? legacyCreditsToUsdMicros(row.credits),
    credits: usdMicrosToLegacyCredits(
      row.usdMicros ?? legacyCreditsToUsdMicros(row.credits),
    ),
    source: row.source as UsageEvent["source"],
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
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
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    objectKey: row.objectKey,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}
