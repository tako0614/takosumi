import type { AuditEvent, AuditEventId, AuditEventQuery } from "./types.ts";

export interface AuditStore {
  append(event: AuditEvent): Promise<AuditEvent>;
  get(id: AuditEventId): Promise<AuditEvent | undefined>;
  list(query?: AuditEventQuery): Promise<readonly AuditEvent[]>;
}

export class InMemoryAuditStore implements AuditStore {
  readonly #events = new Map<AuditEventId, AuditEvent>();
  readonly #order: AuditEventId[] = [];

  append(event: AuditEvent): Promise<AuditEvent> {
    const existing = this.#events.get(event.id);
    if (existing) return Promise.resolve(existing);
    this.#events.set(event.id, event);
    this.#order.push(event.id);
    return Promise.resolve(event);
  }

  get(id: AuditEventId): Promise<AuditEvent | undefined> {
    return Promise.resolve(this.#events.get(id));
  }

  list(query: AuditEventQuery = {}): Promise<readonly AuditEvent[]> {
    const events = this.#order
      .map((id) => this.#events.get(id))
      .filter((event): event is AuditEvent => event !== undefined)
      .filter((event) => matchesQuery(event, query));
    return Promise.resolve(events);
  }
}

function matchesQuery(event: AuditEvent, query: AuditEventQuery): boolean {
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.targetType && event.targetType !== query.targetType) return false;
  if (query.targetId && event.targetId !== query.targetId) return false;
  if (query.type && event.type !== query.type) return false;
  if (query.since && event.occurredAt < query.since) return false;
  if (query.until && event.occurredAt > query.until) return false;
  return true;
}
