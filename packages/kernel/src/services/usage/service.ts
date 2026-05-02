import type { BillingPort } from "./billing_port.ts";
import { NoopBillingPort } from "./billing_port.ts";
import type { UsageAggregateStore } from "./store.ts";
import type { UsageEventDto, UsageProjectionResult } from "./types.ts";

export interface UsageProjectionServiceOptions {
  readonly aggregates: UsageAggregateStore;
  readonly billing?: BillingPort;
  readonly clock?: () => Date;
}

export class UsageProjectionService {
  readonly #aggregates: UsageAggregateStore;
  readonly #billing: BillingPort;
  readonly #clock: () => Date;

  constructor(options: UsageProjectionServiceOptions) {
    this.#aggregates = options.aggregates;
    this.#billing = options.billing ?? new NoopBillingPort();
    this.#clock = options.clock ?? (() => new Date());
  }

  async record(event: UsageEventDto): Promise<UsageProjectionResult> {
    assertUsageEvent(event);
    const aggregate = await this.#aggregates.recordEvent(
      event,
      this.#clock().toISOString(),
    );
    await this.#billing.projectUsage({ event, aggregate });
    return Object.freeze({
      event,
      aggregate,
      billingForwarded: !(this.#billing instanceof NoopBillingPort),
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
