/**
 * Billing / credit / usage facade (§28 / §32 credit reservation; Space billing).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: it owns the
 * Space subscription mutation methods, the per-plan credit-reservation
 * evaluation, the apply-time reserve / capture / release / expire ceremony, the
 * monthly-credit reconciliation, and the per-Space managed-default apply cap.
 * The controller holds one instance, re-exposes `changeSpaceSubscription` /
 * `reconcileStripeSpaceSubscription` on its public API unchanged, and the
 * run-engine call sites delegate to `this.#billing.<method>`.
 *
 * Two seams stay on the controller and are injected as ports rather than moved:
 *   - `requireSpace` — the shared Space-existence guard (used by many non-billing
 *     controller methods too);
 *   - `resolveRunProviderBindings` — the run-scoped provider-binding resolution
 *     that the managed-default cap consults to tell operator-default credential
 *     usage apart from a Space's own Connections.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  PlanResourceChange,
  PlanRun,
  ApplyRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  BillingAccount,
  BillingProvider,
  BillingSettings,
  CreditReservation,
  SpaceSubscription,
} from "takosumi-contract/billing";
import { billingReservationRequired } from "takosumi-contract/billing";
import type { Space } from "takosumi-contract/spaces";
import { evaluateQuotaPolicy } from "takosumi-policy";
import type { ResolvedProviderBinding } from "../connections/mod.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingProvider(value: unknown): value is BillingProvider {
  return value === "stripe" || value === "manual" || value === "none";
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
    return {
      mode: "enforce",
      provider: value.provider,
      reservationRequired: true,
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

/**
 * Ports the controller injects into {@link BillingService}. The two seams that
 * stay on the controller (`requireSpace` / `resolveRunProviderBindings`) are
 * passed as callbacks rather than moved; `store` / `newId` / `now` mirror the
 * controller's own handles so timestamps and ids line up across both surfaces.
 */
export interface BillingServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Operator/self-host billing default (§28); Space.billingSettings overrides it. */
  readonly defaultBillingSettings: BillingSettings;
  /** Per-Space cumulative write-apply ceiling on the operator-default credential. */
  readonly managedDefaultApplyCap?: number;
  /** Shared Space-existence guard (used by many non-billing controller methods too). */
  readonly requireSpace: (spaceId: string) => Promise<Space>;
  /** Run-scoped provider-binding resolution (the managed-default cap consults it). */
  readonly resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedProviderBinding[] | undefined>;
}

/**
 * Collaborator owning the Space billing subsystem: subscription mutation, the
 * per-plan credit reservation, the apply-time reserve / capture / release /
 * expire ceremony, monthly-credit reconciliation, and the managed-default apply
 * cap. Behavior is identical to the prior inline controller methods.
 */
