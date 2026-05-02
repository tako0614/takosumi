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
 * Operator-injected Google Cloud Storage admin client. Implementations call the
 * `storage.googleapis.com` JSON API to ensure the requested bucket exists with
 * the desired location / storage class / versioning policy.
 *
 * `listBucketObjects` is exposed for paginated drift / inventory.
 */
export interface GcpGcsBucketAdminClient {
  ensureBucket(input: GcpGcsEnsureInput): Promise<GcpGcsEnsureResult>;
  describeBucket?(
    input: GcpGcsDescribeInput,
  ): Promise<GcpGcsObservedRecord | undefined>;
  listBucketObjects?(
    input: GcpGcsListObjectsInput,
  ): Promise<GcpGcsListObjectsResult>;
}

export interface GcpGcsEnsureInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly bucketName: string;
  readonly location?: string;
  readonly storageClass?: string;
  readonly versioning?: boolean;
  readonly publicAccessPrevention?: "enforced" | "inherited";
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpGcsEnsureResult {
  readonly bucketName: string;
  readonly location?: string;
  readonly selfLink?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpGcsObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpGcsDescribeInput {
  readonly projectId: string;
  readonly bucketName: string;
}

export interface GcpGcsObservedRecord {
  readonly bucketName: string;
  readonly location?: string;
  readonly storageClass?: string;
  readonly versioning?: boolean;
  readonly publicAccessPrevention?: string;
}

export interface GcpGcsListObjectsInput {
  readonly bucketName: string;
  readonly prefix?: string;
  readonly pageToken?: string;
  readonly maxResults?: number;
}

export interface GcpGcsObjectEntry {
  readonly name: string;
  readonly size?: number;
  readonly md5Hash?: string;
  readonly updatedAt?: string;
}

export interface GcpGcsListObjectsResult {
  readonly objects: readonly GcpGcsObjectEntry[];
  readonly nextPageToken?: string;
}

export interface GcpGcsProviderOptions {
  readonly client: GcpGcsBucketAdminClient;
  readonly projectId: string;
  readonly bucketName: string;
  readonly location?: string;
  readonly storageClass?: string;
  readonly versioning?: boolean;
  readonly publicAccessPrevention?: "enforced" | "inherited";
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
}

export const GCP_GCS_DESCRIPTOR = "provider.gcp.gcs@v1" as const;

export class GcpGcsProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpGcsBucketAdminClient;
  readonly #projectId: string;
  readonly #bucketName: string;
  readonly #location?: string;
  readonly #storageClass?: string;
  readonly #versioning?: boolean;
  readonly #publicAccessPrevention?: "enforced" | "inherited";
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;

  constructor(options: GcpGcsProviderOptions) {
    this.#client = options.client;
    this.#projectId = options.projectId;
    this.#bucketName = options.bucketName;
    this.#location = options.location;
    this.#storageClass = options.storageClass;
    this.#versioning = options.versioning;
    this.#publicAccessPrevention = options.publicAccessPrevention;
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
      descriptor: GCP_GCS_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: this.#bucketName,
    });
    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.ensureBucket({
          desiredState: structuredClone(desiredState),
          projectId: this.#projectId,
          bucketName: this.#bucketName,
          location: this.#location,
          storageClass: this.#storageClass,
          versioning: this.#versioning,
          publicAccessPrevention: this.#publicAccessPrevention,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_GCS_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: this.#bucketName,
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
          bucketName: this.#bucketName,
          location: this.#location,
          storageClass: this.#storageClass,
          versioning: this.#versioning,
          publicAccessPrevention: this.#publicAccessPrevention,
        }),
        result.observed as unknown as Readonly<Record<string, unknown>>,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-gcs-ensure",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.bucketName ?? this.#bucketName,
      targetName: result?.bucketName ?? this.#bucketName,
      command: [
        "gcloud",
        "storage",
        "buckets",
        "describe",
        `gs://${result?.bucketName ?? this.#bucketName}`,
        `--project=${this.#projectId}`,
      ],
      details: {
        descriptor: GCP_GCS_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#projectId,
          bucketName: result?.bucketName ?? this.#bucketName,
          location: result?.location ?? this.#location,
          storageClass: this.#storageClass,
          versioning: this.#versioning,
          publicAccessPrevention: this.#publicAccessPrevention,
          selfLink: result?.selfLink,
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
      objectAddress: `gs://${result?.bucketName ?? this.#bucketName}`,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(): Promise<GcpDriftReport> {
    if (!this.#client.describeBucket) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const observed = await this.#client.describeBucket({
      projectId: this.#projectId,
      bucketName: this.#bucketName,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    return computeDrift(
      compactRecord({
        bucketName: this.#bucketName,
        location: this.#location,
        storageClass: this.#storageClass,
        versioning: this.#versioning,
        publicAccessPrevention: this.#publicAccessPrevention,
      }),
      observed as unknown as Readonly<Record<string, unknown>>,
      observedAt,
    );
  }

  /**
   * Paginate over all objects in the bucket. Pagination is opt-in: the kernel
   * uses this for inventory or cleanup tasks. Returns all entries collapsed.
   */
  async listAllObjects(
    options: { readonly prefix?: string; readonly pageSize?: number } = {},
  ): Promise<readonly GcpGcsObjectEntry[]> {
    if (!this.#client.listBucketObjects) {
      throw new Error(
        "GcpGcsBucketAdminClient does not implement listBucketObjects",
      );
    }
    const out: GcpGcsObjectEntry[] = [];
    let pageToken: string | undefined;
    let safety = 0;
    do {
      const page = await this.#client.listBucketObjects({
        bucketName: this.#bucketName,
        prefix: options.prefix,
        pageToken,
        maxResults: options.pageSize,
      });
      out.push(...page.objects);
      pageToken = page.nextPageToken;
      safety += 1;
      if (safety > 10_000) break;
    } while (pageToken);
    return out;
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}
