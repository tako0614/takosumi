/**
 * Portable OSS showback and commercial-enforcement composition contract.
 *
 * Commercial plans, subscriptions, balances, reservations, recharge attempts,
 * payment-provider events, and invoices are host-owned records. They do not
 * cross this OSS contract. Amounts use USD micros: 1 USD = 1,000,000 micros.
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
 * Commercial payment gating is represented only by an injected
 * {@link BillingEnforcement} decision port. No commercial mode or provider is
 * persisted in an OSS Workspace.
 */
export type BillingMode = "disabled" | "showback";

export type BillingSettings =
  | {
      readonly mode: "disabled";
    }
  | {
      readonly mode: "showback";
    };

/** Opaque meter kind; producers may introduce stable tokens without a release. */
export type UsageEventKind = string;

/**
 * Open producer token. `runner` is reserved for Core's execution estimator;
 * hosts and installed meters may publish other stable tokens without a
 * Takosumi contract release.
 */
export type UsageEventSource = string;

/**
 * Provider/runtime-defined family for grouping billable managed resources.
 *
 * The contract intentionally keeps this open so new managed resources can be
 * metered without a public contract migration.
 */
export type UsageResourceFamily = string;

/**
 * Explicit evidence for whether a UsageEvent amount came from a configured
 * host rating policy. `unrated` is not the same as a rated zero-cost event.
 */
export type UsageRatingStatus = "rated" | "unrated";

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

/**
 * Per-Capsule showback aggregate: the sum of this Capsule's recorded usage
 * events. A read-only projection for the dashboard's per-app estimated-cost
 * line; with billing mode `disabled` there are simply no events and the sum
 * is zero.
 */
export interface CapsuleUsageSummary {
  readonly capsuleId: string;
  readonly usdMicros: number;
  readonly eventCount: number;
  readonly ratedEventCount: number;
  readonly unratedEventCount: number;
}

export interface UsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly runId?: string;
  readonly meterId?: string;
  readonly resourceFamily?: UsageResourceFamily;
  readonly resourceId?: string;
  readonly operation?: string;
  readonly resourceMetadata?: UsageResourceMetadata;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly usdMicros: number;
  readonly ratingStatus: UsageRatingStatus;
  readonly source: UsageEventSource;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export function usageEventUsdMicros(event: UsageEvent): number {
  const amount = nonNegativeUsdMicros(event.usdMicros, "usage usdMicros");
  if (event.ratingStatus !== "rated" && event.ratingStatus !== "unrated") {
    throw new TypeError("usage ratingStatus must be rated or unrated");
  }
  if (event.ratingStatus === "unrated" && amount !== 0) {
    throw new TypeError("unrated usage must have zero usdMicros");
  }
  return amount;
}

// ---------------------------------------------------------------------------
// Showback rating composition port
// ---------------------------------------------------------------------------

/** Result of an explicitly configured host rating policy. */
export interface ShowbackRating {
  readonly ratingStatus: UsageRatingStatus;
  readonly usdMicros: number;
  /** Non-secret host evidence stored with the plan audit when applicable. */
  readonly audit?: Readonly<Record<string, JsonValue>>;
}

/** Plan measurement handed to an injected {@link ShowbackRater}. */
export interface PlanShowbackRatingContext {
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly runId: string;
  readonly capsuleId?: string;
  readonly planResourceChanges: readonly PlanResourceChange[];
  readonly now: number;
}

/** Usage measurement handed to an injected {@link ShowbackRater}. */
export interface UsageShowbackRatingContext {
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly runId?: string;
  readonly capsuleId?: string;
  readonly meterId?: string;
  readonly resourceFamily?: UsageResourceFamily;
  readonly resourceId?: string;
  readonly operation?: string;
  readonly resourceMetadata?: UsageResourceMetadata;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly source: UsageEventSource;
  readonly createdAt: string;
}

/**
 * Open host composition port that rates provider-neutral measurements.
 *
 * OSS does not ship prices. A self-host or Operator may install any explicit
 * policy, while Cloud installs its own price-book-backed implementation.
 */
export interface ShowbackRater {
  ratePlan(ctx: PlanShowbackRatingContext): Promise<ShowbackRating>;
  rateUsage(ctx: UsageShowbackRatingContext): Promise<ShowbackRating>;
}

