import type {
  kms,
  objectStorage,
  provider,
  queue,
  router,
  secretStore,
  storage,
} from "takosumi-contract";
import type { RuntimeAgentRegistry } from "takosumi-contract";
import type { ObservabilitySink } from "takosumi-contract";
import type {
  AwsKmsClient,
  AwsObjectStorageClient,
  AwsObservabilityClient,
  AwsProviderClient,
  AwsQueueClient,
  AwsRouterClient,
  AwsRuntimeAgentClient,
  AwsSecretsClient,
  AwsStorageClient,
} from "./clients.ts";

type AwsStorageClientLike = AwsStorageClient | storage.StorageDriver;
type AwsKmsClientLike = AwsKmsClient | kms.KmsPort;
type AwsQueueClientLike = AwsQueueClient | queue.QueuePort;
type AwsSecretsClientLike = AwsSecretsClient | secretStore.SecretStorePort;
type AwsProviderClientLike = AwsProviderClient | provider.ProviderMaterializer;
type AwsRouterClientLike = AwsRouterClient | router.RouterConfigPort;
type AwsObservabilityClientLike = AwsObservabilityClient | ObservabilitySink;
type AwsRuntimeAgentClientLike = AwsRuntimeAgentClient | RuntimeAgentRegistry;

export class AwsStorageAdapter implements storage.StorageDriver {
  constructor(readonly client: AwsStorageClientLike) {}

  get statements(): storage.StorageStatementCatalog {
    return this.client.statements;
  }

  transaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    if ("runTransaction" in this.client) {
      return this.client.runTransaction(fn);
    }
    return this.client.transaction(fn);
  }
}

export class AwsObjectStorageAdapter
  implements objectStorage.ObjectStoragePort {
  constructor(readonly client: AwsObjectStorageClient) {}

  putObject(
    input: objectStorage.ObjectStoragePutInput,
  ): Promise<objectStorage.ObjectStorageObjectHead> {
    const request = {
      bucket: input.bucket,
      key: input.key,
      bucketName: input.bucket,
      objectKey: input.key,
      body: input.body,
      contentType: input.contentType,
      metadata: input.metadata,
      expectedSha256: input.expectedDigest,
      expectedDigest: input.expectedDigest,
    };
    return this.client.putObject(request);
  }

  getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<objectStorage.ObjectStorageObject | undefined> {
    const request = {
      bucket: input.bucket,
      key: input.key,
      bucketName: input.bucket,
      objectKey: input.key,
      expectedSha256: input.expectedDigest,
      expectedDigest: input.expectedDigest,
    };
    return this.client.getObject(request);
  }

  headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined> {
    const request = {
      bucket: input.bucket,
      key: input.key,
      bucketName: input.bucket,
      objectKey: input.key,
      expectedSha256: input.expectedDigest,
      expectedDigest: input.expectedDigest,
    };
    return this.client.headObject(request);
  }

  listObjects(
    input: objectStorage.ObjectStorageListInput,
  ): Promise<objectStorage.ObjectStorageListResult> {
    const request = {
      bucket: input.bucket,
      bucketName: input.bucket,
      prefix: input.prefix,
      cursor: input.cursor,
      continuationToken: input.cursor,
      limit: input.limit,
      maxKeys: input.limit,
    };
    return this.client.listObjects(request);
  }

  deleteObject(
    input: objectStorage.ObjectStorageDeleteInput,
  ): Promise<boolean> {
    const request = {
      bucket: input.bucket,
      key: input.key,
      bucketName: input.bucket,
      objectKey: input.key,
    };
    return this.client.deleteObject(request);
  }
}

export class AwsQueueAdapter implements queue.QueuePort {
  constructor(readonly client: AwsQueueClientLike) {}

  enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    if ("sendMessage" in this.client) {
      return this.client.sendMessage({
        queueName: input.queue,
        body: input.payload,
        messageId: input.messageId,
        priority: input.priority,
        availableAt: input.availableAt,
        maxAttempts: input.maxAttempts,
        metadata: input.metadata,
      }) as Promise<queue.QueueMessage<TPayload>>;
    }
    return this.client.enqueue(input);
  }

  lease<TPayload = unknown>(
    input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined> {
    if ("receiveMessage" in this.client) {
      return this.client.receiveMessage(
        inputToReceiveMessage(input),
      ) as Promise<queue.QueueLease<TPayload> | undefined>;
    }
    return this.client.lease(input);
  }

  ack(input: queue.AckInput): Promise<void> {
    if ("deleteMessage" in this.client) {
      return this.client.deleteMessage({
        queueName: input.queue,
        messageId: input.messageId,
        receiptHandle: input.leaseToken,
      });
    }
    return this.client.ack(input);
  }

  nack<TPayload = unknown>(
    input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    if ("releaseMessage" in this.client) {
      return this.client.releaseMessage({
        queueName: input.queue,
        messageId: input.messageId,
        receiptHandle: input.leaseToken,
        retry: input.retry,
        delayMs: input.delayMs,
        reason: input.reason,
        now: input.now,
      }) as Promise<queue.QueueMessage<TPayload>>;
    }
    return this.client.nack(input);
  }

  deadLetter<TPayload = unknown>(
    input: queue.DeadLetterInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    if ("deadLetterMessage" in this.client) {
      return this.client.deadLetterMessage({
        queueName: input.queue,
        messageId: input.messageId,
        receiptHandle: input.leaseToken,
        reason: input.reason,
        now: input.now,
      }) as Promise<queue.QueueMessage<TPayload>>;
    }
    return this.client.deadLetter(input);
  }
}

export class AwsKmsAdapter implements kms.KmsPort {
  constructor(readonly client: AwsKmsClientLike) {}

  activeKeyRef(): Promise<kms.KmsKeyRefDto> {
    if ("describeActiveKey" in this.client) {
      return this.client.describeActiveKey();
    }
    return this.client.activeKeyRef();
  }

