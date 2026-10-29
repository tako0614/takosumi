/** Provider-neutral app usage/showback with legacy Workspace adapters. */

import type {
  AppBillingIdentity,
  BillingSettings,
  CapsuleUsageSummary,
  UsageEvent,
  UsageEventKind,
  UsageEventSource,
  UsageRatingStatus,
  UsageResourceFamily,
  UsageResourceMetadata,
  UsageResourceMetadataValue,
} from "takosumi-contract/billing";
import { usageMeterNameLeaksInternalWorkersBackend } from "takosumi-contract/billing";
import type { Workspace } from "takosumi-contract/workspaces";
import type { PageParams } from "takosumi-contract/pagination";
import type { BillingService } from "./billing_service.ts";
import { appPayerAtEventTime } from "./app_payer_history.ts";
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

/** GET /api/v1/usage source; the route supplies the authenticated account ID. */
export async function listPayerUsage(
  store: Pick<OpenTofuControlStore, "listUsageEventsForPayerPage">,
  payerAccountId: string,
  params: PageParams = {},
): Promise<{ readonly usageEvents: readonly UsageEvent[]; readonly nextCursor?: string }> {
  requireNonEmptyString(payerAccountId, "payerAccountId");
  const { items, nextCursor } = await store.listUsageEventsForPayerPage(payerAccountId, params);
  return { usageEvents: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

export interface RecordMeteredUsageInput {
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
  readonly source: Exclude<UsageEventSource, "runner">;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface UsageReportingServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  readonly requireWorkspace: (workspaceId: string) => Promise<Workspace>;
  readonly billing: BillingService;
}

export class UsageReportingService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #requireWorkspace: (workspaceId: string) => Promise<Workspace>;
  readonly #billing: BillingService;

  constructor(dependencies: UsageReportingServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#requireWorkspace = dependencies.requireWorkspace;
    this.#billing = dependencies.billing;
  }

  async getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: { readonly settings: BillingSettings };
  }> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const workspace = await this.#requireWorkspace(workspaceId);
    return {
      billing: {
        settings: this.#billing.billingSettingsForWorkspaceRecord(workspace),
      },
    };
  }

  async listWorkspaceUsage(
    workspaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }> {
    requireNonEmptyString(workspaceId, "workspaceId");
    await this.#requireWorkspace(workspaceId);
    const { items, nextCursor } = await this.#store.listUsageEventsPage(
      workspaceId,
      params ?? {},
    );
    return {
      usageEvents: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async getCapsuleUsageSummary(
    capsuleId: string,
  ): Promise<CapsuleUsageSummary> {
    requireNonEmptyString(capsuleId, "capsuleId");
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule) {
      throw new OpenTofuControllerError(
        "not_found",
        `capsule ${capsuleId} not found`,
      );
    }
    // Keep the per-Capsule projection bounded as the Workspace usage ledger
    // grows; the store applies the same rating and count rules in the DB.
    const totals = await this.#store.getCapsuleUsageTotals(capsuleId);
    return {
      capsuleId,
      usdMicros: totals.usdMicros,
      eventCount: totals.eventCount,
      ratedEventCount: totals.ratedEventCount,
      unratedEventCount: totals.eventCount - totals.ratedEventCount,
    };
  }

  async recordMeteredUsage(
    workspaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }> {
    requireNonEmptyString(workspaceId, "workspaceId");
    await this.#requireWorkspace(workspaceId);
    if (input.capsuleId) {
      const capsule = await this.#store.getCapsule(input.capsuleId);
      if (!capsule || capsule.workspaceId !== workspaceId) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "usage capsuleId must belong to the Workspace",
        );
      }
    }
    const recordedAt = this.#now();
    const usageEvent = normalizeMeteredUsageEvent(
      workspaceId,
      input,
      () => this.#newId("usage"),
      () => new Date(recordedAt).toISOString(),
    );
    const identity = input.capsuleId
      ? await this.#meterPayer(input.capsuleId, usageEvent.createdAt, recordedAt)
      : undefined;
    return { usageEvent: await this.#store.putUsageEvent({ ...usageEvent, ...identity }) };
  }

  /**
   * The owner whose ownership interval contains the event time, from the
   * accepted transfer ledger. A producer runId is not Core reservation
   * authority, and an unprovable payer stays absent: never the current owner.
   */
  async #meterPayer(capsuleId: string, eventAt: string, recordedAt: number): Promise<AppBillingIdentity | undefined> {
    const ownership = await this.#billing.resolveAppBillingOwnership(capsuleId);
    // The ledger snapshot can only place instants it has already seen; a later
    // acceptance could still start a new owner's interval before this event.
    if (Date.parse(eventAt) > recordedAt) return undefined;
    const history = await this.#store.getAppOwnershipHistory(capsuleId, eventAt);
    // No owner tuple or ledger yet (pre-backfill / legacy schema): no transfer
    // can have been accepted, so only the initial owner of epoch 0 applies.
    if (!history) return ownership.ownershipEpoch === 0 ? ownership.identity : undefined;
    const payerAccountId = appPayerAtEventTime(history, eventAt);
    return payerAccountId ? { capsuleId, payerAccountId } : undefined;
  }
}

