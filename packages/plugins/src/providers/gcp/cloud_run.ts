import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  buildRuntimeDetails,
  compactRecord,
  computeDrift,
  computeIdempotencyKey,
  deepFreeze,
  executionFromCondition,
  GCP_OK_CONDITION,
  type GcpDriftReport,
  type GcpRuntimeHooks,
  resolveRuntimeContext,
  withRetry,
} from "./_runtime.ts";

/**
 * Operator-injected Cloud Run deploy client. Implementations call the
 * `run.googleapis.com` REST API (or `gcloud run deploy`) to push or update a
 * service revision. The plugin layer stays transport agnostic and consumes a
 * fetch-based JSON gateway in the live operator profile.
 *
 * Long-running revisions ( >`runtime.policy.longRunningThresholdMs` ) are
 * handed off to the runtime-agent via {@link GcpRuntimeAgentHandoff} so the
 * kernel can observe completion later via {@link describeService}.
 */
export interface GcpCloudRunDeployClient {
  applyService(
    input: GcpCloudRunDeployInput,
  ): Promise<GcpCloudRunDeployResult>;
  /** Optional drift / observation hook used by `observe()`. */
  describeService?(
    input: GcpCloudRunDescribeInput,
  ): Promise<GcpCloudRunObservedRecord | undefined>;
}

export interface GcpCloudRunDeployInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly region: string;
  readonly serviceName?: string;
  readonly imageRef?: string;
  readonly serviceAccount?: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpCloudRunDeployResult {
  readonly serviceName: string;
  readonly revisionName?: string;
  readonly url?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpCloudRunObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpCloudRunDescribeInput {
  readonly projectId: string;
  readonly region: string;
  readonly serviceName: string;
}

export interface GcpCloudRunObservedRecord {
  readonly serviceName: string;
  readonly revisionName?: string;
  readonly url?: string;
  readonly imageRef?: string;
  readonly serviceAccount?: string;
  readonly ready?: boolean;
}

export interface GcpCloudRunProviderOptions {
  readonly client: GcpCloudRunDeployClient;
  readonly projectId: string;
  readonly region: string;
  readonly serviceName?: string;
  readonly imageRef?: string;
  readonly serviceAccount?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

/** Descriptor identifier consumed by Deployment.desired graphs. */
export const GCP_CLOUD_RUN_DESCRIPTOR = "provider.gcp.cloud-run@v1" as const;

export class GcpCloudRunProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpCloudRunDeployClient;
  readonly #projectId: string;
  readonly #region: string;
  readonly #serviceName?: string;
  readonly #imageRef?: string;
  readonly #serviceAccount?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpCloudRunProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#region = options.region;
    this.#serviceName = options.serviceName;
    this.#imageRef = options.imageRef;
    this.#serviceAccount = options.serviceAccount;
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
      descriptor: GCP_CLOUD_RUN_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: this.#serviceName ?? desiredState.appName,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.applyService({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          region: this.#region,
          serviceName: this.#serviceName,
          imageRef: this.#imageRef,
          serviceAccount: this.#serviceAccount,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_CLOUD_RUN_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: this.#serviceName ?? desiredState.appName,
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
          serviceName: result.serviceName,
          imageRef: this.#imageRef,
          serviceAccount: this.#serviceAccount,
          region: this.#region,
        }),
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-cloud-run-apply",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.serviceName,
      targetName: result?.serviceName ?? this.#serviceName ??
        desiredState.appName,
      command: [
        "gcloud",
        "run",
        "deploy",
        result?.serviceName ?? this.#serviceName ?? desiredState.appName,
        `--project=${this.#projectId}`,
        `--region=${this.#region}`,
      ],
      details: {
        descriptor: GCP_CLOUD_RUN_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#projectId,
          region: this.#region,
          serviceName: result?.serviceName ?? this.#serviceName,
          revisionName: result?.revisionName,
          url: result?.url,
          imageRef: this.#imageRef,
          serviceAccount: this.#serviceAccount,
          workloadCount: desiredState.workloads.length,
          resourceCount: desiredState.resources.length,
          routeCount: desiredState.routes.length,
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
      objectAddress: result?.url,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  /**
   * Read observed Cloud Run state and return a drift report against the
   * provider configuration. Used by the kernel reconciler to detect drift.
   */
  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeService || !this.#serviceName) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeService({
      projectId: this.#projectId,
      region: this.#region,
      serviceName: this.#serviceName,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    const desired = compactRecord({
      serviceName: this.#serviceName,
      imageRef: this.#imageRef,
      serviceAccount: this.#serviceAccount,
      region: this.#region,
    });
    return computeDrift(
      desired,
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

// Re-export a no-op condition to keep API stable for tests.
export { GCP_OK_CONDITION };
