// In-memory implementation of `UsageAggregateStore`. Each event is
// folded into the matching aggregate by encoded composite key.

import {
  aggregateKeyForEvent,
  encodeAggregateId,
  type UsageAggregateStore,
} from "../../../services/usage/store.ts";
import type {
  UsageAggregate,
  UsageAggregateKey,
  UsageEventDto,
} from "../../../services/usage/types.ts";
import { immutable, maxIso, minIso } from "./helpers.ts";

export class MemoryUsageAggregateStore implements UsageAggregateStore {
  constructor(private readonly aggregates: Map<string, UsageAggregate>) {}

  recordEvent(
    event: UsageEventDto,
    projectedAt: string,
  ): Promise<UsageAggregate> {
    const key = aggregateKeyForEvent(event);
    const id = encodeAggregateId(key);
    const current = this.aggregates.get(id);
    const aggregate: UsageAggregate = current
      ? immutable({
        ...current,
        quantity: current.quantity + event.quantity,
        eventCount: current.eventCount + 1,
        firstOccurredAt: minIso(current.firstOccurredAt, event.occurredAt),
        lastOccurredAt: maxIso(current.lastOccurredAt, event.occurredAt),
        updatedAt: projectedAt,
      })
      : immutable({
        ...key,
        id,
        quantity: event.quantity,
        eventCount: 1,
        firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt,
        updatedAt: projectedAt,
      });
    this.aggregates.set(id, aggregate);
    return Promise.resolve(aggregate);
  }

  get(key: UsageAggregateKey): Promise<UsageAggregate | undefined> {
    return Promise.resolve(this.aggregates.get(encodeAggregateId(key)));
  }

  listBySpace(spaceId: string): Promise<readonly UsageAggregate[]> {
    return Promise.resolve(
      [...this.aggregates.values()].filter((aggregate) =>
        aggregate.spaceId === spaceId
      ),
    );
  }
}
