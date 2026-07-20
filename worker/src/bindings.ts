export interface CloudflareWorkerEnv extends Record<string, unknown> {
  readonly TAKOSUMI_CONTROL_DB: D1Database;
  /**
   * `predeployed` disables request-time schema DDL and requires the complete
   * current migration ledger through a strict read-only check. OSS/self-host
   * defaults to `bootstrap`; hosted compositions must set this only after
   * running their reviewed predeploy gate.
   */
  readonly TAKOSUMI_CONTROL_D1_SCHEMA_MODE?: "bootstrap" | "predeployed";
  /**
   * Accounts-plane token store used only by the unified platform composition.
   * API-only/service-lane workers omit it, leaving Interface oauth2 delivery
   * fail-closed as NotReady.
   */
  readonly TAKOSUMI_ACCOUNTS_DB?: import("@takosjp/takosumi-accounts-service").D1Database;
  /** Bare operator origin used as the exact Interface OAuth resource base. */
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly R2_ARTIFACTS: R2Bucket;
  /**
   * Operator-owned immutable Takoform package envelopes and digest-pinned
   * Sigstore TrustedRoot. This binding has no implicit package or publisher.
   */
  readonly R2_FORM_PACKAGES?: R2Bucket;
  /**
   * Non-secret host trust-policy JSON for R2 Form Package verification.
   * Presence requires R2_FORM_PACKAGES and installs no package by itself.
   */
  readonly TAKOSUMI_FORM_PACKAGE_TRUST_POLICY?: string;
  /**
   * Host-code override for custom readers/verifiers. This is a runtime object,
   * not a text var and not portable Form definition authority.
   */
  readonly TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION?: import("../../core/adapters/takoform/mod.ts").TakoformPackageHostComposition;
  /**
   * Complete code-level generic Offering contribution. This may contain
   * database-backed catalog readers and open subject resolvers; it is never a
   * serialized Worker var and contains no commercial binding data.
   */
  readonly TAKOSUMI_OFFERING_HOST_COMPOSITION?: import("takosumi-contract").OfferingHostComposition;
  /**
   * Source-archive bucket (`takosumi-source`). The OpenTofu runner DO persists
   * the deterministic source archive produced by a `source_sync` run here, under
   * the agreed key layout
   * `workspaces/{workspaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst`.
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
  /**
   * Dedicated HMAC secret for run-scoped managed-provider tokens. Absence
   * disables issuance and verification; deploy-control credentials are never
   * reused for this purpose.
   */
  readonly TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET?: string;
  /** Optional Operator/Cloud commercial billing extension (Seam B). */
  readonly TAKOSUMI_BILLING_EXTENSION_FACTORY?: import("takosumi-contract/billing").BillingExtensionFactory;
  /**
   * Optional host-code admission port for Resource deployment quotes and
   * reserve/capture/release settlement. OSS contributes no pricing policy and
   * therefore leaves this unset; an operator composition may inject a durable
   * implementation without changing the canonical `/v1/resources` lifecycle.
   */
  readonly TAKOSUMI_RESOURCE_DEPLOYMENT_ADMISSION?: import("takosumi-contract/resource-deployment").ResourceDeploymentAdmission;
  /**
   * Code-only immutable artifact storage port. This is never a serialized
   * Wrangler variable and never carries credentials through Run/Output rows.
   */
  readonly TAKOSUMI_RESOURCE_ARTIFACT_WRITER?: import("takosumi-contract").ResourceArtifactWriter;
  /**
   * Host-code projector for recoverable runtime routing/activation state.
   * Canonical Interface and Binding rows remain authority.
   */
  readonly TAKOSUMI_INTERFACE_PROJECTION_SINK?: import("takosumi-contract/interfaces").InterfaceProjectionSink;
  /**
   * Enables the optional, versioned operator-control MCP adapter at the
   * platform worker's `/mcp/operator-control/v1` route. The route is absent
   * unless this exact flag is `1`; authorization still requires a current
   * Principal `mcp.invoke` InterfaceBinding and invocation-time OAuth token.
   */
  readonly TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED?: string;
  /**
   * Explicit host-code bridge from a Resource Shape namespace to the Workspace
   * allowed to own that Resource's runtime Interfaces. Resource and Workspace
   * ids are independent namespaces in OSS; absence therefore keeps
   * Resource-owned and `resource_output` Interfaces fail-closed. A composing
   * host may inject a policy-backed resolver, but this is never a text var or
   * an implicit equal-id fallback.
   */
  readonly TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER?: import("../../core/domains/interfaces/mod.ts").ResourceInterfaceWorkspaceResolver;
  /**
   * Host-code resolver for a portable Form descriptor's canonical
   * `resource_uri` input. It is never accepted as a serialized Wrangler var.
   */
  readonly TAKOSUMI_FORM_INTERFACE_RESOURCE_URI_RESOLVER?: import("../../core/domains/interfaces/mod.ts").FormInterfaceResourceUriResolver;
  /**
   * Additional host-code proof for Resource-owned OAuth2 Interface audiences.
   * OSS contributes no external Resource audience. This must be a runtime
   * function supplied by the composing host, never a Wrangler text variable.
   */
  readonly TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?: import("../../core/domains/interfaces/mod.ts").InterfaceOAuth2ResourceAuthorizer;
  readonly TAKOSUMI_ENVIRONMENT?: string;
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
  readonly TAKOSUMI_PLAN_JSON_ARTIFACT_MAX_BYTES?: string;
  /**
   * Maximum auto-sync Sources a scheduled cron tick may enqueue. This is an
   * operator load-shedding knob for runner-backed source_sync runs.
   */
  readonly TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH?: string;
  /**
   * Read-only scheduled Resource observation. When omitted it follows whether
   * this host enables any Resource Shape kinds; `0` disables and `1` enables.
   */
  readonly TAKOSUMI_RESOURCE_OBSERVATION_ENABLED?: string;
  /** Maximum due Resources claimed by one cron tick. */
  readonly TAKOSUMI_RESOURCE_OBSERVATION_BATCH?: string;
  /** Maximum backend observations running concurrently. */
  readonly TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY?: string;
  /** Minimum seconds between completed attempts for one Resource. */
  readonly TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS?: string;
  /** Seconds before another isolate may reclaim an abandoned claim. */
  readonly TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS?: string;
  /**
   * Local/private probe ingress opt-in for the `/internal/v1/*` HTTP seam.
   * Production edge deployments omit this so generic internal APIs stay 404.
   */
  readonly TAKOSUMI_EXPOSE_INTERNAL_EDGE?: string;
  readonly LOCAL_SUBSTRATE_TEST_BED?: string;
  readonly TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL?: string;
  /**
   * Operator-curated execution profiles. The built-in value is the
   * provider-neutral `opentofu-default`; extra ids represent execution
   * capabilities, not provider brands.
   */
  readonly TAKOSUMI_ENABLED_RUNNER_PROFILES?: string;
  /**
   * Host-code contribution for additional RunnerProfiles and their executor
   * adapters. This is a runtime object supplied by a composing Worker, not a
   * JSON/text var, provider catalog, or OpenTofu Output. The stock composition
   * contributes only the provider-neutral `opentofu-default` profile.
   */
  readonly TAKOSUMI_RUNNER_HOST_COMPOSITION?: RunnerHostComposition;
  /**
   * Complete host-code InstallConfig composition. This runtime object replaces
   * the shipped reference app set (an empty array disables it); it is not a
   * JSON/text var, Store listing, repository manifest, or OpenTofu Output.
   */
  readonly TAKOSUMI_INSTALL_CONFIG_COMPOSITION?: readonly import("takosumi-contract/install-configs").InstallConfig[];
  /**
   * Optional default profile for generic Capsule plans when the public request
   * does not pass runnerProfileId. Must be one of the enabled runner profiles;
   * omitted uses `opentofu-default`.
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
  /**
   * Optional operator/Cloud release activation webhook. The URL may be a plain
   * Worker var; the token must be configured as a secret binding. This generic
   * bridge does not implement provider-specific publication in the OSS worker.
   */
  readonly TAKOSUMI_RELEASE_ACTIVATOR_URL?: string;
  readonly TAKOSUMI_RELEASE_ACTIVATOR_TOKEN?: string;
  /**
   * Non-secret R2 bucket name that stores source snapshots for this operator
   * environment. Release activation runs outside the Worker binding context, so
   * the webhook payload carries this as a bucket hint for the operator
   * materializer.
   */
  readonly TAKOSUMI_RELEASE_SOURCE_BUCKET?: string;
  readonly TAKOSUMI_PRODUCTION_HARDENING_GATE?: string;
  /**
   * Host-code hardening definitions composed with the generic OSS baseline.
   * This is a runtime object, not a text var or evidence source.
   */
  readonly TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS?: readonly import("takosumi-contract").PlatformHardeningContribution[];
  /**
   * Non-secret JSON gate bundle emitted by the production-hardening evidence
   * validator. Check-specific private documents stay outside the Worker.
   */
  readonly TAKOSUMI_PLATFORM_HARDENING_EVIDENCE?: string;
  /**
   * Operator allowlist for Resource Shape kinds exposed by `/v1/resources`.
   * CSV/whitespace list or `all`; unset means no public shape kinds.
   */
  readonly TAKOSUMI_RESOURCE_SHAPES?: string;
  /**
   * Host-code contribution for operator-defined Resource Shape validation.
   * This is a runtime object supplied by a composing Worker, not a text var or
   * an OpenTofu output. Custom shape tokens are rejected without it.
   */
  readonly TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY?: import("../../core/domains/resource-shape/mod.ts").ResourceShapeSchemaRegistry;
  /**
   * Host-code lookup for reviewed OpenTofu module templates named by Target
   * implementation descriptors. Takosumi OSS ships no implicit module catalog.
   */
  readonly TAKOSUMI_RESOURCE_SHAPE_MODULE_REGISTRY?: import("../../core/domains/resource-shape/mod.ts").ResourceShapeModuleRegistry;
  /**
   * Operator-installed Resource Shape adapter capability tokens advertised
   * through `/v1/capabilities`. CSV/whitespace list or JSON string array.
   */
  readonly TAKOSUMI_RESOURCE_ADAPTERS?: string;
  /**
   * Operator-only operational capabilities advertised through
   * `/v1/capabilities`. CSV/whitespace list, JSON string array, or `all`.
   * This is for DB-backed config / CLI / API / runbook operations, not an
   * operator admin UI switch.
   */
  readonly TAKOSUMI_OPERATOR_CAPABILITIES?: string;
  /**
   * Operator-installed Resource Shape adapter plugins. JSON array of
   * `{ "plugin": "...", "handlerKey": "..." }`. The handler key must resolve
   * to a fetch-compatible binding on the host Worker env. OSS treats this as a
   * generic adapter seam; the concrete handler belongs to the operator/Cloud.
   */
  readonly TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS?: string;
  /**
   * Operator-managed provider/compat API base URLs that may appear in Resource
   * Shape TargetPool implementation options. CSV/whitespace list or JSON
   * string array. Unset means provider base URL overrides are rejected.
   */
  readonly TAKOSUMI_RESOURCE_PROVIDER_BASE_URL_ALLOWLIST?: string;
  /**
   * Cloud/Operator-only switch that lets verified operator-scoped managed
   * Provider Connections back Workspace OpenTofu runs. OSS/self-host default is
   * off unless the operator deliberately sets this.
   */
  readonly TAKOSUMI_ALLOW_OPERATOR_BACKED_PROVIDER_ENVS?: string;
  /** Public hostname namespace owned by the operator-managed target. */
  readonly TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN?: string;
  /** Owner-account allowance for short names under the managed base domain. */
  readonly TAKOSUMI_MANAGED_VANITY_HOST_SLOTS_PER_OWNER?: string;
}

/**
 * Open execution extension point owned by the operator's composition root.
 * Profile ids still have to be enabled explicitly through
 * `TAKOSUMI_ENABLED_RUNNER_PROFILES`; executor registry membership is the only
 * dispatch authority for a profile's `executorId`.
 */
export interface RunnerHostComposition {
  readonly profiles: readonly import("@takosumi/internal/deploy-control-api").RunnerProfile[];
  readonly executors?: import("../../core/domains/deploy-control/mod.ts").OpenTofuRunnerExecutorRegistry;
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
  readonly workspaceId: string;
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
   * on a busy Capsule lease instead of burning its retry budget.
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
