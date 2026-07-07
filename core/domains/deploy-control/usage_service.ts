/**
 * Usage / credit reporting facade (§28 / §32 usage metering; owner billing
 * reads + adjustments).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: it owns the
 * owner-account billing READ projection (`getSpaceBilling` / `listSpaceUsage`
 * / `listSpaceCreditReservations`), the operator/meter usage-event writes
 * (`recordMeteredUsage`), the invoice reconciliation adjustment
 * (`reconcileInvoiceUsage`), and the manual credit top-up
 * (`topUpSpaceCredits`). The controller holds one instance and re-exposes
 * each method on its public API unchanged, so the `/api` billing route layer and
 * the accounts control-routes keep calling the controller surface.
 *
 * The subscription-mutation / reservation ceremony stays in {@link BillingService}
 * (which this service reuses for the monthly-credit reconciliation and the
 * settings projection); the run-engine's own `runner_minute` metering stays on
 * the controller (it is coupled to the run-execution path).
 *
 * Two seams stay on the controller and are injected as ports rather than moved:
 *   - `requireSpace` — the shared Space-existence guard (used by many non-billing
 *     controller methods too);
 *   - `billing` — the {@link BillingService} instance, consulted for monthly
 *     credit reconciliation and the effective `BillingSettings`.
 * `store` / `newId` / `now` mirror the controller's own handles so timestamps and
 * ids line up across both surfaces. Behavior is identical to the prior inline
 * controller methods.
 */

