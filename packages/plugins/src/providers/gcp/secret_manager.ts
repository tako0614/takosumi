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
 * Operator-injected Secret Manager admin client. Implementations call the
 * `secretmanager.googleapis.com` REST API to ensure the requested secret
 * resource exists with the desired replication / labels configuration. Secret
 * value enrolment is owned by `secretStore.SecretStorePort`; this materializer
 * only provisions the container so binding records can resolve.
 */
export interface GcpSecretManagerAdminClient {
  ensureSecret(
    input: GcpSecretManagerEnsureInput,
  ): Promise<GcpSecretManagerEnsureResult>;
  describeSecret?(
    input: GcpSecretManagerDescribeInput,
  ): Promise<GcpSecretManagerObservedRecord | undefined>;
}

export interface GcpSecretManagerEnsureInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly secretId: string;
  readonly replicationPolicy?: "automatic" | "user-managed";
  readonly replicationLocations?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpSecretManagerEnsureResult {
  readonly secretResourceName: string;
  readonly latestVersion?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpSecretManagerObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpSecretManagerDescribeInput {
  readonly projectId: string;
  readonly secretId: string;
}

export interface GcpSecretManagerObservedRecord {
  readonly secretResourceName: string;
  readonly replicationPolicy?: string;
  readonly replicationLocations?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly latestVersion?: string;
}

export interface GcpSecretManagerProviderOptions {
  readonly client: GcpSecretManagerAdminClient;
  readonly projectId: string;
  readonly secretId: string;
  readonly replicationPolicy?: "automatic" | "user-managed";
  readonly replicationLocations?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

export const GCP_SECRET_MANAGER_DESCRIPTOR =
  "provider.gcp.secret-manager@v1" as const;

export class GcpSecretManagerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpSecretManagerAdminClient;
  readonly #projectId: string;
  readonly #secretId: string;
  readonly #replicationPolicy?: "automatic" | "user-managed";
  readonly #replicationLocations?: readonly string[];
  readonly #labels?: Record<string, string>;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpSecretManagerProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#secretId = options.secretId;
    this.#replicationPolicy = options.replicationPolicy;
    this.#replicationLocations = options.replicationLocations;
    this.#labels = options.labels;
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
      descriptor: GCP_SECRET_MANAGER_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: this.#secretId,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.ensureSecret({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          secretId: this.#secretId,
          replicationPolicy: this.#replicationPolicy,
          replicationLocations: this.#replicationLocations,
          labels: this.#labels,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_SECRET_MANAGER_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: this.#secretId,
          idempotencyKey,
          enqueuedAt: startedAt,
        },
      },
    );
    const completedAt = ctx.clock().toISOString();
    const result = outcome.result;
    const desiredFingerprint = compactRecord({
      secretId: this.#secretId,
      replicationPolicy: this.#replicationPolicy,
    });
    const drift = result?.observed
      ? computeDrift(
        desiredFingerprint,
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-secret-manager-ensure",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.secretResourceName ?? this.#secretId,
      targetName: this.#secretId,
      command: [
        "gcloud",
        "secrets",
        "describe",
        this.#secretId,
        `--project=${this.#projectId}`,
      ],
      details: {
        descriptor: GCP_SECRET_MANAGER_DESCRIPTOR,
        projectId: this.#projectId,
        secretId: this.#secretId,
        ...(result?.secretResourceName
          ? { secretResourceName: result.secretResourceName }
          : {}),
        ...(result?.latestVersion
          ? { latestVersion: result.latestVersion }
          : {}),
        ...(this.#replicationPolicy
          ? { replicationPolicy: this.#replicationPolicy }
          : {}),
        ...(this.#replicationLocations
          ? { replicationLocations: [...this.#replicationLocations] }
          : {}),
        ...(this.#labels ? { labels: { ...this.#labels } } : {}),
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
      objectAddress: result?.secretResourceName,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeSecret) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeSecret({
      projectId: this.#projectId,
      secretId: this.#secretId,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    return computeDrift(
      compactRecord({
        secretId: this.#secretId,
        replicationPolicy: this.#replicationPolicy,
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
