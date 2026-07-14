/** Provider-neutral Workspace usage/showback service. */

import type {
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
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

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
    await this.#requireWorkspace(workspaceId);
    return {
      billing: {
        settings: await this.#billing.billingSettingsForWorkspace(workspaceId),
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
    const events = await this.#store.listUsageEvents(capsule.workspaceId);
    const attributed = events.filter((event) => event.capsuleId === capsuleId);
    const rated = attributed.filter((event) => event.ratingStatus === "rated");
    return {
      capsuleId,
      usdMicros: rated.reduce((sum, event) => sum + event.usdMicros, 0),
      eventCount: attributed.length,
      ratedEventCount: rated.length,
      unratedEventCount: attributed.length - rated.length,
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
    const usageEvent = normalizeMeteredUsageEvent(
      workspaceId,
      input,
      () => this.#newId("usage"),
      () => new Date(this.#now()).toISOString(),
    );
    return { usageEvent: await this.#store.putUsageEvent(usageEvent) };
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
