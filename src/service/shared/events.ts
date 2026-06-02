import { createId, type IdGenerator } from "./ids.ts";
import { type Clock, type IsoTimestamp, nowIso } from "./time.ts";

export interface DomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: IsoTimestamp;
  readonly payload: TPayload;
  readonly metadata?: Record<string, unknown>;
}

export interface DomainEventInput<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly metadata?: Record<string, unknown>;
}

export interface OutboxStore {
  append(event: DomainEvent): Promise<void>;
  listPending(): Promise<readonly DomainEvent[]>;
  markPublished(eventId: string): Promise<void>;
}

export function createDomainEvent<TPayload extends Record<string, unknown>>(
  input: DomainEventInput<TPayload>,
  options: { clock?: Clock; idGenerator?: IdGenerator } = {},
): DomainEvent<TPayload> {
  return {
    id: createId("event", options.idGenerator),
    type: input.type,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: nowIso(options.clock),
    payload: input.payload,
    metadata: input.metadata,
  };
}

export class InMemoryOutboxStore implements OutboxStore {
  readonly #pending = new Map<string, DomainEvent>();

  append(event: DomainEvent): Promise<void> {
    this.#pending.set(event.id, event);
    return Promise.resolve();
  }

  listPending(): Promise<readonly DomainEvent[]> {
    return Promise.resolve([...this.#pending.values()]);
  }

  markPublished(eventId: string): Promise<void> {
    this.#pending.delete(eventId);
    return Promise.resolve();
  }
}
