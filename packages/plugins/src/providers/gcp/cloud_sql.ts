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
 * Operator-injected Cloud SQL admin client. Implementations call the
 * `sqladmin.googleapis.com` REST API to ensure the requested instance and
 * database / user exist, returning a connection name suitable for
 * Deployment.desired binding records.
 */
export interface GcpCloudSqlAdminClient {
  ensureInstance(
    input: GcpCloudSqlEnsureInput,
  ): Promise<GcpCloudSqlEnsureResult>;
  describeInstance?(
    input: GcpCloudSqlDescribeInput,
  ): Promise<GcpCloudSqlObservedRecord | undefined>;
}

export interface GcpCloudSqlEnsureInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly region: string;
  readonly instanceId: string;
  readonly databaseVersion?: string;
  readonly tier?: string;
  readonly databaseName?: string;
  readonly userName?: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpCloudSqlEnsureResult {
  readonly instanceId: string;
  readonly connectionName?: string;
  readonly databaseName?: string;
  readonly userName?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpCloudSqlObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpCloudSqlDescribeInput {
  readonly projectId: string;
  readonly instanceId: string;
}

export interface GcpCloudSqlObservedRecord {
  readonly instanceId: string;
  readonly region?: string;
  readonly databaseVersion?: string;
  readonly tier?: string;
  readonly state?: string;
  readonly connectionName?: string;
}

export interface GcpCloudSqlProviderOptions {
  readonly client: GcpCloudSqlAdminClient;
  readonly projectId: string;
  readonly region: string;
  readonly instanceId: string;
  readonly databaseVersion?: string;
  readonly tier?: string;
  readonly databaseName?: string;
  readonly userName?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

export const GCP_CLOUD_SQL_DESCRIPTOR = "provider.gcp.cloud-sql@v1" as const;

export class GcpCloudSqlProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpCloudSqlAdminClient;
  readonly #projectId: string;
  readonly #region: string;
  readonly #instanceId: string;
  readonly #databaseVersion?: string;
  readonly #tier?: string;
  readonly #databaseName?: string;
  readonly #userName?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpCloudSqlProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#region = options.region;
    this.#instanceId = options.instanceId;
    this.#databaseVersion = options.databaseVersion;
    this.#tier = options.tier;
    this.#databaseName = options.databaseName;
    this.#userName = options.userName;
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
      descriptor: GCP_CLOUD_SQL_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: this.#instanceId,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.ensureInstance({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          region: this.#region,
          instanceId: this.#instanceId,
          databaseVersion: this.#databaseVersion,
          tier: this.#tier,
          databaseName: this.#databaseName,
          userName: this.#userName,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_CLOUD_SQL_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: this.#instanceId,
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
          instanceId: this.#instanceId,
          databaseVersion: this.#databaseVersion,
          tier: this.#tier,
          region: this.#region,
        }),
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-cloud-sql-ensure",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.instanceId ?? this.#instanceId,
      targetName: result?.instanceId ?? this.#instanceId,
      command: [
        "gcloud",
        "sql",
        "instances",
        "describe",
        result?.instanceId ?? this.#instanceId,
        `--project=${this.#projectId}`,
      ],
      details: {
        descriptor: GCP_CLOUD_SQL_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#projectId,
          region: this.#region,
          instanceId: result?.instanceId ?? this.#instanceId,
          connectionName: result?.connectionName,
          databaseName: result?.databaseName ?? this.#databaseName,
          userName: result?.userName ?? this.#userName,
          databaseVersion: this.#databaseVersion,
          tier: this.#tier,
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
      objectAddress: result?.connectionName,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeInstance) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeInstance({
      projectId: this.#projectId,
      instanceId: this.#instanceId,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    return computeDrift(
      compactRecord({
        instanceId: this.#instanceId,
        databaseVersion: this.#databaseVersion,
        tier: this.#tier,
        region: this.#region,
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