/**
 * OSS default: preserve the measurement as explicitly unrated. This never
 * blocks a Run and never invents a price from resource actions or duration.
 */
export const NOOP_SHOWBACK_RATER: ShowbackRater = {
  async ratePlan(): Promise<ShowbackRating> {
    return { ratingStatus: "unrated", usdMicros: 0 };
  },
  async rateUsage(): Promise<ShowbackRating> {
    return { ratingStatus: "unrated", usdMicros: 0 };
  },
};

// ---------------------------------------------------------------------------
// Composition ports (OSS/Cloud boundary, Seam B)
//
// The OSS deploy controller computes a transparent showback cost estimate, then
// consults these injectable ports for any ENFORCEMENT decision. OSS ships the
// no-op defaults below ({@link NOOP_BILLING_ENFORCEMENT} / {@link
// NOOP_QUOTA_POLICY}), which NEVER block and NEVER touch a payment provider, so
// `showback`/`disabled` are the only behaviors an OSS-only deployment can
// exhibit. A commercial host injects real reserve/capture/release and plan
// quota implementations from its closed billing module, keeping all official
// billing and enforced-payment code out of OSS source.
//
// These types intentionally live in the public contract so the Cloud delta can
// implement them by importing `takosumi-contract` ONLY (never OSS internals).
// ---------------------------------------------------------------------------

/** Context handed to {@link BillingEnforcement.reservePlanBilling} at plan time. */
export interface BillingReservationContext {
  readonly workspaceId: string;
  /** Owner-account subject resolved by OSS from the canonical Workspace. */
  readonly billingSubjectId: string;
  readonly runId: string;
  readonly capsuleId?: string;
  /** The OSS-resolved billing mode (`disabled` | `showback`). */
  readonly mode: BillingMode;
  /** Amount returned by the explicitly composed showback rater. */
  readonly estimatedUsdMicros: number;
  readonly ratingStatus: UsageRatingStatus;
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
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly runId: string;
  readonly now: number;
}

export interface BillingCaptureContext {
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly runId: string;
  readonly applyRunId: string;
  readonly capsuleId?: string;
  /** USD micros the OSS controller recorded as the captured usage estimate. */
  readonly capturedUsdMicros: number;
  readonly ratingStatus: UsageRatingStatus;
  readonly now: number;
}

export interface BillingReleaseContext {
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly runId: string;
  readonly now: number;
}

/**
 * Cloud-injectable enforcement port mirroring the OSS controller's
 * reserve/capture/release surface. OSS supplies {@link NOOP_BILLING_ENFORCEMENT}
 * (showback: never blocks, never charges); a commercial host may supply an
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
  assertReservationSatisfied(
    ctx: BillingReservationCheckContext,
  ): Promise<void>;
  /**
   * Capture after the provider apply succeeds. A required post-apply lifecycle
   * action may still make the Run terminally failed while retaining the
   * provider-applied StateVersion/Output; that provider mutation is still
   * billable and must be captured rather than released. Implementations MUST
   * be idempotent for the stable `(runId, applyRunId)` pair: Takosumi persists a
   * pending finalization marker with the provider ledger and retries capture
   * after process crashes or transient host failures.
   */
  captureRunBilling(ctx: BillingCaptureContext): Promise<void>;
  /** Release a reservation on a failed/abandoned apply (Cloud restores balance). */
  releaseReservation(ctx: BillingReleaseContext): Promise<void>;
}

export interface QuotaEvaluationContext {
  readonly workspaceId: string;
  readonly billingSubjectId: string;
  readonly estimatedUsdMicros: number;
  readonly ratingStatus: UsageRatingStatus;
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

export interface BillingExtensionFactoryResult {
  /** Host price policy; omission leaves OSS measurements explicitly unrated. */
  readonly showbackRater?: ShowbackRater;
  readonly billingEnforcement?: BillingEnforcement;
  readonly quotaPolicy?: QuotaPolicy;
}

/**
 * Seam B factory installed by Operator/Cloud at the host composition root.
 * OSS asks the host for narrow decision ports and otherwise uses its no-op
 * enforcement/quota defaults. Commercial persistence never crosses this seam.
 */
export interface BillingExtensionFactory {
  create():
    BillingExtensionFactoryResult | Promise<BillingExtensionFactoryResult>;
}
