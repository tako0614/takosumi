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
  GcpKmsClient,
  GcpObjectStorageClient,
  GcpObservabilityClient,
  GcpProviderClient,
  GcpQueueClient,
  GcpRouterClient,
  GcpRuntimeAgentClient,
  GcpSecretsClient,
  GcpStorageClient,
} from "./clients.ts";

type GcpStorageClientLike = GcpStorageClient | storage.StorageDriver;
type GcpKmsClientLike = GcpKmsClient | kms.KmsPort;
type GcpQueueClientLike = GcpQueueClient | queue.QueuePort;
type GcpSecretsClientLike = GcpSecretsClient | secretStore.SecretStorePort;
type GcpProviderClientLike = GcpProviderClient | provider.ProviderMaterializer;
type GcpRouterClientLike = GcpRouterClient | router.RouterConfigPort;
type GcpObservabilityClientLike = GcpObservabilityClient | ObservabilitySink;
type GcpRuntimeAgentClientLike = GcpRuntimeAgentClient | RuntimeAgentRegistry;

export class GcpStorageAdapter implements storage.StorageDriver {
  constructor(readonly client: GcpStorageClientLike) {}

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

export class GcpObjectStorageAdapter
  implements objectStorage.ObjectStoragePort {
  constructor(readonly client: GcpObjectStorageClient) {}

  putObject(
    input: objectStorage.ObjectStoragePutInput,
  ): Promise<objectStorage.ObjectStorageObjectHead> {
    return this.client.uploadObject({
      bucket: input.bucket,
      objectName: input.key,
      body: input.body,
      contentType: input.contentType,
      metadata: input.metadata,
      expectedSha256: input.expectedDigest,
    });
  }

  getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<objectStorage.ObjectStorageObject | undefined> {
    return this.client.downloadObject({
      bucket: input.bucket,
      objectName: input.key,
      expectedSha256: input.expectedDigest,
    });
  }

  headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined> {
    return this.client.statObject({
      bucket: input.bucket,
      objectName: input.key,
      expectedSha256: input.expectedDigest,
    });
  }

  listObjects(
    input: objectStorage.ObjectStorageListInput,
  ): Promise<objectStorage.ObjectStorageListResult> {
    return this.client.listObjects({
      bucket: input.bucket,
      prefix: input.prefix,
      pageToken: input.cursor,
      pageSize: input.limit,
    });
  }

  deleteObject(
    input: objectStorage.ObjectStorageDeleteInput,
  ): Promise<boolean> {
    return this.client.deleteObject({
      bucket: input.bucket,
      objectName: input.key,
    });
  }
}

export class GcpQueueAdapter implements queue.QueuePort {
  constructor(readonly client: GcpQueueClientLike) {}

  enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    if ("publishMessage" in this.client) {
      return this.client.publishMessage({
        topicName: input.queue,
        data: input.payload,
        messageId: input.messageId,
        priority: input.priority,
        availableAt: input.availableAt,
        maxAttempts: input.maxAttempts,
        attributes: input.metadata,
      }) as Promise<queue.QueueMessage<TPayload>>;
    }
    return this.client.enqueue(input);
  }

  lease<TPayload = unknown>(
    input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined> {
    if ("pullMessage" in this.client) {
      return this.client.pullMessage({
        subscriptionName: input.queue,
        ackDeadlineMs: input.visibilityTimeoutMs,
        now: input.now,
      }) as Promise<queue.QueueLease<TPayload> | undefined>;
    }
    return this.client.lease(input);
  }

  ack(input: queue.AckInput): Promise<void> {
    if ("acknowledgeMessage" in this.client) {
      return this.client.acknowledgeMessage({
        subscriptionName: input.queue,
        messageId: input.messageId,
        ackId: input.leaseToken,
      });
    }
    return this.client.ack(input);
  }

  nack<TPayload = unknown>(
    input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    if ("modifyAckDeadline" in this.client) {
      return this.client.modifyAckDeadline({
        subscriptionName: input.queue,
        messageId: input.messageId,
        ackId: input.leaseToken,
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
        subscriptionName: input.queue,
        messageId: input.messageId,
        ackId: input.leaseToken,
        reason: input.reason,
        now: input.now,
      }) as Promise<queue.QueueMessage<TPayload>>;
    }
    return this.client.deadLetter(input);
  }
}

export class GcpKmsAdapter implements kms.KmsPort {
  constructor(readonly client: GcpKmsClientLike) {}

  activeKeyRef(): Promise<kms.KmsKeyRefDto> {
    if ("getPrimaryKeyVersion" in this.client) {
      return this.client.getPrimaryKeyVersion();
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

export class GcpSecretsAdapter implements secretStore.SecretStorePort {
  constructor(readonly client: GcpSecretsClientLike) {}

  putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord> {
    if ("addSecretVersion" in this.client) {
      return this.client.addSecretVersion({
        secretId: input.name,
        value: input.value,
        metadata: input.metadata,
      });
    }
    return this.client.putSecret(input);
  }

  getSecret(
    ref: secretStore.SecretVersionRef,
  ): Promise<string | undefined> {
    if ("accessSecretVersion" in this.client) {
      return this.client.accessSecretVersion({
        secretId: ref.name,
        version: ref.version,
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
    if ("latestSecretVersion" in this.client) {
      return this.client.latestSecretVersion(name);
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
    if ("destroySecretVersion" in this.client) {
      return this.client.destroySecretVersion({
        secretId: ref.name,
        version: ref.version,
      });
    }
    return this.client.deleteSecret(ref);
  }
}

export class GcpProviderAdapter implements provider.ProviderMaterializer {
  constructor(readonly client: GcpProviderClientLike) {}

  materialize(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan> {
    if ("reconcileDesiredState" in this.client) {
      return this.client.reconcileDesiredState(desiredState);
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

export class GcpRouterAdapter implements router.RouterConfigPort {
  constructor(readonly client: GcpRouterClientLike) {}

  apply(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult> {
    if ("applyRoutes" in this.client) {
      return this.client.applyRoutes(projection);
    }
    return this.client.apply(projection);
  }
}

export class GcpObservabilityAdapter implements ObservabilitySink {
  constructor(readonly client: GcpObservabilityClientLike) {}

  appendAudit(
    event: Parameters<ObservabilitySink["appendAudit"]>[0],
  ): ReturnType<ObservabilitySink["appendAudit"]> {
    if ("writeAuditLog" in this.client) {
      return this.client.writeAuditLog(event);
    }
    return this.client.appendAudit(event);
  }

  listAudit(): ReturnType<ObservabilitySink["listAudit"]> {
    if ("listAuditLogs" in this.client) {
      return this.client.listAuditLogs();
    }
    return this.client.listAudit();
  }

  verifyAuditChain(): ReturnType<ObservabilitySink["verifyAuditChain"]> {
    if ("verifyAuditLogs" in this.client) {
      return this.client.verifyAuditLogs();
    }
    return this.client.verifyAuditChain();
  }

  recordMetric(
    event: Parameters<ObservabilitySink["recordMetric"]>[0],
  ): ReturnType<ObservabilitySink["recordMetric"]> {
    if ("writeMetric" in this.client) {
      return this.client.writeMetric(event);
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
}

export class GcpRuntimeAgentAdapter implements RuntimeAgentRegistry {
  constructor(readonly client: GcpRuntimeAgentClientLike) {}

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
        "GcpRuntimeAgentClient does not implement reportProgress; wire a registry-shaped client",
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
        "GcpRuntimeAgentClient does not implement detectStaleAgents; wire a registry-shaped client",
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
