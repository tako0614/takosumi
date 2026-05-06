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

export interface GcpStorageClient {
  readonly statements: storage.StorageStatementCatalog;
  runTransaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface GcpObjectStorageClient {
  uploadObject(
    input: GcpObjectStorageUploadRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead>;
  downloadObject(
    input: GcpObjectStorageDownloadRequest,
  ): Promise<objectStorage.ObjectStorageObject | undefined>;
  statObject(
    input: GcpObjectStorageStatRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined>;
  listObjects(
    input: GcpObjectStorageListRequest,
  ): Promise<objectStorage.ObjectStorageListResult>;
  deleteObject(input: GcpObjectStorageDeleteRequest): Promise<boolean>;
}

export interface GcpObjectStorageUploadRequest {
  readonly bucket: string;
  readonly objectName: string;
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface GcpObjectStorageDownloadRequest {
  readonly bucket: string;
  readonly objectName: string;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface GcpObjectStorageStatRequest {
  readonly bucket: string;
  readonly objectName: string;
  readonly expectedSha256?: objectStorage.ObjectStorageDigest;
}

export interface GcpObjectStorageListRequest {
  readonly bucket: string;
  readonly prefix?: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface GcpObjectStorageDeleteRequest {
  readonly bucket: string;
  readonly objectName: string;
}

export interface GcpQueueClient {
  publishMessage(
    input: GcpQueuePublishMessageRequest,
  ): Promise<queue.QueueMessage<unknown>>;
  pullMessage(
    input: GcpQueuePullMessageRequest,
  ): Promise<queue.QueueLease<unknown> | undefined>;
  acknowledgeMessage(input: GcpQueueAcknowledgeMessageRequest): Promise<void>;
  modifyAckDeadline(
    input: GcpQueueModifyAckDeadlineRequest,
  ): Promise<queue.QueueMessage<unknown>>;
  deadLetterMessage(
    input: GcpQueueDeadLetterMessageRequest,
  ): Promise<queue.QueueMessage<unknown>>;
}

export interface GcpQueuePublishMessageRequest<TPayload = unknown> {
  readonly topicName: string;
  readonly data: TPayload;
  readonly messageId?: string;
  readonly priority?: number;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
  readonly attributes?: Record<string, unknown>;
}

export interface GcpQueuePullMessageRequest {
  readonly subscriptionName: string;
  readonly ackDeadlineMs?: number;
  readonly now?: string;
}

export interface GcpQueueAcknowledgeMessageRequest {
  readonly subscriptionName: string;
  readonly messageId: string;
  readonly ackId: string;
}

export interface GcpQueueModifyAckDeadlineRequest {
  readonly subscriptionName: string;
  readonly messageId: string;
  readonly ackId: string;
  readonly retry?: boolean;
  readonly delayMs?: number;
  readonly reason?: string;
  readonly now?: string;
}

export interface GcpQueueDeadLetterMessageRequest {
  readonly subscriptionName: string;
  readonly messageId: string;
  readonly ackId: string;
  readonly reason?: string;
  readonly now?: string;
}

export interface GcpKmsClient {
  getPrimaryKeyVersion(): Promise<kms.KmsKeyRefDto>;
  encryptEnvelope(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto>;
  decryptEnvelope(input: kms.KmsDecryptInput): Promise<Uint8Array>;
  rotateEnvelope(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto>;
}

export interface GcpSecretsClient {
  addSecretVersion(input: {
    readonly secretId: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord>;
  accessSecretVersion(input: {
    readonly secretId: string;
    readonly version: string;
  }): Promise<string | undefined>;
  latestSecretVersion(
    secretId: string,
  ): Promise<secretStore.SecretRecord | undefined>;
  listSecretVersions(): Promise<readonly secretStore.SecretRecord[]>;
  destroySecretVersion(input: {
    readonly secretId: string;
    readonly version: string;
  }): Promise<boolean>;
}

export interface GcpProviderClient {
  reconcileDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan>;
  listOperations(): Promise<readonly provider.ProviderOperation[]>;
  clearOperations(): Promise<void>;
}

export interface GcpRouterClient {
  applyRoutes(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult>;
}

export interface GcpObservabilityClient {
  writeAuditLog(
    event: Parameters<ObservabilitySink["appendAudit"]>[0],
  ): ReturnType<ObservabilitySink["appendAudit"]>;
  listAuditLogs(): ReturnType<ObservabilitySink["listAudit"]>;
  verifyAuditLogs(): ReturnType<ObservabilitySink["verifyAuditChain"]>;
  writeMetric(
    event: Parameters<ObservabilitySink["recordMetric"]>[0],
  ): ReturnType<ObservabilitySink["recordMetric"]>;
  listMetricEvents(
    query?: Parameters<ObservabilitySink["listMetrics"]>[0],
  ): ReturnType<ObservabilitySink["listMetrics"]>;
  writeTrace?(
    event: Parameters<ObservabilitySink["recordTrace"]>[0],
  ): ReturnType<ObservabilitySink["recordTrace"]>;
  listTraceEvents?(
    query?: Parameters<ObservabilitySink["listTraces"]>[0],
  ): ReturnType<ObservabilitySink["listTraces"]>;
}

export interface GcpRuntimeAgentClient {
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
