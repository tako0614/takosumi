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
 * Operator-injected Cloud KMS admin client. Implementations call the
 * `cloudkms.googleapis.com` REST API to ensure the requested keyring + key
 * exist with the desired purpose / rotation period / protection level.
 */
export interface GcpKmsAdminClient {
  ensureCryptoKey(input: GcpKmsEnsureInput): Promise<GcpKmsEnsureResult>;
  describeCryptoKey?(
    input: GcpKmsDescribeInput,
  ): Promise<GcpKmsObservedRecord | undefined>;
}

export interface GcpKmsEnsureInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly location: string;
  readonly keyRingName: string;
  readonly cryptoKeyName: string;
  readonly purpose?: "ENCRYPT_DECRYPT" | "ASYMMETRIC_SIGN" | "MAC";
  readonly rotationPeriod?: string;
  readonly protectionLevel?: "SOFTWARE" | "HSM";
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpKmsEnsureResult {
  readonly cryptoKeyResourceName: string;
  readonly primaryVersion?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpKmsObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpKmsDescribeInput {
  readonly projectId: string;
  readonly location: string;
  readonly keyRingName: string;
  readonly cryptoKeyName: string;
}

export interface GcpKmsObservedRecord {
  readonly cryptoKeyResourceName: string;
  readonly purpose?: string;
  readonly rotationPeriod?: string;
  readonly protectionLevel?: string;
  readonly primaryVersion?: string;
}

export interface GcpKmsProviderOptions {
  readonly client: GcpKmsAdminClient;
  readonly projectId: string;
  readonly location: string;
  readonly keyRingName: string;
  readonly cryptoKeyName: string;
  readonly purpose?: "ENCRYPT_DECRYPT" | "ASYMMETRIC_SIGN" | "MAC";
  readonly rotationPeriod?: string;
  readonly protectionLevel?: "SOFTWARE" | "HSM";
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

export const GCP_KMS_DESCRIPTOR = "provider.gcp.kms@v1" as const;

export class GcpKmsProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpKmsAdminClient;
  readonly #projectId: string;
  readonly #location: string;
  readonly #keyRingName: string;
  readonly #cryptoKeyName: string;
  readonly #purpose?: "ENCRYPT_DECRYPT" | "ASYMMETRIC_SIGN" | "MAC";
  readonly #rotationPeriod?: string;
  readonly #protectionLevel?: "SOFTWARE" | "HSM";
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpKmsProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#location = options.location;
    this.#keyRingName = options.keyRingName;
    this.#cryptoKeyName = options.cryptoKeyName;
    this.#purpose = options.purpose;
    this.#rotationPeriod = options.rotationPeriod;
    this.#protectionLevel = options.protectionLevel;
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
      descriptor: GCP_KMS_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: `${this.#keyRingName}/${this.#cryptoKeyName}`,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.ensureCryptoKey({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          location: this.#location,
          keyRingName: this.#keyRingName,
          cryptoKeyName: this.#cryptoKeyName,
          purpose: this.#purpose,
          rotationPeriod: this.#rotationPeriod,
          protectionLevel: this.#protectionLevel,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_KMS_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: `${this.#keyRingName}/${this.#cryptoKeyName}`,
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
          cryptoKeyName: this.#cryptoKeyName,
          purpose: this.#purpose,
          rotationPeriod: this.#rotationPeriod,
          protectionLevel: this.#protectionLevel,
        }),
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-kms-ensure",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.cryptoKeyResourceName ?? this.#cryptoKeyName,
      targetName: this.#cryptoKeyName,
      command: [
        "gcloud",
        "kms",
        "keys",
        "describe",
        this.#cryptoKeyName,
        `--keyring=${this.#keyRingName}`,
        `--location=${this.#location}`,
        `--project=${this.#projectId}`,
      ],
      details: {
        descriptor: GCP_KMS_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#projectId,
          location: this.#location,
          keyRingName: this.#keyRingName,
          cryptoKeyName: this.#cryptoKeyName,
          cryptoKeyResourceName: result?.cryptoKeyResourceName,
          primaryVersion: result?.primaryVersion,
          purpose: this.#purpose,
          rotationPeriod: this.#rotationPeriod,
          protectionLevel: this.#protectionLevel,
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
      objectAddress: result?.cryptoKeyResourceName,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeCryptoKey) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeCryptoKey({
      projectId: this.#projectId,
      location: this.#location,
      keyRingName: this.#keyRingName,
      cryptoKeyName: this.#cryptoKeyName,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    return computeDrift(
      compactRecord({
        cryptoKeyName: this.#cryptoKeyName,
        purpose: this.#purpose,
        rotationPeriod: this.#rotationPeriod,
        protectionLevel: this.#protectionLevel,
      }),
      observed,
      observedAt,
    );
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}
