import type {
  UsageAggregate,
  UsageAggregateKey,
  UsageEventDto,
} from "./types.ts";

export interface UsageAggregateStore {
  recordEvent(
    event: UsageEventDto,
    projectedAt: string,
  ): Promise<UsageAggregate>;
  get(key: UsageAggregateKey): Promise<UsageAggregate | undefined>;
  listBySpace(spaceId: string): Promise<readonly UsageAggregate[]>;
}

export class InMemoryUsageAggregateStore implements UsageAggregateStore {
  readonly #aggregates = new Map<string, UsageAggregate>();

  recordEvent(
    event: UsageEventDto,
    projectedAt: string,
  ): Promise<UsageAggregate> {
    const key = aggregateKeyForEvent(event);
    const id = encodeAggregateId(key);
    const current = this.#aggregates.get(id);
    const aggregate: UsageAggregate = current
      ? Object.freeze({
        ...current,
        quantity: current.quantity + event.quantity,
        eventCount: current.eventCount + 1,
        firstOccurredAt: minIso(current.firstOccurredAt, event.occurredAt),
        lastOccurredAt: maxIso(current.lastOccurredAt, event.occurredAt),
        updatedAt: projectedAt,
      })
      : Object.freeze({
        ...key,
        id,
        quantity: event.quantity,
        eventCount: 1,
        firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt,
        updatedAt: projectedAt,
      });
    this.#aggregates.set(id, aggregate);
    return Promise.resolve(aggregate);
  }

  get(key: UsageAggregateKey): Promise<UsageAggregate | undefined> {
    return Promise.resolve(this.#aggregates.get(encodeAggregateId(key)));
  }

  listBySpace(spaceId: string): Promise<readonly UsageAggregate[]> {
    return Promise.resolve(
      [...this.#aggregates.values()].filter((aggregate) =>
        aggregate.spaceId === spaceId
      ),
    );
  }
}

export function aggregateKeyForEvent(event: UsageEventDto): UsageAggregateKey {
  return Object.freeze({
    spaceId: event.spaceId,
    groupId: event.groupId,
    ownerKind: event.kind,
    metric: event.metric,
    unit: event.unit,
  });
}

export function encodeAggregateId(key: UsageAggregateKey): string {
  return [
    key.spaceId,
    key.groupId ?? "-",
    key.ownerKind,
    key.metric,
    key.unit,
  ].map(encodeURIComponent).join(":");
}

function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxIso(left: string, right: string): string {
  return left >= right ? left : right;
}