export class BillingService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #managedDefaultApplyCap?: number;
  readonly #requireSpace: (spaceId: string) => Promise<Space>;
  readonly #resolveRunProviderBindings: (
    planRun: PlanRun,
  ) => Promise<readonly ResolvedProviderBinding[] | undefined>;

  constructor(dependencies: BillingServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#defaultBillingSettings = dependencies.defaultBillingSettings;
    this.#managedDefaultApplyCap = dependencies.managedDefaultApplyCap;
    this.#requireSpace = dependencies.requireSpace;
    this.#resolveRunProviderBindings = dependencies.resolveRunProviderBindings;
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
    if (!balance) {
      await this.#store.putCreditBalance({
        spaceId,
        availableCredits: billingPlan.plan.includedCredits,
        reservedCredits: 0,
        monthlyIncludedCredits: billingPlan.plan.includedCredits,
        purchasedCredits: 0,
        updatedAt: nowIso,
      });
      return;
    }
    const balanceUpdatedAtMs = Date.parse(balance.updatedAt);
    if (
      Number.isFinite(balanceUpdatedAtMs) &&
      balanceUpdatedAtMs >= periodStartMs &&
      balance.monthlyIncludedCredits === billingPlan.plan.includedCredits
    ) {
      return;
    }
    // Atomic, idempotent-per-period monthly RESET (same semantics as the old
    // `max(0, available - oldMonthly) + newMonthly` but in one conditional
    // UPDATE, so a concurrent top-up can no longer clobber the read-modify-
    // write).
    await this.#store.reconcileMonthlyCredits(spaceId, {
      newMonthly: billingPlan.plan.includedCredits,
      periodStartIso: new Date(periodStartMs).toISOString(),
      updatedAt: nowIso,
    });
  }

  /**
   * Per-Space cumulative write-apply ceiling on the managed (operator-key)
   * default (P2 operator-economic guard). Apply on the `enforce`-mode hosted
   * SaaS path is already gated by credit reservation; a free/default Space is
   * NOT in `enforce` mode, so on the operator-pays managed key there is
   * otherwise no in-code ceiling on how much a Space can spend by repeatedly
   * applying. This gate fail-closes the unbounded hole, but ONLY when:
   *   1. the operator configured a cap (`managedDefaultApplyCap`) — omitted on
   *      the self-host build target, which is uncapped;
   *   2. billing is NOT `enforce` (the credit path already covers `enforce`);
   *   3. the run actually resolves to an operator-default credential (a
   *      `default`-mode binding backed by an operator-scoped Connection) — so a
   *      self-hoster (or any Space) applying on its OWN Connection is never
   *      capped. The cap protects the OPERATOR'S key, not billing mode alone.
   * The cumulative count is the Space's total successful write-applies, derived
   * from the per-Installation `currentStateGeneration` (bumped +1 by every
   * create / update / destroy_apply), so no new ledger write is introduced.
   */
  async assertManagedDefaultApplyCap(planRun: PlanRun): Promise<void> {
    const cap = this.#managedDefaultApplyCap;
    if (cap === undefined) return;
    // A destroy is the way to STOP spending on the operator key, so it must
    // never be blocked by the spend cap — capping teardown would trap a Space
    // at its ceiling with no way to reclaim the operator's resources.
    if (planRun.operation === "destroy") return;
    const settings = await this.billingSettingsForSpace(planRun.spaceId);
    if (settings.mode === "enforce") return;
    if (!(await this.#runUsesOperatorDefaultCredential(planRun))) return;
    const installations = await this.#store.listInstallations(planRun.spaceId);
    const appliedCount = installations.reduce(
      (total, installation) => total + (installation.currentStateGeneration ?? 0),
      0,
    );
    if (appliedCount >= cap) {
      throw new OpenTofuControllerError(
        "resource_exhausted",
        `managed_apply_cap_reached: space ${planRun.spaceId} has reached the ` +
          `operator-default apply cap (${appliedCount}/${cap}); connect your own ` +
          `provider Connection or enable enforce-mode billing to continue`,
      );
    }
  }

  /**
   * True when a run's provider bindings resolve to an operator-default
   * credential: a `default`-mode binding that fell through to an OPERATOR-scoped
   * Connection (the managed key). A run that binds only the Space's own
   * Connections (mode `connection`), `manual`, or `disabled` returns false, so
   * self-host on an owned Connection is never treated as managed usage. A run
   * without installation context (no resolvable bindings) also returns false.
   */
  async #runUsesOperatorDefaultCredential(planRun: PlanRun): Promise<boolean> {
    const resolved = await this.#resolveRunProviderBindings(planRun);
    if (!resolved) return false;
    return resolved.some(
      (entry) =>
        entry.mode === "default" && entry.connection?.scope === "operator",
    );
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
        audit: { mode: settings.mode, estimatedCredits: 0 },
      };
    }
    await this.reconcileSpaceMonthlyCredits(input.planRun.spaceId);
    const estimatedCredits = estimatePlanCredits(input.planRun, input.result);
    const auditBase = {
      mode: settings.mode,
      estimatedCredits,
    } satisfies Readonly<Record<string, JsonValue>>;
    const planLimit = await this.#evaluateBillingPlanLimits({
      spaceId: input.planRun.spaceId,
      estimatedCredits,
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
      const balance = await this.#store.getCreditBalance(input.planRun.spaceId);
      const available = balance?.availableCredits ?? 0;
      if (available < estimatedCredits) {
        return {
          reasons: [
            `credit reservation failed: ${estimatedCredits} credits estimated but only ${available} available`,
          ],
          audit: {
            ...auditWithPlanLimits,
            availableCredits: available,
            reservationStatus: "insufficient_credits",
          },
        };
      }
      const reservedBalance = await this.#store.reserveCredits(
        input.planRun.spaceId,
        {
          credits: estimatedCredits,
          updatedAt: new Date(input.now).toISOString(),
        },
      );
      if (!reservedBalance) {
        const latest = await this.#store.getCreditBalance(
          input.planRun.spaceId,
        );
        return {
          reasons: [
            `credit reservation failed: ${estimatedCredits} credits estimated but only ${latest?.availableCredits ?? 0} available`,
          ],
          audit: {
            ...auditWithPlanLimits,
            availableCredits: latest?.availableCredits ?? 0,
            reservationStatus: "insufficient_credits",
          },
        };
      }
    }
    const reservation: CreditReservation = {
      id: this.#newId("creditres"),
      spaceId: input.planRun.spaceId,
      runId: input.planRun.id,
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
    readonly estimatedCredits: number;
    readonly changes: readonly PlanResourceChange[];
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    const billingPlan = await this.#billingPlanForSpace(input.spaceId);
    if (!billingPlan) return { reasons: [] };
    const reasons: string[] = [];
    const limits = billingPlan.plan.limits;
    const maxEstimatedCredits = limits.maxEstimatedCreditsPerRun;
    if (
      maxEstimatedCredits !== undefined &&
      Number.isFinite(maxEstimatedCredits) &&
      input.estimatedCredits > maxEstimatedCredits
    ) {
      reasons.push(
        `billing plan ${billingPlan.plan.id} limits estimated credits per run to ${maxEstimatedCredits}; plan estimated ${input.estimatedCredits}`,
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
        ...(maxEstimatedCredits !== undefined
          ? { maxEstimatedCreditsPerRun: maxEstimatedCredits }
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
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      spaceId: input.planRun.spaceId,
      ...(input.planRun.installationId
        ? { installationId: input.planRun.installationId }
        : {}),
      runId: input.applyRun.id,
      kind: "operation",
      quantity: 1,
      credits: reservation.estimatedCredits,
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
      await this.#store.putCreditBalance({
        ...balance,
        reservedCredits: Math.max(
          0,
          balance.reservedCredits - reservation.estimatedCredits,
        ),
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
      await this.#store.putCreditBalance({
        ...balance,
        availableCredits:
          balance.availableCredits + reservation.estimatedCredits,
        reservedCredits: Math.max(
          0,
          balance.reservedCredits - reservation.estimatedCredits,
        ),
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
      await this.#store.putCreditBalance({
        ...balance,
        availableCredits:
          balance.availableCredits + reservation.estimatedCredits,
        reservedCredits: Math.max(
          0,
          balance.reservedCredits - reservation.estimatedCredits,
        ),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
  }
}