  encrypt(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto> {
    if ("encryptEnvelope" in this.client) {
      return this.client.encryptEnvelope(input);
    }
    return this.client.encrypt(input);
  }

  decrypt(input: kms.KmsDecryptInput): Promise<Uint8Array> {
    if ("decryptEnvelope" in this.client) {
      return this.client.decryptEnvelope(input);
    }
    return this.client.decrypt(input);
  }

  rotate(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto> {
    if ("rotateEnvelope" in this.client) {
      return this.client.rotateEnvelope(input);
    }
    return this.client.rotate(input);
  }
}

export class AwsSecretsAdapter implements secretStore.SecretStorePort {
  constructor(readonly client: AwsSecretsClientLike) {}

  putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord> {
    if ("putSecretValue" in this.client) {
      return this.client.putSecretValue({
        secretName: input.name,
        value: input.value,
        metadata: input.metadata,
      });
    }
    return this.client.putSecret(input);
  }

  getSecret(
    ref: secretStore.SecretVersionRef,
  ): Promise<string | undefined> {
    if ("getSecretValue" in this.client) {
      return this.client.getSecretValue({
        secretName: ref.name,
        versionId: ref.version,
      });
    }
    return this.client.getSecret(ref);
  }

  async getSecretRecord(
    ref: secretStore.SecretVersionRef,
  ): Promise<secretStore.SecretRecord | undefined> {
    if ("getSecretRecord" in this.client) {
      return await this.client.getSecretRecord(ref);
    }
    return (await this.listSecrets()).find((record) =>
      record.name === ref.name && record.version === ref.version
    );
  }

  latestSecret(
    name: string,
  ): Promise<secretStore.SecretRecord | undefined> {
    if ("getLatestSecret" in this.client) {
      return this.client.getLatestSecret(name);
    }
    return this.client.latestSecret(name);
  }

  listSecrets(): Promise<readonly secretStore.SecretRecord[]> {
    if ("listSecretVersions" in this.client) {
      return this.client.listSecretVersions();
    }
    return this.client.listSecrets();
  }

  deleteSecret(ref: secretStore.SecretVersionRef): Promise<boolean> {
    if ("deleteSecretVersion" in this.client) {
      return this.client.deleteSecretVersion({
        secretName: ref.name,
        versionId: ref.version,
      });
    }
    return this.client.deleteSecret(ref);
  }
}

export class AwsProviderAdapter implements provider.ProviderMaterializer {
  constructor(readonly client: AwsProviderClientLike) {}

  materialize(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan> {
    if ("materializeDesiredState" in this.client) {
      return this.client.materializeDesiredState(desiredState);
    }
    return this.client.materialize(desiredState);
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    if ("listOperations" in this.client) {
      return this.client.listOperations();
    }
    return this.client.listRecordedOperations();
  }

  clearRecordedOperations(): Promise<void> {
    if ("clearOperations" in this.client) {
      return this.client.clearOperations();
    }
    return this.client.clearRecordedOperations();
  }
}

export class AwsRouterAdapter implements router.RouterConfigPort {
  constructor(readonly client: AwsRouterClientLike) {}

  apply(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult> {
    if ("applyRoutes" in this.client) {
      return this.client.applyRoutes(projection);
    }
    return this.client.apply(projection);
  }
}

export class AwsObservabilityAdapter implements ObservabilitySink {
  constructor(readonly client: AwsObservabilityClientLike) {}

  appendAudit(
    event: Parameters<ObservabilitySink["appendAudit"]>[0],
  ): ReturnType<ObservabilitySink["appendAudit"]> {
    if ("appendAuditEvent" in this.client) {
      return this.client.appendAuditEvent(event);
    }
    return this.client.appendAudit(event);
  }

  listAudit(): ReturnType<ObservabilitySink["listAudit"]> {
    if ("listAuditEvents" in this.client) {
      return this.client.listAuditEvents();
    }
    return this.client.listAudit();
  }

  verifyAuditChain(): ReturnType<ObservabilitySink["verifyAuditChain"]> {
    if ("verifyAuditEvents" in this.client) {
      return this.client.verifyAuditEvents();
    }
    return this.client.verifyAuditChain();
  }

  recordMetric(
    event: Parameters<ObservabilitySink["recordMetric"]>[0],
  ): ReturnType<ObservabilitySink["recordMetric"]> {
    if ("putMetric" in this.client) {
      return this.client.putMetric(event);
    }
    return this.client.recordMetric(event);
  }

  listMetrics(
    query?: Parameters<ObservabilitySink["listMetrics"]>[0],
  ): ReturnType<ObservabilitySink["listMetrics"]> {
    if ("listMetricEvents" in this.client) {
      return this.client.listMetricEvents(query);
    }
    return this.client.listMetrics(query);
  }

  recordTrace(
    event: Parameters<ObservabilitySink["recordTrace"]>[0],
  ): ReturnType<ObservabilitySink["recordTrace"]> {
    if (
      "putTrace" in this.client && typeof this.client.putTrace === "function"
    ) {
      return this.client.putTrace(event);
    }
    if ("recordTrace" in this.client) {
      return this.client.recordTrace(event);
    }
    return Promise.resolve(event);
  }

  listTraces(
    query?: Parameters<ObservabilitySink["listTraces"]>[0],
  ): ReturnType<ObservabilitySink["listTraces"]> {
    if (
      "listTraceEvents" in this.client &&
      typeof this.client.listTraceEvents === "function"
    ) {
      return this.client.listTraceEvents(query);
    }
    if ("listTraces" in this.client) {
      return this.client.listTraces(query);
    }
    return Promise.resolve([]);
  }
}

export class AwsRuntimeAgentAdapter implements RuntimeAgentRegistry {
  constructor(readonly client: AwsRuntimeAgentClientLike) {}

  register(
    input: Parameters<RuntimeAgentRegistry["register"]>[0],
  ): ReturnType<RuntimeAgentRegistry["register"]> {
    if ("registerAgent" in this.client) {
      return this.client.registerAgent(input);
    }
    return this.client.register(input);
  }

  heartbeat(
    input: Parameters<RuntimeAgentRegistry["heartbeat"]>[0],
  ): ReturnType<RuntimeAgentRegistry["heartbeat"]> {
    if ("heartbeatAgent" in this.client) {
      return this.client.heartbeatAgent(input);
    }
    return this.client.heartbeat(input);
  }

  getAgent(
    agentId: Parameters<RuntimeAgentRegistry["getAgent"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getAgent"]> {
    return this.client.getAgent(agentId);
  }

  listAgents(): ReturnType<RuntimeAgentRegistry["listAgents"]> {
    return this.client.listAgents();
  }

  requestDrain(
    agentId: Parameters<RuntimeAgentRegistry["requestDrain"]>[0],
    at?: Parameters<RuntimeAgentRegistry["requestDrain"]>[1],
  ): ReturnType<RuntimeAgentRegistry["requestDrain"]> {
    return this.client.requestDrain(agentId, at);
  }

  revoke(
    agentId: Parameters<RuntimeAgentRegistry["revoke"]>[0],
    at?: Parameters<RuntimeAgentRegistry["revoke"]>[1],
  ): ReturnType<RuntimeAgentRegistry["revoke"]> {
    if ("revokeAgent" in this.client) {
      return this.client.revokeAgent(agentId, at);
    }
    return this.client.revoke(agentId, at);
  }

  enqueueWork(
    input: Parameters<RuntimeAgentRegistry["enqueueWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["enqueueWork"]> {
    return this.client.enqueueWork(input);
  }

  leaseWork(
    input: Parameters<RuntimeAgentRegistry["leaseWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["leaseWork"]> {
    return this.client.leaseWork(input);
  }

  completeWork(
    input: Parameters<RuntimeAgentRegistry["completeWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["completeWork"]> {
    return this.client.completeWork(input);
  }

  failWork(
    input: Parameters<RuntimeAgentRegistry["failWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["failWork"]> {
    return this.client.failWork(input);
  }

  getWork(
    workId: Parameters<RuntimeAgentRegistry["getWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getWork"]> {
    return this.client.getWork(workId);
  }

  listWork(): ReturnType<RuntimeAgentRegistry["listWork"]> {
    return this.client.listWork();
  }

  reportProgress(
    input: Parameters<RuntimeAgentRegistry["reportProgress"]>[0],
  ): ReturnType<RuntimeAgentRegistry["reportProgress"]> {
    if ("reportProgress" in this.client) {
      return this.client.reportProgress(input);
    }
    return Promise.reject(
      new Error(
        "AwsRuntimeAgentClient does not implement reportProgress; wire a registry-shaped client",
      ),
    );
  }

  detectStaleAgents(
    input: Parameters<RuntimeAgentRegistry["detectStaleAgents"]>[0],
  ): ReturnType<RuntimeAgentRegistry["detectStaleAgents"]> {
    if ("detectStaleAgents" in this.client) {
      return this.client.detectStaleAgents(input);
    }
    return Promise.reject(
      new Error(
        "AwsRuntimeAgentClient does not implement detectStaleAgents; wire a registry-shaped client",
      ),
    );
  }

  enqueueLongRunningOperation(
    input: Parameters<RuntimeAgentRegistry["enqueueLongRunningOperation"]>[0],
  ): ReturnType<RuntimeAgentRegistry["enqueueLongRunningOperation"]> {
    if ("enqueueLongRunningOperation" in this.client) {
      return this.client.enqueueLongRunningOperation(input);
    }
    return this.client.enqueueWork({
      kind: `provider.${input.provider}.${input.descriptor}`,
      provider: input.provider,
      priority: input.priority,
      queuedAt: input.enqueuedAt,
      idempotencyKey: input.idempotencyKey,
      payload: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
        ...input.payload,
      },
      metadata: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      },
    });
  }
}

function inputToReceiveMessage(
  input: queue.LeaseInput,
): {
  readonly queueName: string;
  readonly visibilityTimeoutMs?: number;
  readonly now?: string;
} {
  return {
    queueName: input.queue,
    visibilityTimeoutMs: input.visibilityTimeoutMs,
    now: input.now,
  };
}
