/**
 * Provider-neutral showback and host decision-port orchestration.
 *
 * OSS owns only disabled/showback settings, provider-neutral measurements, and
 * provider-applied UsageEvents. A required post-apply lifecycle action may
 * still make the Run failed, but the already-materialized provider work remains
 * billable/showback evidence. An explicit host rater supplies amounts;
 * without one the measurements remain zero/unrated. Commercial plans,
 * balances, reservations, subscriptions, payment providers, and invoice state
 * never enter this class or the OpenTofu store.
 */

import type { JsonValue } from "takosumi-contract";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type {
  AppBillingIdentity,
  BillingEnforcement,
  BillingSettings,
  QuotaPolicy,
  ShowbackRater,
  ShowbackRating,
  UsageShowbackRatingContext,
} from "takosumi-contract/billing";
import {
  NOOP_BILLING_ENFORCEMENT,
  NOOP_QUOTA_POLICY,
  NOOP_SHOWBACK_RATER,
} from "takosumi-contract/billing";
import { appBillingIdentity, appBillingOwnership, type AppBillingOwnership } from "./billing_workspace_compat.ts";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  assertWorkspaceManagementAdmission,
  WorkspaceManagementAdmissionConflictError,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { OpenTofuPlanResult } from "./mod.ts";

export const DISABLED_BILLING_SETTINGS: BillingSettings = {
  mode: "disabled",
};

export interface BillingServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  readonly defaultBillingSettings: BillingSettings;
  readonly requireWorkspace: (workspaceId: string) => Promise<Workspace>;
  readonly rater?: ShowbackRater;
  readonly enforcement?: BillingEnforcement;
  readonly quota?: QuotaPolicy;
  /** Host composition only; never supplied by a Workspace setting or request. */
  readonly enforcementRequired?: boolean;
}

