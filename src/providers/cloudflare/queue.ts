import type { queue } from "takosumi-contract";

export interface CloudflareQueueClient {
  enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>>;
  lease<TPayload = unknown>(
    input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined>;
  ack(input: queue.AckInput): Promise<void>;
  nack<TPayload = unknown>(
    input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>>;
  deadLetter<TPayload = unknown>(
    input: queue.DeadLetterInput,
  ): Promise<queue.QueueMessage<TPayload>>;
}

export class CloudflareQueueAdapter implements queue.QueuePort {
  readonly #client: CloudflareQueueClient;

  constructor(client: CloudflareQueueClient) {
    this.#client = client;
  }

  enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    return this.#client.enqueue(input);
  }

  lease<TPayload = unknown>(
    input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined> {
    return this.#client.lease(input);
  }

  ack(input: queue.AckInput): Promise<void> {
    return this.#client.ack(input);
  }

  nack<TPayload = unknown>(
    input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return this.#client.nack(input);
  }

  deadLetter<TPayload = unknown>(
    input: queue.DeadLetterInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return this.#client.deadLetter(input);
  }
}
