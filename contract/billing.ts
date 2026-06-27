/**
 * Space billing and USD-denominated usage ledger contract.
 *
 * New billing code must use `usdMicros` fields: 1 USD = 1,000,000 micros.
 * Older `credits` fields remain as wire/storage compatibility aliases and are
 * interpreted as USD amounts where no `usdMicros` value exists.
 */

export const USD_MICROS_PER_DOLLAR = 1_000_000;
export const USD_MICROS_PER_CENT = 10_000;

export function usdMicrosFromUsd(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("USD amount must be finite");
  }
  const micros = Math.round(value * USD_MICROS_PER_DOLLAR);
  if (!Number.isSafeInteger(micros)) {
    throw new TypeError("USD micros amount exceeds safe integer range");
  }
  return micros;
}

export function usdFromMicros(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("USD micros amount must be a safe integer");
  }
  return value / USD_MICROS_PER_DOLLAR;
}

export function legacyCreditsToUsdMicros(value: number): number {
  return usdMicrosFromUsd(value);
}

export function usdMicrosToLegacyCredits(value: number): number {
  return usdFromMicros(value);
}

export function positiveUsdMicros(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive USD micros integer`);
  }
  return value;
}

export function nonNegativeUsdMicros(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new TypeError(`${label} must be a non-negative USD micros integer`);
  }
  return value;
}

export type BillingMode = "disabled" | "showback" | "enforce";

export type BillingProvider = "stripe" | "manual" | "none";

export interface BillingAutoRechargeSettings {
  readonly enabled: boolean;
  /** Recharge when available USD balance is below this amount. */
  readonly thresholdUsdMicros: number;
  /** Amount to charge/grant per automatic recharge. */
  readonly rechargeUsdMicros: number;
  /** Optional monthly safety cap for automatic recharge attempts. */
  readonly monthlyLimitUsdMicros?: number;
}

export type BillingSettings =
  | {
      readonly mode: "disabled";
      readonly provider: "none";
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "showback";
      readonly provider: BillingProvider;
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "enforce";
      readonly provider: Exclude<BillingProvider, "none">;
      readonly reservationRequired: true;
      readonly autoRecharge?: BillingAutoRechargeSettings;
    };

export function billingReservationRequired(settings: BillingSettings): boolean {
  return settings.mode === "enforce";
}

export interface BillingAccount {
  readonly id: string;
  readonly ownerType: "user" | "space";
  readonly ownerId: string;
  readonly provider: "stripe" | "manual" | "none";
  readonly stripeCustomerId?: string;
  readonly stripeDefaultPaymentMethodId?: string;
  readonly status: "active" | "past_due" | "disabled" | "trialing";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpaceSubscription {
  readonly id: string;
  readonly spaceId: string;
  readonly billingAccountId: string;
  readonly planId: string;
  readonly status: "active" | "trialing" | "past_due" | "cancelled";
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BillingPlanLimits {
  /** Maximum USD micros one reviewed plan may reserve/capture. */
  readonly maxEstimatedUsdMicrosPerRun?: number;
  /** @deprecated Use maxEstimatedUsdMicrosPerRun. */
  readonly maxEstimatedCreditsPerRun?: number;
  /** Additional resource-count quotas enforced from `tofu show -json` changes. */
  readonly quota?: Readonly<Record<string, number>>;
}

export interface BillingPlan {
  readonly id: string;
  readonly name: string;
  readonly monthlyBasePrice: number;
  /** Included monthly USD grant in micros. */
  readonly includedUsdMicros?: number;
  /** @deprecated Use includedUsdMicros. */
  readonly includedCredits: number;
  readonly limits: BillingPlanLimits;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreditBalance {
  readonly spaceId: string;
  readonly availableUsdMicros?: number;
  readonly reservedUsdMicros?: number;
  readonly monthlyIncludedUsdMicros?: number;
  readonly purchasedUsdMicros?: number;
  /** @deprecated Use availableUsdMicros. */
  readonly availableCredits: number;
  /** @deprecated Use reservedUsdMicros. */
  readonly reservedCredits: number;
  /** @deprecated Use monthlyIncludedUsdMicros. */
  readonly monthlyIncludedCredits: number;
  /** @deprecated Use purchasedUsdMicros. */
  readonly purchasedCredits: number;
  readonly updatedAt: string;
}

export interface CreditReservation {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string;
  readonly estimatedUsdMicros?: number;
  /** @deprecated Use estimatedUsdMicros. */
  readonly estimatedCredits: number;
  readonly status: "reserved" | "captured" | "released" | "expired";
  readonly mode: BillingMode;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type BillingAutoRechargeAttemptStatus =
  | "pending"
  | "pending_unknown"
  | "succeeded"
  | "failed";

export interface BillingAutoRechargeAttempt {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string;
  readonly billingAccountId: string;
  readonly idempotencyKey: string;
  /** UTC calendar-month start used for monthly auto-recharge safety caps. */
  readonly periodStart: string;
  readonly periodEnd?: string;
  readonly requestedUsdMicros: number;
  readonly monthlyLimitUsdMicros?: number;
  readonly chargedUsdMicros?: number;
  readonly status: BillingAutoRechargeAttemptStatus;
  readonly stripePaymentIntentId?: string;
  readonly providerStatus?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type UsageEventKind =
  | "runner_minute"
  | "artifact_storage_gb_hour"
  | "backup_storage_gb_hour"
  | "egress_gb"
  | "operation";

export type UsageEventSource =
  | "runner"
  | "resource_meter"
  | "billing_reconciliation"
  | "manual_adjustment";

/**
 * Provider/runtime-defined family for grouping billable managed resources.
 *
 * Takosumi Cloud extensions should use stable user-facing dotted names such as
 * `cloudflare.workers_script`, `cloudflare.kv`, `cloudflare.r2`,
 * `cloudflare.d1`, `cloudflare.queues`, `cloudflare.workflows`, or
 * `cloudflare.containers`.
 * Internal implementation backends must not
 * appear in public usage events, billing payloads, or Stripe meters.
 * The contract intentionally keeps this open so new managed resources can be
 * metered without a public contract migration.
 */
export type UsageResourceFamily = string;

export function usageMeterNameLeaksInternalWorkersBackend(
  value: string,
): boolean {
  const normalized = value.trim().toLowerCase();
  return /(^|[_.:-])(?:wfp|workers[_.:-]?for[_.:-]?platforms)($|[_.:-])/u.test(
    normalized,
  );
}

export type UsageResourceMetadataValue = string | number | boolean | null;
export type UsageResourceMetadata = Readonly<
  Record<string, UsageResourceMetadataValue>
>;

export interface UsageEvent {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly runId?: string;
  readonly meterId?: string;
  readonly resourceFamily?: UsageResourceFamily;
  readonly resourceId?: string;
  readonly operation?: string;
  readonly resourceMetadata?: UsageResourceMetadata;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly usdMicros?: number;
  /** @deprecated Use usdMicros. */
  readonly credits: number;
  readonly source: UsageEventSource;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface InvoiceUsageReconciliation {
  readonly invoiceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly meteredUsdMicros?: number;
  readonly invoicedUsdMicros?: number;
  readonly adjustmentUsdMicros?: number;
  /** @deprecated Use meteredUsdMicros. */
  readonly meteredCredits: number;
  /** @deprecated Use invoicedUsdMicros. */
  readonly invoicedCredits: number;
  /** @deprecated Use adjustmentUsdMicros. */
  readonly adjustmentCredits: number;
  readonly usageEvent: UsageEvent;
}

export function creditBalanceAvailableUsdMicros(
  balance: CreditBalance | undefined,
): number {
  if (!balance) return 0;
  return (
    balance.availableUsdMicros ??
    legacyCreditsToUsdMicros(balance.availableCredits)
  );
}

export function creditBalanceReservedUsdMicros(
  balance: CreditBalance | undefined,
): number {
  if (!balance) return 0;
  return (
    balance.reservedUsdMicros ??
    legacyCreditsToUsdMicros(balance.reservedCredits)
  );
}

export function creditBalanceMonthlyIncludedUsdMicros(
  balance: CreditBalance | undefined,
): number {
  if (!balance) return 0;
  return (
    balance.monthlyIncludedUsdMicros ??
    legacyCreditsToUsdMicros(balance.monthlyIncludedCredits)
  );
}

export function creditBalancePurchasedUsdMicros(
  balance: CreditBalance | undefined,
): number {
  if (!balance) return 0;
  return (
    balance.purchasedUsdMicros ??
    legacyCreditsToUsdMicros(balance.purchasedCredits)
  );
}

export function usageEventUsdMicros(event: {
  readonly usdMicros?: number;
  readonly credits?: number;
}): number {
  return event.usdMicros ?? legacyCreditsToUsdMicros(event.credits ?? 0);
}

export function creditReservationEstimatedUsdMicros(
  reservation: CreditReservation,
): number {
  return (
    reservation.estimatedUsdMicros ??
    legacyCreditsToUsdMicros(reservation.estimatedCredits)
  );
}

export function billingPlanIncludedUsdMicros(plan: BillingPlan): number {
  return (
    plan.includedUsdMicros ?? legacyCreditsToUsdMicros(plan.includedCredits)
  );
}

export function billingPlanMaxEstimatedUsdMicros(
  limits: BillingPlanLimits,
): number | undefined {
  return (
    limits.maxEstimatedUsdMicrosPerRun ??
    (limits.maxEstimatedCreditsPerRun === undefined
      ? undefined
      : legacyCreditsToUsdMicros(limits.maxEstimatedCreditsPerRun))
  );
}
