// In-memory implementation of `AuditStore`. Keeps two collections: a
// map of events keyed by id, and an insertion-order list of ids so
// `list` returns events in append order. Match-time filtering is
// delegated to `matchesAuditQuery` from helpers.ts.

import type { AuditStore } from "../../../domains/audit/store.ts";
import type {
  AuditEvent,
  AuditEventId,
  AuditEventQuery,
} from "../../../domains/audit/types.ts";
import { immutable, matchesAuditQuery } from "./helpers.ts";

export class MemoryAuditStore implements AuditStore {
  constructor(
    private readonly events: Map<AuditEventId, AuditEvent>,
    private readonly order: AuditEventId[],
  ) {}

  append(event: AuditEvent): Promise<AuditEvent> {
    const existing = this.events.get(event.id);
    if (existing) return Promise.resolve(existing);
    const value = immutable(event);
    this.events.set(event.id, value);
    this.order.push(event.id);
    return Promise.resolve(value);
  }

  get(id: AuditEventId): Promise<AuditEvent | undefined> {
    return Promise.resolve(this.events.get(id));
  }

  list(query: AuditEventQuery = {}): Promise<readonly AuditEvent[]> {
    return Promise.resolve(
      this.order
        .map((id) => this.events.get(id))
        .filter((event): event is AuditEvent => event !== undefined)
        .filter((event) => matchesAuditQuery(event, query)),
    );
  }
}
