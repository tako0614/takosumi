// deno-lint-ignore-file no-namespace no-slow-types
import type { ActorContext, Digest, JsonObject } from "./types.ts";
import type { ObjectAddress } from "./core-v1.ts";
import type { TakosumiActorContext } from "./internal-api.ts";
import type {
  KernelPluginClientRegistry,
  KernelPluginInitContext,
  KernelPluginIoBoundary,
  KernelPluginPortKind,
} from "./plugin.ts";
import {
  TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
  type TakosumiKernelPluginManifest,
} from "./plugin.ts";
import {
  RUNTIME_AGENT_RPC_PATHS,
  type SignedGatewayManifest,
  signGatewayManifest,
  signGatewayResponse,
  TAKOSUMI_GATEWAY_IDENTITY_NONCE_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
} from "./runtime-agent.ts";

export type PublicDeployManifest = JsonObject;

export type TakosumiProcessRole =
  | "takosumi-api"
  | "takosumi-worker"
  | "takosumi-router"
  | "takosumi-log-worker"
  | "takosumi-runtime-agent";

export function isTakosumiProcessRole(
  value: string,
): value is TakosumiProcessRole {
  return value === "takosumi-api" ||
    value === "takosumi-worker" ||
    value === "takosumi-router" ||
    value === "takosumi-log-worker" ||
    value === "takosumi-runtime-agent";
}

export function processRoleFromEnv(
  env: Record<string, string | undefined> = {},
): TakosumiProcessRole {
  const value = env.TAKOSUMI_PROCESS_ROLE ?? "takosumi-api";
  return isTakosumiProcessRole(value) ? value : "takosumi-api";
}

export const TAKOSUMI_RUNTIME_AGENT_PATHS = RUNTIME_AGENT_RPC_PATHS;

export namespace auth {
  export type AuthResult =
    | { readonly ok: true; readonly actor: TakosumiActorContext }
    | {
      readonly ok: false;
      readonly error: string;
      readonly status: 401 | 403;
    };

  export interface AuthPort {
    authenticate(request: Request): Promise<AuthResult>;
  }

  export interface ActorAdapter {
    actorForRequest(request: Request): Promise<TakosumiActorContext>;
  }

  export class LocalActorAdapter implements AuthPort, ActorAdapter {
    async authenticate(request: Request): Promise<AuthResult> {
      return { ok: true, actor: await this.actorForRequest(request) };
    }

    actorForRequest(request: Request): Promise<TakosumiActorContext> {
      return Promise.resolve({
        actorAccountId: request.headers.get("x-takosumi-actor-account-id") ??
          "local",
        spaceId: request.headers.get("x-takosumi-space-id") ?? undefined,
        requestId: request.headers.get("x-takosumi-request-id") ?? "local",
        roles: ["local"],
        principalKind: "account",
      });
    }
  }
}

export namespace coordination {
  export interface CoordinationLease {
    readonly scope: string;
    readonly holderId: string;
    readonly token: string;
    readonly acquired: boolean;
    readonly expiresAt: string;
    readonly metadata?: JsonObject;
  }

  export interface CoordinationLeaseInput {
    readonly scope: string;
    readonly holderId: string;
    readonly ttlMs: number;
    readonly metadata?: JsonObject;
  }

  export interface CoordinationRenewInput {
    readonly scope: string;
    readonly holderId: string;
    readonly token: string;
    readonly ttlMs: number;
  }

  export interface CoordinationReleaseInput {
    readonly scope: string;
    readonly holderId: string;
    readonly token: string;
  }

  export interface CoordinationAlarm {
    readonly id: string;
    readonly scope: string;
    readonly fireAt: string;
    readonly payload?: JsonObject;
  }

  export interface CoordinationAlarmInput {
    readonly id: string;
    readonly scope: string;
    readonly fireAt: string;
    readonly payload?: JsonObject;
  }

