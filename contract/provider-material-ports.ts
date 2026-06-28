/**
 * Provider material ports — the type-only port surface that
 * {@link ./provider-adapter.ts | provider-adapter.ts} pins onto a
 * `PlatformContext`.
 *
 * Extracted from the now-removed `implementation-sdk.ts` reference SDK. That
 * module also carried in-memory reference *implementations* of these ports, but
 * those classes were an independent parallel-universe copy of the live
 * `core/` runtime and prone to silent drift. Only the port *contracts*
 * below are consumed by the contract layer, so only the contracts live here.
 */
import type { ActorContext, JsonObject } from "./types.ts";

export namespace kms {
  export type KmsKeyProvider = "local-webcrypto" | "test-noop" | string;

  export interface KmsKeyRefDto {
    readonly provider: KmsKeyProvider;
    readonly keyId: string;
    readonly keyVersion: string;
  }

  export interface KmsRotationMetadataDto {
    readonly rotationId?: string;
    readonly rotatedFrom?: KmsKeyRefDto;
    readonly rotatedAt?: string;
    readonly nextRotationAt?: string;
    readonly reason?: string;
  }

  export interface KmsEnvelopeDto {
    readonly version: "takosumi.kms.envelope.v1";
    readonly algorithm: "AES-256-GCM" | "PROVIDER-KMS" | "TEST-NOOP";
    readonly keyRef: KmsKeyRefDto;
    readonly iv: string;
    readonly ciphertext: string;
    readonly createdAt: string;
    readonly rotation?: KmsRotationMetadataDto;
  }

  export interface KmsEncryptInput {
    readonly plaintext: Uint8Array | string;
    readonly keyRef?: KmsKeyRefDto;
    readonly rotation?: KmsRotationMetadataDto;
  }

  export interface KmsDecryptInput {
    readonly envelope: KmsEnvelopeDto;
  }

  export interface KmsRotateInput {
    readonly envelope: KmsEnvelopeDto;
    readonly targetKeyRef?: KmsKeyRefDto;
    readonly reason?: string;
  }

  export interface KmsPort {
    activeKeyRef(): Promise<KmsKeyRefDto>;
    encrypt(input: KmsEncryptInput): Promise<KmsEnvelopeDto>;
    decrypt(input: KmsDecryptInput): Promise<Uint8Array>;
    rotate(input: KmsRotateInput): Promise<KmsEnvelopeDto>;
  }
}

export namespace objectStorage {
  export type ObjectStorageDigest = `sha256:${string}`;

  export interface ObjectStorageLocation {
    readonly bucket: string;
    readonly key: string;
  }

  export interface ObjectStoragePutInput extends ObjectStorageLocation {
    readonly body: Uint8Array | string;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
    readonly expectedDigest?: ObjectStorageDigest;
  }

  export interface ObjectStorageGetInput extends ObjectStorageLocation {
    readonly expectedDigest?: ObjectStorageDigest;
  }

  export interface ObjectStorageHeadInput extends ObjectStorageLocation {
    readonly expectedDigest?: ObjectStorageDigest;
  }

  export interface ObjectStorageListInput {
    readonly bucket: string;
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }

  export interface ObjectStorageDeleteInput extends ObjectStorageLocation {}

  export interface ObjectStorageObjectHead extends ObjectStorageLocation {
    readonly contentLength: number;
    readonly contentType?: string;
    readonly metadata: Record<string, string>;
    readonly digest: ObjectStorageDigest;
    readonly etag: string;
    readonly updatedAt: string;
  }

  export interface ObjectStorageObject extends ObjectStorageObjectHead {
    readonly body: Uint8Array;
  }

  export interface ObjectStorageListResult {
    readonly objects: readonly ObjectStorageObjectHead[];
    readonly nextCursor?: string;
  }

  export interface ObjectStoragePort {
    putObject(input: ObjectStoragePutInput): Promise<ObjectStorageObjectHead>;
    getObject(
      input: ObjectStorageGetInput,
    ): Promise<ObjectStorageObject | undefined>;
    headObject(
      input: ObjectStorageHeadInput,
    ): Promise<ObjectStorageObjectHead | undefined>;
    listObjects(
      input: ObjectStorageListInput,
    ): Promise<ObjectStorageListResult>;
    deleteObject(input: ObjectStorageDeleteInput): Promise<boolean>;
  }
}

export namespace secretStore {
  export interface SecretVersionRef {
    readonly name: string;
    readonly version: string;
  }

  export interface SecretRecord extends SecretVersionRef {
    readonly createdAt: string;
    readonly metadata: Record<string, unknown>;
  }

  export interface SecretStorePort {
    putSecret(input: {
      readonly name: string;
      readonly value: string;
      readonly metadata?: Record<string, unknown>;
    }): Promise<SecretRecord>;
    getSecret(ref: SecretVersionRef): Promise<string | undefined>;
    getSecretRecord(ref: SecretVersionRef): Promise<SecretRecord | undefined>;
    latestSecret(name: string): Promise<SecretRecord | undefined>;
    listSecrets(): Promise<readonly SecretRecord[]>;
    deleteSecret(ref: SecretVersionRef): Promise<boolean>;
  }
}

export interface AuditEvent {
  readonly id: string;
  readonly eventClass?: "security" | "compliance" | "irreversible-action";
  readonly type: string;
  readonly severity?: "info" | "warning" | "critical";
  readonly action?: string;
  readonly actor?: ActorContext;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly targetType?: string;
  readonly target?: string;
  readonly targetId?: string;
  readonly payload?: JsonObject;
  readonly occurredAt: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface ChainedAuditEvent {
  readonly sequence: number;
  readonly event: AuditEvent;
  readonly previousHash?: string;
  readonly hash: string;
}

export type MetricEventId = string;
export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricEvent {
  readonly id: MetricEventId;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Record<string, string>;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly actor?: ActorContext;
  readonly payload?: JsonObject;
  readonly observedAt: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface MetricEventQuery {
  readonly name?: string;
  readonly kind?: MetricKind;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly since?: string;
  readonly until?: string;
}

export type TraceSpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";
export type TraceSpanStatus = "unset" | "ok" | "error";

export interface TraceSpanEvent {
  readonly id: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: TraceSpanKind;
  readonly status: TraceSpanStatus;
  readonly statusMessage?: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly attributes?: Record<string, string | number | boolean>;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface TraceSpanQuery {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly name?: string;
  readonly kind?: TraceSpanKind;
  readonly status?: TraceSpanStatus;
  readonly workspaceId?: string;
  readonly groupId?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface ObservabilitySink {
  appendAudit(event: AuditEvent): Promise<ChainedAuditEvent>;
  listAudit(): Promise<readonly ChainedAuditEvent[]>;
  verifyAuditChain(): Promise<boolean>;
  recordMetric(event: MetricEvent): Promise<MetricEvent>;
  listMetrics(query?: MetricEventQuery): Promise<readonly MetricEvent[]>;
  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent>;
  listTraces(query?: TraceSpanQuery): Promise<readonly TraceSpanEvent[]>;
}
