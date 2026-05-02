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

export interface AwsStorageClient {
  readonly statements: storage.StorageStatementCatalog;
  runTransaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface AwsObjectStorageClient {
  putObject(
    input: AwsObjectStoragePutRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead>;
  getObject(
    input: AwsObjectStorageGetRequest,
  ): Promise<objectStorage.ObjectStorageObject | undefined>;
  headObject(
    input: AwsObjectStorageHeadRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined>;
  listObjects(
    input: AwsObjectStorageListRequest,
  ): Promise<objectStorage.ObjectStorageListResult>;
  deleteObject(input: AwsObjectStorageDeleteRequest): Promise<boolean>;
}

export interface AwsObjectStoragePutRequest {
  readonly bucketName: string;
  readonly objectKey: string;
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface AwsObjectStorageGetRequest {
  readonly bucketName: string;
  readonly objectKey: string;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface AwsObjectStorageHeadRequest {
  readonly bucketName: string;
  readonly objectKey: string;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface AwsObjectStorageListRequest {
  readonly bucketName: string;
  readonly prefix?: string;
  readonly continuationToken?: string;
  readonly maxKeys?: number;
}

export interface AwsObjectStorageDeleteRequest {
  readonly bucketName: string;
  readonly objectKey: string;
}

export interface AwsQueueClient {
  sendMessage(
    input: AwsQueueSendMessageRequest,
  ): Promise<queue.QueueMessage<unknown>>;
  receiveMessage(
    input: AwsQueueReceiveMessageRequest,
  ): Promise<queue.QueueLease<unknown> | undefined>;
  deleteMessage(input: AwsQueueDeleteMessageRequest): Promise<void>;
  releaseMessage(
    input: AwsQueueReleaseMessageRequest,
  ): Promise<queue.QueueMessage<unknown>>;
  deadLetterMessage(
    input: AwsQueueDeadLetterMessageRequest,
  ): Promise<queue.QueueMessage<unknown>>;
}

export interface AwsQueueSendMessageRequest<TPayload = unknown> {
  readonly queueName: string;
  readonly body: TPayload;
  readonly messageId?: string;
  readonly priority?: number;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AwsQueueReceiveMessageRequest {
  readonly queueName: string;
  readonly visibilityTimeoutMs?: number;
  readonly now?: string;
}

export interface AwsQueueDeleteMessageRequest {
  readonly queueName: string;
  readonly messageId: string;
  readonly receiptHandle: string;
}

export interface AwsQueueReleaseMessageRequest {
  readonly queueName: string;
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly retry?: boolean;
  readonly delayMs?: number;
  readonly reason?: string;
  readonly now?: string;
}

export interface AwsQueueDeadLetterMessageRequest {
  readonly queueName: string;
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly reason?: string;
  readonly now?: string;
}

export interface AwsKmsClient {
  describeActiveKey(): Promise<kms.KmsKeyRefDto>;
  encryptEnvelope(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto>;
  decryptEnvelope(input: kms.KmsDecryptInput): Promise<Uint8Array>;
  rotateEnvelope(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto>;
}

export interface AwsSecretsClient {
  putSecretValue(input: {
    readonly secretName: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord>;
  getSecretValue(input: {
    readonly secretName: string;
    readonly versionId: string;
  }): Promise<string | undefined>;
  getLatestSecret(
    secretName: string,
  ): Promise<secretStore.SecretRecord | undefined>;
  listSecretVersions(): Promise<readonly secretStore.SecretRecord[]>;
  deleteSecretVersion(input: {
    readonly secretName: string;
    readonly versionId: string;
  }): Promise<boolean>;
}

export interface AwsProviderClient {
  materializeDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan>;
  listOperations(): Promise<readonly provider.ProviderOperation[]>;
  clearOperations(): Promise<void>;
}

export interface AwsRouterClient {
  applyRoutes(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult>;
}

export interface AwsObservabilityClient {
  appendAuditEvent(
    event: Parameters<ObservabilitySink["appendAudit"]>[0],
  ): ReturnType<ObservabilitySink["appendAudit"]>;
  listAuditEvents(): ReturnType<ObservabilitySink["listAudit"]>;
  verifyAuditEvents(): ReturnType<ObservabilitySink["verifyAuditChain"]>;
  putMetric(
    event: Parameters<ObservabilitySink["recordMetric"]>[0],
  ): ReturnType<ObservabilitySink["recordMetric"]>;
  listMetricEvents(
    query?: Parameters<ObservabilitySink["listMetrics"]>[0],
  ): ReturnType<ObservabilitySink["listMetrics"]>;
}

export interface AwsRuntimeAgentClient {
  registerAgent(
    input: Parameters<RuntimeAgentRegistry["register"]>[0],
  ): ReturnType<RuntimeAgentRegistry["register"]>;
  heartbeatAgent(
    input: Parameters<RuntimeAgentRegistry["heartbeat"]>[0],
  ): ReturnType<RuntimeAgentRegistry["heartbeat"]>;
  getAgent(
    agentId: Parameters<RuntimeAgentRegistry["getAgent"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getAgent"]>;
  listAgents(): ReturnType<RuntimeAgentRegistry["listAgents"]>;
  requestDrain(
    agentId: Parameters<RuntimeAgentRegistry["requestDrain"]>[0],
    at?: Parameters<RuntimeAgentRegistry["requestDrain"]>[1],
  ): ReturnType<RuntimeAgentRegistry["requestDrain"]>;
  revokeAgent(
    agentId: Parameters<RuntimeAgentRegistry["revoke"]>[0],
    at?: Parameters<RuntimeAgentRegistry["revoke"]>[1],
  ): ReturnType<RuntimeAgentRegistry["revoke"]>;
  enqueueWork(
    input: Parameters<RuntimeAgentRegistry["enqueueWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["enqueueWork"]>;
  leaseWork(
    input: Parameters<RuntimeAgentRegistry["leaseWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["leaseWork"]>;
  completeWork(
    input: Parameters<RuntimeAgentRegistry["completeWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["completeWork"]>;
  failWork(
    input: Parameters<RuntimeAgentRegistry["failWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["failWork"]>;
  getWork(
    workId: Parameters<RuntimeAgentRegistry["getWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getWork"]>;
  listWork(): ReturnType<RuntimeAgentRegistry["listWork"]>;
}
