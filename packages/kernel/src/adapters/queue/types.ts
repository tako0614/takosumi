export type QueueMessageStatus = "queued" | "leased" | "acked" | "dead";

export interface QueueMessage<TPayload = unknown> {
  readonly id: string;
  readonly queue: string;
  readonly payload: TPayload;
  readonly status: QueueMessageStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly enqueuedAt: string;
  readonly availableAt: string;
  readonly leasedAt?: string;
  readonly leaseExpiresAt?: string;
  readonly leaseToken?: string;
  readonly deadLetteredAt?: string;
  readonly failureReason?: string;
  readonly metadata: Record<string, unknown>;
}

export interface QueueLease<TPayload = unknown> {
  readonly token: string;
  readonly message: QueueMessage<TPayload>;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export interface EnqueueInput<TPayload = unknown> {
  readonly queue: string;
  readonly payload: TPayload;
  readonly messageId?: string;
  readonly priority?: number;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface LeaseInput {
  readonly queue: string;
  readonly visibilityTimeoutMs?: number;
  readonly now?: string;
}

export interface AckInput {
  readonly queue: string;
  readonly messageId: string;
  readonly leaseToken: string;
}

export interface NackInput {
  readonly queue: string;
  readonly messageId: string;
  readonly leaseToken: string;
  readonly retry?: boolean;
  readonly delayMs?: number;
  readonly reason?: string;
  readonly now?: string;
}

export interface DeadLetterInput {
  readonly queue: string;
  readonly messageId: string;
  readonly leaseToken: string;
  readonly reason?: string;
  readonly now?: string;
}

export interface QueuePort {
  enqueue<TPayload = unknown>(
    input: EnqueueInput<TPayload>,
  ): Promise<QueueMessage<TPayload>>;
  lease<TPayload = unknown>(
    input: LeaseInput,
  ): Promise<QueueLease<TPayload> | undefined>;
  ack(input: AckInput): Promise<void>;
  nack<TPayload = unknown>(input: NackInput): Promise<QueueMessage<TPayload>>;
  deadLetter<TPayload = unknown>(
    input: DeadLetterInput,
  ): Promise<QueueMessage<TPayload>>;
}
