import type { BillingPort } from "./billing_port.ts";
import { NoopBillingPort } from "./billing_port.ts";
import type { UsageQuotaPolicyPort } from "./quota_policy.ts";
import { aggregateKeyForEvent, type UsageAggregateStore } from "./store.ts";
import type {
  UsageEventDto,
  UsageProjectionResult,
  UsageQuotaDecision,
  UsageQuotaKey,
} from "./types.ts";

export interface UsageProjectionServiceOptions {
  readonly aggregates: UsageAggregateStore;
  readonly billing?: BillingPort;
  readonly quotaPolicy?: UsageQuotaPolicyPort;
  readonly clock?: () => Date;
}

export class UsageQuotaExceededError extends Error {
  readonly decision: UsageQuotaDecision;

  constructor(decision: UsageQuotaDecision) {
    super(
      `usage quota exceeded for ${decision.key}: ` +
        `${decision.quantity}/${decision.limit}`,
    );
    this.name = "UsageQuotaExceededError";
    this.decision = decision;
  }
}

export class UsageProjectionService {
  readonly #aggregates: UsageAggregateStore;
  readonly #billing: BillingPort;
  readonly #quotaPolicy?: UsageQuotaPolicyPort;
  readonly #clock: () => Date;

  constructor(options: UsageProjectionServiceOptions) {
    this.#aggregates = options.aggregates;
    this.#billing = options.billing ?? new NoopBillingPort();
    this.#quotaPolicy = options.quotaPolicy;
    this.#clock = options.clock ?? (() => new Date());
  }

  async record(event: UsageEventDto): Promise<UsageProjectionResult> {
    return await this.#record(event, { enforceQuota: false });
  }

  async requireWithinQuota(
    event: UsageEventDto,
  ): Promise<UsageProjectionResult> {
    return await this.#record(event, { enforceQuota: true });
  }

  async #record(
    event: UsageEventDto,
    options: { readonly enforceQuota: boolean },
  ): Promise<UsageProjectionResult> {
    assertUsageEvent(event);
    const quotaDecision = await this.#decideQuota(event);
    if (options.enforceQuota && quotaDecision && !quotaDecision.allowed) {
      throw new UsageQuotaExceededError(quotaDecision);
    }
    const aggregate = await this.#aggregates.recordEvent(
      event,
      this.#clock().toISOString(),
    );
    await this.#billing.projectUsage({ event, aggregate });
    return Object.freeze({
      event,
      aggregate,
      billingForwarded: !(this.#billing instanceof NoopBillingPort),
      ...(quotaDecision ? { quotaDecision } : {}),
    });
  }

  async #decideQuota(
    event: UsageEventDto,
  ): Promise<UsageQuotaDecision | undefined> {
    if (!this.#quotaPolicy) return undefined;
    const key = quotaKeyForEvent(event);
    if (!key) return undefined;
    const tier = await this.#quotaPolicy.getQuotaTier(event.spaceId);
    if (!tier) return undefined;
    const current = await this.#aggregates.get(aggregateKeyForEvent(event));
    const quantity = (current?.quantity ?? 0) + event.quantity;
    const limit = tier.limits[key];
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      return Object.freeze({
        allowed: true,
        key,
        tierId: tier.tierId,
        quantity,
        reason: "quota-unlimited",
      });
    }
    const allowed = quantity <= limit;
    return Object.freeze({
      allowed,
      key,
      tierId: tier.tierId,
      quantity,
      limit,
      reason: allowed ? "quota-within-limit" : "quota-exceeded",
    });
  }
}

export function assertUsageEvent(event: UsageEventDto): void {
  if (!event.id) throw new TypeError("usage event id is required");
  if (!event.spaceId) throw new TypeError("usage event spaceId is required");
  if (!event.occurredAt) {
    throw new TypeError("usage event occurredAt is required");
  }
  if (!Number.isFinite(event.quantity) || event.quantity < 0) {
    throw new TypeError("usage event quantity must be a non-negative number");
  }
}

export function quotaKeyForEvent(
  event: UsageEventDto,
): UsageQuotaKey | undefined {
  switch (event.metric) {
    case "runtime.cpu_milliseconds":
    case "runtime.service_milliseconds":
    case "runtime.worker_milliseconds":
      return "cpuMilliseconds";
    case "resource.storage_bytes":
      return "storageBytes";
    case "runtime.bandwidth_bytes":
      return "bandwidthBytes";
    default:
      return undefined;
  }
}
