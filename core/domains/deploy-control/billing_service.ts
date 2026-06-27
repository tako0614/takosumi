/**
 * Billing / credit / usage facade (§28 / §32 credit reservation; Space billing).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: it owns the
 * Space subscription mutation methods, the per-plan credit-reservation
 * evaluation, the apply-time reserve / capture / release / expire ceremony, the
 * monthly-credit reconciliation, and basic billing reservation.
 * The controller holds one instance, re-exposes `changeSpaceSubscription` /
 * `reconcileStripeSpaceSubscription` on its public API unchanged, and the
 * run-engine call sites delegate to `this.#billing.<method>`.
 *
 * The shared `requireSpace` guard stays on the controller and is injected as a
 * port rather than moved.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  PlanResourceChange,
  PlanRun,
  ApplyRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  BillingAccount,
  BillingAutoRechargeSettings,
  BillingProvider,
  BillingSettings,
  CreditBalance,
  CreditReservation,
  SpaceSubscription,
} from "takosumi-contract/billing";
import {
  billingPlanIncludedUsdMicros,
  billingPlanMaxEstimatedUsdMicros,
  billingReservationRequired,
  creditBalanceAvailableUsdMicros,
  creditBalanceMonthlyIncludedUsdMicros,
  creditBalanceReservedUsdMicros,
  creditReservationEstimatedUsdMicros,
  legacyCreditsToUsdMicros,
  nonNegativeUsdMicros,
  positiveUsdMicros,
  usdFromMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type { Space } from "takosumi-contract/spaces";
import { evaluateQuotaPolicy } from "takosumi-policy";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { OpenTofuPlanResult } from "./mod.ts";

/**
 * Operator/self-host billing default (§28). The controller falls back to this
 * when no `defaultBillingSettings` dependency is wired (self-host style), and
 * the Stripe-cancelled path resets a Space to it.
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
 *
 * Future runner-minute cost (`runner_minute` usage) is intentionally NOT folded
 * in here; it is metered separately as a `UsageEvent` after the run and would be
 * added to this estimate as a separate additive term when introduced.
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
 * `credits = max(PLAN_CREDIT_BASE, Σ per-change weight)`. The per-change weight
 * is the heaviest action token of that change (see {@link planChangeWeight}), so
 * a replacement is billed once as a create. With no resource changes the
 * estimate falls back to `PLAN_CREDIT_BASE` (minimum charge).
 *
 * `planRun` is unused today: cost depends only on the plan resource changes, but
 * the signature keeps the run available for a future runner-minute term.
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

function requirePositiveUsdMicros(value: unknown, label: string): number {
  try {
    return positiveUsdMicros(value, label);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a positive USD micros integer`,
    );
  }
}

function requireNonNegativeUsdMicros(value: unknown, label: string): number {
  try {
    return nonNegativeUsdMicros(value, label);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a non-negative USD micros integer`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingProvider(value: unknown): value is BillingProvider {
  return value === "stripe" || value === "manual" || value === "none";
}

function normalizeAutoRechargeSettings(
  value: unknown,
): BillingAutoRechargeSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "autoRecharge must be an object",
    );
  }
  if (value.enabled !== true) {
    return {
      enabled: false,
      thresholdUsdMicros: 0,
      rechargeUsdMicros: 0,
    };
  }
  const thresholdUsdMicros = requireNonNegativeUsdMicros(
    value.thresholdUsdMicros,
    "autoRecharge.thresholdUsdMicros",
  );
  const rechargeUsdMicros = requirePositiveUsdMicros(
    value.rechargeUsdMicros,
    "autoRecharge.rechargeUsdMicros",
  );
  return {
    enabled: true,
    thresholdUsdMicros,
    rechargeUsdMicros,
    ...(value.monthlyLimitUsdMicros !== undefined
      ? {
          monthlyLimitUsdMicros: requirePositiveUsdMicros(
            value.monthlyLimitUsdMicros,
            "autoRecharge.monthlyLimitUsdMicros",
          ),
        }
      : {}),
  };
}

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
  if (value.mode === "enforce") {
    if (value.provider !== "stripe" && value.provider !== "manual") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "enforced billing requires stripe or manual provider",
      );
    }
    if (value.reservationRequired !== true) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "enforced billing requires reservationRequired true",
      );
    }
    const autoRecharge = normalizeAutoRechargeSettings(value.autoRecharge);
    if (autoRecharge?.enabled && value.provider !== "stripe") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "autoRecharge requires stripe billing",
      );
    }
    return {
      mode: "enforce",
      provider: value.provider,
      reservationRequired: true,
      ...(autoRecharge ? { autoRecharge } : {}),
    };
  }
  throw new OpenTofuControllerError("invalid_argument", "unknown billing mode");
}

function stripeCoreBillingStatus(status: string): BillingAccount["status"] {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "disabled";
  }
}

function stripeSpaceSubscriptionStatus(
  status: string,
): SpaceSubscription["status"] {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "cancelled";
  }
}

function stripeSpaceBillingSettings(status: string): BillingSettings {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
      return {
        mode: "enforce",
        provider: "stripe",
        reservationRequired: true,
      };
    default:
      return DISABLED_BILLING_SETTINGS;
  }
}

export interface ReconcileStripeSpaceSubscriptionInput {
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly stripePriceId?: string;
  readonly planCode: string;
  readonly status: string;
  readonly currentPeriodStartUnix?: number;
  readonly currentPeriodEndUnix?: number;
}

export interface BillingAutoRechargeInput {
  readonly spaceId: string;
  readonly estimatedUsdMicros: number;
  readonly availableUsdMicros: number;
  readonly shortfallUsdMicros: number;
  readonly thresholdUsdMicros: number;
  readonly rechargeUsdMicros: number;
  readonly monthlyLimitUsdMicros?: number;
  readonly now: number;
}

export interface BillingAutoRechargeResult {
  readonly balance?: CreditBalance;
  readonly chargedUsdMicros?: number;
  readonly skippedReason?: string;
}

export type BillingAutoRechargePort = (
  input: BillingAutoRechargeInput,
) => Promise<BillingAutoRechargeResult>;

/**
 * Ports the controller injects into {@link BillingService}. The Space guard is
 * passed as a callback; `store` / `newId` / `now` mirror the controller's own
 * handles so timestamps and ids line up across both surfaces.
 */
