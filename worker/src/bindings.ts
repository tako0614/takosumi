import type { CredentialRecipeHostComposition } from "takosumi-contract/credential-recipe-host";

export type { CredentialRecipeHostComposition } from "takosumi-contract/credential-recipe-host";

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
  /**
   * Hosted compositions set `predeployed` after the reviewed Accounts
   * migration lane. Every Accounts store created by this Worker then assumes
   * the schema exists and performs no request-time DDL.
   */
  readonly TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE?: import("@takosjp/takosumi-accounts-service").D1AccountsSchemaMode;
  /** Bare operator origin used as the exact Interface OAuth resource base. */
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly R2_ARTIFACTS: R2Bucket;
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
  readonly COORDINATION: DurableObjectNamespace;
  /**
   * Per-run Durable Object that is the sole GA execution authority. The create
   * path schedules it directly; the object drives controller dispatch, retries,
   * and terminal failure handling.
   */
  readonly RUN_OWNER?: DurableObjectNamespace;
  readonly RUNNER?: DurableObjectNamespace;
  /** Operator control-plane bearer for deploy-control routes mounted by hosts. */
  readonly TAKOSUMI_DEPLOY_CONTROL_TOKEN?: string;
  /** Dedicated HMAC secret for generic, route-scoped run credentials. */
  readonly TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET?: string;
  /** Optional Operator/Cloud commercial billing extension (Seam B). */
  readonly TAKOSUMI_BILLING_EXTENSION_FACTORY?: import("takosumi-contract/billing").BillingExtensionFactory;
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
  /** Optional host-code proof for custom Interface OAuth2 resources. */
  readonly TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER?: import("../../core/domains/interfaces/mod.ts").InterfaceOAuth2ResourceAuthorizer;
  readonly TAKOSUMI_ENVIRONMENT?: string;
  /**
   * Runner performance knobs forwarded to the OpenTofu runner container. These
   * are non-secret operational settings: the plugin cache stores provider
   * binaries only. Keepalive is a legacy activity-expiry grace; every completed
   * non-indeterminate Run explicitly destroys its Run-scoped container.
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
   * Additive, code-only Credential Recipe contribution supplied by a trusted
   * composing Worker. This runtime object may contain driver functions and is
   * therefore never decoded from JSON/text vars, database rows, or Outputs.
   */
  readonly TAKOSUMI_CREDENTIAL_RECIPE_HOST_COMPOSITION?: CredentialRecipeHostComposition;
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
   * Operator-only operational capabilities advertised through
   * `/api/v1/capabilities`. CSV/whitespace list, JSON string array, or `all`.
   * This is for DB-backed config / CLI / API / runbook operations, not an
   * operator admin UI switch.
   */
  readonly TAKOSUMI_OPERATOR_CAPABILITIES?: string;
  /**
   * Cloud/Operator-only switch that lets verified operator-scoped managed
   * Provider Connections back Workspace OpenTofu runs. OSS/self-host default is
   * off unless the operator deliberately sets this.
   */
  readonly TAKOSUMI_ALLOW_OPERATOR_BACKED_PROVIDER_ENVS?: string;
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

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(
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
  ): Promise<R2Object | null>;
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
  /** Cloudflare R2 conditional write fence. A failed condition returns null. */
  readonly onlyIf?: {
    readonly etagMatches?: string;
    readonly etagDoesNotMatch?: string;
    readonly uploadedBefore?: Date;
    readonly uploadedAfter?: Date;
  };
}

export interface R2ListOptions {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly delimiter?: string;
  readonly startAfter?: string;
  readonly include?: readonly ("httpMetadata" | "customMetadata")[];
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

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