  export interface CoordinationPort {
    acquireLease(input: CoordinationLeaseInput): Promise<CoordinationLease>;
    renewLease(input: CoordinationRenewInput): Promise<CoordinationLease>;
    releaseLease(input: CoordinationReleaseInput): Promise<boolean>;
    getLease(scope: string): Promise<CoordinationLease | undefined>;
    scheduleAlarm(input: CoordinationAlarmInput): Promise<CoordinationAlarm>;
    cancelAlarm(id: string): Promise<boolean>;
    listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]>;
  }

  export class MemoryCoordinationAdapter implements CoordinationPort {
    readonly #leases = new Map<string, CoordinationLease>();
    readonly #alarms = new Map<string, CoordinationAlarm>();
    readonly #clock: () => Date;
    readonly #idGenerator: () => string;

    constructor(options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    }

    acquireLease(input: CoordinationLeaseInput): Promise<CoordinationLease> {
      const existing = this.#leases.get(input.scope);
      const now = this.#clock().toISOString();
      if (existing && existing.expiresAt > now) {
        return Promise.resolve({ ...existing, acquired: false });
      }
      const lease: CoordinationLease = {
        scope: input.scope,
        holderId: input.holderId,
        token: `lease_${this.#idGenerator()}`,
        acquired: true,
        expiresAt: new Date(this.#clock().getTime() + input.ttlMs)
          .toISOString(),
        metadata: input.metadata,
      };
      this.#leases.set(input.scope, lease);
      return Promise.resolve(lease);
    }

    renewLease(input: CoordinationRenewInput): Promise<CoordinationLease> {
      const current = this.#leases.get(input.scope);
      if (
        !current || current.holderId !== input.holderId ||
        current.token !== input.token
      ) {
        throw new Error(`coordination lease not held: ${input.scope}`);
      }
      const renewed = {
        ...current,
        acquired: true,
        expiresAt: new Date(this.#clock().getTime() + input.ttlMs)
          .toISOString(),
      };
      this.#leases.set(input.scope, renewed);
      return Promise.resolve(renewed);
    }

    releaseLease(input: CoordinationReleaseInput): Promise<boolean> {
      const current = this.#leases.get(input.scope);
      if (
        !current || current.holderId !== input.holderId ||
        current.token !== input.token
      ) {
        return Promise.resolve(false);
      }
      return Promise.resolve(this.#leases.delete(input.scope));
    }

    getLease(scope: string): Promise<CoordinationLease | undefined> {
      return Promise.resolve(clone(this.#leases.get(scope)));
    }

    scheduleAlarm(input: CoordinationAlarmInput): Promise<CoordinationAlarm> {
      const alarm = { ...input };
      this.#alarms.set(input.id, alarm);
      return Promise.resolve(clone(alarm));
    }

    cancelAlarm(id: string): Promise<boolean> {
      return Promise.resolve(this.#alarms.delete(id));
    }

    listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]> {
      return Promise.resolve(
        [...this.#alarms.values()].filter((alarm) =>
          scope === undefined || alarm.scope === scope
        ).map(clone),
      );
    }
  }
}

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

  export class NoopTestKms implements KmsPort {
    readonly #clock: () => Date;
    readonly #keyRef: KmsKeyRefDto;

    constructor(options: {
      readonly clock?: () => Date;
      readonly keyRef?: KmsKeyRefDto;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#keyRef = options.keyRef ?? {
        provider: "test-noop",
        keyId: "test",
        keyVersion: "1",
      };
    }

    activeKeyRef(): Promise<KmsKeyRefDto> {
      return Promise.resolve(this.#keyRef);
    }

    encrypt(input: KmsEncryptInput): Promise<KmsEnvelopeDto> {
      return Promise.resolve({
        version: "takosumi.kms.envelope.v1",
        algorithm: "TEST-NOOP",
        keyRef: input.keyRef ?? this.#keyRef,
        iv: "",
        ciphertext: bytesToBase64(toBytes(input.plaintext)),
        createdAt: this.#clock().toISOString(),
        rotation: input.rotation,
      });
    }

    decrypt(input: KmsDecryptInput): Promise<Uint8Array> {
      return Promise.resolve(base64ToBytes(input.envelope.ciphertext));
    }

    async rotate(input: KmsRotateInput): Promise<KmsEnvelopeDto> {
      const plaintext = await this.decrypt({ envelope: input.envelope });
      return await this.encrypt({
        plaintext,
        keyRef: input.targetKeyRef ?? this.#keyRef,
        rotation: {
          reason: input.reason,
          rotatedFrom: input.envelope.keyRef,
          rotatedAt: this.#clock().toISOString(),
        },
      });
    }
  }
}

export namespace notification {
  export type NotificationSeverity = "info" | "warning" | "error";

  export interface NotificationInput {
    readonly type: string;
    readonly subject?: string;
    readonly body?: string;
    readonly severity?: NotificationSeverity;
    readonly metadata?: Record<string, unknown>;
  }

  export interface NotificationRecord extends NotificationInput {
    readonly id: string;
    readonly severity: NotificationSeverity;
    readonly createdAt: string;
    readonly metadata: Record<string, unknown>;
  }

  export interface NotificationPort {
    publish(input: NotificationInput): Promise<NotificationRecord>;
  }

  export class MemoryNotificationSink implements NotificationPort {
    readonly #records: NotificationRecord[] = [];
    readonly #clock: () => Date;
    readonly #idGenerator: () => string;

    constructor(options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    }

    publish(input: NotificationInput): Promise<NotificationRecord> {
      const record = {
        ...input,
        id: `notification_${this.#idGenerator()}`,
        severity: input.severity ?? "info",
        metadata: input.metadata ?? {},
        createdAt: this.#clock().toISOString(),
      };
      this.#records.push(record);
      return Promise.resolve(clone(record));
    }
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

  export class ObjectStorageDigestMismatchError extends Error {
    constructor(
      readonly expectedDigest: ObjectStorageDigest,
      readonly actualDigest: ObjectStorageDigest,
    ) {
      super(
        `object storage digest mismatch: expected ${expectedDigest}, got ${actualDigest}`,
      );
      this.name = "ObjectStorageDigestMismatchError";
    }
  }

  export function objectBodyBytes(body: Uint8Array | string): Uint8Array {
    return toBytes(body);
  }

  export async function verifyObjectDigest(
    body: Uint8Array | string,
    expectedDigest?: ObjectStorageDigest,
  ): Promise<ObjectStorageDigest> {
    const digest = await sha256Digest(toBytes(body));
    if (expectedDigest && expectedDigest !== digest) {
      throw new ObjectStorageDigestMismatchError(expectedDigest, digest);
    }
    return digest;
  }

  export class MemoryObjectStorage implements ObjectStoragePort {
    readonly #objects = new Map<string, ObjectStorageObject>();
    readonly #clock: () => Date;

    constructor(options: { readonly clock?: () => Date } = {}) {
      this.#clock = options.clock ?? (() => new Date());
    }

    async putObject(
      input: ObjectStoragePutInput,
    ): Promise<ObjectStorageObjectHead> {
      const body = toBytes(input.body);
      const digest = await sha256Digest(body);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw new ObjectStorageDigestMismatchError(
          input.expectedDigest,
          digest,
        );
      }
      const object: ObjectStorageObject = {
        bucket: input.bucket,
        key: input.key,
        contentLength: body.byteLength,
        contentType: input.contentType,
        metadata: input.metadata ?? {},
        digest,
        etag: digest.slice("sha256:".length),
        updatedAt: this.#clock().toISOString(),
        body,
      };
      this.#objects.set(key(input), object);
      return head(object);
    }

    getObject(
      input: ObjectStorageGetInput,
    ): Promise<ObjectStorageObject | undefined> {
      try {
        const object = this.#objects.get(key(input));
        if (
          object && input.expectedDigest &&
          object.digest !== input.expectedDigest
        ) {
          throw new ObjectStorageDigestMismatchError(
            input.expectedDigest,
            object.digest,
          );
        }
        return Promise.resolve(clone(object));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    async headObject(
      input: ObjectStorageHeadInput,
    ): Promise<ObjectStorageObjectHead | undefined> {
      const object = await this.getObject(input);
      return object ? head(object) : undefined;
    }

    listObjects(
      input: ObjectStorageListInput,
    ): Promise<ObjectStorageListResult> {
      const objects = [...this.#objects.values()]
        .filter((object) =>
          object.bucket === input.bucket &&
          (input.prefix === undefined || object.key.startsWith(input.prefix))
        )
        .map(head);
      return Promise.resolve({
        objects: input.limit === undefined
          ? objects
          : objects.slice(0, input.limit),
      });
    }

    deleteObject(input: ObjectStorageDeleteInput): Promise<boolean> {
      return Promise.resolve(this.#objects.delete(key(input)));
    }
  }

  function key(input: ObjectStorageLocation): string {
    return `${input.bucket}:${input.key}`;
  }

  function head(object: ObjectStorageObject): ObjectStorageObjectHead {
    const { body: _body, ...rest } = object;
    return clone(rest);
  }
}

export namespace operatorConfig {
  export type OperatorConfigSource = "env" | "local";

  export interface OperatorConfigSecretRef {
    readonly name: string;
    readonly version?: string;
  }

  export type OperatorConfigValue =
    | {
      readonly kind: "plain";
      readonly key: string;
      readonly source: OperatorConfigSource;
      readonly value: string;
    }
    | {
      readonly kind: "secret-ref";
      readonly key: string;
      readonly source: OperatorConfigSource;
      readonly ref: OperatorConfigSecretRef;
      readonly redacted: true;
    };

  export interface OperatorConfigSnapshot {
    readonly generatedAt: string;
    readonly values: readonly OperatorConfigValue[];
  }

  export interface OperatorConfigPort {
    get(key: string): Promise<OperatorConfigValue | undefined>;
    require(key: string): Promise<OperatorConfigValue>;
    snapshot(): Promise<OperatorConfigSnapshot>;
  }

  export type LocalOperatorConfigInputValue = string | OperatorConfigSecretRef;

  export class LocalOperatorConfig implements OperatorConfigPort {
    readonly #values: Record<string, LocalOperatorConfigInputValue>;
    readonly #clock: () => Date;

    constructor(options: {
      readonly values?: Record<string, LocalOperatorConfigInputValue>;
      readonly clock?: () => Date;
    } = {}) {
      this.#values = options.values ?? {};
      this.#clock = options.clock ?? (() => new Date());
    }

    get(key: string): Promise<OperatorConfigValue | undefined> {
      const value = this.#values[key];
      if (value === undefined) return Promise.resolve(undefined);
      if (typeof value === "string") {
        return Promise.resolve({ kind: "plain", key, source: "local", value });
      }
      return Promise.resolve({
        kind: "secret-ref",
        key,
        source: "local",
        ref: value,
        redacted: true,
      });
    }

    async require(key: string): Promise<OperatorConfigValue> {
      const value = await this.get(key);
      if (!value) throw new Error(`operator config is required: ${key}`);
      return value;
    }

    async snapshot(): Promise<OperatorConfigSnapshot> {
      const values = await Promise.all(
        Object.keys(this.#values).map((key) => this.require(key)),
      );
      return { generatedAt: this.#clock().toISOString(), values };
    }
  }
}

export namespace queue {
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
    nack<TPayload = unknown>(
      input: NackInput,
    ): Promise<QueueMessage<TPayload>>;
    deadLetter<TPayload = unknown>(
      input: DeadLetterInput,
    ): Promise<QueueMessage<TPayload>>;
  }

  export class MemoryQueueAdapter implements QueuePort {
    readonly #messages = new Map<string, QueueMessage<unknown>>();
    readonly #clock: () => Date;
    readonly #idGenerator: () => string;

    constructor(options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    }

    enqueue<TPayload = unknown>(
      input: EnqueueInput<TPayload>,
    ): Promise<QueueMessage<TPayload>> {
      const now = this.#clock().toISOString();
      const message: QueueMessage<TPayload> = {
        id: input.messageId ?? `msg_${this.#idGenerator()}`,
        queue: input.queue,
        payload: input.payload,
        status: "queued",
        priority: input.priority ?? 0,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        enqueuedAt: now,
        availableAt: input.availableAt ?? now,
        metadata: input.metadata ?? {},
      };
      this.#messages.set(message.id, message);
      return Promise.resolve(clone(message));
    }

    lease<TPayload = unknown>(
      input: LeaseInput,
    ): Promise<QueueLease<TPayload> | undefined> {
      const now = input.now ?? this.#clock().toISOString();
      const message = [...this.#messages.values()]
        .filter((candidate) =>
          candidate.queue === input.queue && candidate.status === "queued" &&
          candidate.availableAt <= now
        )
        .sort((a, b) =>
          b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt)
        )[0];
      if (!message) return Promise.resolve(undefined);
      const token = `lease_${this.#idGenerator()}`;
      const leasedAt = now;
      const expiresAt = new Date(
        Date.parse(now) + (input.visibilityTimeoutMs ?? 30_000),
      ).toISOString();
      const leased = {
        ...message,
        status: "leased" as const,
        attempts: message.attempts + 1,
        leasedAt,
        leaseExpiresAt: expiresAt,
        leaseToken: token,
      };
      this.#messages.set(leased.id, leased);
      return Promise.resolve({
        token,
        message: clone(leased) as QueueMessage<TPayload>,
        leasedAt,
        expiresAt,
      });
    }

    ack(input: AckInput): Promise<void> {
      const message = this.#messages.get(input.messageId);
      if (message?.leaseToken === input.leaseToken) {
        this.#messages.set(message.id, { ...message, status: "acked" });
      }
      return Promise.resolve();
    }

    nack<TPayload = unknown>(
      input: NackInput,
    ): Promise<QueueMessage<TPayload>> {
      const message = this.#messages.get(input.messageId);
      if (!message) {
        throw new Error(`queue message not found: ${input.messageId}`);
      }
      const next = {
        ...message,
        status: input.retry === false ? "dead" as const : "queued" as const,
        failureReason: input.reason,
        availableAt: new Date(
          Date.parse(input.now ?? this.#clock().toISOString()) +
            (input.delayMs ?? 0),
        ).toISOString(),
      };
      this.#messages.set(message.id, next);
      return Promise.resolve(clone(next) as QueueMessage<TPayload>);
    }

    deadLetter<TPayload = unknown>(
      input: DeadLetterInput,
    ): Promise<QueueMessage<TPayload>> {
      const message = this.#messages.get(input.messageId);
      if (!message) {
        throw new Error(`queue message not found: ${input.messageId}`);
      }
      const next = {
        ...message,
        status: "dead" as const,
        failureReason: input.reason,
        deadLetteredAt: input.now ?? this.#clock().toISOString(),
      };
      this.#messages.set(message.id, next);
      return Promise.resolve(clone(next) as QueueMessage<TPayload>);
    }
  }
}

export namespace source {
  export type SourceSnapshotKind = "manifest" | "git" | "local_upload";

  export interface SourceFileSnapshot {
    readonly path: string;
    readonly contentType?: string;
    readonly bytes: Uint8Array;
    readonly digest: string;
  }

  export interface SourceSnapshot {
    readonly id: string;
    readonly kind: SourceSnapshotKind;
    readonly manifest: PublicDeployManifest;
    readonly files: readonly SourceFileSnapshot[];
    readonly metadata: Record<string, unknown>;
    readonly createdAt: string;
    readonly immutable: true;
  }

  export interface SourcePort<TInput = unknown> {
    snapshot(input: TInput): Promise<SourceSnapshot>;
  }

  export class ImmutableManifestSourceAdapter implements
    SourcePort<{
      readonly sourceId?: string;
      readonly manifest: PublicDeployManifest;
      readonly files?: readonly {
        readonly path: string;
        readonly body?: Uint8Array | string;
        readonly bytes?: Uint8Array | string;
        readonly contentType?: string;
      }[];
    }> {
    readonly #clock: () => Date;
    readonly #idGenerator: () => string;

    constructor(options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    }

    async snapshot(input: {
      readonly sourceId?: string;
      readonly manifest: PublicDeployManifest;
      readonly files?: readonly {
        readonly path: string;
        readonly body?: Uint8Array | string;
        readonly bytes?: Uint8Array | string;
        readonly contentType?: string;
      }[];
    }): Promise<SourceSnapshot> {
      const files = await Promise.all((input.files ?? []).map(async (file) => {
        const bytes = toBytes(file.bytes ?? file.body ?? "");
        return {
          path: file.path,
          contentType: file.contentType,
          bytes,
          digest: await sha256Digest(bytes),
        };
      }));
      return {
        id: input.sourceId ?? `source_${this.#idGenerator()}`,
        kind: "manifest",
        manifest: input.manifest,
        files,
        metadata: {},
        createdAt: this.#clock().toISOString(),
        immutable: true,
      };
    }
  }
}

export namespace provider {
  export type ProviderMaterializationRole =
    | "router"
    | "runtime"
    | "resource"
    | "access";

  export interface ProviderMaterializationReference {
    readonly id: string;
    readonly role: ProviderMaterializationRole;
    readonly desiredObjectRef: string;
    readonly providerTarget: string;
    readonly objectAddress: ObjectAddress;
    readonly createdByOperationId: string;
  }

  export type ProviderOperationKind = string;
  export type ProviderOperationExecutionStatus =
    | "succeeded"
    | "failed"
    | "skipped";

  export interface ProviderOperationExecution {
    readonly status: ProviderOperationExecutionStatus;
    readonly code: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly skipped?: boolean;
    readonly startedAt: string;
    readonly completedAt: string;
  }

  export interface ProviderOperation {
    readonly id: string;
    readonly kind: ProviderOperationKind;
    readonly provider: string;
    readonly desiredStateId: string;
    readonly targetId?: string;
    readonly targetName?: string;
    readonly command: readonly string[];
    readonly details: Record<string, unknown>;
    readonly recordedAt: string;
    readonly execution?: ProviderOperationExecution;
  }

  export interface ProviderMaterializationPlan {
    readonly id: string;
    readonly provider: string;
    readonly desiredStateId: string;
    readonly recordedAt: string;
    readonly role?: ProviderMaterializationRole;
    readonly desiredObjectRef?: string;
    readonly objectAddress?: string;
    readonly createdByOperationId?: string;
    readonly materializations?: readonly ProviderMaterializationReference[];
    readonly operations: readonly ProviderOperation[];
  }

  export interface ProviderMaterializer {
    materialize(
      desiredState: RuntimeDesiredState,
    ): Promise<ProviderMaterializationPlan>;
    listRecordedOperations(): Promise<readonly ProviderOperation[]>;
    clearRecordedOperations(): Promise<void>;
  }
}

export namespace router {
  export type RouteProtocol = "http" | "https" | "tcp" | string;

  export interface RouteProjectionRoute {
    readonly id: string;
    readonly name: string;
    readonly spaceId?: string;
    readonly groupId?: string;
    readonly activationId?: string;
    readonly host?: string;
    readonly path?: string;
    readonly port?: number;
    readonly protocol: RouteProtocol;
    readonly source?: string;
    readonly target: {
      readonly componentName: string;
      readonly runtimeRouteId: string;
      readonly port?: number;
    };
  }

  export interface RouteProjection {
    readonly id: string;
    readonly spaceId: string;
    readonly groupId: string;
    readonly activationId: string;
    readonly desiredStateId?: string;
    readonly projectedAt: string;
    readonly routes: readonly RouteProjectionRoute[];
  }

  export interface RouterConfigRoute {
    readonly id: string;
    readonly name: string;
    readonly host?: string;
    readonly path?: string;
    readonly port?: number;
    readonly protocol: RouteProtocol;
    readonly source?: string;
    readonly target: {
      readonly componentName: string;
      readonly runtimeRouteId: string;
      readonly port?: number;
    };
    readonly activationId: string;
  }

  export interface RouterConfig {
    readonly id: string;
    readonly spaceId: string;
    readonly groupId: string;
    readonly activationId: string;
    readonly desiredStateId?: string;
    readonly projectedAt: string;
    readonly routes: readonly RouterConfigRoute[];
  }

  export interface RouterConfigApplyResult {
    readonly adapter: string;
    readonly config: RouterConfig;
    readonly appliedAt: string;
    readonly path?: string;
    readonly noop?: boolean;
  }

  export interface RouterConfigPort {
    apply(projection: RouteProjection): Promise<RouterConfigApplyResult>;
  }

  export interface RouterConfigRenderer {
    render(projection: RouteProjection): RouterConfig;
  }

  export class InMemoryRouterConfigAdapter implements RouterConfigPort {
    readonly #clock: () => Date;
    readonly applied: RouterConfigApplyResult[] = [];

    constructor(options: { readonly clock?: () => Date } = {}) {
      this.#clock = options.clock ?? (() => new Date());
    }

    apply(projection: RouteProjection): Promise<RouterConfigApplyResult> {
      const config: RouterConfig = {
        ...projection,
        routes: projection.routes.map((route) => ({
          id: route.id,
          name: route.name,
          host: route.host,
          path: route.path,
          port: route.port,
          protocol: route.protocol,
          source: route.source,
          target: route.target,
          activationId: route.activationId ?? projection.activationId,
        })),
      };
      const result = {
        adapter: "memory",
        config,
        appliedAt: this.#clock().toISOString(),
        noop: true,
      };
      this.applied.push(result);
      return Promise.resolve(clone(result));
    }
  }

  export class DefaultRouterConfigRenderer implements RouterConfigRenderer {
    render(projection: RouteProjection): RouterConfig {
      return {
        ...projection,
        routes: projection.routes.map((route) => ({
          id: route.id,
          name: route.name,
          host: route.host,
          path: route.path,
          port: route.port,
          protocol: route.protocol,
          source: route.source,
          target: route.target,
          activationId: route.activationId ?? projection.activationId,
        })),
      };
    }
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

  export class MemoryEncryptedSecretStore implements SecretStorePort {
    readonly #values = new Map<string, string>();
    readonly #records = new Map<string, SecretRecord>();
    readonly #latest = new Map<string, string>();
    readonly #clock: () => Date;
    readonly #idGenerator: () => string;

    constructor(options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {}) {
      this.#clock = options.clock ?? (() => new Date());
      this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    }

    putSecret(input: {
      readonly name: string;
      readonly value: string;
      readonly metadata?: Record<string, unknown>;
    }): Promise<SecretRecord> {
      const version = `v_${this.#idGenerator()}`;
      const record = {
        name: input.name,
        version,
        createdAt: this.#clock().toISOString(),
        metadata: input.metadata ?? {},
      };
      this.#values.set(secretKey(record), input.value);
      this.#records.set(secretKey(record), record);
      this.#latest.set(input.name, version);
      return Promise.resolve(clone(record));
    }

    getSecret(ref: SecretVersionRef): Promise<string | undefined> {
      return Promise.resolve(this.#values.get(secretKey(ref)));
    }

    getSecretRecord(ref: SecretVersionRef): Promise<SecretRecord | undefined> {
      return Promise.resolve(clone(this.#records.get(secretKey(ref))));
    }

    latestSecret(name: string): Promise<SecretRecord | undefined> {
      const version = this.#latest.get(name);
      return version
        ? this.getSecretRecord({ name, version })
        : Promise.resolve(undefined);
    }

    listSecrets(): Promise<readonly SecretRecord[]> {
      return Promise.resolve([...this.#records.values()].map(clone));
    }

    deleteSecret(ref: SecretVersionRef): Promise<boolean> {
      this.#values.delete(secretKey(ref));
      this.#records.delete(secretKey(ref));
      if (this.#latest.get(ref.name) === ref.version) {
        this.#latest.delete(ref.name);
      }
      return Promise.resolve(true);
    }
  }

  function secretKey(ref: SecretVersionRef): string {
    return `${ref.name}:${ref.version}`;
  }
}

export namespace storage {
  export type StorageDomain =
    | "core"
    | "deploy"
    | "runtime"
    | "resources"
    | "registry"
    | "audit"
    | "usage"
    | "service-endpoints";

  export type StorageStatementOperation =
    | "insert"
    | "select"
    | "list"
    | "upsert"
    | "update"
    | "append";

  export interface StorageStatementDescription {
    readonly id: string;
    readonly domain: StorageDomain;
    readonly object: string;
    readonly operation: StorageStatementOperation;
    readonly sql: string;
    readonly parameters: readonly string[];
    readonly returns: string;
    readonly notes?: string;
  }

  export interface StorageStatementCatalog {
    readonly core: readonly StorageStatementDescription[];
    readonly deploy: readonly StorageStatementDescription[];
    readonly runtime: readonly StorageStatementDescription[];
    readonly resources: readonly StorageStatementDescription[];
    readonly registry: readonly StorageStatementDescription[];
    readonly audit: readonly StorageStatementDescription[];
    readonly usage: readonly StorageStatementDescription[];
    readonly serviceEndpoints: readonly StorageStatementDescription[];
    readonly all: readonly StorageStatementDescription[];
  }

  export const storageStatementCatalog: StorageStatementCatalog = {
    core: [],
    deploy: [],
    runtime: [],
    resources: [],
    registry: [],
    audit: [],
    usage: [],
    serviceEndpoints: [],
    all: [],
  };

  export interface StorageDriver {
    readonly statements: StorageStatementCatalog;
    transaction<T>(
      fn: (transaction: StorageTransaction) => T | Promise<T>,
    ): Promise<T>;
  }

  export interface CoreStorageStores {
    readonly spaces: AnyStore;
    readonly groups: AnyStore;
    readonly spaceMemberships: AnyStore;
  }
  export interface DeployStorageStores {
    readonly deploys: AnyStore;
  }
  export interface RuntimeStorageStores {
    readonly desiredStates: AnyStore;
    readonly observedStates: AnyStore;
    readonly providerObservations: AnyStore;
  }
  export interface ResourceStorageStores {
    readonly instances: AnyStore;
    readonly bindings: AnyStore;
    readonly bindingSetRevisions: AnyStore;
    readonly migrationLedger: AnyStore;
  }
  export interface RegistryStorageStores {
    readonly descriptors: AnyStore;
    readonly resolutions: AnyStore;
    readonly trustRecords: AnyStore;
    readonly bundledRegistry: AnyStore;
  }
  export interface AuditStorageStores {
    readonly events: AnyStore;
  }
  export interface UsageStorageStores {
    readonly aggregates: AnyStore;
  }
  export interface ServiceEndpointStorageStores {
    readonly endpoints: AnyStore;
    readonly trustRecords: AnyStore;
    readonly grants: AnyStore;
  }

  export interface StorageTransaction {
    readonly core: CoreStorageStores;
    readonly deploy: DeployStorageStores;
    readonly runtime: RuntimeStorageStores;
    readonly resources: ResourceStorageStores;
    readonly registry: RegistryStorageStores;
    readonly audit: AuditStorageStores;
    readonly usage: UsageStorageStores;
    readonly serviceEndpoints: ServiceEndpointStorageStores;
  }

  // `AnyStore` deliberately uses `any[]` in the method-param position so that
  // concrete store implementations with typed methods (`(space: Space) => …`)
  // are assignable without a bridging cast. Param-position contravariance
  // would otherwise reject typed methods against `readonly unknown[]`.
  // deno-lint-ignore no-explicit-any
  type EmptyStoreMethod = (...args: any[]) => unknown;
  type AnyStore = Record<string, EmptyStoreMethod>;

  export class MemoryStorageDriver implements StorageDriver {
    readonly statements = storageStatementCatalog;

    transaction<T>(
      fn: (transaction: StorageTransaction) => T | Promise<T>,
    ): Promise<T> {
      return Promise.resolve(fn(emptyTransaction()));
    }
  }

  function emptyTransaction(): StorageTransaction {
    const anyStore = new Proxy({}, {
      get: () => () => undefined,
    }) as AnyStore;
    return {
      core: { spaces: anyStore, groups: anyStore, spaceMemberships: anyStore },
      deploy: { deploys: anyStore },
      runtime: {
        desiredStates: anyStore,
        observedStates: anyStore,
        providerObservations: anyStore,
      },
      resources: {
        instances: anyStore,
        bindings: anyStore,
        bindingSetRevisions: anyStore,
        migrationLedger: anyStore,
      },
      registry: {
        descriptors: anyStore,
        resolutions: anyStore,
        trustRecords: anyStore,
        bundledRegistry: anyStore,
      },
      audit: { events: anyStore },
      usage: { aggregates: anyStore },
      serviceEndpoints: {
        endpoints: anyStore,
        trustRecords: anyStore,
        grants: anyStore,
      },
    };
  }
}

export type RuntimeProviderRole = "router" | "runtime" | "resource" | "access";
export type RuntimeDesiredStateId = string;
export type RuntimeObservedStateId = string;

export type RuntimeWorkloadPhase =
  | "pending"
  | "starting"
  | "running"
  | "degraded"
  | "stopped"
  | "unknown";
export type RuntimeResourcePhase =
  | "pending"
  | "provisioning"
  | "ready"
  | "degraded"
  | "deleted"
  | "unknown";

export interface RuntimeWorkloadSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly componentName: string;
  readonly runtimeName: string;
  readonly type: string;
  readonly image?: string;
  readonly entrypoint?: string;
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly depends: readonly string[];
}

export interface RuntimeResourceSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly resourceName: string;
  readonly runtimeName: string;
  readonly type: string;
  readonly env: Record<string, string>;
}

export interface RuntimeRouteBindingSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly routeName: string;
  readonly targetComponentName: string;
  readonly host?: string;
  readonly path?: string;
  readonly protocol?: string;
  readonly port?: number;
  readonly targetPort?: number;
  readonly source?: string;
}

export interface RuntimeDesiredState {
  readonly id: RuntimeDesiredStateId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly appName: string;
  readonly appVersion?: string;
  readonly materializedAt: string;
  readonly workloads: readonly RuntimeWorkloadSpec[];
  readonly resources: readonly RuntimeResourceSpec[];
  readonly routes: readonly RuntimeRouteBindingSpec[];
}

export interface RuntimeObservedWorkloadState {
  readonly workloadId: string;
  readonly phase: RuntimeWorkloadPhase;
  readonly observedGeneration?: string;
  readonly message?: string;
}

export interface RuntimeObservedResourceState {
  readonly resourceId: string;
  readonly phase: RuntimeResourcePhase;
  readonly message?: string;
}

export interface RuntimeObservedRouteState {
  readonly routeId: string;
  readonly ready: boolean;
  readonly message?: string;
}

export interface RuntimeObservedStateSnapshot {
  readonly id: RuntimeObservedStateId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly desiredStateId?: RuntimeDesiredStateId;
  readonly observedAt: string;
  readonly workloads: readonly RuntimeObservedWorkloadState[];
  readonly resources: readonly RuntimeObservedResourceState[];
  readonly routes: readonly RuntimeObservedRouteState[];
  readonly diagnostics: readonly string[];
}

export interface RuntimeProviderObservation {
  readonly materializationId: string;
  readonly observedState: "present" | "missing" | "drifted" | "unknown";
  readonly driftReason?: string;
  readonly observedDigest?: Digest;
  readonly observedAt: string;
  readonly role?: RuntimeProviderRole;
  readonly desiredObjectRef?: string;
  readonly objectAddress?: string;
  readonly createdByOperationId?: string;
}

export type MetricEventId = string;
export type MetricKind = "counter" | "gauge" | "histogram";

export interface AuditEvent {
  readonly id: string;
  readonly eventClass?: "security" | "compliance" | "irreversible-action";
  readonly type: string;
  readonly severity?: "info" | "warning" | "critical";
  readonly action?: string;
  readonly actor?: ActorContext;
  readonly spaceId?: string;
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

export interface MetricEvent {
  readonly id: MetricEventId;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Record<string, string>;
  readonly spaceId?: string;
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
  readonly spaceId?: string;
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
  readonly spaceId?: string;
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
  readonly spaceId?: string;
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

export class InMemoryObservabilitySink implements ObservabilitySink {
  readonly #auditRecords: ChainedAuditEvent[] = [];
  readonly #metrics: MetricEvent[] = [];
  readonly #traces: TraceSpanEvent[] = [];

  async appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    const previous = this.#auditRecords.at(-1);
    const record = {
      sequence: this.#auditRecords.length + 1,
      event,
      previousHash: previous?.hash ?? "0".repeat(64),
      hash: await sha256Text(
        JSON.stringify({ event, previousHash: previous?.hash }),
      ),
    };
    this.#auditRecords.push(record);
    return clone(record);
  }

  listAudit(): Promise<readonly ChainedAuditEvent[]> {
    return Promise.resolve(this.#auditRecords.map(clone));
  }

  verifyAuditChain(): Promise<boolean> {
    return Promise.resolve(true);
  }

  recordMetric(event: MetricEvent): Promise<MetricEvent> {
    this.#metrics.push(clone(event));
    return Promise.resolve(clone(event));
  }

  listMetrics(query: MetricEventQuery = {}): Promise<readonly MetricEvent[]> {
    return Promise.resolve(
      this.#metrics.filter((event) =>
        (!query.name || event.name === query.name) &&
        (!query.kind || event.kind === query.kind) &&
        (!query.spaceId || event.spaceId === query.spaceId) &&
        (!query.groupId || event.groupId === query.groupId) &&
        (!query.since || event.observedAt >= query.since) &&
        (!query.until || event.observedAt <= query.until)
      ).map(clone),
    );
  }

  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    this.#traces.push(clone(event));
    return Promise.resolve(clone(event));
  }

  listTraces(query: TraceSpanQuery = {}): Promise<readonly TraceSpanEvent[]> {
    return Promise.resolve(
      this.#traces.filter((event) =>
        (!query.traceId || event.traceId === query.traceId) &&
        (!query.spanId || event.spanId === query.spanId) &&
        (!query.name || event.name === query.name) &&
        (!query.kind || event.kind === query.kind) &&
        (!query.status || event.status === query.status) &&
        (!query.spaceId || event.spaceId === query.spaceId) &&
        (!query.groupId || event.groupId === query.groupId) &&
        (!query.since || event.startTime >= query.since) &&
        (!query.until || event.endTime <= query.until)
      ).map(clone),
    );
  }
}

export interface AppAdapters {
  readonly actor: auth.ActorAdapter;
  readonly auth: auth.AuthPort;
  readonly coordination: coordination.CoordinationPort;
  readonly notifications: notification.NotificationPort;
  readonly operatorConfig: operatorConfig.OperatorConfigPort;
  readonly provider: provider.ProviderMaterializer;
  readonly secrets: secretStore.SecretStorePort;
  readonly source: source.SourcePort;
  readonly storage: storage.StorageDriver;
  readonly kms: kms.KmsPort;
  readonly observability: ObservabilitySink;
  readonly routerConfig: router.RouterConfigPort;
  readonly queue: queue.QueuePort;
  readonly objectStorage: objectStorage.ObjectStoragePort;
  readonly runtimeAgent: RuntimeAgentRegistry;
}

export interface AppRuntimeConfig {
  readonly plugins?: Partial<Record<KernelPluginPortKind, string>>;
  readonly pluginConfig?: JsonObject;
  readonly environment?: string;
  readonly processRole?: string;
  readonly allowUnsafeProductionDefaults?: boolean;
  readonly routes?: {
    readonly publicRoutesEnabled?: boolean;
  };
}

export type KernelPluginAdapterOverrides = Partial<AppAdapters>;

export interface KernelPluginCreateAdaptersContext
  extends KernelPluginInitContext {
  readonly clock: () => Date;
  readonly idGenerator: () => string;
}

export interface TrustedKernelPluginSelectionMetadata {
  readonly source: "trusted-signed-manifest";
  readonly keyId: string;
  readonly publisherId: string;
  readonly signatureAlgorithm: string;
}

export interface TrustedKernelPluginImplementationProvenance {
  readonly artifactDigest?: string;
  readonly moduleSpecifier?: string;
  readonly provenanceRef?: string;
  readonly artifact?: Record<string, unknown>;
  readonly module?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface TakosumiKernelPlugin {
  readonly manifest: TakosumiKernelPluginManifest;
  readonly trustedInstall?: TrustedKernelPluginSelectionMetadata;
  readonly implementationProvenance?:
    TrustedKernelPluginImplementationProvenance;
  createAdapters(
    context: KernelPluginCreateAdaptersContext,
  ): KernelPluginAdapterOverrides;
}

export interface KernelPluginRegistry {
  list(): readonly TakosumiKernelPlugin[];
  get(id: string): TakosumiKernelPlugin | undefined;
}

export class InMemoryKernelPluginRegistry implements KernelPluginRegistry {
  readonly #plugins = new Map<string, TakosumiKernelPlugin>();

  constructor(plugins: readonly TakosumiKernelPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: TakosumiKernelPlugin): void {
    assertValidPluginManifest(plugin.manifest);
    if (this.#plugins.has(plugin.manifest.id)) {
      throw new Error(
        `kernel plugin already registered: ${plugin.manifest.id}`,
      );
    }
    this.#plugins.set(plugin.manifest.id, plugin);
  }

  list(): readonly TakosumiKernelPlugin[] {
    return Object.freeze([...this.#plugins.values()]);
  }

  get(id: string): TakosumiKernelPlugin | undefined {
    return this.#plugins.get(id);
  }
}

export function createKernelPluginRegistry(
  plugins: readonly TakosumiKernelPlugin[] = [],
): KernelPluginRegistry {
  return new InMemoryKernelPluginRegistry(plugins);
}

export function createPluginAdapterOverrides(input: {
  readonly registry: KernelPluginRegistry;
  readonly selectedPluginIds: Partial<Record<KernelPluginPortKind, string>>;
  readonly context: KernelPluginCreateAdaptersContext;
}): KernelPluginAdapterOverrides {
  const overrides: KernelPluginAdapterOverrides = {};
  const initialized = new Set<string>();
  const selectedPorts = selectedPortsByPluginId(input.selectedPluginIds);
  for (const pluginId of Object.values(input.selectedPluginIds)) {
    if (!pluginId || initialized.has(pluginId)) continue;
    const plugin = input.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`kernel plugin is not registered: ${pluginId}`);
    }
    const ports = selectedPorts.get(pluginId) ?? [];
    assertPluginSupportsSelectedPorts(plugin.manifest, ports);
    assertPluginAllowedForEnvironment(
      plugin.manifest,
      ports,
      input.context.environment,
    );
    assertPluginTrustedForEnvironment(plugin, input.context.environment);
    const pluginOverrides = plugin.createAdapters(input.context);
    assertPluginProvidesSelectedAdapters(
      plugin.manifest,
      pluginOverrides,
      ports,
    );
    const selectedPluginOverrides = selectedAdapterOverrides(
      plugin.manifest,
      pluginOverrides,
      ports,
      overrides,
    );
    assertPluginDoesNotOverrideExistingAdapters(
      plugin.manifest,
      overrides,
      selectedPluginOverrides,
    );
    assignPluginOverrides(
      overrides,
      plugin.manifest.id,
      selectedPluginOverrides,
    );
    initialized.add(pluginId);
  }
  return overrides;
}

export function assertValidPluginManifest(
  manifest: TakosumiKernelPluginManifest,
): void {
  if (!manifest.id.trim()) throw new Error("kernel plugin id is required");
  if (!manifest.version.trim()) {
    throw new Error(`kernel plugin version is required: ${manifest.id}`);
  }
  if (!manifest.kernelApiVersion.trim()) {
    throw new Error(
      `kernel plugin kernelApiVersion is required: ${manifest.id}`,
    );
  }
  if (manifest.kernelApiVersion !== TAKOSUMI_KERNEL_PLUGIN_API_VERSION) {
    throw new Error(
      `kernel plugin ${manifest.id} targets unsupported kernel API ${manifest.kernelApiVersion}; expected ${TAKOSUMI_KERNEL_PLUGIN_API_VERSION}`,
    );
  }
}

export function assertPluginAllowedForEnvironment(
  manifest: TakosumiKernelPluginManifest,
  ports: readonly KernelPluginPortKind[],
  environment: string,
): void {
  if (environment !== "production" && environment !== "staging") return;
  const normalizedId = manifest.id.toLowerCase();
  if (
    normalizedId === "takosumi.kernel.reference" ||
    /(^|[._-])noop([._-]|$)/.test(normalizedId) ||
    /(^|[._-])reference([._-]|$)/.test(normalizedId)
  ) {
    throw new Error(
      `${environment} cannot select reference/noop kernel plugin ${manifest.id}`,
    );
  }
  for (const port of ports) {
    const capabilities = manifest.capabilities.filter((capability) =>
      capability.port === port
    );
    if (
      capabilities.length > 0 &&
      capabilities.every((capability) =>
        capability.externalIo.length === 0 ||
        capability.externalIo.every((boundary) => boundary === "none")
      )
    ) {
      throw new Error(
        `${environment} plugin ${manifest.id} declares no external I/O for selected port ${port}`,
      );
    }
  }
}

export function assertPluginTrustedForEnvironment(
  plugin: TakosumiKernelPlugin,
  environment: string,
): void {
  if (environment !== "production" && environment !== "staging") return;
  if (hasTrustedKernelPluginInstall(plugin)) return;
  throw new Error(
    `${environment} requires trusted install metadata for kernel plugin ${plugin.manifest.id}`,
  );
}

export const TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM =
  "ECDSA-P256-SHA256" as const;

export interface TrustedKernelPluginEnvelope {
  readonly manifest: TakosumiKernelPluginManifest;
  readonly signature: {
    readonly alg: typeof TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM;
    readonly keyId: string;
    readonly value: string;
  };
}

export interface TrustedKernelPluginKey {
  readonly keyId: string;
  readonly publisherId: string;
  readonly publicKeyJwk: JsonWebKey;
}

export interface TrustedKernelPluginInstallPolicy {
  readonly enabledPluginIds: readonly string[];
  readonly trustedKeyIds?: readonly string[];
  readonly allowedPublisherIds?: readonly string[];
  readonly allowedPorts?: readonly KernelPluginPortKind[];
  readonly allowedExternalIo?: readonly KernelPluginIoBoundary[];
  readonly requireImplementationProvenance?: boolean;
}

export function canonicalTrustedKernelPluginManifest(
  manifest: TakosumiKernelPluginManifest,
): string {
  return [
    "takosumi-kernel-plugin-manifest-v1",
    stableStringify(manifest),
  ].join("\n");
}

export async function installTrustedKernelPlugins(input: {
  readonly envelopes: readonly TrustedKernelPluginEnvelope[];
  readonly availablePlugins: readonly TakosumiKernelPlugin[];
  readonly trustedKeys: readonly TrustedKernelPluginKey[];
  readonly policy: TrustedKernelPluginInstallPolicy;
  readonly environment: string;
}): Promise<readonly TakosumiKernelPlugin[]> {
  const installed: TakosumiKernelPlugin[] = [];
  const available = new Map(
    input.availablePlugins.map((plugin) => [plugin.manifest.id, plugin]),
  );
  const seen = new Set<string>();
  for (const envelope of input.envelopes) {
    assertValidPluginManifest(envelope.manifest);
    assertTrustedPluginInstallPolicy(envelope, input.policy);
    const plugin = available.get(envelope.manifest.id);
    if (!plugin) {
      throw new Error(
        `trusted kernel plugin implementation is not available: ${envelope.manifest.id}`,
      );
    }
    if (
      stableStringify(plugin.manifest) !== stableStringify(envelope.manifest)
    ) {
      throw new Error(
        `trusted kernel plugin manifest does not match available implementation: ${envelope.manifest.id}`,
      );
    }
    assertImplementationProvenance(envelope, plugin, input.policy);
    const trustedKey = trustedKeyForEnvelope(
      envelope,
      input.trustedKeys,
      input.policy,
    );
    const ok = await verifyTrustedManifestSignature(envelope, trustedKey);
    if (!ok) {
      throw new Error(
        `trusted kernel plugin manifest signature is invalid: ${envelope.manifest.id}`,
      );
    }
    const selectedPorts = envelope.manifest.capabilities.map((capability) =>
      capability.port
    );
    assertPluginAllowedForEnvironment(
      envelope.manifest,
      selectedPorts,
      input.environment,
    );
    if (seen.has(plugin.manifest.id)) continue;
    const wrapped = Object.freeze({
      ...plugin,
      trustedInstall: {
        source: "trusted-signed-manifest" as const,
        keyId: trustedKey.keyId,
        publisherId: trustedKey.publisherId,
        signatureAlgorithm: envelope.signature.alg,
      },
    });
    markTrustedKernelPlugin(wrapped);
    installed.push(wrapped);
    seen.add(plugin.manifest.id);
  }
  return Object.freeze(installed);
}

export function markTrustedKernelPlugin<T extends TakosumiKernelPlugin>(
  plugin: T,
): T {
  trustedInstalledPlugins.add(plugin);
  return plugin;
}

export function hasTrustedKernelPluginInstall(
  plugin: TakosumiKernelPlugin,
): boolean {
  return plugin.trustedInstall?.source === "trusted-signed-manifest" &&
    trustedInstalledPlugins.has(plugin);
}

const trustedInstalledPlugins = new WeakSet<TakosumiKernelPlugin>();

export interface RuntimeAgentCapabilities {
  readonly providers: readonly string[];
  readonly maxConcurrentLeases?: number;
  readonly labels?: Record<string, string>;
}

export type RuntimeAgentStatus =
  | "registered"
  | "ready"
  | "draining"
  | "revoked"
  | "expired";
export type RuntimeAgentWorkStatus =
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "cancelled";

export interface RuntimeAgentRecord {
  readonly id: string;
  readonly provider: string;
  readonly endpoint?: string;
  readonly capabilities: RuntimeAgentCapabilities;
  readonly status: RuntimeAgentStatus;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  readonly drainRequestedAt?: string;
  readonly revokedAt?: string;
  readonly expiredAt?: string;
  readonly hostKeyDigest?: string;
  readonly metadata: Record<string, unknown>;
}

export interface RegisterRuntimeAgentInput {
  readonly agentId?: string;
  readonly provider: string;
  readonly endpoint?: string;
  readonly capabilities?: Partial<RuntimeAgentCapabilities>;
  readonly metadata?: Record<string, unknown>;
  readonly heartbeatAt?: string;
  readonly hostKeyDigest?: string;
  readonly allowHostKeyRotation?: boolean;
}

export interface RuntimeAgentHeartbeatInput {
  readonly agentId: string;
  readonly heartbeatAt?: string;
  readonly status?: Extract<RuntimeAgentStatus, "ready" | "draining">;
  readonly metadata?: Record<string, unknown>;
}

export interface RuntimeAgentWorkItem {
  readonly id: string;
  readonly kind: string;
  readonly status: RuntimeAgentWorkStatus;
  readonly payload: Record<string, unknown>;
  readonly provider?: string;
  readonly priority: number;
  readonly queuedAt: string;
  readonly leasedByAgentId?: string;
  readonly leaseId?: string;
  readonly leaseExpiresAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: string;
  readonly attempts: number;
  readonly metadata: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly lastProgress?: Record<string, unknown>;
  readonly lastProgressAt?: string;
  readonly result?: Record<string, unknown>;
}

export interface EnqueueRuntimeAgentWorkInput {
  readonly workId?: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly provider?: string;
  readonly priority?: number;
  readonly metadata?: Record<string, unknown>;
  readonly queuedAt?: string;
  readonly idempotencyKey?: string;
}

export interface RuntimeAgentRegistryWorkLease {
  readonly id: string;
  readonly workId: string;
  readonly agentId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
  readonly renewAfter: string;
  readonly work: RuntimeAgentWorkItem;
}

export interface LeaseRuntimeAgentWorkInput {
  readonly agentId: string;
  readonly leaseTtlMs?: number;
  readonly now?: string;
}

export interface CompleteRuntimeAgentWorkInput {
  readonly agentId: string;
  readonly leaseId: string;
  readonly completedAt?: string;
  readonly result?: Record<string, unknown>;
}

export interface FailRuntimeAgentWorkInput {
  readonly agentId: string;
  readonly leaseId: string;
  readonly reason: string;
  readonly retry?: boolean;
  readonly failedAt?: string;
  readonly result?: Record<string, unknown>;
}

export interface ReportRuntimeAgentProgressInput {
  readonly agentId: string;
  readonly leaseId: string;
  readonly progress?: Record<string, unknown>;
  readonly extendUntil?: string;
  readonly reportedAt?: string;
}

export interface DetectStaleAgentsInput {
  readonly ttlMs: number;
  readonly now?: string;
}

export interface StaleAgentDetection {
  readonly stale: readonly RuntimeAgentRecord[];
  readonly requeuedWork: readonly RuntimeAgentWorkItem[];
}

export interface EnqueueLongRunningOperationInput {
  readonly provider: string;
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly payload: Record<string, unknown>;
  readonly priority?: number;
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
}

export interface IssueGatewayManifestInput {
  readonly agentId: string;
  readonly gatewayUrl: string;
  readonly issuedAt?: string;
}

export interface GatewayManifestIssuer {
  issue(input: IssueGatewayManifestInput): Promise<SignedGatewayManifest>;
}

export interface RuntimeAgentRegistry {
  register(input: RegisterRuntimeAgentInput): Promise<RuntimeAgentRecord>;
  heartbeat(input: RuntimeAgentHeartbeatInput): Promise<RuntimeAgentRecord>;
  getAgent(agentId: string): Promise<RuntimeAgentRecord | undefined>;
  listAgents(): Promise<readonly RuntimeAgentRecord[]>;
  requestDrain(agentId: string, at?: string): Promise<RuntimeAgentRecord>;
  revoke(agentId: string, at?: string): Promise<RuntimeAgentRecord>;
  enqueueWork(
    input: EnqueueRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem>;
  leaseWork(
    input: LeaseRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentRegistryWorkLease | undefined>;
  completeWork(
    input: CompleteRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem>;
  failWork(input: FailRuntimeAgentWorkInput): Promise<RuntimeAgentWorkItem>;
  reportProgress(
    input: ReportRuntimeAgentProgressInput,
  ): Promise<RuntimeAgentWorkItem>;
  detectStaleAgents(
    input: DetectStaleAgentsInput,
  ): Promise<StaleAgentDetection>;
  enqueueLongRunningOperation(
    input: EnqueueLongRunningOperationInput,
  ): Promise<RuntimeAgentWorkItem>;
  getWork(workId: string): Promise<RuntimeAgentWorkItem | undefined>;
  listWork(): Promise<readonly RuntimeAgentWorkItem[]>;
}

export class InMemoryRuntimeAgentRegistry implements RuntimeAgentRegistry {
  readonly #agents = new Map<string, RuntimeAgentRecord>();
  readonly #work = new Map<string, RuntimeAgentWorkItem>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #defaultLeaseTtlMs: number;

  constructor(options: {
    readonly clock?: () => Date;
    readonly idGenerator?: () => string;
    readonly defaultLeaseTtlMs?: number;
  } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 60_000;
  }

  register(input: RegisterRuntimeAgentInput): Promise<RuntimeAgentRecord> {
    const id = input.agentId ?? `agent_${this.#idGenerator()}`;
    const now = input.heartbeatAt ?? this.#clock().toISOString();
    const record: RuntimeAgentRecord = {
      id,
      provider: input.provider,
      endpoint: input.endpoint,
      capabilities: {
        providers: input.capabilities?.providers ?? [input.provider],
        maxConcurrentLeases: input.capabilities?.maxConcurrentLeases,
        labels: input.capabilities?.labels,
      },
      status: "ready",
      registeredAt: this.#agents.get(id)?.registeredAt ?? now,
      lastHeartbeatAt: now,
      hostKeyDigest: input.hostKeyDigest,
      metadata: input.metadata ?? {},
    };
    this.#agents.set(id, record);
    return Promise.resolve(clone(record));
  }

  heartbeat(input: RuntimeAgentHeartbeatInput): Promise<RuntimeAgentRecord> {
    const current = this.#requireAgent(input.agentId);
    const next = {
      ...current,
      status: input.status ?? current.status,
      lastHeartbeatAt: input.heartbeatAt ?? this.#clock().toISOString(),
      metadata: { ...current.metadata, ...(input.metadata ?? {}) },
    };
    this.#agents.set(current.id, next);
    return Promise.resolve(clone(next));
  }

  getAgent(agentId: string): Promise<RuntimeAgentRecord | undefined> {
    return Promise.resolve(clone(this.#agents.get(agentId)));
  }

  listAgents(): Promise<readonly RuntimeAgentRecord[]> {
    return Promise.resolve([...this.#agents.values()].map(clone));
  }

  requestDrain(
    agentId: string,
    at: string = this.#clock().toISOString(),
  ): Promise<RuntimeAgentRecord> {
    const current = this.#requireAgent(agentId);
    const next = {
      ...current,
      status: "draining" as const,
      drainRequestedAt: at,
    };
    this.#agents.set(agentId, next);
    return Promise.resolve(clone(next));
  }

  revoke(
    agentId: string,
    at: string = this.#clock().toISOString(),
  ): Promise<RuntimeAgentRecord> {
    const current = this.#requireAgent(agentId);
    const next = { ...current, status: "revoked" as const, revokedAt: at };
    this.#agents.set(agentId, next);
    this.#requeueLeases(agentId);
    return Promise.resolve(clone(next));
  }

  enqueueWork(
    input: EnqueueRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem> {
    if (input.idempotencyKey) {
      const existing = [...this.#work.values()].find((work) =>
        work.idempotencyKey === input.idempotencyKey &&
        work.status !== "completed" && work.status !== "failed" &&
        work.status !== "cancelled"
      );
      if (existing) return Promise.resolve(clone(existing));
    }
    const work: RuntimeAgentWorkItem = {
      id: input.workId ?? `work_${this.#idGenerator()}`,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      provider: input.provider,
      priority: input.priority ?? 0,
      queuedAt: input.queuedAt ?? this.#clock().toISOString(),
      attempts: 0,
      metadata: input.metadata ?? {},
      idempotencyKey: input.idempotencyKey,
    };
    this.#work.set(work.id, work);
    return Promise.resolve(clone(work));
  }

  leaseWork(
    input: LeaseRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentRegistryWorkLease | undefined> {
    const agent = this.#requireAgent(input.agentId);
    const now = input.now ?? this.#clock().toISOString();
    const work = [...this.#work.values()]
      .filter((candidate) =>
        candidate.status === "queued" &&
        (!candidate.provider ||
          agent.capabilities.providers.includes(candidate.provider))
      )
      .sort((a, b) =>
        b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt)
      )[0];
    if (!work) return Promise.resolve(undefined);
    const leaseTtlMs = input.leaseTtlMs ?? this.#defaultLeaseTtlMs;
    const leasedAtMs = Date.parse(now);
    const lease: RuntimeAgentRegistryWorkLease = {
      id: `lease_${this.#idGenerator()}`,
      workId: work.id,
      agentId: agent.id,
      leasedAt: now,
      expiresAt: new Date(leasedAtMs + leaseTtlMs).toISOString(),
      renewAfter: new Date(leasedAtMs + Math.floor(leaseTtlMs / 2))
        .toISOString(),
      work: clone({ ...work, status: "leased", attempts: work.attempts + 1 }),
    };
    this.#work.set(work.id, {
      ...work,
      status: "leased",
      leasedByAgentId: agent.id,
      leaseId: lease.id,
      leaseExpiresAt: lease.expiresAt,
      attempts: work.attempts + 1,
    });
    return Promise.resolve(clone(lease));
  }

  completeWork(
    input: CompleteRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem> {
    const current = this.#requireWorkByLease(input.agentId, input.leaseId);
    const next = {
      ...current,
      status: "completed" as const,
      completedAt: input.completedAt ?? this.#clock().toISOString(),
    };
    this.#work.set(current.id, next);
    return Promise.resolve(clone(next));
  }

  failWork(input: FailRuntimeAgentWorkInput): Promise<RuntimeAgentWorkItem> {
    const current = this.#requireWorkByLease(input.agentId, input.leaseId);
    const retry = input.retry === true;
    const next = {
      ...current,
      status: retry ? "queued" as const : "failed" as const,
      leasedByAgentId: retry ? undefined : current.leasedByAgentId,
      leaseId: retry ? undefined : current.leaseId,
      leaseExpiresAt: retry ? undefined : current.leaseExpiresAt,
      failedAt: input.failedAt ?? this.#clock().toISOString(),
      failureReason: input.reason,
      result: input.result,
    };
    this.#work.set(current.id, next);
    return Promise.resolve(clone(next));
  }

  reportProgress(
    input: ReportRuntimeAgentProgressInput,
  ): Promise<RuntimeAgentWorkItem> {
    const current = this.#requireWorkByLease(input.agentId, input.leaseId);
    const next = {
      ...current,
      leaseExpiresAt: input.extendUntil ?? current.leaseExpiresAt,
      lastProgress: input.progress,
      lastProgressAt: input.reportedAt ?? this.#clock().toISOString(),
    };
    this.#work.set(current.id, next);
    return Promise.resolve(clone(next));
  }

  detectStaleAgents(
    input: DetectStaleAgentsInput,
  ): Promise<StaleAgentDetection> {
    const cutoff = Date.parse(input.now ?? this.#clock().toISOString()) -
      input.ttlMs;
    const stale: RuntimeAgentRecord[] = [];
    const requeuedWork: RuntimeAgentWorkItem[] = [];
    for (const agent of this.#agents.values()) {
      if (Date.parse(agent.lastHeartbeatAt) >= cutoff) continue;
      const expired = {
        ...agent,
        status: "expired" as const,
        expiredAt: input.now ?? this.#clock().toISOString(),
      };
      this.#agents.set(agent.id, expired);
      stale.push(expired);
      requeuedWork.push(...this.#requeueLeases(agent.id));
    }
    return Promise.resolve({ stale: stale.map(clone), requeuedWork });
  }

  enqueueLongRunningOperation(
    input: EnqueueLongRunningOperationInput,
  ): Promise<RuntimeAgentWorkItem> {
    return this.enqueueWork({
      kind: `provider.${input.provider}.${input.descriptor}`,
      provider: input.provider,
      payload: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
        ...input.payload,
      },
      priority: input.priority,
      queuedAt: input.enqueuedAt,
      idempotencyKey: input.idempotencyKey,
      metadata: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
      },
    });
  }

  getWork(workId: string): Promise<RuntimeAgentWorkItem | undefined> {
    return Promise.resolve(clone(this.#work.get(workId)));
  }

  listWork(): Promise<readonly RuntimeAgentWorkItem[]> {
    return Promise.resolve([...this.#work.values()].map(clone));
  }

  #requireAgent(agentId: string): RuntimeAgentRecord {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`runtime agent not found: ${agentId}`);
    return agent;
  }

  #requireWorkByLease(agentId: string, leaseId: string): RuntimeAgentWorkItem {
    const work = [...this.#work.values()].find((candidate) =>
      candidate.leasedByAgentId === agentId && candidate.leaseId === leaseId
    );
    if (!work) throw new Error(`runtime-agent lease not found: ${leaseId}`);
    return work;
  }

  #requeueLeases(agentId: string): RuntimeAgentWorkItem[] {
    const requeued: RuntimeAgentWorkItem[] = [];
    for (const work of this.#work.values()) {
      if (work.leasedByAgentId !== agentId || work.status !== "leased") {
        continue;
      }
      const next = {
        ...work,
        status: "queued" as const,
        leasedByAgentId: undefined,
        leaseId: undefined,
        leaseExpiresAt: undefined,
      };
      this.#work.set(work.id, next);
      requeued.push(clone(next));
    }
    return requeued;
  }
}

export class RuntimeAgentGatewayManifestIssuer
  implements GatewayManifestIssuer {
  readonly #registry: RuntimeAgentRegistry;
  readonly #signingKey: CryptoKey;
  readonly #publicKeyBase64: string;
  readonly #publicKeyFingerprint: string;
  readonly #issuer: string;
  readonly #clock: () => Date;
  readonly #manifestTtlMs: number;
  readonly #tlsPubkeySha256?: string;
  readonly #allowedGatewayUrls?: readonly string[];

  constructor(options: {
    readonly registry: RuntimeAgentRegistry;
    readonly signingKey: CryptoKey;
    readonly publicKeyBase64: string;
    readonly publicKeyFingerprint: string;
    readonly issuer: string;
    readonly clock?: () => Date;
    readonly manifestTtlMs?: number;
    readonly tlsPubkeySha256?: string;
    readonly allowedGatewayUrls?: readonly string[];
  }) {
    this.#registry = options.registry;
    this.#signingKey = options.signingKey;
    this.#publicKeyBase64 = options.publicKeyBase64;
    this.#publicKeyFingerprint = options.publicKeyFingerprint;
    this.#issuer = options.issuer;
    this.#clock = options.clock ?? (() => new Date());
    this.#manifestTtlMs = options.manifestTtlMs ?? 5 * 60 * 1000;
    this.#tlsPubkeySha256 = options.tlsPubkeySha256;
    this.#allowedGatewayUrls = options.allowedGatewayUrls;
  }

  async issue(
    input: IssueGatewayManifestInput,
  ): Promise<SignedGatewayManifest> {
    if (
      this.#allowedGatewayUrls &&
      !this.#allowedGatewayUrls.includes(input.gatewayUrl)
    ) {
      throw new Error(`gateway URL is not allowed: ${input.gatewayUrl}`);
    }
    const agent = await this.#registry.getAgent(input.agentId);
    if (!agent) throw new Error(`runtime agent not found: ${input.agentId}`);
    const issuedAt = input.issuedAt ?? this.#clock().toISOString();
    return await signGatewayManifest(
      {
        issuer: this.#issuer,
        agentId: input.agentId,
        gatewayUrl: input.gatewayUrl,
        allowedProviderKinds: agent.capabilities.providers,
        pubkey: this.#publicKeyBase64,
        pubkeyFingerprint: this.#publicKeyFingerprint,
        tlsPubkeySha256: this.#tlsPubkeySha256,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + this.#manifestTtlMs)
          .toISOString(),
      },
      this.#signingKey,
    );
  }
}

export interface AppContext {
  readonly adapters: AppAdapters;
  readonly runtimeConfig?: AppRuntimeConfig;
}

export interface CreatePaaSAppOptions {
  readonly role?: TakosumiProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly runtimeConfig?: AppRuntimeConfig;
  readonly plugins?: readonly TakosumiKernelPlugin[];
  readonly pluginRegistry?: KernelPluginRegistry;
  readonly pluginClientRegistry?: KernelPluginClientRegistry;
  readonly dateClock?: () => Date;
  readonly uuidFactory?: () => string;
  readonly context?: AppContext;
}

export interface CreatedPaaSApp {
  readonly app: unknown;
  readonly context: AppContext;
  readonly role: TakosumiProcessRole;
}

export function createPaaSApp(
  options: CreatePaaSAppOptions = {},
): Promise<CreatedPaaSApp> {
  const role = options.role ?? processRoleFromEnv(options.runtimeEnv);
  if (options.context) {
    return Promise.resolve({ app: undefined, context: options.context, role });
  }
  const runtimeConfig = options.runtimeConfig ?? {};
  const clock = options.dateClock ?? (() => new Date());
  const idGenerator = options.uuidFactory ?? (() => crypto.randomUUID());
  const pluginRegistry = options.pluginRegistry ??
    createKernelPluginRegistry(options.plugins ?? []);
  const selectedPluginIds = runtimeConfig.plugins ?? {};
  const overrides = createPluginAdapterOverrides({
    registry: pluginRegistry,
    selectedPluginIds,
    context: {
      kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
      environment: runtimeConfig.environment ?? "local",
      processRole: runtimeConfig.processRole ?? role,
      selectedPluginIds,
      operatorConfig: runtimeConfig.pluginConfig,
      clientRegistry: options.pluginClientRegistry,
      clock,
      idGenerator,
    },
  });
  const adapters = {
    ...createDefaultAppAdapters({ clock, idGenerator }),
    ...overrides,
  };
  return Promise.resolve({
    app: undefined,
    context: { adapters, runtimeConfig },
    role,
  });
}

export type RuntimeAgentAuthResult =
  | {
    readonly ok: true;
    readonly actor?: {
      readonly actorAccountId: string;
      readonly spaceId?: string;
    };
    readonly workloadIdentityId?: string;
  }
  | { readonly ok: false; readonly status?: 401 | 403; readonly error: string };

export interface RegisterRuntimeAgentRoutesOptions {
  readonly registry: RuntimeAgentRegistry;
  readonly authenticate?: (
    request: Request,
  ) => Promise<RuntimeAgentAuthResult> | RuntimeAgentAuthResult;
  readonly gatewayManifestIssuer?: GatewayManifestIssuer;
  readonly gatewayResponseSigner?: {
    readonly privateKey: CryptoKey;
    readonly clock?: () => Date;
  };
}

export function registerRuntimeAgentRoutes(
  app: HonoLikeApp,
  options: RegisterRuntimeAgentRoutesOptions,
): void {
  const authenticate = options.authenticate ??
    failClosedRuntimeAgentRouteAuthenticate;
  const signer = options.gatewayResponseSigner;
  if (signer) {
    const clock = signer.clock ?? (() => new Date());
    for (const path of Object.values(TAKOSUMI_RUNTIME_AGENT_PATHS)) {
      app.use?.(path, async (c: HonoLikeContext, next: () => Promise<void>) => {
        await next();
        const res = c.res;
        if (!res || res.status >= 400) return;
        const body = await res.clone().text();
        const timestamp = clock().toISOString();
        const requestId = c.req.raw.headers.get("x-takosumi-request-id") ??
          crypto.randomUUID();
        const nonce = crypto.randomUUID();
        const sig = await signGatewayResponse({
          privateKey: signer.privateKey,
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          body,
          timestamp,
          requestId,
          nonce,
        });
        const headers = new Headers(res.headers);
        headers.set(TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER, sig);
        headers.set(TAKOSUMI_GATEWAY_IDENTITY_TIMESTAMP_HEADER, timestamp);
        headers.set(TAKOSUMI_GATEWAY_IDENTITY_REQUEST_ID_HEADER, requestId);
        headers.set(TAKOSUMI_GATEWAY_IDENTITY_NONCE_HEADER, nonce);
        c.res = new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      });
    }
  }

  app.post(
    TAKOSUMI_RUNTIME_AGENT_PATHS.enroll,
    async (c: HonoLikeContext) => {
      const auth = await authenticate(c.req.raw);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
      const request = await readRequestJson(c.req.raw);
      const record = await options.registry.register({
        agentId: stringValue(request.agentId),
        provider: requiredString(request.provider, "provider"),
        endpoint: stringValue(request.endpoint),
        capabilities: objectValue(request.capabilities),
        metadata: objectValue(request.metadata),
        heartbeatAt: stringValue(request.enrolledAt),
        hostKeyDigest: stringValue(request.hostKeyDigest),
      });
      return c.json({
        agent: {
          id: record.id,
          provider: record.provider,
          status: record.status,
          registeredAt: record.registeredAt,
          lastHeartbeatAt: record.lastHeartbeatAt,
          capabilities: record.capabilities,
        },
        renewAfterMs: 30_000,
      }, 201);
    },
  );

  app.post(
    TAKOSUMI_RUNTIME_AGENT_PATHS.heartbeat,
    async (c: HonoLikeContext) => {
      const auth = await authenticate(c.req.raw);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
      const request = await readRequestJson(c.req.raw);
      const agent = await options.registry.heartbeat({
        agentId: c.req.param("agentId"),
        heartbeatAt: stringValue(request.heartbeatAt),
        status: request.status === "draining" ? "draining" : "ready",
        metadata: objectValue(request.metadata),
      });
      return c.json({
        agent: {
          id: agent.id,
          status: agent.status,
          lastHeartbeatAt: agent.lastHeartbeatAt,
        },
        renewAfterMs: numberValue(request.ttlMs) ?? 30_000,
      });
    },
  );

  app.post(TAKOSUMI_RUNTIME_AGENT_PATHS.lease, async (c: HonoLikeContext) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
    const request = await readRequestJson(c.req.raw);
    const lease = await options.registry.leaseWork({
      agentId: c.req.param("agentId"),
      leaseTtlMs: numberValue(request.leaseTtlMs),
      now: stringValue(request.now),
    });
    return c.json({ lease: lease ? toRuntimeAgentRpcLease(lease) : null });
  });

  app.post(
    TAKOSUMI_RUNTIME_AGENT_PATHS.report,
    async (c: HonoLikeContext) => {
      const auth = await authenticate(c.req.raw);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
      const request = await readRequestJson(c.req.raw);
      const status = requiredString(request.status, "status");
      if (status === "progress") {
        const work = await options.registry.reportProgress({
          agentId: c.req.param("agentId"),
          leaseId: requiredString(request.leaseId, "leaseId"),
          progress: objectValue(request.progress),
          extendUntil: stringValue(request.extendUntil),
          reportedAt: stringValue(request.reportedAt),
        });
        return c.json({ work });
      }
      if (status === "completed") {
        const work = await options.registry.completeWork({
          agentId: c.req.param("agentId"),
          leaseId: requiredString(request.leaseId, "leaseId"),
          completedAt: stringValue(request.completedAt),
          result: objectValue(request.result),
        });
        return c.json({ work });
      }
      const work = await options.registry.failWork({
        agentId: c.req.param("agentId"),
        leaseId: requiredString(request.leaseId, "leaseId"),
        reason: stringValue(request.reason) ?? "failed",
        retry: request.retry === true,
        failedAt: stringValue(request.failedAt),
        result: objectValue(request.result),
      });
      return c.json({ work });
    },
  );

  app.post(TAKOSUMI_RUNTIME_AGENT_PATHS.drain, async (c: HonoLikeContext) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
    await options.registry.requestDrain(c.req.param("agentId"));
    return c.json({});
  });

  const gatewayManifestHandler = async (c: HonoLikeContext) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status ?? 401);
    if (!options.gatewayManifestIssuer) {
      return c.json({ error: "gateway manifest issuer unavailable" }, 501);
    }
    try {
      const request = c.req.method === "POST"
        ? await readRequestJson(c.req.raw)
        : {};
      const signed = await options.gatewayManifestIssuer.issue({
        agentId: c.req.param("agentId"),
        gatewayUrl: stringValue(request.gatewayUrl) ??
          c.req.query("gatewayUrl") ?? "",
      });
      return c.json(signed);
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
      }, 409);
    }
  };
  app.get(
    TAKOSUMI_RUNTIME_AGENT_PATHS.gatewayManifest,
    gatewayManifestHandler,
  );
  app.post(
    TAKOSUMI_RUNTIME_AGENT_PATHS.gatewayManifest,
    gatewayManifestHandler,
  );
}

export function allowUnauthenticatedRuntimeAgentRoutesForTests(): NonNullable<
  RegisterRuntimeAgentRoutesOptions["authenticate"]
> {
  return () => ({ ok: true });
}

function failClosedRuntimeAgentRouteAuthenticate(): RuntimeAgentAuthResult {
  return {
    ok: false,
    status: 401,
    error: "runtime agent route authentication is not configured",
  };
}

interface HonoLikeApp {
  use?: (path: string, middleware: HonoLikeMiddleware) => void;
  get: (path: string, handler: HonoLikeHandler) => void;
  post: (path: string, handler: HonoLikeHandler) => void;
}

type HonoLikeHandler = (
  context: HonoLikeContext,
) => Response | Promise<Response>;
type HonoLikeMiddleware = (
  context: HonoLikeContext,
  next: () => Promise<void>,
) => Promise<void | Response> | void | Response;

interface HonoLikeContext {
  req: {
    raw: Request;
    method: string;
    url: string;
    param(name: string): string;
    query(name: string): string | undefined;
  };
  res?: Response;
  json(body: unknown, status?: number): Response;
}

function createDefaultAppAdapters(options: {
  readonly clock: () => Date;
  readonly idGenerator: () => string;
}): AppAdapters {
  return {
    actor: new auth.LocalActorAdapter(),
    auth: new auth.LocalActorAdapter(),
    coordination: new coordination.MemoryCoordinationAdapter(options),
    notifications: new notification.MemoryNotificationSink(options),
    operatorConfig: new operatorConfig.LocalOperatorConfig({
      clock: options.clock,
    }),
    provider: new NoopProviderMaterializer(options),
    secrets: new secretStore.MemoryEncryptedSecretStore(options),
    source: new source.ImmutableManifestSourceAdapter(options),
    storage: new storage.MemoryStorageDriver(),
    kms: new kms.NoopTestKms({ clock: options.clock }),
    observability: new InMemoryObservabilitySink(),
    routerConfig: new router.InMemoryRouterConfigAdapter({
      clock: options.clock,
    }),
    queue: new queue.MemoryQueueAdapter(options),
    objectStorage: new objectStorage.MemoryObjectStorage({
      clock: options.clock,
    }),
    runtimeAgent: new InMemoryRuntimeAgentRegistry(options),
  };
}

class NoopProviderMaterializer implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: {
    readonly clock: () => Date;
    readonly idGenerator: () => string;
  }) {
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
  }

  materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const recordedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "noop",
      provider: "noop",
      desiredStateId: desiredState.id,
      targetId: desiredState.id,
      targetName: desiredState.appName,
      command: [],
      details: {},
      recordedAt,
      execution: {
        status: "skipped",
        code: 0,
        skipped: true,
        startedAt: recordedAt,
        completedAt: recordedAt,
      },
    };
    this.#operations.push(operation);
    return Promise.resolve({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "noop",
      desiredStateId: desiredState.id,
      recordedAt,
      operations: [operation],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve(this.#operations.map(clone));
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}

async function readRequestJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${field} is required`);
}

function toRuntimeAgentRpcLease(
  lease: RuntimeAgentRegistryWorkLease,
): {
  readonly id: string;
  readonly workId: string;
  readonly agentId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
  readonly renewAfter: string;
  readonly work: {
    readonly id: string;
    readonly kind: string;
    readonly provider?: string;
    readonly priority: number;
    readonly attempts: number;
    readonly payload: JsonObject;
    readonly metadata: JsonObject;
    readonly queuedAt: string;
  };
} {
  return {
    id: lease.id,
    workId: lease.workId,
    agentId: lease.agentId,
    leasedAt: lease.leasedAt,
    expiresAt: lease.expiresAt,
    renewAfter: lease.renewAfter,
    work: {
      id: lease.work.id,
      kind: lease.work.kind,
      provider: lease.work.provider,
      priority: lease.work.priority,
      attempts: lease.work.attempts,
      payload: lease.work.payload as JsonObject,
      metadata: lease.work.metadata as JsonObject,
      queuedAt: lease.work.queuedAt,
    },
  };
}

function selectedPortsByPluginId(
  selectedPluginIds: Partial<Record<KernelPluginPortKind, string>>,
): Map<string, KernelPluginPortKind[]> {
  const portsByPlugin = new Map<string, KernelPluginPortKind[]>();
  for (const [rawPort, pluginId] of Object.entries(selectedPluginIds)) {
    if (!pluginId) continue;
    const port = rawPort as KernelPluginPortKind;
    portsByPlugin.set(pluginId, [...(portsByPlugin.get(pluginId) ?? []), port]);
  }
  return portsByPlugin;
}

function assertPluginSupportsSelectedPorts(
  manifest: TakosumiKernelPluginManifest,
  ports: readonly KernelPluginPortKind[],
): void {
  const supportedPorts = new Set(
    manifest.capabilities.map((capability) => capability.port),
  );
  for (const port of ports) {
    if (supportedPorts.has(port)) continue;
    throw new Error(
      `kernel plugin ${manifest.id} does not declare capability for selected port ${port}`,
    );
  }
}

function assertPluginProvidesSelectedAdapters(
  manifest: TakosumiKernelPluginManifest,
  overrides: KernelPluginAdapterOverrides,
  ports: readonly KernelPluginPortKind[],
): void {
  for (const port of ports) {
    const adapterKey = adapterKeyForPort(port);
    if (!adapterKey) continue;
    if (overrides[adapterKey]) continue;
    throw new Error(
      `kernel plugin ${manifest.id} did not provide adapter ${adapterKey} for selected port ${port}`,
    );
  }
}

function selectedAdapterOverrides(
  manifest: TakosumiKernelPluginManifest,
  overrides: KernelPluginAdapterOverrides,
  ports: readonly KernelPluginPortKind[],
  existing: KernelPluginAdapterOverrides,
): KernelPluginAdapterOverrides {
  const selectedOverrides: KernelPluginAdapterOverrides = {};
  const mutableSelected =
    selectedOverrides as MutableKernelPluginAdapterOverrides;
  const selectedAdapterKeys = new Set<AdapterOverrideKey>();
  for (const port of ports) {
    for (const key of adapterKeysForPort(port)) selectedAdapterKeys.add(key);
  }
  const supportedAdapterKeys = new Set<AdapterOverrideKey>();
  for (const capability of manifest.capabilities) {
    for (const key of adapterKeysForPort(capability.port)) {
      supportedAdapterKeys.add(key);
    }
  }
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    const adapter = overrides[adapterKey];
    if (adapter === undefined) continue;
    if (selectedAdapterKeys.has(adapterKey)) {
      mutableSelected[adapterKey] = adapter as never;
      continue;
    }
    if (existing[adapterKey] !== undefined) {
      throw new Error(
        `kernel plugin ${manifest.id} attempted duplicate ownership of adapter ${adapterKey}`,
      );
    }
    if (supportedAdapterKeys.has(adapterKey)) continue;
    throw new Error(
      `kernel plugin ${manifest.id} provided unselected adapter ${adapterKey}`,
    );
  }
  return selectedOverrides;
}

function assertPluginDoesNotOverrideExistingAdapters(
  manifest: TakosumiKernelPluginManifest,
  existing: KernelPluginAdapterOverrides,
  overrides: KernelPluginAdapterOverrides,
): void {
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    if (overrides[adapterKey] === undefined) continue;
    if (existing[adapterKey] === undefined) continue;
    throw new Error(
      `kernel plugin ${manifest.id} attempted duplicate ownership of adapter ${adapterKey}`,
    );
  }
}

function assignPluginOverrides(
  target: KernelPluginAdapterOverrides,
  pluginId: string,
  overrides: KernelPluginAdapterOverrides,
): void {
  const mutableTarget = target as MutableKernelPluginAdapterOverrides;
  for (const adapterKey of Object.keys(overrides) as AdapterOverrideKey[]) {
    const adapter = overrides[adapterKey];
    if (adapter === undefined) continue;
    if (target[adapterKey] !== undefined) {
      throw new Error(
        `kernel plugin ${pluginId} attempted duplicate ownership of adapter ${adapterKey}`,
      );
    }
    mutableTarget[adapterKey] = adapter as never;
  }
}

type AdapterOverrideKey = keyof KernelPluginAdapterOverrides;
type MutableKernelPluginAdapterOverrides = {
  -readonly [K in keyof KernelPluginAdapterOverrides]:
    KernelPluginAdapterOverrides[K];
};

function adapterKeysForPort(
  port: KernelPluginPortKind,
): readonly AdapterOverrideKey[] {
  if (port === "auth") return ["auth", "actor"];
  const single = adapterKeyForPort(port);
  return single === undefined ? [] : [single];
}

function adapterKeyForPort(
  port: KernelPluginPortKind,
): keyof KernelPluginAdapterOverrides | undefined {
  switch (port) {
    case "auth":
      return "auth";
    case "coordination":
      return "coordination";
    case "kms":
      return "kms";
    case "notification":
      return "notifications";
    case "object-storage":
      return "objectStorage";
    case "operator-config":
      return "operatorConfig";
    case "provider":
      return "provider";
    case "queue":
      return "queue";
    case "router-config":
      return "routerConfig";
    case "secret-store":
      return "secrets";
    case "source":
      return "source";
    case "storage":
      return "storage";
    case "observability":
      return "observability";
    case "runtime-agent":
      return "runtimeAgent";
  }
}

async function verifyTrustedManifestSignature(
  envelope: TrustedKernelPluginEnvelope,
  trustedKey: TrustedKernelPluginKey,
): Promise<boolean> {
  if (envelope.signature.alg !== TRUSTED_KERNEL_PLUGIN_MANIFEST_ALGORITHM) {
    throw new Error(
      `trusted kernel plugin manifest uses unsupported signature algorithm: ${envelope.signature.alg}`,
    );
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    trustedKey.publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(base64UrlToBytes(envelope.signature.value)),
    toArrayBuffer(
      new TextEncoder().encode(
        canonicalTrustedKernelPluginManifest(envelope.manifest),
      ),
    ),
  );
}

function assertTrustedPluginInstallPolicy(
  envelope: TrustedKernelPluginEnvelope,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const manifest = envelope.manifest;
  if (!policy.enabledPluginIds.includes(manifest.id)) {
    throw new Error(
      `trusted kernel plugin is not enabled by install policy: ${manifest.id}`,
    );
  }

  if (policy.allowedPorts) {
    const allowed = new Set(policy.allowedPorts);
    const denied = manifest.capabilities.find((capability) =>
      !allowed.has(capability.port)
    );
    if (denied) {
      throw new Error(
        `trusted kernel plugin ${manifest.id} declares port outside install policy: ${denied.port}`,
      );
    }
  }

  if (policy.allowedExternalIo) {
    const allowed = new Set(policy.allowedExternalIo);
    const denied = manifest.capabilities.find((capability) =>
      capability.externalIo.some((boundary) => !allowed.has(boundary))
    );
    if (denied) {
      throw new Error(
        `trusted kernel plugin ${manifest.id} declares external I/O outside install policy: ${denied.port}`,
      );
    }
  }
}

function assertImplementationProvenance(
  envelope: TrustedKernelPluginEnvelope,
  plugin: TakosumiKernelPlugin,
  policy: TrustedKernelPluginInstallPolicy,
): void {
  const signed = implementationProvenanceFromManifest(envelope.manifest);
  const implementation = plugin.implementationProvenance ??
    implementationProvenanceFromManifest(plugin.manifest);

  if (policy.requireImplementationProvenance && !signed && !implementation) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} requires implementation provenance metadata`,
    );
  }
  if (!signed && !implementation) return;
  if (!signed) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} implementation provenance is not covered by signed manifest`,
    );
  }
  assertImplementationProvenanceBindsArtifactOrModule(
    envelope.manifest.id,
    signed,
  );
  if (!implementation) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} signed manifest declares implementation provenance that is missing from implementation`,
    );
  }
  assertImplementationProvenanceBindsArtifactOrModule(
    envelope.manifest.id,
    implementation,
  );
  if (stableStringify(implementation) !== stableStringify(signed)) {
    throw new Error(
      `trusted kernel plugin ${envelope.manifest.id} implementation provenance does not match signed manifest`,
    );
  }
}

function implementationProvenanceFromManifest(
  manifest: TakosumiKernelPluginManifest,
): TrustedKernelPluginImplementationProvenance | undefined {
  const metadata = manifest.metadata;
  if (!metadata) return undefined;
  const direct = metadata.implementationProvenance;
  if (direct !== undefined) {
    return assertImplementationProvenanceRecord(manifest.id, direct);
  }
  const trustedInstall = metadata.trustedInstall;
  if (trustedInstall === undefined) return undefined;
  if (!isRecord(trustedInstall)) {
    throw new Error(
      `trusted kernel plugin ${manifest.id} trustedInstall metadata must be an object`,
    );
  }
  const nested = trustedInstall.implementationProvenance;
  if (nested === undefined) return undefined;
  return assertImplementationProvenanceRecord(manifest.id, nested);
}

function assertImplementationProvenanceRecord(
  pluginId: string,
  value: unknown,
): TrustedKernelPluginImplementationProvenance {
  if (!isRecord(value)) {
    throw new Error(
      `trusted kernel plugin ${pluginId} implementation provenance metadata must be an object`,
    );
  }
  return value;
}

function assertImplementationProvenanceBindsArtifactOrModule(
  pluginId: string,
  provenance: TrustedKernelPluginImplementationProvenance,
): void {
  if (
    nonEmptyString(provenance.artifactDigest) ||
    nonEmptyString(provenance.moduleSpecifier) ||
    isRecord(provenance.artifact) ||
    isRecord(provenance.module)
  ) {
    return;
  }
  throw new Error(
    `trusted kernel plugin ${pluginId} implementation provenance must bind an artifact or module`,
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trustedKeyForEnvelope(
  envelope: TrustedKernelPluginEnvelope,
  keys: readonly TrustedKernelPluginKey[],
  policy: TrustedKernelPluginInstallPolicy,
): TrustedKernelPluginKey {
  const key = keys.find((item) => item.keyId === envelope.signature.keyId);
  if (!key) {
    throw new Error(
      `trusted kernel plugin manifest key is not configured: ${envelope.signature.keyId}`,
    );
  }
  if (
    policy.trustedKeyIds &&
    !policy.trustedKeyIds.includes(envelope.signature.keyId)
  ) {
    throw new Error(
      `trusted kernel plugin manifest key is not allowed by install policy: ${envelope.signature.keyId}`,
    );
  }
  if (
    policy.allowedPublisherIds &&
    !policy.allowedPublisherIds.includes(key.publisherId)
  ) {
    throw new Error(
      `trusted kernel plugin publisher is not allowed by install policy: ${key.publisherId}`,
    );
  }
  return key;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, nested]) =>
        `${JSON.stringify(key)}:${stableStringify(nested)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

async function sha256Digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  return `sha256:${await sha256Hex(bytes)}`;
}

async function sha256Text(value: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(value));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    Math.ceil(normalized.length / 4) * 4,
    "=",
  );
  return base64ToBytes(padded);
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