function normalizeMeteredUsageEvent(
  workspaceId: string,
  input: RecordMeteredUsageInput,
  newId: () => string,
  nowIso: () => string,
): UsageEvent {
  const kind = usageToken(input.kind, "kind");
  if (!isExternalUsageEventSource(input.source)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage source must be a valid non-runner producer token",
    );
  }
  if (!Number.isFinite(input.quantity) || input.quantity < 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage quantity must be a non-negative finite number",
    );
  }
  if (!Number.isSafeInteger(input.usdMicros) || input.usdMicros < 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage usdMicros must be a non-negative safe integer",
    );
  }
  if (input.ratingStatus !== "rated" && input.ratingStatus !== "unrated") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage ratingStatus must be rated or unrated",
    );
  }
  if (input.ratingStatus === "unrated" && input.usdMicros !== 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "unrated usage must have zero usdMicros",
    );
  }
  const idempotencyKey = requiredString(
    input.idempotencyKey,
    "idempotencyKey",
    512,
  );
  const meterId = optionalToken(input.meterId, "meterId");
  const resourceFamily = optionalToken(input.resourceFamily, "resourceFamily");
  const resourceId = optionalString(input.resourceId, "resourceId");
  const operation = optionalToken(input.operation, "operation");
  const resourceMetadata = normalizeUsageResourceMetadata(
    input.resourceMetadata,
  );
  const createdAtMs = Date.parse(input.createdAt ?? nowIso());
  if (!Number.isFinite(createdAtMs)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage createdAt must be an ISO timestamp",
    );
  }
  return {
    id: newId(),
    workspaceId,
    ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(meterId ? { meterId } : {}),
    ...(resourceFamily ? { resourceFamily } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(operation ? { operation } : {}),
    ...(Object.keys(resourceMetadata).length > 0 ? { resourceMetadata } : {}),
    kind,
    quantity: input.quantity,
    usdMicros: input.usdMicros,
    ratingStatus: input.ratingStatus,
    source: input.source,
    idempotencyKey,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function isExternalUsageEventSource(
  value: unknown,
): value is Exclude<UsageEventSource, "runner"> {
  if (typeof value !== "string" || value === "runner") return false;
  try {
    return usageToken(value, "source") === value;
  } catch {
    return false;
  }
}

function usageToken(value: unknown, label: string): string {
  const token = requiredString(value, label, 128);
  if (!/^[a-z0-9][a-z0-9_.:-]*$/u.test(token)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `usage ${label} must use lowercase letters, numbers, dot, underscore, colon, or dash`,
    );
  }
  if (usageMeterNameLeaksInternalWorkersBackend(token)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `usage ${label} must describe the customer-facing resource`,
    );
  }
  return token;
}

function optionalToken(
  value: string | undefined,
  label: string,
): string | undefined {
  return value === undefined ? undefined : usageToken(value, label);
}

function optionalString(
  value: string | undefined,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, 256);
}

function requiredString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a string`,
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must contain 1-${maximumLength} characters`,
    );
  }
  return normalized;
}

function normalizeUsageResourceMetadata(
  value: UsageResourceMetadata | undefined,
): UsageResourceMetadata {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "usage resourceMetadata must be an object",
    );
  }
  const normalized: Record<string, UsageResourceMetadataValue> = {};
  for (const [rawKey, metadataValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || usageMeterNameLeaksInternalWorkersBackend(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "usage resourceMetadata keys must be non-empty public names",
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
    normalized[key] = metadataValue;
  }
  return normalized;
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
