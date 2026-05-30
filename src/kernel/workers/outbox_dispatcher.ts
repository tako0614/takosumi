import type { DomainEvent, OutboxStore } from "../shared/events.ts";

export interface OutboxPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface DispatchOutboxOptions {
  readonly limit?: number;
}

export interface DispatchOutboxResult {
  readonly published: number;
  readonly failed: number;
}

export class OutboxDispatcher {
  constructor(
    readonly store: OutboxStore,
    readonly publisher: OutboxPublisher,
  ) {}

  async dispatchPending(
    options: DispatchOutboxOptions = {},
  ): Promise<DispatchOutboxResult> {
    const pending = await this.store.listPending();
    const batch = pending.slice(0, options.limit ?? pending.length);
    let published = 0;
    let failed = 0;
    for (const event of batch) {
      try {
        await this.publisher.publish(event);
        await this.store.markPublished(event.id);
        published += 1;
      } catch {
        failed += 1;
      }
    }
    return { published, failed };
  }
}

export class NoopOutboxPublisher implements OutboxPublisher {
  readonly published: DomainEvent[] = [];

  publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }
}
