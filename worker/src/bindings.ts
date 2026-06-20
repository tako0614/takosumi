export interface CloudflareWorkerEnv extends Record<string, unknown> {
  readonly TAKOSUMI_CONTROL_DB: D1Database;
  readonly R2_ARTIFACTS: R2Bucket;
  /**
   * Source-archive bucket (`takosumi-source`). The OpenTofu runner DO persists
   * the deterministic source archive produced by a `source_sync` run here, under
   * the agreed key layout
   * `spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst`.
   * Separate from `R2_ARTIFACTS` (plan/run artifacts) so source bytes have their own
   * lifecycle. The binding is wired by the service lane; this type is additive.
   */
  readonly R2_SOURCE?: R2Bucket;
  /** OpenTofu state bucket (`takosumi-state`). Used from M2. */
  readonly R2_STATE?: R2Bucket;
  /** Backup/export bucket (`takosumi-backups`, core-spec.md §26 / §33). */
  readonly R2_BACKUPS?: R2Bucket;
  readonly RUN_QUEUE?: Queue<OpenTofuRunQueueMessage>;
  readonly COORDINATION: DurableObjectNamespace;
  readonly RUNNER?: DurableObjectNamespace;
  /** Operator control-plane bearer for deploy-control routes mounted by hosts. */
  readonly TAKOSUMI_DEPLOY_CONTROL_TOKEN?: string;
  /**
   * Local/private probe ingress opt-in for the `/internal/v1/*` HTTP seam.
   * Production edge deployments omit this so generic internal APIs stay 404.
   */
  readonly TAKOSUMI_EXPOSE_INTERNAL_EDGE?: string;
  readonly LOCAL_SUBSTRATE_TEST_BED?: string;
  /**
   * Operator-curated provider surface: CSV of runner profile ids the operator
   * enables (e.g. `"cloudflare-default,aws-provider-env-candidate"`). Only listed ids appear in
   * `/v1/runner-profiles` and policy evaluation, each with
   * `takosumi.com/profile-enabled=true`. Unset/empty defaults to
   * `"cloudflare-default"`.
   */
  readonly TAKOSUMI_ENABLED_RUNNER_PROFILES?: string;
  /**
   * Cloud-only hosted-provider-connection switch. When set to `enabled`, the
   * platform composition may expose Space-scoped ProviderConnections backed by
   * operator-scoped Connections (`takos_provided`).
   */
  readonly TAKOSUMI_CLOUD_OPERATOR_PROVIDER_CONNECTIONS?: string;
  readonly TAKOSUMI_PRODUCTION_HARDENING_GATE?: string;
  readonly TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF?: string;
  readonly TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF?: string;
  readonly TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST?: string;
}

export type OpenTofuRunAction =
  | "plan"
  | "apply"
  | "destroy"
  | "source_sync"
  | "compatibility_check"
  | "backup"
  | "restore";

/**
 * Run-dispatch message on `RUN_QUEUE`. The producer (the
 * controller's `enqueueRun` seam) publishes only the run identity; the queue
 * consumer loads the full run from the deploy-control store, applies the
 * idempotency guard, mints credentials, and drives the container dispatch. The
 * legacy `requestedAt` / `request` fields are retained as optional so older
 * messages still parse, but the consumer no longer depends on them.
 */
export interface OpenTofuRunQueueMessage {
  readonly kind: "takosumi.opentofu-run@v1";
  readonly action: OpenTofuRunAction;
  readonly runId: string;
  readonly spaceId: string;
  readonly requestedAt?: string;
  readonly request?: Record<string, unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]>;
}

export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  readonly results?: readonly T[];
  readonly success?: boolean;
  readonly meta?: {
    readonly changes?: number;
    readonly last_row_id?: number;
    readonly rows_read?: number;
    readonly rows_written?: number;
  };
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(key: string): Promise<void>;
}

export interface R2PutOptions {
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface R2ListOptions {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface R2Objects {
  readonly objects: readonly R2Object[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Queue<T> {
  send(message: T): Promise<void>;
}

export interface QueueBatch<T = unknown> {
  /** The queue this batch was delivered from (used to detect the DLQ). */
  readonly queue?: string;
  readonly messages: readonly QueueMessage<T>[];
}

export interface QueueRetryOptions {
  /**
   * Delay before this message is redelivered (Cloudflare Queues
   * `MessageRetryOptions.delaySeconds`). Used to back off a run that is parked
   * on a busy installation lease instead of burning its retry budget.
   */
  readonly delaySeconds?: number;
}

export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly body: T;
  /** Delivery attempt count (1-based) when the runtime provides it. */
  readonly attempts?: number;
  ack?(): void;
  retry?(options?: QueueRetryOptions): void;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface WorkersForPlatformsDispatchNamespace {
  get(
    scriptName: string,
    options?: WorkersForPlatformsDispatchOptions,
    context?: WorkersForPlatformsDispatchContext,
  ): WorkersForPlatformsUserWorker;
}

export interface WorkersForPlatformsDispatchOptions {
  readonly limits?: Record<string, unknown>;
  readonly outbound?: Record<string, unknown>;
}

export interface WorkersForPlatformsDispatchContext {
  readonly outbound?: Record<string, unknown>;
}

export interface WorkersForPlatformsUserWorker {
  fetch(request: Request): Promise<Response>;
}
