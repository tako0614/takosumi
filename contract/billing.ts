/**
 * Workspace billing and USD-denominated usage ledger contract.
 *
 * New billing code must use `usdMicros` fields: 1 USD = 1,000,000 micros.
 * Older `credits` fields remain as wire/storage compatibility aliases and are
 * interpreted as USD amounts where no `usdMicros` value exists.
 */

import type { JsonValue } from "./types.ts";
import type { PlanResourceChange } from "./internal-deploy-control-api.ts";

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

/**
 * OSS / Takosumi for-Operators billing mode.
 *
 * The open control plane supports only an operator-scoped, NON-blocking ledger:
 *   - `disabled` (self-host default): no billing ledger, no UI gate.
 *   - `showback`: record cost estimates and usage WITHOUT ever blocking apply.
 *
 * `enforce` (Stripe-backed payment gating / quota that blocks apply) is a
 * Takosumi Cloud-only CLOSED feature. It is intentionally NOT part of this
 * union: OSS code can never PRODUCE an enforce setting, and the only way to gate
 * an apply on payment is to inject a Cloud {@link BillingEnforcement} port (see
 * `core/bootstrap.ts`). The string `"enforce"` survives only as a DB enum /
 * migration value for rows a Cloud deployment may have written; OSS never reads
 * or acts on it.
 */
export type BillingMode = "disabled" | "showback";

export type BillingProvider = "stripe" | "manual" | "none";

/**
 * @deprecated Auto-recharge is a Cloud-only enforcement concern. Retained as an
 * inert wire/storage shape so the ledger tables and Cloud port can describe it;
 * OSS never produces or acts on it.
 */
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
    };

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
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
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
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
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
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
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
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
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
  | "operation"
  | "gateway_compute"
  | "gateway_storage_gb_hour"
  | "ai_request"
  | "ai_input_token"
  | "ai_output_token";

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

export function usageResourceMetadataLeaksInternalWorkersBackend(
  value: UsageResourceMetadata,
): boolean {
  return Object.entries(value).some(
    ([key, metadataValue]) =>
      usageMeterNameLeaksInternalWorkersBackend(key) ||
      (typeof metadataValue === "string" &&
        usageMeterNameLeaksInternalWorkersBackend(metadataValue)),
  );
}

export interface UsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
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

// ---------------------------------------------------------------------------
// Composition ports (OSS/Cloud boundary, Seam B)
//
// The OSS deploy controller computes a transparent showback cost estimate, then
// consults these injectable ports for any ENFORCEMENT decision. OSS ships the
// no-op defaults below ({@link NOOP_BILLING_ENFORCEMENT} / {@link
// NOOP_QUOTA_POLICY}), which NEVER block and NEVER touch a payment provider, so
// `showback`/`disabled` are the only behaviors an OSS-only deployment can
// exhibit. Takosumi Cloud injects real port implementations (Stripe-backed
// reserve/capture/release + plan quota) from its closed `billing-enforce`
// module, keeping all official-billing/enforced-payment code out of OSS source.
//
// These types intentionally live in the public contract so the Cloud delta can
// implement them by importing `takosumi-contract` ONLY (never OSS internals).
// ---------------------------------------------------------------------------

/** Context handed to {@link BillingEnforcement.reservePlanBilling} at plan time. */
export interface BillingReservationContext {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly runId: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** The OSS-resolved billing mode (`disabled` | `showback`). */
  readonly mode: BillingMode;
  /** Transparent showback estimate the OSS controller already computed. */
  readonly estimatedUsdMicros: number;
  readonly planResourceChanges: readonly PlanResourceChange[];
  /**
   * Whether layered policy + compatibility passed before billing. Enforcement
   * may only BLOCK a plan that would otherwise pass; an already-blocked plan is
   * recorded for audit but never additionally blocked by billing.
   */
  readonly policyPassedBeforeBilling: boolean;
  readonly now: number;
}

/** Decision returned by a {@link BillingEnforcement} / {@link QuotaPolicy} port. */
export interface BillingEnforcementDecision {
  /** Blocking reasons; an empty array means "allowed". OSS no-op returns `[]`. */
  readonly reasons: readonly string[];
  /** Extra audit fields merged into the plan's billing audit record. */
  readonly audit?: Readonly<Record<string, JsonValue>>;
}

export interface BillingReservationCheckContext {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly runId: string;
  readonly now: number;
}

export interface BillingCaptureContext {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly runId: string;
  readonly applyRunId: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  /** USD micros the OSS controller recorded as the captured usage estimate. */
  readonly capturedUsdMicros: number;
  readonly now: number;
}

export interface BillingReleaseContext {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly runId: string;
  readonly now: number;
}

/**
 * Cloud-injectable enforcement port mirroring the OSS controller's
 * reserve/capture/release surface. OSS supplies {@link NOOP_BILLING_ENFORCEMENT}
 * (showback: never blocks, never charges); Cloud supplies a Stripe-backed
 * implementation that reserves/captures USD balance against its own ledger and
 * can return blocking reasons.
 */
export interface BillingEnforcement {
  /**
   * Plan-time reservation. Returns blocking `reasons` (e.g. insufficient USD
   * balance) for an enforce-mode Workspace; OSS returns `{ reasons: [] }`.
   */
  reservePlanBilling(
    ctx: BillingReservationContext,
  ): Promise<BillingEnforcementDecision>;
  /**
   * Apply-time precondition. Throws when an enforce reservation is missing /
   * expired so the apply fails closed; OSS is a no-op.
   */
  assertReservationSatisfied(ctx: BillingReservationCheckContext): Promise<void>;
  /** Capture the reserved amount on a successful apply (Cloud debits balance). */
  captureRunBilling(ctx: BillingCaptureContext): Promise<void>;
  /** Release a reservation on a failed/abandoned apply (Cloud restores balance). */
  releaseReservation(ctx: BillingReleaseContext): Promise<void>;
}

export interface QuotaEvaluationContext {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly estimatedUsdMicros: number;
  readonly planResourceChanges: readonly PlanResourceChange[];
}

/**
 * Cloud-injectable plan quota / per-run limit port. OSS supplies
 * {@link NOOP_QUOTA_POLICY} (no plan limits); Cloud enforces subscription plan
 * limits + resource quotas and can return blocking reasons.
 */
export interface QuotaPolicy {
  evaluatePlanQuota(
    ctx: QuotaEvaluationContext,
  ): Promise<BillingEnforcementDecision>;
}

/** OSS default: showback enforcement that never blocks and never charges. */
export const NOOP_BILLING_ENFORCEMENT: BillingEnforcement = {
  async reservePlanBilling(): Promise<BillingEnforcementDecision> {
    return { reasons: [] };
  },
  async assertReservationSatisfied(): Promise<void> {},
  async captureRunBilling(): Promise<void> {},
  async releaseReservation(): Promise<void> {},
};

/** OSS default: no plan quota enforcement. */
export const NOOP_QUOTA_POLICY: QuotaPolicy = {
  async evaluatePlanQuota(): Promise<BillingEnforcementDecision> {
    return { reasons: [] };
  },
};
