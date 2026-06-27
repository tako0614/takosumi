/**
 * Showback billing / usage facade (§28 / §32; Space billing).
 *
 * OSS Takosumi (and Takosumi for-Operators) only ever runs a NON-blocking
 * Workspace-scoped ledger: `disabled` (no ledger) or `showback` (record a
 * transparent cost estimate + usage WITHOUT ever blocking apply). Official
 * billing, enforced payment gates, Stripe, and per-plan quota that BLOCK apply
 * are Takosumi Cloud-only CLOSED features.
 *
 * This collaborator therefore:
 *   - computes the transparent plan cost estimate,
 *   - records the showback CreditReservation + UsageEvent ledger rows, and
 *   - delegates EVERY enforcement decision to the injected
 *     {@link BillingEnforcement} / {@link QuotaPolicy} composition ports
 *     (Seam B). OSS injects the no-op defaults (showback: never block, never
 *     charge); Takosumi Cloud injects a Stripe-backed implementation from its
 *     closed `billing-enforce` module.
 *
 * No Stripe API call and no apply-blocking code path lives here anymore.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  PlanResourceChange,
  PlanRun,
  ApplyRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  BillingEnforcement,
  BillingProvider,
  BillingSettings,
  CreditReservation,
  QuotaPolicy,
} from "takosumi-contract/billing";
import {
  billingPlanIncludedUsdMicros,
  creditBalanceMonthlyIncludedUsdMicros,
  creditReservationEstimatedUsdMicros,
  legacyCreditsToUsdMicros,
  NOOP_BILLING_ENFORCEMENT,
  NOOP_QUOTA_POLICY,
  usdFromMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type { Space } from "takosumi-contract/spaces";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { OpenTofuPlanResult } from "./mod.ts";

/**
 * Operator/self-host billing default (§28). The controller falls back to this
 * when no `defaultBillingSettings` dependency is wired (self-host style).
 */
export const DISABLED_BILLING_SETTINGS: BillingSettings = {
  mode: "disabled",
  provider: "none",
};

const BILLING_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Transparent, deterministic plan cost model (core-spec §32.3.1).
 *
 * `credits = max(PLAN_CREDIT_BASE, Σ per-change weight)` where each plan
 * resource change contributes the weight of its heaviest OpenTofu action. A
 * replacement (`["delete","create"]` / `["create","delete"]`) is therefore
 * billed once as a create (`max(delete=1, create=2) = 2`) rather than
 * double-counted as create + delete. `read` / `no-op` contribute nothing.
 */
const PLAN_CREDIT_BASE = 1;
const PLAN_CREDIT_WEIGHT_CREATE = 2;
const PLAN_CREDIT_WEIGHT_REPLACE = 2;
const PLAN_CREDIT_WEIGHT_UPDATE = 1;
const PLAN_CREDIT_WEIGHT_DELETE = 1;
const PLAN_CREDIT_WEIGHT_READ = 0;
const PLAN_CREDIT_WEIGHT_NOOP = 0;

/** Weight of a single OpenTofu plan action token. Unknown tokens cost nothing. */
function planActionWeight(action: string): number {
  switch (action.trim()) {
    case "create":
      return PLAN_CREDIT_WEIGHT_CREATE;
    case "replace":
      return PLAN_CREDIT_WEIGHT_REPLACE;
    case "update":
      return PLAN_CREDIT_WEIGHT_UPDATE;
    case "delete":
      return PLAN_CREDIT_WEIGHT_DELETE;
    case "read":
      return PLAN_CREDIT_WEIGHT_READ;
    case "no-op":
      return PLAN_CREDIT_WEIGHT_NOOP;
    default:
      return 0;
  }
}

/**
 * Weight of one plan resource change: the heaviest of its action tokens. Taking
 * the max (rather than the sum) keeps a replacement, which OpenTofu emits as the
 * two-token `["delete","create"]`, billed as a single create instead of
 * create + delete.
 */
function planChangeWeight(change: PlanResourceChange): number {
  let weight = 0;
  for (const action of change.actions) {
    weight = Math.max(weight, planActionWeight(action));
  }
  return weight;
}

/**
 * Transparent, deterministic credit estimate for a plan (core-spec §32.3.1):
 * `credits = max(PLAN_CREDIT_BASE, Σ per-change weight)`.
 */
