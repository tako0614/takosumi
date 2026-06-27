/**
 * Space usage / credit reporting facade (§28 / §32 usage metering; Space billing
 * reads + adjustments).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: it owns the
 * Space-scoped billing READ projection (`getSpaceBilling` / `listSpaceUsage` /
 * `listSpaceCreditReservations`), the operator/meter usage-event writes
 * (`recordMeteredUsage` / `recordGatewayResourceUsage`), the invoice
 * reconciliation adjustment (`reconcileInvoiceUsage`), and the manual credit
 * top-up (`topUpSpaceCredits`). The controller holds one instance and re-exposes
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
  GatewayResourceUsageMeter,
  SpaceSubscription,
  UsageEvent,
  UsageEventKind,
  UsageResourceFamily,
  UsageResourceMetadata,
  UsageResourceMetadataValue,
  UsageEventSource,
} from "takosumi-contract/billing";
import type { Space } from "takosumi-contract/spaces";
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
  readonly credits: number;
  readonly source: Exclude<UsageEventSource, "runner">;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface RecordGatewayResourceUsageInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly meters: readonly GatewayResourceUsageMeter[];
}

export interface ReconcileInvoiceUsageInput {
  readonly invoiceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly invoicedCredits: number;
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
 * Collaborator owning the Space usage / credit reporting subsystem: the billing
 * read projection, operator/meter usage-event writes, invoice reconciliation, and
 * manual credit top-up. Behavior is identical to the prior inline controller
 * methods.
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
    await this.#requireSpace(spaceId);
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const settings = await this.#billing.billingSettingsForSpace(spaceId);
    const balance = await this.#store.getCreditBalance(spaceId);
    const account = await this.#store.getBillingAccountForOwner(
      "space",
      spaceId,
    );
    const subscription = await this.#store.getSpaceSubscription(spaceId);
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
    await this.#requireSpace(spaceId);
    const { items, nextCursor } = await this.#store.listUsageEventsPage(
      spaceId,
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
    await this.#requireSpace(spaceId);
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
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        input,
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async #recordBillingReconciliationUsage(
    spaceId: string,
    input: Omit<RecordMeteredUsageInput, "source"> & {
      readonly source: "billing_reconciliation";
    },
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        input,
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async #recordResourceMeterUsage(
    spaceId: string,
    input: Omit<RecordMeteredUsageInput, "source">,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    const usageEvent = await this.#store.putUsageEvent(
      normalizeMeteredUsageEvent(
        spaceId,
        {
          ...input,
          source: "resource_meter",
        },
        () => this.#newId("usage"),
        () => new Date(this.#now()).toISOString(),
      ),
    );
    return { usageEvent };
  }

  async recordGatewayResourceUsage(
    spaceId: string,
    input: RecordGatewayResourceUsageInput,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[] }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    const period = normalizeUsagePeriod(input);
    const usageEvents: UsageEvent[] = [];
    for (const meter of input.meters) {
      const recorded = await this.#recordResourceMeterUsage(spaceId, {
        ...(meter.installationId
          ? { installationId: meter.installationId }
          : {}),
        meterId: meter.meterId,
        ...(meter.resourceFamily
          ? { resourceFamily: meter.resourceFamily }
          : {}),
        ...(meter.resourceId ? { resourceId: meter.resourceId } : {}),
        ...(meter.operation ? { operation: meter.operation } : {}),
        ...(meter.resourceMetadata
          ? { resourceMetadata: meter.resourceMetadata }
          : {}),
        kind: meter.kind,
        quantity: meter.quantity,
        credits: meter.credits,
        idempotencyKey: [
          "provider-runtime",
          spaceId,
          period.periodStart,
          period.periodEnd,
          meter.meterId,
          meter.installationId ?? "space",
          meter.resourceFamily ?? "resource-family",
          meter.resourceId ?? "resource",
          meter.operation ?? "operation",
          meter.kind,
        ].join(":"),
        createdAt: period.periodEnd,
      });
      usageEvents.push(recorded.usageEvent);
    }
    return { usageEvents };
  }

  async reconcileInvoiceUsage(
    spaceId: string,
    input: ReconcileInvoiceUsageInput,
  ): Promise<InvoiceUsageReconciliation> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    requireNonEmptyString(input.invoiceId, "invoiceId");
    const period = normalizeInvoiceUsagePeriod(input);
    const events = await this.#store.listUsageEvents(spaceId);
    const meteredCredits = events
      .filter((event) => isMeteredInvoiceUsageSource(event.source))
      .filter((event) =>
        isUsageEventInInvoicePeriod(
          event,
          period.periodStart,
          period.periodEnd,
        ),
      )
      .reduce((sum, event) => sum + event.credits, 0);
    const adjustmentCredits = input.invoicedCredits - meteredCredits;
    const { usageEvent } = await this.#recordBillingReconciliationUsage(
      spaceId,
      {
        kind: "operation",
        quantity: 1,
        credits: adjustmentCredits,
        source: "billing_reconciliation",
        idempotencyKey: [
          "invoice-reconciliation",
          spaceId,
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
      meteredCredits,
      invoicedCredits: input.invoicedCredits,
      adjustmentCredits,
      usageEvent,
    };
  }

  async listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    return {
      creditReservations: await this.#store.listCreditReservations(spaceId),
    };
  }

  async topUpSpaceCredits(
    spaceId: string,
    input: { readonly credits: number },
  ): Promise<{ readonly balance: CreditBalance }> {
    requireNonEmptyString(spaceId, "spaceId");
    await this.#requireSpace(spaceId);
    if (
      !Number.isInteger(input.credits) ||
      !Number.isFinite(input.credits) ||
      input.credits <= 0
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "credits must be a positive integer",
      );
    }
    await this.#billing.reconcileSpaceMonthlyCredits(spaceId);
    const nowIso = new Date(this.#now()).toISOString();
    // Atomic grant (single UPDATE): concurrent webhook deliveries — or a top-up
    // racing the monthly reconcile — cannot lose updates (was a read-modify-
    // write get→compute→putCreditBalance).
    const balance = await this.#store.addCredits(spaceId, {
      credits: input.credits,
      updatedAt: nowIso,
    });
    return { balance };
  }
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
  if (
    !Number.isInteger(input.credits) ||
    (input.source !== "billing_reconciliation" && input.credits < 0)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      input.source === "billing_reconciliation"
        ? "usage credits must be an integer"
        : "usage credits must be a non-negative integer",
    );
  }
  requireNonEmptyString(input.idempotencyKey, "idempotencyKey");
  const meterId = optionalNonEmptyString(input.meterId, "meterId");
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
    credits: input.credits,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    createdAt,
  };
}

function normalizeUsagePeriod(input: RecordGatewayResourceUsageInput): {
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
      "Gateway resource usage period must have valid ISO periodStart < periodEnd",
    );
  }
  if (!Array.isArray(input.meters)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "Gateway resource usage meters must be an array",
    );
  }
  for (const meter of input.meters) {
    if (!isGatewayResourceUsageKind(meter.kind)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "Gateway resource usage kind is not supported",
      );
    }
    requireNonEmptyString(meter.meterId, "meterId");
    normalizeUsageResourceFamily(meter.resourceFamily);
    optionalNonEmptyString(meter.resourceId, "resourceId");
    optionalNonEmptyString(meter.operation, "operation");
    normalizeUsageResourceMetadata(meter.resourceMetadata);
  }
  return {
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
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
  return family;
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
    if (!isUsageResourceMetadataValue(metadataValue)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata values must be strings, numbers, booleans, or null",
      );
    }
    normalized[normalizedKey] = metadataValue;
  }
  return normalized;
}

function isUsageEventKind(value: unknown): value is UsageEventKind {
  return (
    value === "runner_minute" ||
    value === "gateway_compute" ||
    value === "gateway_storage_gb_hour" ||
    value === "ai_request" ||
    value === "ai_input_token" ||
    value === "ai_output_token" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb" ||
    value === "operation"
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

function isGatewayResourceUsageKind(
  value: unknown,
): value is GatewayResourceUsageMeter["kind"] {
  return (
    value === "gateway_compute" ||
    value === "gateway_storage_gb_hour" ||
    value === "ai_request" ||
    value === "ai_input_token" ||
    value === "ai_output_token" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb"
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
