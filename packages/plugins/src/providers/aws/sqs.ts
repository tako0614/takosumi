import type { queue } from "takosumi-contract";
import type {
  AwsQueueClient,
  AwsQueueDeadLetterMessageRequest,
  AwsQueueDeleteMessageRequest,
  AwsQueueReceiveMessageRequest,
  AwsQueueReleaseMessageRequest,
  AwsQueueSendMessageRequest,
} from "./clients.ts";
import {
  type AwsRetryConfig,
  classifyAwsError,
  detectDrift,
  type DriftField,
  withRetry,
} from "./support.ts";

/**
 * `provider.aws.sqs@v1` — SQS queue lifecycle (create/configure/delete) +
 * data plane forwarding to an operator-injected {@link AwsQueueClient}.
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx
 *  - `not-found` is mapped to `undefined` for `describeQueue`
 *  - paginated `listQueues` (NextToken-based)
 *  - drift detection between desired attributes and observed queue
 */
export type AwsSqsQueueKind = "standard" | "fifo";

export interface AwsSqsQueueAttributes {
  readonly visibilityTimeoutSeconds?: number;
  readonly messageRetentionSeconds?: number;
  readonly delaySeconds?: number;
  readonly receiveMessageWaitSeconds?: number;
  readonly maxMessageSizeBytes?: number;
  readonly kmsMasterKeyId?: string;
  readonly contentBasedDeduplication?: boolean;
  readonly fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
  readonly redrivePolicy?: AwsSqsRedrivePolicy;
}

export interface AwsSqsRedrivePolicy {
  readonly deadLetterTargetArn: string;
  readonly maxReceiveCount: number;
}

export interface AwsSqsQueueDescriptor {
  readonly queueName: string;
  readonly queueUrl: string;
  readonly arn: string;
  readonly kind: AwsSqsQueueKind;
  readonly attributes?: AwsSqsQueueAttributes;
  readonly tags?: Record<string, string>;
}

export interface AwsSqsCreateQueueInput {
  readonly queueName: string;
  readonly kind?: AwsSqsQueueKind;
  readonly attributes?: AwsSqsQueueAttributes;
  readonly tags?: Record<string, string>;
}

export interface AwsSqsDescribeQueueInput {
  readonly queueName: string;
}

export interface AwsSqsDeleteQueueInput {
  readonly queueName: string;
}

export interface AwsSqsListQueuesPage {
  readonly items: readonly AwsSqsQueueDescriptor[];
  readonly nextToken?: string;
}

export interface AwsSqsListQueuesInput {
  readonly prefix?: string;
  readonly nextToken?: string;
  readonly limit?: number;
}

export interface AwsSqsLifecycleClient {
  createQueue(
    input: AwsSqsCreateQueueInput,
  ): Promise<AwsSqsQueueDescriptor>;
  describeQueue(
    input: AwsSqsDescribeQueueInput,
  ): Promise<AwsSqsQueueDescriptor | undefined>;
  deleteQueue(input: AwsSqsDeleteQueueInput): Promise<boolean>;
  listQueues?(input: AwsSqsListQueuesInput): Promise<AwsSqsListQueuesPage>;
}

export interface AwsSqsProviderOptions {
  readonly lifecycle: AwsSqsLifecycleClient;
  readonly queue?: AwsQueueClient;
  readonly retry?: Partial<AwsRetryConfig>;
}

export class AwsSqsProvider {
  readonly #lifecycle: AwsSqsLifecycleClient;
  readonly #queue?: AwsQueueClient;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsSqsProviderOptions) {
    this.#lifecycle = options.lifecycle;
    this.#queue = options.queue;
    this.#retry = options.retry;
  }

  createQueue(
    input: AwsSqsCreateQueueInput,
  ): Promise<AwsSqsQueueDescriptor> {
    return withRetry(
      "aws-sqs-create-queue",
      () => this.#lifecycle.createQueue(input),
      this.#retry,
    );
  }

  async describeQueue(
    input: AwsSqsDescribeQueueInput,
  ): Promise<AwsSqsQueueDescriptor | undefined> {
    try {
      return await withRetry(
        "aws-sqs-describe-queue",
        () => this.#lifecycle.describeQueue(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  deleteQueue(input: AwsSqsDeleteQueueInput): Promise<boolean> {
    return withRetry(
      "aws-sqs-delete-queue",
      () => this.#lifecycle.deleteQueue(input),
      this.#retry,
    );
  }

  /**
   * Paginated queue enumeration. Each page is retried independently.
   */
  async listAllQueues(
    input: Omit<AwsSqsListQueuesInput, "nextToken"> = {},
  ): Promise<readonly AwsSqsQueueDescriptor[]> {
    if (!this.#lifecycle.listQueues) {
      throw new Error(
        "AwsSqsLifecycleClient does not implement listQueues; cannot enumerate",
      );
    }
    const out: AwsSqsQueueDescriptor[] = [];
    let token: string | undefined;
    do {
      const page = await withRetry(
        "aws-sqs-list-queues",
        () => this.#lifecycle.listQueues!({ ...input, nextToken: token }),
        this.#retry,
      );
      for (const item of page.items) out.push(item);
      token = page.nextToken;
    } while (token !== undefined);
    return out;
  }

  /**
   * Detects drift between desired queue attributes and observed state.
   */
  async detectDrift(
    desired: AwsSqsCreateQueueInput,
  ): Promise<readonly DriftField[]> {
    const observed = await this.describeQueue({ queueName: desired.queueName });
    if (!observed) {
      return [{ path: "$", desired, observed: undefined }];
    }
    return detectDrift(
      { kind: desired.kind ?? "standard", attributes: desired.attributes },
      { kind: observed.kind, attributes: observed.attributes },
    );
  }

  sendMessage(
    input: AwsQueueSendMessageRequest,
  ): Promise<queue.QueueMessage<unknown>> {
    return withRetry(
      "aws-sqs-send-message",
      () => this.#requireQueue().sendMessage(input),
      this.#retry,
    );
  }

  async receiveMessage(
    input: AwsQueueReceiveMessageRequest,
  ): Promise<queue.QueueLease<unknown> | undefined> {
    try {
      return await withRetry(
        "aws-sqs-receive-message",
        () => this.#requireQueue().receiveMessage(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  deleteMessage(input: AwsQueueDeleteMessageRequest): Promise<void> {
    return withRetry(
      "aws-sqs-delete-message",
      () => this.#requireQueue().deleteMessage(input),
      this.#retry,
    );
  }

  releaseMessage(
    input: AwsQueueReleaseMessageRequest,
  ): Promise<queue.QueueMessage<unknown>> {
    return withRetry(
      "aws-sqs-release-message",
      () => this.#requireQueue().releaseMessage(input),
      this.#retry,
    );
  }

  deadLetterMessage(
    input: AwsQueueDeadLetterMessageRequest,
  ): Promise<queue.QueueMessage<unknown>> {
    return withRetry(
      "aws-sqs-dead-letter-message",
      () => this.#requireQueue().deadLetterMessage(input),
      this.#retry,
    );
  }

  #requireQueue(): AwsQueueClient {
    if (!this.#queue) {
      throw new Error(
        "AwsSqsProvider was not constructed with a queue client; inject AwsQueueClient to perform message I/O",
      );
    }
    return this.#queue;
  }
}