export class BillingService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #defaultBillingSettings: BillingSettings;
  readonly #requireWorkspace: (workspaceId: string) => Promise<Workspace>;
  readonly #rater: ShowbackRater;
  readonly #enforcement: BillingEnforcement;
  readonly #quota: QuotaPolicy;
  readonly #enforcementRequired: boolean;

  constructor(dependencies: BillingServiceDependencies) {
    this.#enforcementRequired = dependencies.enforcementRequired === true;
    if (this.#enforcementRequired && (
      typeof dependencies.rater?.ratePlan !== "function" ||
      typeof dependencies.rater?.rateUsage !== "function" ||
      typeof dependencies.enforcement?.reservePlanBilling !== "function" ||
      typeof dependencies.enforcement?.assertReservationSatisfied !== "function" ||
      typeof dependencies.enforcement?.captureRunBilling !== "function" ||
      typeof dependencies.enforcement?.releaseReservation !== "function" ||
      typeof dependencies.quota?.evaluatePlanQuota !== "function"
    )) {
      throw new TypeError("Required billing composition must provide all seven billing methods");
    }
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#defaultBillingSettings = normalizeBillingSettings(
      dependencies.defaultBillingSettings,
    );
    this.#requireWorkspace = dependencies.requireWorkspace;
    this.#rater = dependencies.rater ?? NOOP_SHOWBACK_RATER;
    this.#enforcement = dependencies.enforcement ?? NOOP_BILLING_ENFORCEMENT;
    this.#quota = dependencies.quota ?? NOOP_QUOTA_POLICY;
  }

  async updateWorkspaceBillingSettings(
    workspaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const settings = normalizeBillingSettings(input.billingSettings);
    try {
      const management = assertWorkspaceManagementAdmission(
        await this.#store.getWorkspaceManagement(workspaceId), workspaceId,
      );
      const expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority = {
        workspaceId, managementState: "active", managementEpoch: management.managementEpoch,
      };
      const workspace = await this.#requireWorkspace(workspaceId);
      const replaced = await this.#store.replaceWorkspace({
        workspace: {
          ...workspace, billingSettings: settings,
          updatedAt: new Date(this.#now()).toISOString(),
        },
        expectedWorkspace: workspace,
        expectedWorkspaceManagementAuthority,
      });
      if (!replaced) {
        throw new OpenTofuControllerError(
          "failed_precondition", "Workspace changed while preparing this update.",
          { reason: "workspace_changed" },
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw new OpenTofuControllerError(
          "failed_precondition", "Workspace is not accepting this management operation.",
          { reason: "workspace_management_admission_conflict" },
        );
      }
      throw error;
    }
    return { billing: { settings } };
  }

  async billingSettingsForWorkspace(
    workspaceId: string,
  ): Promise<BillingSettings> {
    const workspace = await this.#store.getWorkspace(workspaceId);
    return workspace
      ? this.billingSettingsForWorkspaceRecord(workspace)
      : this.#defaultBillingSettings;
  }

  billingSettingsForWorkspaceRecord(workspace: Workspace): BillingSettings {
    return workspace.billingSettings?.mode === "showback"
      ? { mode: "showback" }
      : this.#defaultBillingSettings;
  }

  async evaluatePlanBilling(input: {
    readonly planRun: PlanRun;
    readonly result: OpenTofuPlanResult;
    readonly now: number;
    readonly policyPassedBeforeBilling: boolean;
  }): Promise<{
    readonly reasons: readonly string[];
    readonly audit?: Readonly<Record<string, JsonValue>>;
  }> {
    const workspaceId = input.planRun.workspaceId;
    const workspace = await this.#requireWorkspace(workspaceId);
    const settings = this.billingSettingsForWorkspaceRecord(workspace);
    if (settings.mode === "disabled" && !this.#enforcementRequired) {
      return {
        reasons: [],
        audit: {
          mode: "disabled",
          estimatedUsdMicros: 0,
          blocked: false,
          reasons: [],
        },
      };
    }

    // Destroy must remain available for safe deprovisioning even when a host
    // price catalog is missing, expired, or the billing subject has no
    // spendable balance. Deleting native resources is never precharged.
    //
    // A refresh-only apply adopts provider observations into state/output but
    // does not create, update, replace, or delete native resources. Resource
    // change entries in its plan describe external drift, so they must not be
    // rated or commercially reserved as materialization work. Runner-minute
    // usage is recorded independently by the Run engine.
    if (planSkipsBillingReservation(input.planRun)) {
      const identity = input.planRun.capsuleId
        ? await this.resolveAppBillingIdentity(input.planRun.capsuleId)
        : undefined;
      return {
        reasons: [],
        audit: {
          mode: settings.mode,
          ...identity,
          ...(identity ? { identityVersion: 1 } : {}),
          estimatedUsdMicros: 0,
          ratingStatus: "rated",
          blocked: false,
          reasons: [],
        },
      };
    }

    const identity = input.planRun.capsuleId
      ? await this.resolveAppBillingIdentity(input.planRun.capsuleId)
      : undefined;
    if (!identity && this.#enforcementRequired) {
      throw new OpenTofuControllerError("failed_precondition", "Billing requires an app.");
    }
    const billingSubjectId = identity?.payerAccountId ?? workspace.ownerUserId;
    const planResourceChanges = input.result.planResourceChanges ?? [];
    const rating = normalizeShowbackRating(
      await this.#rater.ratePlan({
        workspaceId,
        billingSubjectId,
        runId: input.planRun.id,
        ...(input.planRun.capsuleId
          ? { capsuleId: input.planRun.capsuleId }
          : {}),
        planResourceChanges,
        now: input.now,
      }),
      "plan",
    );
    const estimatedUsdMicros = rating.usdMicros;
    const quota = identity ? await this.#quota.evaluatePlanQuota({
      ...identity,
      estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      planResourceChanges,
    }) : { reasons: [] };
    const enforcement = identity ? await this.#enforcement.reservePlanBilling({
      ...identity,
      runId: input.planRun.id,
      mode: settings.mode,
      estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      planResourceChanges,
      policyPassedBeforeBilling: input.policyPassedBeforeBilling,
      now: input.now,
    }) : { reasons: [] };
    const reasons = input.policyPassedBeforeBilling
      ? uniqueStrings([...quota.reasons, ...enforcement.reasons])
      : [];
    const extension: Record<string, JsonValue> = {};
    if (rating.audit) extension.rating = rating.audit;
    if (quota.audit) extension.quota = quota.audit;
    if (enforcement.audit) extension.enforcement = enforcement.audit;
    return {
      reasons,
      audit: {
        mode: settings.mode,
        ...identity,
        ...(identity ? { identityVersion: 1 } : {}),
        estimatedUsdMicros,
        ratingStatus: rating.ratingStatus,
        blocked: reasons.length > 0,
        reasons,
        ...(Object.keys(extension).length > 0 ? { extension } : {}),
      },
    };
  }

  async assertApplyBillingAllowed(planRun: PlanRun): Promise<void> {
    const workspaceId = planRun.workspaceId;
    const workspace = await this.#requireWorkspace(workspaceId);
    const settings = this.billingSettingsForWorkspaceRecord(workspace);
    if ((settings.mode === "disabled" && !this.#enforcementRequired) || planSkipsBillingReservation(planRun)) {
      return;
    }
    const identity = await this.#billingIdentityForPlan(planRun);
    if (!identity) {
      if (this.#enforcementRequired) throw new OpenTofuControllerError("failed_precondition", "Plan billing payer is unavailable.");
      return;
    }
    const current = await this.resolveAppBillingIdentity(planRun.capsuleId);
    if (identity.payerAccountId !== current.payerAccountId) {
      throw new OpenTofuControllerError("failed_precondition", "App owner changed after billing reservation.");
    }
    await this.#enforcement.assertReservationSatisfied({
      ...identity,
      runId: planRun.id,
      now: this.#now(),
    });
  }

  async captureApplyBillingUsage(input: {
    readonly planRun: PlanRun;
    readonly applyRun: ApplyRun;
    readonly now: number;
  }): Promise<void> {
    const workspaceId = input.planRun.workspaceId;
    const workspace = await this.#requireWorkspace(workspaceId);
    const settings = this.billingSettingsForWorkspaceRecord(workspace);
    if (settings.mode === "disabled" && !this.#enforcementRequired) return;
    const identity = input.planRun.capsuleId
      ? await this.#billingIdentityForPlan(input.planRun)
      : undefined;
    if (!identity && this.#enforcementRequired && !planSkipsBillingReservation(input.planRun)) {
      throw new OpenTofuControllerError("failed_precondition", "Billing requires an app.");
    }
    const rating = planShowbackRating(input.planRun);
    const estimatedUsdMicros = rating.usdMicros;
    if (settings.mode === "showback") await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      workspaceId,
      ...identity,
      runId: input.applyRun.id,
      kind: "opentofu.apply",
      quantity: 1,
      usdMicros: estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      source: "runner",
      idempotencyKey: `${input.applyRun.id}:opentofu.apply`,
      createdAt: new Date(input.now).toISOString(),
    });
    if (planSkipsBillingReservation(input.planRun) || !identity) return;
    await this.#enforcement.captureRunBilling({
      ...identity,
      runId: input.planRun.id,
      applyRunId: input.applyRun.id,
      capturedUsdMicros: estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      now: input.now,
    });
  }

  async releaseApplyBilling(planRun: PlanRun): Promise<void> {
    const workspaceId = planRun.workspaceId;
    const workspace = await this.#requireWorkspace(workspaceId);
    const settings = this.billingSettingsForWorkspaceRecord(workspace);
    if ((settings.mode === "disabled" && !this.#enforcementRequired) || planSkipsBillingReservation(planRun)) {
      return;
    }
    const identity = await this.#billingIdentityForPlan(planRun);
    if (!identity) {
      if (this.#enforcementRequired) throw new OpenTofuControllerError("failed_precondition", "Plan billing payer is unavailable.");
      return;
    }
    await this.#enforcement.releaseReservation({
      ...identity,
      runId: planRun.id,
      now: this.#now(),
    });
  }

  async #billingIdentityForPlan(planRun: PlanRun): Promise<AppBillingIdentity | undefined> {
    // Reservation settlement is pinned to the plan's durable billing audit.
    // A transfer changes the payer of future work, never an existing debt or
    // the payload replayed after provider commit / a lost capture acknowledgement.
    for (const event of [...planRun.auditEvents].reverse()) {
      if (event.type !== "plan.policy_evaluated") continue;
      const value = event.data?.billing;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (value.payerAccountId === undefined && value.identityVersion === undefined) break; // pre-change audit
      if (typeof value.payerAccountId !== "string" || !value.payerAccountId.trim() ||
        typeof value.capsuleId !== "string" || value.capsuleId !== planRun.capsuleId) {
        throw new OpenTofuControllerError("failed_precondition", "Plan billing identity is invalid.");
      }
      return { capsuleId: value.capsuleId, payerAccountId: value.payerAccountId };
    }
    const ownership = await this.resolveAppBillingOwnership(planRun.capsuleId);
    // Pre-change runs have no payer pin. After transfer their original owner
    // cannot be recovered from the current row; retain unattributed evidence.
    return ownership.ownershipEpoch === 0 ? ownership.identity : undefined;
  }

  async #runBillingIdentity(input: Pick<UsageShowbackRatingContext, "capsuleId" | "runId">): Promise<AppBillingIdentity | null | undefined> {
    if (!input.capsuleId || !input.runId) return undefined;
    let plan = await this.#store.getPlanRun(input.runId);
    if (!plan) {
      const apply = await this.#store.getApplyRun(input.runId);
      if (apply) plan = await this.#store.getPlanRun(apply.planRunId);
    }
    if (!plan) return null; // a named Run without durable authority is unattributed
    if (plan.capsuleId !== input.capsuleId) {
      throw new OpenTofuControllerError("failed_precondition", "Usage app does not match its run.");
    }
    return await this.#billingIdentityForPlan(plan) ?? null;
  }

  async #usageBillingIdentity(input: Pick<UsageShowbackRatingContext, "capsuleId" | "runId">): Promise<AppBillingIdentity | undefined> {
    if (!input.capsuleId) return undefined;
    const recorded = await this.#runBillingIdentity(input);
    return recorded === null ? undefined : recorded ?? this.resolveAppBillingIdentity(input.capsuleId);
  }

  resolveAppBillingOwnership(capsuleId: string | undefined): Promise<AppBillingOwnership> {
    return appBillingOwnership(this.#store, capsuleId);
  }

  resolveAppBillingIdentity(capsuleId: string | undefined): Promise<AppBillingIdentity> {
    return appBillingIdentity(this.#store, capsuleId);
  }

  /**
   * Rate one provider-neutral measurement. Disabled Workspaces produce no OSS
   * usage event; an explicitly required host still receives the measurement.
   */
  async rateUsageMeasurement(
    input: Omit<UsageShowbackRatingContext, "billingSubjectId">,
  ): Promise<(ShowbackRating & { readonly payerAccountId?: string }) | undefined> {
    const workspace = await this.#requireWorkspace(input.workspaceId);
    const settings = this.billingSettingsForWorkspaceRecord(workspace);
    if (settings.mode === "disabled" && !this.#enforcementRequired) return undefined;
    // Non-app legacy measurements remain unattributed. They must never enter
    // the payer history by guessing from a Workspace or the current actor.
    const identity = await this.#usageBillingIdentity(input);
    if (!identity && this.#enforcementRequired) {
      throw new OpenTofuControllerError("failed_precondition", "Billing requires an app.");
    }
    if (input.capsuleId && !identity) {
      // An old app Run can outlive its ownership history. Do not send any
      // person's subject to the host when its recorded payer is unknown.
      return settings.mode === "disabled" ? undefined : { ratingStatus: "unrated", usdMicros: 0 };
    }
    const rating = normalizeShowbackRating(
      await this.#rater.rateUsage({
        ...input,
        billingSubjectId: identity?.payerAccountId ?? workspace.ownerUserId,
      }),
      "usage",
    );
    return settings.mode === "disabled" ? undefined : {
      ...rating,
      ...(identity ? { payerAccountId: identity.payerAccountId } : {}),
    };
  }
}

