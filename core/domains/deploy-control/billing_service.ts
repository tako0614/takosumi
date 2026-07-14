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
import type { Workspace } from "takosumi-contract/workspaces";
import type { OpenTofuControlStore } from "./store.ts";
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

  constructor(dependencies: BillingServiceDependencies) {
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
    const workspace = await this.#requireWorkspace(workspaceId);
    const settings = normalizeBillingSettings(input.billingSettings);
    await this.#store.putWorkspace({
      ...workspace,
      billingSettings: settings,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    return { billing: { settings } };
  }

  async billingSettingsForWorkspace(
    workspaceId: string,
  ): Promise<BillingSettings> {
    const workspace = await this.#store.getWorkspace(workspaceId);
    return workspace?.billingSettings?.mode === "showback"
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
    const settings = await this.billingSettingsForWorkspace(workspaceId);
    if (settings.mode === "disabled") {
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

    // A refresh-only apply adopts provider observations into state/output but
    // does not create, update, replace, or delete native resources. Resource
    // change entries in its plan describe external drift, so they must not be
    // rated or commercially reserved as materialization work. Runner-minute
    // usage is recorded independently by the Run engine.
    if (
      input.planRun.refreshOnly === true ||
      input.planRun.resourceImport === true
    ) {
      return {
        reasons: [],
        audit: {
          mode: settings.mode,
          estimatedUsdMicros: 0,
          ratingStatus: "rated",
          blocked: false,
          reasons: [],
        },
      };
    }

    const workspace = await this.#requireWorkspace(workspaceId);
    const billingSubjectId = workspace.ownerUserId;
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
    const quota = await this.#quota.evaluatePlanQuota({
      workspaceId,
      billingSubjectId,
      estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      planResourceChanges,
    });
    const enforcement = await this.#enforcement.reservePlanBilling({
      workspaceId,
      billingSubjectId,
      runId: input.planRun.id,
      ...(input.planRun.capsuleId
        ? { capsuleId: input.planRun.capsuleId }
        : {}),
      mode: settings.mode,
      estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      planResourceChanges,
      policyPassedBeforeBilling: input.policyPassedBeforeBilling,
      now: input.now,
    });
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
    const settings = await this.billingSettingsForWorkspace(workspaceId);
    if (settings.mode === "disabled") return;
    const workspace = await this.#requireWorkspace(workspaceId);
    await this.#enforcement.assertReservationSatisfied({
      workspaceId,
      billingSubjectId: workspace.ownerUserId,
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
    const settings = await this.billingSettingsForWorkspace(workspaceId);
    if (settings.mode === "disabled") return;
    const rating = planShowbackRating(input.planRun);
    const estimatedUsdMicros = rating.usdMicros;
    const workspace = await this.#requireWorkspace(workspaceId);
    await this.#store.putUsageEvent({
      id: this.#newId("usage"),
      workspaceId,
      ...(input.planRun.capsuleId
        ? { capsuleId: input.planRun.capsuleId }
        : {}),
      runId: input.applyRun.id,
      kind: "opentofu.apply",
      quantity: 1,
      usdMicros: estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      source: "runner",
      idempotencyKey: `${input.applyRun.id}:opentofu.apply`,
      createdAt: new Date(input.now).toISOString(),
    });
    await this.#enforcement.captureRunBilling({
      workspaceId,
      billingSubjectId: workspace.ownerUserId,
      runId: input.planRun.id,
      applyRunId: input.applyRun.id,
      ...(input.planRun.capsuleId
        ? { capsuleId: input.planRun.capsuleId }
        : {}),
      capturedUsdMicros: estimatedUsdMicros,
      ratingStatus: rating.ratingStatus,
      now: input.now,
    });
  }

  async releaseApplyBilling(planRun: PlanRun): Promise<void> {
    const workspaceId = planRun.workspaceId;
    const settings = await this.billingSettingsForWorkspace(workspaceId);
    if (settings.mode === "disabled") return;
    const workspace = await this.#requireWorkspace(workspaceId);
    await this.#enforcement.releaseReservation({
      workspaceId,
      billingSubjectId: workspace.ownerUserId,
      runId: planRun.id,
      now: this.#now(),
    });
  }

  /**
   * Rate one provider-neutral measurement. Disabled Workspaces produce no
   * usage event; showback Workspaces always receive explicit rated/unrated
   * evidence from the configured host rater.
   */
  async rateUsageMeasurement(
    input: Omit<UsageShowbackRatingContext, "billingSubjectId">,
  ): Promise<ShowbackRating | undefined> {
    const settings = await this.billingSettingsForWorkspace(input.workspaceId);
    if (settings.mode === "disabled") return undefined;
    const workspace = await this.#requireWorkspace(input.workspaceId);
    return normalizeShowbackRating(
      await this.#rater.rateUsage({
        ...input,
        billingSubjectId: workspace.ownerUserId,
      }),
      "usage",
    );
  }
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
