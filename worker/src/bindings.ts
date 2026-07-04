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
  /**
   * Per-run Durable Object that owns execution after a queue delivery is
   * validated. Queue consumers schedule this object and ack quickly; the object
   * drives controller dispatch, retries, and final DLQ-style failure handling.
   */
  readonly RUN_OWNER?: DurableObjectNamespace;
  readonly RUNNER?: DurableObjectNamespace;
  /** Operator control-plane bearer for deploy-control routes mounted by hosts. */
  readonly TAKOSUMI_DEPLOY_CONTROL_TOKEN?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_API_BASE?: string;
  readonly TAKOSUMI_ENVIRONMENT?: string;
  readonly TAKOSUMI_RUNTIME_CELL_ID?: string;
  readonly TAKOSUMI_RUNTIME_CELL?: string;
  /**
   * Runner performance knobs forwarded to the OpenTofu runner container. These
   * are non-secret operational settings: the plugin cache stores provider
   * binaries only, and keepalive only controls warm container lifetime.
   */
  readonly TAKOSUMI_RUNNER_KEEPALIVE_SECONDS?: string;
  readonly TAKOSUMI_RUNNER_CAPACITY_RETRY_ATTEMPTS?: string;
  readonly TAKOSUMI_RUNNER_CAPACITY_RETRY_BASE_MS?: string;
  readonly TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR?: string;
  readonly TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL?: string;
  /**
   * Maximum auto-sync Sources a scheduled cron tick may enqueue. This is an
   * operator load-shedding knob for runner-backed source_sync runs.
   */
  readonly TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH?: string;
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
   * Optional default profile for generic Capsule plans when the public request
   * does not pass runnerProfileId. Must be one of the enabled runner profiles;
   * omitted keeps the conservative Cloudflare default.
   */
  readonly TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID?: string;
  /**
   * Maximum time the request path waits for the runner-backed Capsule
   * compatibility source-file extraction. Compatibility checks are still
   * recorded as Runs by the control plane; this prevents a stuck runner DO from
   * holding `/api/v1/deploy` or dashboard compatibility requests open for
   * minutes before the caller receives an actionable failure.
   */
  readonly TAKOSUMI_COMPATIBILITY_CHECK_TIMEOUT_MS?: string;
  readonly TAKOSUMI_OFFICIAL_CATALOG_GIT?: string;
  readonly TAKOSUMI_OFFICIAL_CATALOG_REF?: string;
  /**
   * Optional operator/Cloud release activation webhook. The URL may be a plain
   * Worker var; the token must be configured as a secret binding. This generic
   * bridge does not implement provider-specific publication in the OSS worker.
   */
  readonly TAKOSUMI_RELEASE_ACTIVATOR_URL?: string;
  readonly TAKOSUMI_RELEASE_ACTIVATOR_TOKEN?: string;
  readonly TAKOSUMI_PRODUCTION_HARDENING_GATE?: string;
  readonly TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF?: string;
  readonly TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF?: string;
  readonly TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST?: string;
  /**
   * Operator allowlist for Resource Shape kinds exposed by `/v1/resources`.
   * CSV/whitespace list or `all`; unset means no public shape kinds.
   */
  readonly TAKOSUMI_RESOURCE_SHAPES?: string;
  /**
   * Operator allowlist for Resource Shape adapter families advertised through
   * `/v1/capabilities`. CSV/whitespace list or `all`.
   */
  readonly TAKOSUMI_RESOURCE_ADAPTERS?: string;
  /**
   * Operator-defined Resource Shape adapter capability tokens advertised through
   * `/v1/capabilities`. CSV/whitespace list or JSON string array. These are not
   * parsed as known built-in adapter families; they are accepted as extension
   * tokens and must still be backed by TargetPool capability evidence and a
   * plugin-aware adapter at runtime.
   */
  readonly TAKOSUMI_RESOURCE_ADAPTER_EXTENSIONS?: string;
  /**
   * Operator-installed Resource Shape adapter plugins. JSON array of
   * `{ "plugin": "...", "handlerKey": "..." }`. The handler key must resolve
   * to a fetch-compatible binding on the host Worker env. OSS treats this as a
   * generic adapter seam; the concrete handler belongs to the operator/Cloud.
   */
  readonly TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS?: string;
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
  readonly cause?: "controller_retry";
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
