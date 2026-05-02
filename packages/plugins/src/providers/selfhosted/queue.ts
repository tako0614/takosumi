import type { queue } from "takosumi-contract";
import { freezeClone } from "./common.ts";
import {
  createDocumentStore,
  type SelfHostedDocumentStore,
  type SelfHostedSqlClient,
} from "./sql.ts";

export interface SelfHostedPostgresQueueAdapterOptions {
  readonly client: SelfHostedSqlClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly defaultVisibilityTimeoutMs?: number;
  readonly defaultMaxAttempts?: number;
}

export class SelfHostedPostgresQueueAdapter implements queue.QueuePort {
  readonly #client: SelfHostedSqlClient;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #defaultVisibilityTimeoutMs: number;
  readonly #defaultMaxAttempts: number;

  constructor(options: SelfHostedPostgresQueueAdapterOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#defaultVisibilityTimeoutMs = options.defaultVisibilityTimeoutMs ??
      30_000;
    this.#defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  }

  async enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    const documents = createDocumentStore(this.#client, this.#clock);
    const id = input.messageId ?? `msg_${this.#idGenerator()}`;
    const key = messageKey(input.queue, id);
    if (await documents.get(queueCollection, key)) {
      throw new Error(`queue message already exists: ${input.queue}/${id}`);
    }
    const now = this.#now();
    const message = freezeClone({
      id,
      queue: input.queue,
      payload: input.payload,
      status: "queued" as const,
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.#defaultMaxAttempts,
      enqueuedAt: now,
      availableAt: input.availableAt ?? now,
      leasedAt: undefined,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      deadLetteredAt: undefined,
      failureReason: undefined,
      metadata: { ...(input.metadata ?? {}) },
    });
    await documents.put(queueCollection, key, message);
    return message as queue.QueueMessage<TPayload>;
  }

  async lease<TPayload = unknown>(
    input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined> {
    return await this.#withQueueTransaction(async (documents) => {
      const now = input.now ?? this.#now();
      await releaseExpiredLeases(documents, now);
      const candidate =
        (await documents.list<queue.QueueMessage<TPayload>>(queueCollection))
          .filter((message) =>
            message.queue === input.queue && message.status === "queued" &&
            message.availableAt <= now
          )
          .sort((left, right) =>
            right.priority - left.priority ||
            left.availableAt.localeCompare(right.availableAt) ||
            left.enqueuedAt.localeCompare(right.enqueuedAt)
          )[0];
      if (!candidate) return undefined;

      const token = `lease_${this.#idGenerator()}`;
      const expiresAt = new Date(
        Date.parse(now) +
          (input.visibilityTimeoutMs ?? this.#defaultVisibilityTimeoutMs),
      ).toISOString();
      const leased = freezeClone({
        ...candidate,
        status: "leased" as const,
        attempts: candidate.attempts + 1,
        leasedAt: now,
        leaseExpiresAt: expiresAt,
        leaseToken: token,
      });
      await documents.put(
        queueCollection,
        messageKey(leased.queue, leased.id),
        leased,
      );
      return freezeClone({
        token,
        message: leased,
        leasedAt: now,
        expiresAt,
      }) as queue.QueueLease<TPayload>;
    });
  }

  async ack(input: queue.AckInput): Promise<void> {
    await this.#withQueueTransaction(async (documents) => {
      const message = await requireLease(documents, input);
      await documents.put(
        queueCollection,
        messageKey(input.queue, input.messageId),
        {
          ...message,
          status: "acked" as const,
        },
      );
    });
  }

  async nack<TPayload = unknown>(
    input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return await this.#withQueueTransaction(async (documents) => {
      const message = await requireLease<TPayload>(documents, input);
      const now = input.now ?? this.#now();
      const shouldRetry = input.retry ?? true;
      if (!shouldRetry || message.attempts >= message.maxAttempts) {
        return await deadLetterMessage(documents, message, {
          reason: input.reason,
          now,
        });
      }
      const queued = freezeClone({
        ...message,
        status: "queued" as const,
        availableAt: new Date(Date.parse(now) + (input.delayMs ?? 0))
          .toISOString(),
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        leaseToken: undefined,
        failureReason: input.reason,
      });
      await documents.put(
        queueCollection,
        messageKey(input.queue, input.messageId),
        queued,
      );
      return queued;
    });
  }

  async deadLetter<TPayload = unknown>(
    input: queue.DeadLetterInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return await this.#withQueueTransaction(async (documents) => {
      const message = await requireLease<TPayload>(documents, input);
      return await deadLetterMessage(documents, message, {
        reason: input.reason,
        now: input.now ?? this.#now(),
      });
    });
  }

  async #withQueueTransaction<T>(
    fn: (documents: SelfHostedDocumentStore) => Promise<T>,
  ): Promise<T> {
    if (this.#client.transaction) {
      return await this.#client.transaction((transaction) =>
        fn(createDocumentStore(transaction, this.#clock))
      );
    }
    await this.#client.query("begin");
    try {
      const result = await fn(createDocumentStore(this.#client, this.#clock));
      await this.#client.query("commit");
      return result;
    } catch (error) {
      await this.#client.query("rollback");
      throw error;
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

const queueCollection = "queue_messages";

async function requireLease<TPayload>(
  documents: SelfHostedDocumentStore,
  input: queue.AckInput | queue.NackInput | queue.DeadLetterInput,
): Promise<queue.QueueMessage<TPayload>> {
  const message = await documents.get<queue.QueueMessage<TPayload>>(
    queueCollection,
    messageKey(input.queue, input.messageId),
  );
  if (!message) {
    throw new Error(
      `queue message not found: ${input.queue}/${input.messageId}`,
    );
  }
  if (message.status !== "leased" || message.leaseToken !== input.leaseToken) {
    throw new Error(
      `queue message lease not found: ${input.queue}/${input.messageId}`,
    );
  }
  return message;
}

async function releaseExpiredLeases(
  documents: SelfHostedDocumentStore,
  now: string,
): Promise<void> {
  const messages = await documents.list<queue.QueueMessage>(queueCollection);
  await Promise.all(messages.map(async (message) => {
    if (
      message.status === "leased" && message.leaseExpiresAt &&
      message.leaseExpiresAt <= now
    ) {
      await documents.put(
        queueCollection,
        messageKey(message.queue, message.id),
        {
          ...message,
          status: "queued" as const,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          leaseToken: undefined,
        },
      );
    }
  }));
}

async function deadLetterMessage<TPayload>(
  documents: SelfHostedDocumentStore,
  message: queue.QueueMessage<TPayload>,
  options: { readonly reason?: string; readonly now: string },
): Promise<queue.QueueMessage<TPayload>> {
  const dead = freezeClone({
    ...message,
    status: "dead" as const,
    leasedAt: undefined,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    deadLetteredAt: options.now,
    failureReason: options.reason,
  });
  await documents.put(
    queueCollection,
    messageKey(message.queue, message.id),
    dead,
  );
  return dead;
}

function messageKey(queueName: string, messageId: string): string {
  return `${queueName}:${messageId}`;
}