export interface BillingServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Operator/self-host billing default (§28); Space.billingSettings overrides it. */
  readonly defaultBillingSettings: BillingSettings;
  /** Shared Space-existence guard (used by many non-billing controller methods too). */
  readonly requireSpace: (spaceId: string) => Promise<Space>;
  /**
   * Cloud/account-plane hook that can create an off-session Stripe charge and
   * grant USD balance before a reservation is attempted.
   */
  readonly autoRecharge?: BillingAutoRechargePort;
}

/**
 * Collaborator owning the Space billing subsystem: subscription mutation, the
 * per-plan credit reservation, the apply-time reserve / capture / release /
 * expire ceremony, and monthly-credit reconciliation.
 */
export class BillingService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #requireSpace: (spaceId: string) => Promise<Space>;
  readonly #autoRecharge?: BillingAutoRechargePort;

  constructor(dependencies: BillingServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#defaultBillingSettings = dependencies.defaultBillingSettings;
    this.#requireSpace = dependencies.requireSpace;
    this.#autoRecharge = dependencies.autoRecharge;
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

  async reconcileStripeSpaceSubscription(
    spaceId: string,
    input: ReconcileStripeSpaceSubscriptionInput,
  ): Promise<{
    readonly billingAccount: BillingAccount;
    readonly subscription: SpaceSubscription;
    readonly billing: { readonly settings: BillingSettings };
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    const space = await this.#requireSpace(spaceId);
    requireNonEmptyString(input.stripeCustomerId, "stripeCustomerId");
    requireNonEmptyString(input.stripeSubscriptionId, "stripeSubscriptionId");
    requireNonEmptyString(input.planCode, "planCode");
    const nowIso = new Date(this.#now()).toISOString();
    const existingAccount = await this.#store.getBillingAccountForOwner(
      "space",
      spaceId,
    );
    const billingAccountId = existingAccount?.id ?? `bill_space_${spaceId}`;
    const billingAccount = await this.#store.putBillingAccount({
      id: billingAccountId,
      ownerType: "space",
      ownerId: spaceId,
      provider: "stripe",
      stripeCustomerId: input.stripeCustomerId,
      status: stripeCoreBillingStatus(input.status),
      createdAt: existingAccount?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    const existingSubscription =
      await this.#store.getSpaceSubscription(spaceId);
    const subscription = await this.#store.putSpaceSubscription({
      id: existingSubscription?.id ?? input.stripeSubscriptionId,
      spaceId,
      billingAccountId: billingAccount.id,
      planId: input.planCode,
      status: stripeSpaceSubscriptionStatus(input.status),
      currentPeriodStart: input.currentPeriodStartUnix
        ? new Date(input.currentPeriodStartUnix * 1000).toISOString()
        : (existingSubscription?.currentPeriodStart ?? nowIso),
      currentPeriodEnd: input.currentPeriodEndUnix
        ? new Date(input.currentPeriodEndUnix * 1000).toISOString()
        : (existingSubscription?.currentPeriodEnd ?? nowIso),
      createdAt: existingSubscription?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    const settings = stripeSpaceBillingSettings(input.status);
    await this.#store.putSpace({
      ...space,
      billingAccountId: billingAccount.id,
      billingSettings: settings,
      updatedAt: nowIso,
    });
    // On cancellation, end the monthly subscription grant: zero
    // monthlyIncludedCredits and remove the unused monthly portion, keeping
    // purchased credits. `reconcileMonthlyCredits(newMonthly: 0)` resolves to
    // `available = max(0, available - oldMonthly)`, monthly = 0 — atomic and
    // idempotent (a second cancel finds monthly already 0 and is skipped).
    if (subscription.status === "cancelled") {
      await this.#store.reconcileMonthlyCredits(spaceId, {
        newMonthly: 0,
        periodStartIso: nowIso,
        updatedAt: nowIso,
      });
    }
    return { billingAccount, subscription, billing: { settings } };
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
    // Atomic, idempotent-per-period monthly RESET (same semantics as the old
    // `max(0, available - oldMonthly) + newMonthly` but in one conditional
    // UPDATE, so a concurrent top-up can no longer clobber the read-modify-
    // write).
    await this.#store.reconcileMonthlyCredits(spaceId, {
      newMonthly: includedCredits,
      periodStartIso: new Date(periodStartMs).toISOString(),
      updatedAt: nowIso,
    });
  }

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
    const auditBase = {
      mode: settings.mode,
      estimatedUsdMicros,
      estimatedCredits,
    } satisfies Readonly<Record<string, JsonValue>>;
    const planLimit = await this.#evaluateBillingPlanLimits({
      spaceId: input.planRun.spaceId,
      estimatedUsdMicros,
      changes: input.result.planResourceChanges ?? [],
    });
    const auditWithPlanLimits = planLimit.audit
      ? { ...auditBase, planLimits: planLimit.audit }
      : auditBase;
    if (!input.policyPassedBeforeBilling) {
      return { reasons: [], audit: auditWithPlanLimits };
    }
    if (settings.mode === "enforce" && planLimit.reasons.length > 0) {
      return { reasons: planLimit.reasons, audit: auditWithPlanLimits };
    }
    if (billingReservationRequired(settings)) {
      let balance = await this.#store.getCreditBalance(input.planRun.spaceId);
      let availableUsdMicros = creditBalanceAvailableUsdMicros(balance);
      const autoRecharge =
        settings.mode === "enforce" ? settings.autoRecharge : undefined;
      const postReserveUsdMicros = availableUsdMicros - estimatedUsdMicros;
      const shouldAutoRecharge =
        autoRecharge?.enabled === true &&
        settings.provider === "stripe" &&
        this.#autoRecharge !== undefined &&
        (availableUsdMicros < estimatedUsdMicros ||
          postReserveUsdMicros < autoRecharge.thresholdUsdMicros);
      if (shouldAutoRecharge && autoRecharge) {
        const neededUsdMicros = Math.max(
          0,
          estimatedUsdMicros +
            autoRecharge.thresholdUsdMicros -
            availableUsdMicros,
        );
        const result = await this.#autoRecharge({
          spaceId: input.planRun.spaceId,
          estimatedUsdMicros,
          availableUsdMicros,
          shortfallUsdMicros: Math.max(
            0,
            estimatedUsdMicros - availableUsdMicros,
          ),
          thresholdUsdMicros: autoRecharge.thresholdUsdMicros,
          rechargeUsdMicros: Math.max(
            autoRecharge.rechargeUsdMicros,
            neededUsdMicros,
          ),
          ...(autoRecharge.monthlyLimitUsdMicros !== undefined
            ? { monthlyLimitUsdMicros: autoRecharge.monthlyLimitUsdMicros }
            : {}),
          now: input.now,
        });
        balance =
          result.balance ??
          (await this.#store.getCreditBalance(input.planRun.spaceId));
        availableUsdMicros = creditBalanceAvailableUsdMicros(balance);
      }
      if (availableUsdMicros < estimatedUsdMicros) {
        return {
          reasons: [
            `USD balance reservation failed: ${formatUsdMicros(estimatedUsdMicros)} estimated but only ${formatUsdMicros(availableUsdMicros)} available`,
          ],
          audit: {
            ...auditWithPlanLimits,
            availableUsdMicros,
            availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
            reservationStatus: "insufficient_credits",
          },
        };
      }
      const reservedBalance = await this.#store.reserveCredits(
        input.planRun.spaceId,
        {
          usdMicros: estimatedUsdMicros,
          credits: estimatedCredits,
          updatedAt: new Date(input.now).toISOString(),
        },
      );
      if (!reservedBalance) {
        const latest = await this.#store.getCreditBalance(
          input.planRun.spaceId,
        );
        const latestAvailableUsdMicros =
          creditBalanceAvailableUsdMicros(latest);
        return {
          reasons: [
            `USD balance reservation failed: ${formatUsdMicros(estimatedUsdMicros)} estimated but only ${formatUsdMicros(latestAvailableUsdMicros)} available`,
          ],
          audit: {
            ...auditWithPlanLimits,
            availableUsdMicros: latestAvailableUsdMicros,
            availableCredits: usdMicrosToLegacyCredits(
              latestAvailableUsdMicros,
            ),
            reservationStatus: "insufficient_credits",
          },
        };
      }
    }
    const reservation: CreditReservation = {
      id: this.#newId("creditres"),
      spaceId: input.planRun.spaceId,
      runId: input.planRun.id,
      estimatedUsdMicros,
      estimatedCredits,
      status: "reserved",
      mode: settings.mode,
      createdAt: new Date(input.now).toISOString(),
      expiresAt: new Date(input.now + BILLING_RESERVATION_TTL_MS).toISOString(),
    };
    await this.#store.putCreditReservation(reservation);
    return {
      reasons: [],
      audit: {
        ...auditWithPlanLimits,
        reservationId: reservation.id,
        reservationStatus: reservation.status,
      },
    };
  }

  async #evaluateBillingPlanLimits(input: {
    readonly spaceId: string;
    readonly estimatedUsdMicros: number;
    readonly changes: readonly PlanResourceChange[];
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    const billingPlan = await this.#billingPlanForSpace(input.spaceId);
    if (!billingPlan) return { reasons: [] };
    const reasons: string[] = [];
    const limits = billingPlan.plan.limits;
    const maxEstimatedUsdMicros = billingPlanMaxEstimatedUsdMicros(limits);
    if (
      maxEstimatedUsdMicros !== undefined &&
      Number.isFinite(maxEstimatedUsdMicros) &&
      input.estimatedUsdMicros > maxEstimatedUsdMicros
    ) {
      reasons.push(
        `billing plan ${billingPlan.plan.id} limits estimated USD per run to ${formatUsdMicros(maxEstimatedUsdMicros)}; plan estimated ${formatUsdMicros(input.estimatedUsdMicros)}`,
      );
    }
    const quota = evaluateQuotaPolicy(input.changes, limits.quota);
    reasons.push(
      ...quota.reasons.map(
        (reason) => `billing plan ${billingPlan.plan.id} ${reason}`,
      ),
    );
    return {
      reasons,
      audit: {
        planId: billingPlan.plan.id,
        subscriptionId: billingPlan.subscription.id,
        ...(maxEstimatedUsdMicros !== undefined
          ? {
              maxEstimatedUsdMicrosPerRun: maxEstimatedUsdMicros,
              maxEstimatedCreditsPerRun: usdMicrosToLegacyCredits(
                maxEstimatedUsdMicros,
              ),
            }
          : {}),
        ...(limits.quota ? { quota: limits.quota } : {}),
        exceeded: reasons,
      },
    };
  }

  async assertApplyBillingReservation(planRun: PlanRun): Promise<void> {
    const settings = await this.billingSettingsForSpace(planRun.spaceId);
    if (!billingReservationRequired(settings)) return;
    const reservation = await this.#store.getCreditReservationForRun(
      planRun.id,
    );
    if (!reservation) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `credit_reservation_missing: plan run ${planRun.id} has no reserved credits`,
      );
    }
    if (reservation.status !== "reserved") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `credit_reservation_not_reserved: reservation ${reservation.id} is ${reservation.status}`,
      );
    }
    if (Date.parse(reservation.expiresAt) <= this.#now()) {
      await this.#expireCreditReservation(reservation);
      throw new OpenTofuControllerError(
        "failed_precondition",
        `credit_reservation_expired: reservation ${reservation.id} expired at ${reservation.expiresAt}`,
      );
    }
  }

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
    const balance = await this.#store.getCreditBalance(input.planRun.spaceId);
    if (balance && reservation.mode === "enforce") {
      const nextReservedUsdMicros = Math.max(
        0,
        creditBalanceReservedUsdMicros(balance) - reservedUsdMicros,
      );
      await this.#store.putCreditBalance({
        ...balance,
        reservedUsdMicros: nextReservedUsdMicros,
        reservedCredits: usdMicrosToLegacyCredits(nextReservedUsdMicros),
        updatedAt: new Date(input.now).toISOString(),
      });
    }
  }

  async releaseApplyBillingReservation(planRun: PlanRun): Promise<void> {
    const reservation = await this.#store.getCreditReservationForRun(
      planRun.id,
    );
    if (!reservation || reservation.status !== "reserved") return;
    await this.#store.putCreditReservation({
      ...reservation,
      status: "released",
    });
    const balance = await this.#store.getCreditBalance(planRun.spaceId);
    if (balance && reservation.mode === "enforce") {
      const reservationUsdMicros =
        creditReservationEstimatedUsdMicros(reservation);
      const nextAvailableUsdMicros =
        creditBalanceAvailableUsdMicros(balance) + reservationUsdMicros;
      const nextReservedUsdMicros = Math.max(
        0,
        creditBalanceReservedUsdMicros(balance) - reservationUsdMicros,
      );
      await this.#store.putCreditBalance({
        ...balance,
        availableUsdMicros: nextAvailableUsdMicros,
        reservedUsdMicros: nextReservedUsdMicros,
        availableCredits: usdMicrosToLegacyCredits(nextAvailableUsdMicros),
        reservedCredits: usdMicrosToLegacyCredits(nextReservedUsdMicros),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
  }

  async #expireCreditReservation(
    reservation: CreditReservation,
  ): Promise<void> {
    await this.#store.putCreditReservation({
      ...reservation,
      status: "expired",
    });
    const balance = await this.#store.getCreditBalance(reservation.spaceId);
    if (balance && reservation.mode === "enforce") {
      const reservationUsdMicros =
        creditReservationEstimatedUsdMicros(reservation);
      const nextAvailableUsdMicros =
        creditBalanceAvailableUsdMicros(balance) + reservationUsdMicros;
      const nextReservedUsdMicros = Math.max(
        0,
        creditBalanceReservedUsdMicros(balance) - reservationUsdMicros,
      );
      await this.#store.putCreditBalance({
        ...balance,
        availableUsdMicros: nextAvailableUsdMicros,
        reservedUsdMicros: nextReservedUsdMicros,
        availableCredits: usdMicrosToLegacyCredits(nextAvailableUsdMicros),
        reservedCredits: usdMicrosToLegacyCredits(nextReservedUsdMicros),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
  }
}