function estimatePlanCredits(
  _planRun: PlanRun,
  result: OpenTofuPlanResult,
): number {
  const changes = result.planResourceChanges ?? [];
  let sum = 0;
  for (const change of changes) {
    sum += planChangeWeight(change);
  }
  return Math.max(PLAN_CREDIT_BASE, sum);
}

function estimatePlanUsdMicros(
  planRun: PlanRun,
  result: OpenTofuPlanResult,
): number {
  return legacyCreditsToUsdMicros(estimatePlanCredits(planRun, result));
}

function formatUsdMicros(value: number): string {
  return `$${usdFromMicros(value)
    .toFixed(6)
    .replace(/\.?0+$/u, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingProvider(value: unknown): value is BillingProvider {
  return value === "stripe" || value === "manual" || value === "none";
}

/**
 * Normalizes operator-supplied billing settings. OSS ACCEPTS only `disabled` and
 * `showback`. A legacy/Cloud `enforce` value is rejected here: OSS never
 * PRODUCES an enforce setting, and the only way to gate an apply on payment is a
 * Cloud-injected {@link BillingEnforcement} port.
 */
function normalizeBillingSettings(value: unknown): BillingSettings {
  if (!isRecord(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "billingSettings must be an object",
    );
  }
  if (value.mode === "disabled") {
    if (value.provider !== "none") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "disabled billing requires provider none",
      );
    }
    return { mode: "disabled", provider: "none" };
  }
  if (value.mode === "showback") {
    if (!isBillingProvider(value.provider)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "showback billing provider must be stripe, manual, or none",
      );
    }
    if (
      value.reservationRequired !== undefined &&
      value.reservationRequired !== false
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "showback billing reservationRequired must be false when provided",
      );
    }
    return {
      mode: "showback",
      provider: value.provider,
      ...(value.reservationRequired === false
        ? { reservationRequired: false }
        : {}),
    };
  }
  // `enforce` (and anything else) is not an OSS-producible mode.
  throw new OpenTofuControllerError(
    "invalid_argument",
    "billing mode must be disabled or showback (enforce is Takosumi Cloud-only)",
  );
}

/**
 * Ports the controller injects into {@link BillingService}. `enforcement` /
 * `quota` default to the OSS showback no-ops; Cloud overrides them.
 */
export interface BillingServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Operator/self-host billing default (§28); Space.billingSettings overrides it. */
  readonly defaultBillingSettings: BillingSettings;
  /** Shared Space-existence guard (used by many non-billing controller methods too). */
  readonly requireSpace: (spaceId: string) => Promise<Space>;
  /** Seam B enforcement port. Defaults to the showback no-op. */
  readonly enforcement?: BillingEnforcement;
  /** Seam B plan-quota port. Defaults to the no-op. */
  readonly quota?: QuotaPolicy;
}

/**
 * Collaborator owning the Space showback ledger: subscription mutation
 * (disabled|showback), the per-plan cost estimate, the showback
 * CreditReservation + UsageEvent rows, and monthly-credit bookkeeping. All
 * enforcement is delegated to the injected ports.
 */
export class BillingService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #requireSpace: (spaceId: string) => Promise<Space>;
  readonly #enforcement: BillingEnforcement;
  readonly #quota: QuotaPolicy;

  constructor(dependencies: BillingServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#defaultBillingSettings = dependencies.defaultBillingSettings;
    this.#requireSpace = dependencies.requireSpace;
    this.#enforcement = dependencies.enforcement ?? NOOP_BILLING_ENFORCEMENT;
    this.#quota = dependencies.quota ?? NOOP_QUOTA_POLICY;
  }

  async changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }> {
    requireNonEmptyString(spaceId, "spaceId");
    const space = await this.#requireSpace(spaceId);
    const settings = normalizeBillingSettings(input.billingSettings);
    await this.#store.putSpace({
      ...space,
      billingSettings: settings,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    return { billing: { settings } };
  }

  async billingSettingsForSpace(spaceId: string): Promise<BillingSettings> {
    const space = await this.#store.getSpace(spaceId);
    return space?.billingSettings ?? this.#defaultBillingSettings;
  }

  async #billingPlanForSpace(spaceId: string) {
    const subscription = await this.#store.getSpaceSubscription(spaceId);
    if (!subscription) return undefined;
    const plan = await this.#store.getBillingPlan(subscription.planId);
    return plan ? { subscription, plan } : undefined;
  }

  /**
   * Monthly-credit bookkeeping for a subscribed Space. Inert for OSS-only
   * deployments (no subscription rows exist without Cloud enforcement); kept so
   * the usage service can call it uniformly. No Stripe, no blocking.
   */
  async reconcileSpaceMonthlyCredits(spaceId: string): Promise<void> {
    const billingPlan = await this.#billingPlanForSpace(spaceId);
    if (!billingPlan) return;
    if (
      billingPlan.subscription.status !== "active" &&
      billingPlan.subscription.status !== "trialing"
    ) {
      return;
    }
    const periodStartMs = Date.parse(
      billingPlan.subscription.currentPeriodStart,
    );
    if (!Number.isFinite(periodStartMs) || periodStartMs > this.#now()) {
      return;
    }
    const balance = await this.#store.getCreditBalance(spaceId);
    const nowIso = new Date(this.#now()).toISOString();
    const includedUsdMicros = billingPlanIncludedUsdMicros(billingPlan.plan);
    const includedCredits = usdMicrosToLegacyCredits(includedUsdMicros);
    if (!balance) {
      await this.#store.putCreditBalance({
        spaceId,
        availableUsdMicros: includedUsdMicros,
        reservedUsdMicros: 0,
        monthlyIncludedUsdMicros: includedUsdMicros,
        purchasedUsdMicros: 0,
        availableCredits: includedCredits,
        reservedCredits: 0,
        monthlyIncludedCredits: includedCredits,
        purchasedCredits: 0,
        updatedAt: nowIso,
      });
      return;
    }
    const balanceUpdatedAtMs = Date.parse(balance.updatedAt);
    if (
      Number.isFinite(balanceUpdatedAtMs) &&
      balanceUpdatedAtMs >= periodStartMs &&
      creditBalanceMonthlyIncludedUsdMicros(balance) === includedUsdMicros
    ) {
      return;
    }
    await this.#store.reconcileMonthlyCredits(spaceId, {
      newMonthly: includedCredits,
      periodStartIso: new Date(periodStartMs).toISOString(),
      updatedAt: nowIso,
    });
  }

  /**
   * Plan-time billing. Records the transparent showback estimate and consults
   * the injected quota + enforcement ports. Billing may BLOCK only a plan that
   * would otherwise pass; the OSS no-op ports never block.
   */
  async evaluatePlanBillingReservation(input: {
    readonly planRun: PlanRun;
    readonly result: OpenTofuPlanResult;
    readonly now: number;
    readonly policyPassedBeforeBilling: boolean;
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    const settings = await this.billingSettingsForSpace(input.planRun.spaceId);
    if (settings.mode === "disabled") {
      return {
        reasons: [],
        audit: {
          mode: settings.mode,
          estimatedUsdMicros: 0,
          estimatedCredits: 0,
        },
      };
    }
    await this.reconcileSpaceMonthlyCredits(input.planRun.spaceId);
    const estimatedUsdMicros = estimatePlanUsdMicros(
      input.planRun,
      input.result,
    );
    const estimatedCredits = usdMicrosToLegacyCredits(estimatedUsdMicros);
    const changes = input.result.planResourceChanges ?? [];
    let audit: Readonly<Record<string, JsonValue>> = {
      mode: settings.mode,
      estimatedUsdMicros,
      estimatedCredits,
    };

    // Seam B quota port (OSS no-op: no plan limits).
    const quota = await this.#quota.evaluatePlanQuota({
      spaceId: input.planRun.spaceId,
      estimatedUsdMicros,
      planResourceChanges: changes,
    });
    if (quota.audit) audit = { ...audit, ...quota.audit };

    // Seam B enforcement port (OSS no-op: never blocks, never charges).
    const enforced = await this.#enforcement.reservePlanBilling({
      spaceId: input.planRun.spaceId,
      runId: input.planRun.id,
      ...(input.planRun.installationId
        ? { installationId: input.planRun.installationId }
        : {}),
      mode: settings.mode,
      estimatedUsdMicros,
      planResourceChanges: changes,
      policyPassedBeforeBilling: input.policyPassedBeforeBilling,
      now: input.now,
    });
    if (enforced.audit) audit = { ...audit, ...enforced.audit };

    // Enforcement may only block a plan that would otherwise PASS policy.
    if (input.policyPassedBeforeBilling) {
      const reasons = [...quota.reasons, ...enforced.reasons];
      if (reasons.length > 0) {
        return { reasons, audit };
      }
    }
    // Showback ledger: record the estimate reservation (never blocks).
    return await this.#recordCreditReservation({
      planRun: input.planRun,
      estimatedUsdMicros,
      estimatedCredits,
      settings,
      now: input.now,
      audit,
    });
  }

  async #recordCreditReservation(input: {
    readonly planRun: PlanRun;
    readonly estimatedUsdMicros: number;
    readonly estimatedCredits: number;
    readonly settings: BillingSettings;
    readonly now: number;
    readonly audit: Readonly<Record<string, JsonValue>>;
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    const reservation: CreditReservation = {
      id: this.#newId("creditres"),
      spaceId: input.planRun.spaceId,
      runId: input.planRun.id,
      estimatedUsdMicros: input.estimatedUsdMicros,
      estimatedCredits: input.estimatedCredits,
      status: "reserved",
      mode: input.settings.mode,
      createdAt: new Date(input.now).toISOString(),
      expiresAt: new Date(input.now + BILLING_RESERVATION_TTL_MS).toISOString(),
    };
    await this.#store.putCreditReservation(reservation);
    return {
      reasons: [],
      audit: {
        ...input.audit,
        reservationId: reservation.id,
        reservationStatus: reservation.status,
      },
    };
  }

  /**
   * Apply-time precondition. Showback never blocks; an injected enforcement port
   * may throw (e.g. expired reservation / insufficient balance) to fail closed.
   */
  async assertApplyBillingReservation(planRun: PlanRun): Promise<void> {
    const settings = await this.billingSettingsForSpace(planRun.spaceId);
    if (settings.mode === "disabled") return;
    await this.#enforcement.assertReservationSatisfied({
      spaceId: planRun.spaceId,
      planRunId: planRun.id,
      now: this.#now(),
    });
  }

  /**
   * Records the showback usage event for a successful apply (against the
   * recorded estimate) and delegates any balance capture to the enforcement
   * port.
   */
  async captureApplyBillingUsage(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly now: number;
  }): Promise<void> {
    const reservation = await this.#store.getCreditReservationForRun(
      input.planRun.id,
    );
    if (!reservation) return;
    if (reservation.status !== "reserved") return;
    const reservedUsdMicros = creditReservationEstimatedUsdMicros(reservation);
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      spaceId: input.planRun.spaceId,
      ...(input.planRun.installationId
        ? { installationId: input.planRun.installationId }
        : {}),
      runId: input.applyRun.id,
      kind: "operation",
      quantity: 1,
      usdMicros: reservedUsdMicros,
      credits: usdMicrosToLegacyCredits(reservedUsdMicros),
      source: "runner",
      idempotencyKey: `${input.applyRun.id}:operation`,
      createdAt: new Date(input.now).toISOString(),
    });
    await this.#store.putCreditReservation({
      ...reservation,
      status: "captured",
    });
    await this.#enforcement.captureRunBilling({
      spaceId: input.planRun.spaceId,
      planRunId: input.planRun.id,
      applyRunId: input.applyRun.id,
      ...(input.planRun.installationId
        ? { installationId: input.planRun.installationId }
        : {}),
      capturedUsdMicros: reservedUsdMicros,
      now: input.now,
    });
  }

  /**
   * Releases a reservation on a failed/abandoned apply. Marks the showback row
   * released and delegates any balance restore to the enforcement port.
   */
  async releaseApplyBillingReservation(planRun: PlanRun): Promise<void> {
    const reservation = await this.#store.getCreditReservationForRun(
      planRun.id,
    );
    if (reservation && reservation.status === "reserved") {
      await this.#store.putCreditReservation({
        ...reservation,
        status: "released",
      });
    }
    await this.#enforcement.releaseReservation({
      spaceId: planRun.spaceId,
      planRunId: planRun.id,
      now: this.#now(),
    });
  }
}
