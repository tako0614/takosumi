import type {
  AckInput,
  DeadLetterInput,
  EnqueueInput,
  LeaseInput,
  NackInput,
  QueueLease,
  QueueMessage,
  QueuePort,
} from "./types.ts";

export interface MemoryQueueOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly defaultVisibilityTimeoutMs?: number;
  readonly defaultMaxAttempts?: number;
}

export class MemoryQueueAdapter implements QueuePort {
  readonly #messages = new Map<string, QueueMessage>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #defaultVisibilityTimeoutMs: number;
  readonly #defaultMaxAttempts: number;

  constructor(options: MemoryQueueOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#defaultVisibilityTimeoutMs = options.defaultVisibilityTimeoutMs ??
      30_000;
    this.#defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  }

  enqueue<TPayload = unknown>(
    input: EnqueueInput<TPayload>,
  ): Promise<QueueMessage<TPayload>> {
    const id = input.messageId ?? `msg_${this.#idGenerator()}`;
    const key = messageKey(input.queue, id);
    if (this.#messages.has(key)) {
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
    this.#messages.set(key, message);
    return Promise.resolve(cloneMessage(message));
  }

  lease<TPayload = unknown>(
    input: LeaseInput,
  ): Promise<QueueLease<TPayload> | undefined> {
    const now = input.now ?? this.#now();
    this.#releaseExpiredLeases(now);
    const candidate =
      [...this.#messages.values()].filter((message) =>
        message.queue === input.queue && message.status === "queued" &&
        message.availableAt <= now
      ).sort((a, b) =>
        b.priority - a.priority || a.availableAt.localeCompare(b.availableAt) ||
        a.enqueuedAt.localeCompare(b.enqueuedAt)
      )[0];
    if (!candidate) return Promise.resolve(undefined);

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
    this.#messages.set(messageKey(leased.queue, leased.id), leased);
    return Promise.resolve(freezeClone({
      token,
      message: leased,
      leasedAt: now,
      expiresAt,
    }) as QueueLease<TPayload>);
  }

  ack(input: AckInput): Promise<void> {
    const message = this.#requireLease(input);
    this.#messages.set(
      messageKey(input.queue, input.messageId),
      freezeClone({ ...message, status: "acked" as const }),
    );
    return Promise.resolve();
  }

  nack<TPayload = unknown>(input: NackInput): Promise<QueueMessage<TPayload>> {
    const message = this.#requireLease(input);
    const now = input.now ?? this.#now();
    const shouldRetry = input.retry ?? true;
    if (!shouldRetry || message.attempts >= message.maxAttempts) {
      return this.deadLetter<TPayload>({
        queue: input.queue,
        messageId: input.messageId,
        leaseToken: input.leaseToken,
        reason: input.reason,
        now,
      });
    }
    const availableAt = new Date(Date.parse(now) + (input.delayMs ?? 0))
      .toISOString();
    const queued = freezeClone({
      ...message,
      status: "queued" as const,
      availableAt,
      leasedAt: undefined,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      failureReason: input.reason,
    });
    this.#messages.set(messageKey(input.queue, input.messageId), queued);
    return Promise.resolve(cloneMessage(queued) as QueueMessage<TPayload>);
  }

  deadLetter<TPayload = unknown>(
    input: DeadLetterInput,
  ): Promise<QueueMessage<TPayload>> {
    const message = this.#requireLease(input);
    const dead = freezeClone({
      ...message,
      status: "dead" as const,
      leasedAt: undefined,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      deadLetteredAt: input.now ?? this.#now(),
      failureReason: input.reason,
    });
    this.#messages.set(messageKey(input.queue, input.messageId), dead);
    return Promise.resolve(cloneMessage(dead) as QueueMessage<TPayload>);
  }

  get<TPayload = unknown>(
    queue: string,
    messageId: string,
  ): Promise<QueueMessage<TPayload> | undefined> {
    const message = this.#messages.get(messageKey(queue, messageId));
    return Promise.resolve(
      message ? cloneMessage(message) as QueueMessage<TPayload> : undefined,
    );
  }

  list<TPayload = unknown>(
    queue?: string,
  ): Promise<readonly QueueMessage<TPayload>[]> {
    return Promise.resolve(
      [...this.#messages.values()].filter((message) =>
        !queue || message.queue === queue
      ).map((message) => cloneMessage(message) as QueueMessage<TPayload>),
    );
  }

  listDeadLetters<TPayload = unknown>(
    queue?: string,
  ): Promise<readonly QueueMessage<TPayload>[]> {
    return Promise.resolve(
      [...this.#messages.values()].filter((message) =>
        message.status === "dead" && (!queue || message.queue === queue)
      ).map((message) => cloneMessage(message) as QueueMessage<TPayload>),
    );
  }

  #requireLease(input: AckInput | NackInput | DeadLetterInput): QueueMessage {
    const message = this.#messages.get(
      messageKey(input.queue, input.messageId),
    );
    if (!message) {
      throw new Error(
        `queue message not found: ${input.queue}/${input.messageId}`,
      );
    }
    if (
      message.status !== "leased" || message.leaseToken !== input.leaseToken
    ) {
      throw new Error(
        `queue message lease not found: ${input.queue}/${input.messageId}`,
      );
    }
    return message;
  }

  #releaseExpiredLeases(now: string): void {
    for (const message of this.#messages.values()) {
      if (
        message.status === "leased" && message.leaseExpiresAt &&
        message.leaseExpiresAt <= now
      ) {
        this.#messages.set(
          messageKey(message.queue, message.id),
          freezeClone({
            ...message,
            status: "queued" as const,
            leasedAt: undefined,
            leaseExpiresAt: undefined,
            leaseToken: undefined,
          }),
        );
      }
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function messageKey(queue: string, messageId: string): string {
  return `${queue}\u0000${messageId}`;
}

function cloneMessage<TPayload>(
  message: QueueMessage<TPayload>,
): QueueMessage<TPayload> {
  return freezeClone(message);
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
