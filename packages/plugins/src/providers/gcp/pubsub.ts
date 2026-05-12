import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  buildRuntimeDetails,
  compactRecord,
  computeDrift,
  computeIdempotencyKey,
  deepFreeze,
  executionFromCondition,
  type GcpDriftReport,
  type GcpRuntimeHooks,
  resolveRuntimeContext,
  withRetry,
} from "./_runtime.ts";

/**
 * Operator-injected Pub/Sub admin client. Implementations call the
 * `pubsub.googleapis.com` REST API to ensure the requested topic +
 * subscription pair exists with the desired ack deadline / retry policy.
 *
 * `listTopics` is exposed for paginated drift / inventory.
 */
export interface GcpPubSubAdminClient {
  ensureTopicAndSubscription(
    input: GcpPubSubEnsureInput,
  ): Promise<GcpPubSubEnsureResult>;
  describeTopic?(
    input: GcpPubSubDescribeInput,
  ): Promise<GcpPubSubObservedRecord | undefined>;
  listTopics?(input: GcpPubSubListInput): Promise<GcpPubSubListResult>;
}

export interface GcpPubSubEnsureInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly topicName: string;
  readonly subscriptionName?: string;
  readonly ackDeadlineSeconds?: number;
  readonly messageRetentionDuration?: string;
  readonly deadLetterTopic?: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpPubSubEnsureResult {
  readonly topicResourceName: string;
  readonly subscriptionResourceName?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpPubSubObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpPubSubDescribeInput {
  readonly projectId: string;
  readonly topicName: string;
}

export interface GcpPubSubObservedRecord {
  readonly topicResourceName: string;
  readonly subscriptionResourceName?: string;
  readonly ackDeadlineSeconds?: number;
  readonly messageRetentionDuration?: string;
  readonly deadLetterTopic?: string;
}

export interface GcpPubSubListInput {
  readonly projectId: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface GcpPubSubListResult {
  readonly topics: readonly { readonly name: string }[];
  readonly nextPageToken?: string;
}

export interface GcpPubSubProviderOptions {
  readonly client: GcpPubSubAdminClient;
  readonly projectId: string;
  readonly topicName: string;
  readonly subscriptionName?: string;
  readonly ackDeadlineSeconds?: number;
  readonly messageRetentionDuration?: string;
  readonly deadLetterTopic?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

export const GCP_PUBSUB_DESCRIPTOR = "provider.gcp.pubsub@v1" as const;

export class GcpPubSubProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpPubSubAdminClient;
  readonly #projectId: string;
  readonly #topicName: string;
  readonly #subscriptionName?: string;
  readonly #ackDeadlineSeconds?: number;
  readonly #messageRetentionDuration?: string;
  readonly #deadLetterTopic?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpPubSubProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#topicName = options.topicName;
    this.#subscriptionName = options.subscriptionName;
    this.#ackDeadlineSeconds = options.ackDeadlineSeconds;
    this.#messageRetentionDuration = options.messageRetentionDuration;
    this.#deadLetterTopic = options.deadLetterTopic;
    this.#clock = options.clock ?? options.runtime?.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#runtime = options.runtime;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const ctx = resolveRuntimeContext({
      ...(this.#runtime ?? {}),
      clock: this.#clock,
    });
    const startedAt = ctx.clock().toISOString();
    const idempotencyKey = computeIdempotencyKey({
      descriptor: GCP_PUBSUB_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: this.#topicName,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.ensureTopicAndSubscription({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          topicName: this.#topicName,
          subscriptionName: this.#subscriptionName,
          ackDeadlineSeconds: this.#ackDeadlineSeconds,
          messageRetentionDuration: this.#messageRetentionDuration,
          deadLetterTopic: this.#deadLetterTopic,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_PUBSUB_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: this.#topicName,
          idempotencyKey,
          enqueuedAt: startedAt,
        },
      },
    );
    const completedAt = ctx.clock().toISOString();
    const result = outcome.result;
    const drift = result?.observed
      ? computeDrift(
        compactRecord({
          topicName: this.#topicName,
          subscriptionName: this.#subscriptionName,
          ackDeadlineSeconds: this.#ackDeadlineSeconds,
          messageRetentionDuration: this.#messageRetentionDuration,
          deadLetterTopic: this.#deadLetterTopic,
        }),
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-pubsub-ensure",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.topicResourceName,
      targetName: this.#topicName,
      command: [
        "gcloud",
        "pubsub",
        "topics",
        "describe",
        this.#topicName,
        `--project=${this.#projectId}`,
      ],
      details: {
        descriptor: GCP_PUBSUB_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#projectId,
          topicName: this.#topicName,
          subscriptionName: this.#subscriptionName,
          topicResourceName: result?.topicResourceName,
          subscriptionResourceName: result?.subscriptionResourceName,
          ackDeadlineSeconds: this.#ackDeadlineSeconds,
          messageRetentionDuration: this.#messageRetentionDuration,
          deadLetterTopic: this.#deadLetterTopic,
        }),
        ...buildRuntimeDetails(outcome, idempotencyKey),
        ...(drift ? { drift } : {}),
      },
      recordedAt: completedAt,
      execution: executionFromCondition(
        outcome.condition,
        startedAt,
        completedAt,
        result?.stdout,
        result?.stderr,
      ),
    };
    this.#operations.push(operation, ...(result?.operations ?? []));
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "gcp",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      objectAddress: result?.topicResourceName,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeTopic) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeTopic({
      projectId: this.#projectId,
      topicName: this.#topicName,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    return computeDrift(
      compactRecord({
        topicName: this.#topicName,
        subscriptionName: this.#subscriptionName,
        ackDeadlineSeconds: this.#ackDeadlineSeconds,
        messageRetentionDuration: this.#messageRetentionDuration,
        deadLetterTopic: this.#deadLetterTopic,
      }),
      observed,
      observedAt,
    );
  }

  /** Paginate through all topics on the project. */
  async listAllTopics(
    options: { readonly pageSize?: number } = {},
  ): Promise<readonly { readonly name: string }[]> {
    if (!this.#client.listTopics) {
      throw new Error("GcpPubSubAdminClient does not implement listTopics");
    }
    const out: { readonly name: string }[] = [];
    let pageToken: string | undefined;
    let safety = 0;
    do {
      const page = await this.#client.listTopics({
        projectId: this.#projectId,
        pageToken,
        pageSize: options.pageSize,
      });
      out.push(...page.topics);
      pageToken = page.nextPageToken;
      safety += 1;
      if (safety > 10_000) break;
    } while (pageToken);
    return out;
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}
