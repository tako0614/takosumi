import type { BillingUsageRecord } from "./store.ts";

export interface BillingUsageRollup {
  billingAccountId: string;
  meter: string;
  unit: string;
  quantity: number;
  usageReportCount: number;
  usageReportIds: readonly string[];
  periodStart?: number;
  periodEnd?: number;
  firstReportedAt: number;
  lastReportedAt: number;
}

export interface BillingUsageAggregationPolicy {
  billingAccountId?: string;
  windowStart?: number;
  windowEnd?: number;
  lateArrivalAcceptedUntil?: number;
}

export function aggregateBillingUsage(
  records: readonly BillingUsageRecord[],
  policy: BillingUsageAggregationPolicy = {},
): BillingUsageRollup[] {
  const rollups = new Map<string, BillingUsageRollup>();
  const sorted = records
    .filter((record) => billingUsageRecordMatchesPolicy(record, policy))
    .sort(
      (left, right) =>
        left.reportedAt - right.reportedAt ||
        left.usageReportId.localeCompare(right.usageReportId),
    );

  for (const record of sorted) {
    const key = [record.billingAccountId, record.meter, record.unit].join(
      "\u0000",
    );
    const existing = rollups.get(key);
    if (!existing) {
      rollups.set(key, {
        billingAccountId: record.billingAccountId,
        meter: record.meter,
        unit: record.unit,
        quantity: record.quantity,
        usageReportCount: 1,
        usageReportIds: [record.usageReportId],
        ...(record.periodStart === undefined
          ? {}
          : { periodStart: record.periodStart }),
        ...(record.periodEnd === undefined
          ? {}
          : { periodEnd: record.periodEnd }),
        firstReportedAt: record.reportedAt,
        lastReportedAt: record.reportedAt,
      });
      continue;
    }
    rollups.set(key, {
      ...existing,
      quantity: existing.quantity + record.quantity,
      usageReportCount: existing.usageReportCount + 1,
      usageReportIds: [...existing.usageReportIds, record.usageReportId],
      periodStart: minOptional(existing.periodStart, record.periodStart),
      periodEnd: maxOptional(existing.periodEnd, record.periodEnd),
      firstReportedAt: Math.min(existing.firstReportedAt, record.reportedAt),
      lastReportedAt: Math.max(existing.lastReportedAt, record.reportedAt),
    });
  }

  return [...rollups.values()];
}

function minOptional(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function maxOptional(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function billingUsageRecordMatchesPolicy(
  record: BillingUsageRecord,
  policy: BillingUsageAggregationPolicy,
): boolean {
  if (
    policy.billingAccountId &&
    record.billingAccountId !== policy.billingAccountId
  ) {
    return false;
  }

  const usageStart = record.periodStart ?? record.reportedAt;
  const usageEnd = record.periodEnd ?? usageStart;
  if (policy.windowStart !== undefined && usageStart < policy.windowStart) {
    return false;
  }
  if (policy.windowEnd !== undefined && usageEnd > policy.windowEnd) {
    return false;
  }
  if (
    policy.lateArrivalAcceptedUntil !== undefined &&
    record.reportedAt > policy.lateArrivalAcceptedUntil
  ) {
    return false;
  }
  return true;
}