import type {
  BillingAccount,
  BillingPlan,
  BillingSettings,
  CreditBalance,
  CreditReservation,
  InvoiceUsageReconciliation,
  SpaceSubscription,
  UsageEvent,
  UsageEventKind,
  UsageResourceFamily,
  UsageResourceMetadata,
  UsageResourceMetadataValue,
  UsageEventSource,
} from "takosumi-contract/billing";
import {
  legacyCreditsToUsdMicros,
  usageEventUsdMicros,
  usageMeterNameLeaksInternalWorkersBackend,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type { Workspace as Space } from "takosumi-contract/workspaces";
import type { PageParams } from "takosumi-contract/pagination";
import type { BillingService } from "./billing_service.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

export interface RecordMeteredUsageInput {
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
  /** @deprecated Use usdMicros. Legacy credits are interpreted as USD amounts. */
  readonly credits?: number;
  readonly source: Exclude<UsageEventSource, "runner">;
  /**
   * Cloud-only metering paths set this when a successful resource operation must
   * atomically debit the owner account USD balance. OSS/operator showback callers
   * leave it unset so usage stays observational.
   */
  readonly spendRequired?: boolean;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface ReconcileInvoiceUsageInput {
  readonly invoiceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly invoicedUsdMicros?: number;
  /** @deprecated Use invoicedUsdMicros. */
  readonly invoicedCredits?: number;
  readonly createdAt?: string;
}

/**
 * Ports the controller injects into {@link UsageReportingService}. `requireSpace`
 * and `billing` stay owned by the controller and are passed in rather than moved;
 * `store` / `newId` / `now` mirror the controller's own handles so timestamps and
 * ids line up across both surfaces.
 */
export interface UsageReportingServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Shared Space-existence guard (used by many non-billing controller methods too). */
  readonly requireSpace: (spaceId: string) => Promise<Space>;
  /** Owns monthly-credit reconciliation + the effective `BillingSettings`. */
  readonly billing: BillingService;
}

/**
 * Collaborator owning the usage / credit reporting subsystem. Workspace routes
 * remain the source/permission boundary, but credit balance, reservations, and
 * usage spend are keyed to the owning user so one account funds all Workspaces
 * owned by that user.
 */
export class UsageReportingService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #requireSpace: (spaceId: string) => Promise<Space>;
  readonly #billing: BillingService;

  constructor(dependencies: UsageReportingServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#requireSpace = dependencies.requireSpace;
    this.#billing = dependencies.billing;
  }

  async getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: CreditBalance;
      readonly account?: BillingAccount;
      readonly subscription?: SpaceSubscription;
      readonly plan?: BillingPlan;
    };
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    const { sourceWorkspaceId, billingSubjectId } =
      await this.#billingSubjectForSpace(spaceId);
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const settings = await this.#billing.billingSettingsForSpace(spaceId);
    const balance = await this.#store.getCreditBalance(billingSubjectId);
    const account = await this.#store.getBillingAccountForOwner(
      "user",
      billingSubjectId,
    );
    const subscription = await this.#spaceSubscriptionForBillingSubject(
      billingSubjectId,
      sourceWorkspaceId,
    );
    const plan = subscription
      ? await this.#store.getBillingPlan(subscription.planId)
      : undefined;
    return {
      billing: {
        settings,
        ...(balance ? { balance } : {}),
        ...(account ? { account } : {}),
        ...(subscription ? { subscription } : {}),
        ...(plan ? { plan } : {}),
      },
    };
  }

  async listSpaceUsage(
    spaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    const { billingSubjectId } = await this.#billingSubjectForSpace(spaceId);
    const { items, nextCursor } = await this.#store.listUsageEventsPage(
      billingSubjectId,
      params ?? {},
    );
    return {
      usageEvents: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async recordMeteredUsage(
    spaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    requireNonEmptyString(spaceId, "spaceId");
    const { sourceWorkspaceId, billingSubjectId } =
      await this.#billingSubjectForSpace(spaceId);
    if (input.source === "billing_reconciliation") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage event source must be resource_meter or manual_adjustment",
      );
    }
    if (!isExternalOperatorUsageEventSource(input.source)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage event source must be resource_meter or manual_adjustment",
      );
    }
    const usageEvent = normalizeMeteredUsageEvent(
      billingSubjectId,
      {
        ...input,
        resourceMetadata: usageMetadataWithSourceWorkspace(
          input.resourceMetadata,
          sourceWorkspaceId,
        ),
      },
      () => this.#newId("usage"),
      () => new Date(this.#now()).toISOString(),
    );
    if (input.spendRequired === true) {
      const usdMicros = usageEventUsdMicros(usageEvent);
      if (usdMicros > 0) {
        const result = await this.#store.putUsageEventAndSpendCredits(
          usageEvent,
          {
            usdMicros,
            credits: usageEvent.credits,
            updatedAt: new Date(this.#now()).toISOString(),
          },
        );
        if (!result) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "metered usage spend failed: insufficient USD balance",
            {
              reason: "insufficient_credits",
              usdMicros,
            },
          );
        }
        return { usageEvent: result.usageEvent };
      }
    }
    const recorded = await this.#store.putUsageEvent(usageEvent);
    return { usageEvent: recorded };
  }

  async #recordBillingReconciliationUsage(
    spaceId: string,
    input: Omit<RecordMeteredUsageInput, "source"> & {
      readonly source: "billing_reconciliation";
    },
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    const { sourceWorkspaceId, billingSubjectId } =
      await this.#billingSubjectForSpace(spaceId);
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        billingSubjectId,
        {
          ...input,
          resourceMetadata: usageMetadataWithSourceWorkspace(
            input.resourceMetadata,
            sourceWorkspaceId,
          ),
        },
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async reconcileInvoiceUsage(
    spaceId: string,
    input: ReconcileInvoiceUsageInput,
  ): Promise<InvoiceUsageReconciliation> {
    requireNonEmptyString(spaceId, "spaceId");
    const { sourceWorkspaceId, billingSubjectId } =
      await this.#billingSubjectForSpace(spaceId);
    requireNonEmptyString(input.invoiceId, "invoiceId");
    const period = normalizeInvoiceUsagePeriod(input);
    const events = await this.#store.listUsageEvents(billingSubjectId);
    const invoicedUsdMicros = invoiceInputUsdMicros(input);
    const meteredUsdMicros = events
      .filter((event) => isMeteredInvoiceUsageSource(event.source))
      .filter((event) =>
        isUsageEventInInvoicePeriod(
          event,
          period.periodStart,
          period.periodEnd,
        ),
      )
      .reduce((sum, event) => sum + usageEventUsdMicros(event), 0);
    const adjustmentUsdMicros = invoicedUsdMicros - meteredUsdMicros;
    const { usageEvent } = await this.#recordBillingReconciliationUsage(
      spaceId,
      {
        kind: "operation",
        quantity: 1,
        usdMicros: adjustmentUsdMicros,
        source: "billing_reconciliation",
        idempotencyKey: [
          "invoice-reconciliation",
          billingSubjectId,
          sourceWorkspaceId,
          input.invoiceId,
          period.periodStart,
          period.periodEnd,
        ].join(":"),
        createdAt: input.createdAt ?? new Date(this.#now()).toISOString(),
      },
    );
    return {
      invoiceId: input.invoiceId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      meteredUsdMicros,
      invoicedUsdMicros,
      adjustmentUsdMicros,
      meteredCredits: usdMicrosToLegacyCredits(meteredUsdMicros),
      invoicedCredits: usdMicrosToLegacyCredits(invoicedUsdMicros),
      adjustmentCredits: usdMicrosToLegacyCredits(adjustmentUsdMicros),
      usageEvent,
    };
  }

  async listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    const { billingSubjectId } = await this.#billingSubjectForSpace(spaceId);
    return {
      creditReservations:
        await this.#store.listCreditReservations(billingSubjectId),
    };
  }

  async topUpSpaceCredits(
    spaceId: string,
    input: { readonly usdMicros?: number; readonly credits?: number },
  ): Promise<{ readonly balance: CreditBalance }> {
    requireNonEmptyString(spaceId, "spaceId");
    const { billingSubjectId } = await this.#billingSubjectForSpace(spaceId);
    const usdMicros = topUpInputUsdMicros(input);
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const nowIso = new Date(this.#now()).toISOString();
    // Atomic grant (single UPDATE): concurrent webhook deliveries — or a top-up
    // racing the monthly reconcile — cannot lose updates (was a read-modify-
    // write get→compute→putCreditBalance).
    const balance = await this.#store.addCredits(billingSubjectId, {
      usdMicros,
      credits: usdMicrosToLegacyCredits(usdMicros),
      updatedAt: nowIso,
    });
    return { balance };
  }

  async #billingSubjectForSpace(spaceId: string): Promise<{
    readonly sourceWorkspaceId: string;
    readonly billingSubjectId: string;
  }> {
    const space = await this.#requireSpace(spaceId);
    return {
      sourceWorkspaceId: space.id,
      billingSubjectId: space.ownerUserId,
    };
  }

  async #spaceSubscriptionForBillingSubject(
    billingSubjectId: string,
    sourceWorkspaceId: string,
  ): Promise<SpaceSubscription | undefined> {
    return (
      (await this.#store.getSpaceSubscription(billingSubjectId)) ??
      (billingSubjectId === sourceWorkspaceId
        ? undefined
        : await this.#store.getSpaceSubscription(sourceWorkspaceId))
    );
  }
}

function usageMetadataWithSourceWorkspace(
  metadata: UsageResourceMetadata | undefined,
  sourceWorkspaceId: string,
): UsageResourceMetadata {
  return {
    ...(metadata ?? {}),
    source_workspace_id: sourceWorkspaceId,
  };
}

function normalizeMeteredUsageEvent(
  spaceId: string,
  input: RecordMeteredUsageInput,
  newIdForUsage: () => string,
  nowIso: () => string,
): UsageEvent {
  if (!isUsageEventKind(input.kind)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage event kind is not supported",
    );
  }
  if (!isExternalUsageEventSource(input.source)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage event source must be resource_meter, billing_reconciliation, or manual_adjustment",
    );
  }
  if (!Number.isFinite(input.quantity) || input.quantity < 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage quantity must be a non-negative finite number",
    );
  }
  const usdMicros = usageInputUsdMicros(input);
  requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const meterId = optionalNonEmptyString(input.meterId, "meterId");
  rejectInternalWorkersBackendUsageName(meterId, "meterId");
  const resourceFamily = normalizeUsageResourceFamily(input.resourceFamily);
  const resourceId = optionalNonEmptyString(input.resourceId, "resourceId");
  const operation = optionalNonEmptyString(input.operation, "operation");
  const resourceMetadata = normalizeUsageResourceMetadata(
    input.resourceMetadata,
  );
  const createdAt = input.createdAt ?? nowIso();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage createdAt must be an ISO timestamp",
    );
  }
  return {
    id: newIdForUsage(),
    workspaceId: spaceId,
    spaceId,
    ...(input.installationId ? { installationId: input.installationId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(meterId ? { meterId } : {}),
    ...(resourceFamily ? { resourceFamily } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(operation ? { operation } : {}),
    ...(Object.keys(resourceMetadata).length > 0 ? { resourceMetadata } : {}),
    kind: input.kind,
    quantity: input.quantity,
    usdMicros,
    credits: usdMicrosToLegacyCredits(usdMicros),
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    createdAt,
  };
}

function normalizeInvoiceUsagePeriod(input: ReconcileInvoiceUsageInput): {
  readonly periodStart: string;
  readonly periodEnd: string;
} {
  const periodStartMs = Date.parse(input.periodStart);
  const periodEndMs = Date.parse(input.periodEnd);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(periodEndMs) ||
    periodEndMs <= periodStartMs
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invoice usage period must have valid ISO periodStart < periodEnd",
    );
  }
  return {
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
  };
}

