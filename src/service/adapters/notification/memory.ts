import type {
  NotificationInput,
  NotificationPort,
  NotificationRecord,
} from "./types.ts";

export interface MemoryNotificationSinkOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class MemoryNotificationSink implements NotificationPort {
  readonly #records: NotificationRecord[] = [];
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: MemoryNotificationSinkOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  publish(input: NotificationInput): Promise<NotificationRecord> {
    const record: NotificationRecord = Object.freeze({
      id: `notification_${this.#idGenerator()}`,
      type: input.type,
      subject: input.subject,
      body: input.body,
      severity: input.severity ?? "info",
      metadata: { ...(input.metadata ?? {}) },
      createdAt: this.#clock().toISOString(),
    });
    this.#records.push(record);
    return Promise.resolve(cloneRecord(record));
  }

  list(): Promise<readonly NotificationRecord[]> {
    return Promise.resolve(this.#records.map(cloneRecord));
  }

  clear(): Promise<void> {
    this.#records.splice(0, this.#records.length);
    return Promise.resolve();
  }
}

function cloneRecord(record: NotificationRecord): NotificationRecord {
  return Object.freeze(structuredClone(record));
}