function planSkipsBillingReservation(planRun: PlanRun): boolean {
  return (
    planRun.operation === "destroy" ||
    planRun.refreshOnly === true
  );
}

function normalizeBillingSettings(value: unknown): BillingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "billingSettings must be an object",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some((key) => key !== "mode")) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "billingSettings accepts only mode",
    );
  }
  if (record.mode === "disabled" || record.mode === "showback") {
    return { mode: record.mode };
  }
  throw new OpenTofuControllerError(
    "invalid_argument",
    "billing mode must be disabled or showback",
  );
}

function planShowbackRating(planRun: PlanRun): ShowbackRating {
  let billing: JsonValue | undefined;
  for (let index = planRun.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = planRun.auditEvents[index];
    if (event?.type !== "plan.policy_evaluated") continue;
    const candidate = event.data?.billing;
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      billing = candidate;
      break;
    }
  }
  if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
    return { ratingStatus: "unrated", usdMicros: 0 };
  }
  const record = billing as Readonly<Record<string, JsonValue>>;
  const amount = record.estimatedUsdMicros;
  const ratingStatus = record.ratingStatus;
  return (ratingStatus === "rated" || ratingStatus === "unrated") &&
    typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount >= 0 &&
    (ratingStatus === "rated" || amount === 0)
    ? { ratingStatus, usdMicros: amount }
    : { ratingStatus: "unrated", usdMicros: 0 };
}

function normalizeShowbackRating(
  value: ShowbackRating,
  label: string,
): ShowbackRating {
  if (value.ratingStatus !== "rated" && value.ratingStatus !== "unrated") {
    throw new OpenTofuControllerError(
      "internal_error",
      `${label} rating status must be rated or unrated`,
    );
  }
  if (!Number.isSafeInteger(value.usdMicros) || value.usdMicros < 0) {
    throw new OpenTofuControllerError(
      "internal_error",
      `${label} rating usdMicros must be a non-negative safe integer`,
    );
  }
  if (value.ratingStatus === "unrated" && value.usdMicros !== 0) {
    throw new OpenTofuControllerError(
      "internal_error",
      `${label} unrated measurement must have zero usdMicros`,
    );
  }
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter((value) => value.trim()).map((value) => value.trim()),
    ),
  ];
}