function usageInputUsdMicros(input: RecordMeteredUsageInput): number {
  const value =
    input.usdMicros !== undefined
      ? input.usdMicros
      : input.credits !== undefined
        ? finiteCreditsToUsdMicros(input.credits)
        : undefined;
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(value) ||
    (input.source !== "billing_reconciliation" && value < 0)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      input.source === "billing_reconciliation"
        ? "usage usdMicros must be a safe integer"
        : "usage usdMicros must be a non-negative safe integer",
    );
  }
  return value;
}

function invoiceInputUsdMicros(input: ReconcileInvoiceUsageInput): number {
  const value =
    input.invoicedUsdMicros !== undefined
      ? input.invoicedUsdMicros
      : input.invoicedCredits !== undefined
        ? finiteCreditsToUsdMicros(input.invoicedCredits)
        : undefined;
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invoicedUsdMicros must be a non-negative safe integer",
    );
  }
  return value;
}

function topUpInputUsdMicros(input: {
  readonly usdMicros?: number;
  readonly credits?: number;
}): number {
  const value =
    input.usdMicros !== undefined
      ? input.usdMicros
      : input.credits !== undefined
        ? finiteCreditsToUsdMicros(input.credits)
        : undefined;
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usdMicros must be a positive safe integer",
    );
  }
  return value;
}

function finiteCreditsToUsdMicros(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  try {
    return legacyCreditsToUsdMicros(value);
  } catch {
    return undefined;
  }
}

function optionalNonEmptyString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a non-empty string of at most 256 characters when provided`,
    );
  }
  return trimmed;
}

function normalizeUsageResourceFamily(
  value: UsageResourceFamily | undefined,
): UsageResourceFamily | undefined {
  if (value === undefined) return undefined;
  const family = optionalNonEmptyString(value, "resourceFamily");
  if (family === undefined) return undefined;
  if (!/^[a-z0-9][a-z0-9_.:-]*$/u.test(family)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage resourceFamily must use lowercase letters, numbers, dot, underscore, colon, or dash",
    );
  }
  rejectInternalWorkersBackendUsageName(family, "resourceFamily");
  return family;
}

function rejectInternalWorkersBackendUsageName(
  value: string | undefined,
  label: string,
): void {
  if (!value) return;
  if (usageMeterNameLeaksInternalWorkersBackend(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `usage ${label} must describe the customer-facing managed resource`,
    );
  }
}

function normalizeUsageResourceMetadata(
  value: UsageResourceMetadata | undefined,
): UsageResourceMetadata {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage resourceMetadata must be an object",
    );
  }
  const normalized: Record<string, UsageResourceMetadataValue> = {};
  for (const [key, metadataValue] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata keys must be non-empty strings",
      );
    }
    if (usageMeterNameLeaksInternalWorkersBackend(normalizedKey)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata must not expose an internal resource backend",
      );
    }
    if (!isUsageResourceMetadataValue(metadataValue)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata values must be strings, numbers, booleans, or null",
      );
    }
    if (
      typeof metadataValue === "string" &&
      usageMeterNameLeaksInternalWorkersBackend(metadataValue)
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata must not expose an internal resource backend",
      );
    }
    normalized[normalizedKey] = metadataValue;
  }
  return normalized;
}

function isUsageEventKind(value: unknown): value is UsageEventKind {
  return (
    value === "runner_minute" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb" ||
    value === "operation" ||
    value === "gateway_compute" ||
    value === "gateway_storage_gb_hour" ||
    value === "ai_request" ||
    value === "ai_input_token" ||
    value === "ai_output_token"
  );
}

function isUsageResourceMetadataValue(
  value: unknown,
): value is UsageResourceMetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isExternalUsageEventSource(
  value: unknown,
): value is Exclude<UsageEventSource, "runner"> {
  return (
    value === "resource_meter" ||
    value === "billing_reconciliation" ||
    value === "manual_adjustment"
  );
}

function isExternalOperatorUsageEventSource(
  value: unknown,
): value is "resource_meter" | "manual_adjustment" {
  return value === "resource_meter" || value === "manual_adjustment";
}

function isMeteredInvoiceUsageSource(source: UsageEventSource): boolean {
  return source === "runner" || source === "resource_meter";
}

function isUsageEventInInvoicePeriod(
  event: UsageEvent,
  periodStart: string,
  periodEnd: string,
): boolean {
  const createdAt = Date.parse(event.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (event.source === "resource_meter") {
    return createdAt > start && createdAt <= end;
  }
  return createdAt >= start && createdAt < end;
}
