/**
 * Typed client for the session-authenticated Takosumi control-plane
 * `/api/v1/*` route family.
 *
 * The dashboard SPA authenticates with the Accounts HttpOnly `takosumi_session`
 * cookie, not the operator deploy-control bearer. Accounts resolves the cookie
 * into a scoped principal and then delegates to the in-process control facade;
 * `/api/v1/*` remains the product control API for Workspaces, Capsules, Runs,
 * Connections, and related resources.
 *
 * The `/api/v1/*` routes pass the control-plane contract types through
 * `JSON.stringify` unchanged, so
 * the wire shape is the camelCase contract shape. The exported DTOs below are
 * the dashboard's local view-model mirrors of the deploy-control contract. The
 * type-only assertions near the mirror definitions ensure contract response
 * types remain assignable to the dashboard view models.
 */

import type { DestroyProviderConnectionReplacement } from "takosumi-contract";
import { randomUuid } from "./random-uuid.ts";
import {
  canReuseRecentSharedAuthProbe,
  invalidateRecentSharedAuthProbe,
  isKnownSharedAuthRouteAbsent,
  preflightSharedAuthSession,
  requireSharedAuthReadResponse,
  SHARED_AUTH_READ_HEADER,
  SharedAuthSessionPreflightError,
  throwIfSharedAuthCallerAborted,
} from "./shared-auth-session-preflight.ts";
import type {
  ActivityEvent as ContractActivityEvent,
  BackupRecord as ContractBackupRecord,
  CredentialRecipe as ContractCredentialRecipe,
  InstallConfig as ContractInstallConfig,
  Capsule as ContractCapsule,
  CapsuleProviderPackage as ContractCapsuleProviderPackage,
  CapsuleRootProviderRequirement as ContractCapsuleRootProviderRequirement,
  JsonValue as ContractJsonValue,
  ProviderBinding as ContractProviderBinding,
  ProviderBindings as ContractProviderBindings,
  ProviderBindingSet as ContractProviderBindingSet,
  ProviderConnection as ContractProviderConnection,
  ProviderResolution as ContractProviderResolution,
  RepositoryInstallUxCompatibilityResult as ContractRepositoryInstallUxCompatibilityResult,
  PublicStateVersion as ContractPublicStateVersion,
  Run as ContractRun,
  RunCostInfo as ContractRunCostInfo,
  RunLogsResponse as ContractRunLogsResponse,
  Source as ContractSource,
  SourceBuildConfig,
  SourceSnapshot as ContractSourceSnapshot,
  StableSourceTagResolutionResponse,
  Workspace as ContractWorkspace,
  PublicWorkspaceListPage as ContractPublicWorkspaceListPage,
  UsageEvent as ContractUsageEvent,
  CapsuleCurrentResourceInventory as ContractCapsuleCurrentResourceInventory,
  CapsuleConfigurationPlanRequest,
  CapsuleConfigurationPlanResponse,
  CapsuleInstallConfigReAdoptionResponse,
  CapsuleInstallConfigReAdoptionInputContext,
  CapsuleInstallConfigReAdoptionInputContextResponse,
  CreateCapsuleInstallConfigReAdoptionRequest,
  CreateGitInstallAttemptRequest,
  DiscardGitInstallPlanRequest,
  GitInstallPlanResponse,
  ListOpenGitInstallPlansResponse,
  InstalledAppSummary,
  ListInstalledAppsResponse,
  PatchGitInstallPlanRequest,
  CreateGitRevisionPlanRequest,
  GitRevisionPlanResponse,
  CapsuleAppView as ContractCapsuleAppView,
  RunPlanOrigin as ContractRunPlanOrigin,
  RunPolicyReason as ContractRunPolicyReason,
} from "takosumi-contract";
import {
  hasCredentialQueryParams,
  INSTALLED_APP_PROJECTION,
  installedAppSourceIsMatchable,
  installedAppSourceUrl,
  isCanonicalRepositoryDirectoryPath,
  normalizeInstallConfigSourcePath,
} from "takosumi-contract";
import { gitPlanProgressSignature } from "./git-plan-progress.ts";
import { normalizeProviderSourceAddress } from "takosumi-contract/provider-env-rules";

// ===========================================================================
// Transport — same-origin fetch with the session cookie (mirrors the account
// plane's lib/http.ts apiFetch, kept local so the control client has no
// dependency on the account-plane RPC internals).
// ===========================================================================

/** Error thrown for any non-2xx control-plane response. */
export class ControlApiError extends Error {
  /** Definite errors are safe to surface without mutation reconciliation. */
  readonly isIndeterminate: boolean = false;

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body?: unknown,
    /**
     * True when `message` is only the bare `${status} ${statusText}` HTTP
     * fallback — i.e. the server sent no usable description, so `message`
     * carries no user-facing meaning. Callers (see `lib/error-copy.ts`
     * `friendlyError`) treat this as an opaque server failure and show generic
     * reassuring copy instead of leaking the raw status line.
     */
    readonly isHttpStatusFallback: boolean = false,
  ) {
    super(message);
    this.name = "ControlApiError";
  }

  /** True when the backend rejected because the Source has no synced snapshot. */
  get isSourceSyncRequired(): boolean {
    return this.status === 409 && this.reason === "source_sync_required";
  }

  /** Definite Apply refusal because the reviewed base state has changed. */
  get isApplyStateConflict(): boolean {
    const reason = this.reason;
    return this.status === 409 && this.code === "failed_precondition" &&
      (reason === "state_version_mismatch" || reason === "state_generation_mismatch");
  }

  /** Typed detail payload from deploy-control error envelopes, when present. */
  get details(): unknown {
    return controlErrorDetails(this.body);
  }

  /** Machine-readable detail reason from deploy-control error envelopes. */
  get reason(): string | undefined {
    const details = this.details;
    if (!isRecord(details)) return undefined;
    const reason = details.reason;
    return typeof reason === "string" ? reason : undefined;
  }

  /**
   * Correlation id from the control error envelope (`error.requestId`),
   * suitable for a "quote this id to support" line. Never a message text.
   */
  get requestId(): string | undefined {
    if (!isRecord(this.body)) return undefined;
    const payload = this.body.error;
    if (!isRecord(payload)) return undefined;
    const requestId = payload.requestId;
    return typeof requestId === "string" && requestId.trim().length > 0
      ? requestId
      : undefined;
  }

  /** True when creating a service hit the Workspace/name/environment guard. */
  get isDuplicateService(): boolean {
    return this.status === 409 && this.reason === "duplicate_capsule";
  }

}

export interface ControlApiErrorSummary {
  readonly category: "http" | "timeout" | "transport" | "unknown";
  readonly status: number;
  readonly code?: string;
}

function summarizeControlError(error: unknown): ControlApiErrorSummary {
  if (error instanceof ControlApiError) {
    return {
      category:
        error.status === 0 || error.code === "request_timeout"
          ? "timeout"
          : "http",
      status: error.status,
      ...(error.code ? { code: error.code } : {}),
    };
  }
  if (error instanceof Error) {
    return { category: "transport", status: 0 };
  }
  return { category: "unknown", status: 0 };
}

/**
 * The server may have committed a mutation even though its response was not
 * observed. Callers must reconcile the exact operation rather than blindly
 * issuing another mutation.
 */
export class ControlApiIndeterminateError extends ControlApiError {
  readonly operation: "apply" | "source_create" | "source_patch" | "rollback_plan" | "configuration_plan";
  readonly isIndeterminate = true;
  readonly causeSummary?: ControlApiErrorSummary;

  constructor(
    operation: ControlApiIndeterminateError["operation"],
    message: string,
    cause?: unknown,
  ) {
    super(0, "request_indeterminate", message);
    this.name = "ControlApiIndeterminateError";
    this.operation = operation;
    if (cause !== undefined) this.causeSummary = summarizeControlError(cause);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function controlErrorDetails(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const payload = body.error;
  if (!isRecord(payload) || !("details" in payload)) return undefined;
  return payload.details;
}

interface RequestOpts {
  readonly cache?: "no-store";
  readonly acceptResponseAfterAbort?: boolean;
  readonly reuseRecentSharedAuthProbe?: boolean;
  readonly isCurrent?: () => boolean;
  readonly beforeDispatch?: () => void;
  readonly onResponseStatus?: (status: number) => void;
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Request was aborted.", "AbortError");
  }
}

function throwIfReadRetired(options: RequestOpts): void {
  if (!options.isCurrent) return;
  throwIfAborted(options.signal);
  if (!options.isCurrent()) throw new DOMException("Read owner was retired.", "AbortError");
}

export async function controlFetch<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  throwIfReadRetired(opts);
  const headers: Record<string, string> = {
    accept: "application/json",
    // Value-free self-identification read only by the server's legacy
    // Workspace telemetry (TASK-0118 Phase 9).
    "takosumi-client": "takosumi-dashboard",
    ...(opts.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    body = JSON.stringify(opts.body);
  }
  const method = opts.method ?? "GET";
  // JSON mutations must stay on the API route selected by the caller.
  const redirect = ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ? "follow" : "error";
  const reusedProbe = method === "GET" && opts.reuseRecentSharedAuthProbe &&
    canReuseRecentSharedAuthProbe();
  if (reusedProbe) headers[SHARED_AUTH_READ_HEADER] = "1";
  else {
    const preflight = preflightSharedAuthSession(opts.signal);
    if (preflight) await preflight;
  }
  throwIfSharedAuthCallerAborted(opts.signal);
  throwIfReadRetired(opts);
  opts.beforeDispatch?.();
  const res = await fetch(path, {
    method,
    headers,
    body,
    credentials: "include",
    redirect,
    signal: opts.signal,
    ...(reusedProbe ? { cache: "no-store" } : opts.cache ? { cache: opts.cache } : {}),
  });

  // A late response must not redirect a replacement screen or clear its
  // ownership cache after the requesting scope retires. Apply also keeps a
  // received HTTP decision when only its transport deadline has expired.
  throwIfReadRetired(opts.acceptResponseAfterAbort
    ? { isCurrent: opts.isCurrent }
    : opts);
  opts.onResponseStatus?.(res.status);
  if (reusedProbe) requireSharedAuthReadResponse(res);
  if (res.status === 401) {
    invalidateRecentSharedAuthProbe();
    resetAppOwnershipCache();
    // The control routes share the account-plane session gate. On expiry, send
    // the operator back through sign-in, preserving the intended destination
    // (mirrors the account-plane apiFetch behaviour).
    if (typeof location !== "undefined") {
      const intended = location.pathname + location.search + location.hash;
      location.assign("/sign-in?return=" + encodeURIComponent(intended));
    }
    throw new ControlApiError(401, "unauthorized", "session expired");
  }

  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json")
    ? await res.json().catch(() => undefined)
    : undefined;

  if (!res.ok) {
    const deployControlError = (
      data as
        | {
            error?: { code?: string; message?: string };
          }
        | undefined
    )?.error;
    const legacyError = (data as { error?: string } | undefined)?.error;
    const code =
      typeof legacyError === "string" ? legacyError : deployControlError?.code;
    const desc =
      (data as { error_description?: string } | undefined)?.error_description ??
      deployControlError?.message;
    throw new ControlApiError(
      res.status,
      code,
      desc ?? `${res.status} ${res.statusText}`,
      data,
      // No server-provided description → the message is just the HTTP status
      // line, which must never surface raw. Flag it as an opaque failure.
      desc === undefined,
    );
  }
  // 204 No Content resolves to undefined.
  return data as T;
}

const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
type ControlReadScope = Pick<RequestOpts, "signal" | "cache" | "isCurrent">;

/** Bounds a request through response decoding and retires late responses. */
async function withControlDeadline<T>(
  label: string,
  scope: ControlReadScope,
  request: (scope: ControlReadScope) => Promise<T>,
): Promise<T> {
  const caller = scope.signal;
  throwIfAborted(caller);
  const controller = new AbortController();
  const signal = controller.signal;
  const requestScope = { ...scope, signal, isCurrent: () => !signal.aborted && (scope.isCurrent?.() ?? true) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new DOMException("Request was aborted.", "AbortError"));
      controller.abort();
    };
    caller?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      // Settle the timeout before aborting, including when fetch rejects on abort.
      reject(new ControlApiError(0, "request_timeout", `${label} timed out after ${CONTROL_REQUEST_TIMEOUT_MS}ms`));
      controller.abort();
    }, CONTROL_REQUEST_TIMEOUT_MS);
  });
  try {
    // Some transports and response bodies ignore abort. Race the whole request
    // and fence controlFetch's session-expiry handling after retirement.
    const result = await Promise.race([request(requestScope), stopped]);
    throwIfReadRetired(requestScope);
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) caller?.removeEventListener("abort", onAbort);
  }
}

/** Keep a received client rejection when its response body never finishes. */
function clientRejectionOnDeadline(status: number | undefined, failure: unknown): ControlApiError | undefined {
  if (status !== undefined && status >= 400 && status < 500 &&
    failure instanceof ControlApiError && failure.code === "request_timeout") {
    return new ControlApiError(status, undefined, `HTTP ${status}`, undefined, true);
  }
}

function query(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

/**
 * Follows the keyset `nextCursor` of a now-capped list endpoint (spec §30
 * pagination) until it is exhausted, concatenating every page so the dashboard
 * keeps its previous "load the whole list" behaviour. `extract` pulls the array
 * field out of each page body. A defensive page ceiling guards against a server
 * that never stops returning a cursor.
 */
async function fetchAllPages<T>(
  basePath: string,
  extract: (
    body: { nextCursor?: string } & Record<string, unknown>,
  ) => readonly T[],
  opts: Pick<RequestOpts, "signal" | "cache" | "isCurrent" | "reuseRecentSharedAuthProbe"> & {
    readonly readPage?: (path: string) => Promise<{ nextCursor?: string } & Record<string, unknown>>;
  } = {},
): Promise<readonly T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path =
      cursor === undefined
        ? basePath
        : `${basePath}${sep}cursor=${encodeURIComponent(cursor)}`;
    const body = opts.readPage ? await opts.readPage(path) : await controlFetch<
      { nextCursor?: string } & Record<string, unknown>
    >(path, opts);
    all.push(...extract(body));
    if (typeof body.nextCursor !== "string" || body.nextCursor === "") break;
    cursor = body.nextCursor;
  }
  return all;
}

const BASE = "/api/v1";

// ===========================================================================
// Wire shapes (local mirror of the deploy-control contract — see module header)
// ===========================================================================

export type WorkspaceType = "personal" | "organization";

export type PlanScopeScalar = string | number | boolean;

export interface ScopeBoundaryDimension {
  readonly selector: string;
  readonly allowedValues: readonly PlanScopeScalar[];
}

export interface ScopeBoundaryRule {
  readonly resourceTypePattern: string;
  readonly dimensions: Readonly<Record<string, ScopeBoundaryDimension>>;
}

export interface ScopeBoundaryPolicy {
  readonly mode?: "permissive" | "strict";
  readonly rules: readonly ScopeBoundaryRule[];
}

export type PolicyConfig = ContractInstallConfig["policy"];

export interface Workspace {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
  readonly billingSettings?: BillingSettings;
  readonly policy?: PolicyConfig;
  /** Set when the workspace is archived (restore via updateWorkspace). */
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type BillingMode = "disabled" | "showback";

export type BillingSettings = { readonly mode: BillingMode };

export interface BackupRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly environment?: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly serviceData?: {
    readonly ref: string;
    readonly digest: string;
    readonly sizeBytes: number;
    readonly exportedCount: number;
    readonly unsupportedCount: number;
    readonly missingCount: number;
  };
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

export type UsageEventKind = string;

export interface UsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly runId?: string;
  readonly meterId?: string;
  readonly resourceFamily?: string;
  readonly resourceId?: string;
  readonly operation?: string;
  readonly resourceMetadata?: Readonly<Record<string, unknown>>;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly usdMicros: number;
  readonly ratingStatus: "rated" | "unrated";
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface UsageEventsPage {
  readonly usageEvents: readonly UsageEvent[];
  readonly nextCursor?: string;
}

export interface WorkspaceBilling {
  readonly settings: BillingSettings;
}

/**
 * Value-free projection of one durable Interface materialization failure.
 *
 * The control API deliberately exposes digests and counters only. In
 * particular, the dashboard never receives Interface values or diagnostic
 * payloads through this projection.
 */
export interface CapsuleInterfaceMaterializationFailure {
  readonly id: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly blueprintsDigest: string;
  readonly totalItems: number;
  readonly nextItemIndex: number;
  readonly attempts: number;
  readonly error: {
    readonly code: string;
    readonly detailDigest: string;
    readonly recordedAt: string;
  };
  readonly deadLetteredAt: string;
  readonly failureDigest: string;
}

export interface RetryCapsuleInterfaceMaterializationFailureInput {
  readonly failureDigest: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
}

export interface CapsuleInterfaceMaterializationRetryReceipt {
  readonly id: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly blueprintsDigest: string;
  readonly status: "pending";
  readonly nextItemIndex: number;
  readonly totalItems: number;
  readonly nextRetryAt: string;
}

export interface InterfaceMaterializationFailureListOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export type CapsuleStatus =
  | "pending"
  | "active"
  | "stale"
  | "error"
  | "disabled"
  | "uninstalled"
  | "destroyed";

/** Two-stage uninstall progress (see `uninstall` on the public Capsule). */
export type CapsuleUninstall = NonNullable<ContractCapsule["uninstall"]>;

export interface Capsule {
  readonly id: string;
  readonly workspaceId?: string;
  /** Exact compatibility evidence pinned by the retained install configuration. */
  readonly compatibilityReportId?: string;
  /** Owning Project, when exposed by the public Capsule projection. */
  readonly projectId?: string;
  readonly name: string;
  readonly displayName?: ContractCapsule["displayName"];
  readonly slug: string;
  readonly sourceId?: string;
  readonly installConfigId: string;
  /** Applied SourceSnapshot provenance; absent before the first successful Apply. */
  readonly adoptedSourceRevision?: NonNullable<
    ContractCapsule["adoptedSourceRevision"]
  >;
  readonly environment: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
  readonly status: CapsuleStatus;
  /**
   * Read-time DERIVED freshness relative to the tracked Source revision.
   * Newer backends stop STORING `status: "stale"` and surface this field
   * instead; older backends omit it. Views must treat
   * `status === "stale" || freshness === "stale"` as the stale presentation
   * (see `effectiveCapsuleStatus` in capsules-ui.ts) so the
   * dashboard renders correctly against both.
   */
  readonly freshness?: "fresh" | "stale";
  /**
   * Auto-update opt-in: a stale-from-source-update Capsule re-plans and
   * auto-applies server-side when the plan is clean. Destructive updates
   * always stop and wait for the user.
   */
  readonly autoUpdate?: boolean;
  /**
   * Latest two-stage uninstall request. While `status` is `uninstalled` the
   * service and its data stay until `scheduledDestroyAt`.
   */
  readonly uninstall?: CapsuleUninstall;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderBinding = ContractProviderBinding;
export type ProviderBindings = ContractProviderBindings;
export type ProviderBindingSet = ContractProviderBindingSet;

export type ProviderResolution = ContractProviderResolution;

export interface InstallConfig {
  readonly id: string;
  readonly workspaceId?: string;
  readonly name: string;
  readonly sourceSelector?: ContractInstallConfig["sourceSelector"];
  readonly modulePath?: string;
  readonly sourceBuild?: SourceBuildConfig;
  readonly lifecycleActions?: ContractInstallConfig["lifecycleActions"];
  readonly policy: ContractInstallConfig["policy"];
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly variablePresentation?: ContractInstallConfig["variablePresentation"];
  readonly installExperience?: ContractInstallConfig["installExperience"];
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly interfaceBlueprints?: ContractInstallConfig["interfaceBlueprints"];
  readonly store?: ContractInstallConfig["store"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

type OutputAllowlistEntry = ContractInstallConfig["outputAllowlist"][string];

export type RunType =
  | "source_sync"
  | "compatibility_check"
  | "artifact"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check"
  | "backup"
  | "restore"
  | "state_recovery";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type RunPolicyStatus = "pass" | "warn" | "deny";

export interface RunChangeSummary {
  readonly add?: number;
  readonly change?: number;
  readonly destroy?: number;
}

export interface RunPlanResource {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  readonly scope?: {
    readonly facts: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface RunApplyExpectedGuard {
  readonly planId: string;
  readonly capsuleId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly resolvedProviderBindingsDigest?: string;
}

export interface RunServiceDataRestoreResult {
  readonly status: "restored";
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly restoredCount?: number;
}

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly workspaceId: string;
  /** Exact PlanRun id consumed by an ApplyRun, when this is an apply row. */
  readonly planRunId?: string;
  readonly sourceId?: string;
  /** Source-scoped sync ref and resolved commit, when exposed by the API. */
  readonly ref?: string;
  readonly resolvedCommit?: string;
  readonly capsuleId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactRef?: string;
  readonly applyExpected?: RunApplyExpectedGuard;
  readonly summary?: RunChangeSummary;
  readonly planResources?: readonly RunPlanResource[];
  readonly policyStatus?: RunPolicyStatus;
  /** Structured, value-free reasons a policy blocked or gated this plan. */
  readonly policyReasons?: readonly RunPolicyReason[];
  /** The change flow that created this plan (version, rollback, settings). */
  readonly origin?: RunPlanOrigin;
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest?: string;
  readonly redactionProfileId?: string;
  readonly requiresApproval?: boolean;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoreServiceData?: boolean;
  readonly restoredStateVersionId?: string;
  readonly restoredFromStateVersionId?: string;
  readonly restoredServiceData?: RunServiceDataRestoreResult;
  readonly errorCode?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface SourceSnapshotWaitProgress {
  readonly elapsedMs: number;
  /**
   * Snapshots returned by the most recent listing this wait performed. It is
   * `0` while no listing was authoritative (the sync Run is still queued or
   * running), which is the normal case for most of the wait.
   */
  readonly snapshotsCount: number;
  readonly run?: Run;
}

export interface RunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code?: string;
  readonly message: string;
  readonly detail?: string;
}

export interface RunAuditEvent {
  readonly id?: string;
  readonly type?: string;
  readonly at?: number;
  readonly actor?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly detail?: unknown;
  readonly metadata?: unknown;
  readonly createdAt?: string;
  readonly action?: string;
}

/** `GET /api/v1/runs/:id/logs` body (RunLogsResponse). */
export interface RunLogs {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly RunAuditEvent[];
}

/** Provider-neutral plan showback projection. */
export interface RunCostInfo {
  readonly runId: string;
  readonly billingMode: "disabled" | "showback";
  readonly estimatedUsdMicros: number;
  readonly ratingStatus: "not_applicable" | "rated" | "unrated";
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly extension?: Readonly<Record<string, ContractJsonValue>>;
}

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

/** `GET|POST /api/v1/run-groups/:id` body (RunGroupWithRuns projection). */
export interface RunGroupWithRuns {
  readonly runGroup: {
    readonly id: string;
    readonly workspaceId: string;
    readonly status?: RunGroupStatus;
    readonly type?: string;
    /** Recorded member graph; the dashboard reads recognized pre-plan failures. */
    readonly graphJson?: string;
  };
  readonly runs: readonly Run[];
}

export interface Source {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef: string;
  readonly defaultPath: string;
  readonly authConnectionId?: string;
  readonly status: "active" | "disabled" | "error";
  readonly autoSync: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Git's canonical immutable commit spelling accepted by the Workload flow. */
const IMMUTABLE_SOURCE_REVISION = /^[0-9a-f]{40}$/iu;

/** True only for an exact 40-hex Git commit. */
export function isImmutableSourceRevision(value: string): boolean {
  return IMMUTABLE_SOURCE_REVISION.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceResponse(value: unknown): value is Source {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.defaultRef) &&
    isNonEmptyString(value.defaultPath) &&
    (value.authConnectionId === undefined ||
      isNonEmptyString(value.authConnectionId)) &&
    (value.status === "active" ||
      value.status === "disabled" ||
      value.status === "error") &&
    typeof value.autoSync === "boolean" &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}

function decodeSourceEnvelope(body: unknown): Source {
  if (!isRecord(body) || !isSourceResponse(body.source)) {
    throw new ControlApiError(
      502,
      "invalid_source_response",
      "Source returned an invalid response.",
    );
  }
  return body.source;
}

export interface SourcePatchRequest {
  readonly name?: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string | null;
  readonly status?: Source["status"];
  readonly autoSync?: boolean;
}

export interface CapsuleSourceIdentity {
  readonly workspaceId?: string;
  readonly sourceId: string;
  readonly url: string;
  readonly defaultPath: string;
}

export type SourceSnapshotOrigin = "git";

export interface SourceSnapshot {
  readonly id: string;
  readonly origin: SourceSnapshotOrigin;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly resolvedRef?: string;
  readonly path: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly repositoryInstallMetadata?: ContractSourceSnapshot["repositoryInstallMetadata"];
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

/**
 * Browser-safe StateVersion ledger projection. State refs and digests
 * remain on the internal runner seam.
 */
export interface PublicStateVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly createdAt: string;
}

export interface ActivityEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId?: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly runId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export type ConnectionStatus = ContractProviderConnection["status"];
export type ConnectionScopeKind = ContractProviderConnection["scope"];
export type ConnectionScopeHints = NonNullable<
  ContractProviderConnection["scopeHints"]
>;
export type ProviderConnectionMaterialization =
  ContractProviderConnection["materialization"];
export type ProviderConnection = ContractProviderConnection;

export type CredentialRecipe = ContractCredentialRecipe;

export type CapsuleCompatibilityLevel = "ready" | "needs_patch" | "unsupported";

export interface CapsuleCompatibilityDiagnostic {
  readonly code?: string;
  readonly severity: "info" | "warning" | "error";
  readonly compatibilityImpact?: "none" | "needs_patch" | "unsupported";
  readonly message: string;
  readonly detail?: string;
  readonly path?: string;
  readonly context?: Readonly<Record<string, string>>;
}

export type CapsuleCompatibilityProviderPackage =
  ContractCapsuleProviderPackage;
export type CapsuleCompatibilityRootProviderRequirement =
  ContractCapsuleRootProviderRequirement;

export interface CapsuleCompatibilityResource {
  readonly type: string;
  readonly count?: number;
  readonly allowed: boolean;
}

export type RepositoryInstallUxPreview =
  ContractRepositoryInstallUxCompatibilityResult;

export interface CapsuleCompatibilityResult {
  readonly reportId?: string;
  readonly compatibilityCheckRunId?: string;
  readonly sourceSnapshotId?: string;
  readonly level: CapsuleCompatibilityLevel;
  readonly summary: string;
  readonly diagnostics: readonly CapsuleCompatibilityDiagnostic[];
  readonly providerPackages: readonly CapsuleCompatibilityProviderPackage[];
  readonly rootProviderRequirements: readonly CapsuleCompatibilityRootProviderRequirement[];
  readonly resources: readonly CapsuleCompatibilityResource[];
  readonly rootModuleVariables: readonly string[];
  readonly installConfigId?: string;
  readonly repositoryInstallUx?: RepositoryInstallUxPreview;
  readonly sourceId?: string;
  readonly source?: "api";
}

type AssertAssignable<Expected, Actual extends Expected> = true;

type _ContractResponseAssignableToDashboardMirrors = [
  AssertAssignable<Workspace, ContractWorkspace>,
  AssertAssignable<Capsule, ContractCapsule>,
  AssertAssignable<InstallConfig, ContractInstallConfig>,
  AssertAssignable<Run, ContractRun>,
  AssertAssignable<RunLogs, ContractRunLogsResponse>,
  AssertAssignable<Source, ContractSource>,
  AssertAssignable<SourceSnapshot, ContractSourceSnapshot>,
  AssertAssignable<PublicStateVersion, ContractPublicStateVersion>,
  AssertAssignable<ActivityEvent, ContractActivityEvent>,
  AssertAssignable<ProviderConnection, ContractProviderConnection>,
  AssertAssignable<UsageEvent, ContractUsageEvent>,
  AssertAssignable<RunCostInfo, ContractRunCostInfo>,
  AssertAssignable<BackupRecord, ContractBackupRecord>,
  AssertAssignable<ProviderBinding, ContractProviderBinding>,
  AssertAssignable<ProviderBindingSet, ContractProviderBindingSet>,
];

// ===========================================================================
// Typed methods (one per route the dashboard calls)
// ===========================================================================

// --- Workspaces ----------------------------------------------------------------

export interface WorkspaceListPage {
  readonly workspaces: readonly Workspace[];
  readonly total?: number;
  readonly returned: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
  readonly pinnedWorkspaceId?: string;
}
type WorkspaceEnvelope = {
  readonly workspace: Workspace;
};

export const DASHBOARD_WORKSPACE_LIST_LIMIT = 50;

export async function listWorkspacePage(
  options: {
    readonly includeArchived?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    readonly order?: "created_asc" | "updated_desc";
    readonly selectedWorkspaceId?: string;
    readonly includeTotal?: boolean;
  } = {},
  scope: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<WorkspaceListPage> {
  return await controlFetch<ContractPublicWorkspaceListPage>(
    `${BASE}/workspaces${query({
      includeArchived: options.includeArchived,
      limit: options.limit ?? DASHBOARD_WORKSPACE_LIST_LIMIT,
      cursor: options.cursor,
      order: options.order ?? "updated_desc",
      selectedWorkspaceId: options.selectedWorkspaceId,
      includeTotal: options.includeTotal,
    })}`,
    scope,
  );
}

export async function listWorkspaces(
  options: {
    readonly selectedWorkspaceId?: string;
    readonly limit?: number;
  } = {},
  scope: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<readonly Workspace[]> {
  return (
    await listWorkspacePage({
      limit: options.limit,
      order: "updated_desc",
      selectedWorkspaceId: options.selectedWorkspaceId,
    }, scope)
  ).workspaces;
}

export async function createWorkspace(input: {
  readonly handle: string;
  readonly displayName?: string;
  readonly type?: WorkspaceType;
}, options: Pick<RequestOpts, "beforeDispatch"> = {}): Promise<Workspace> {
  const body = await controlFetch<WorkspaceEnvelope>(`${BASE}/workspaces`, {
    ...options,
    method: "POST",
    body: {
      handle: input.handle,
      displayName: input.displayName ?? input.handle,
      type: input.type ?? "personal",
    },
  });
  return body.workspace;
}

export async function getWorkspace(workspaceId: string): Promise<Workspace> {
  const body = await controlFetch<WorkspaceEnvelope>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  return body.workspace;
}

export async function getWorkspaceBilling(
  workspaceId: string,
): Promise<WorkspaceBilling> {
  const body = await controlFetch<{ billing: WorkspaceBilling }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/billing`,
  );
  return body.billing;
}

/**
 * Queues one observed Interface materialization failure using the exact
 * failure/state identity shown by the app. An unknown outcome carries no receipt.
 */
export async function retryCapsuleInterfaceMaterializationFailure(
  capsuleId: string,
  intentId: string,
  input: RetryCapsuleInterfaceMaterializationFailureInput,
  scope: Pick<RequestOpts, "isCurrent"> = {},
): Promise<CapsuleInterfaceMaterializationRetryReceipt | undefined> {
  let response: { readonly retry?: CapsuleInterfaceMaterializationRetryReceipt } | undefined;
  try {
    response = await controlFetch<typeof response>(
      `${BASE}/capsules/${encodeURIComponent(capsuleId)}/interface-materialization-failures/${encodeURIComponent(intentId)}/retries`,
      {
        ...scope,
        method: "POST",
        body: {
          failureDigest: input.failureDigest,
          stateVersionId: input.stateVersionId,
          stateGeneration: input.stateGeneration,
        },
      },
    );
  } catch (cause) {
    if (!isMutationOutcomeUnknown(cause)) throw cause;
  }
  throwIfReadRetired(scope);
  const receipt = response?.retry;
  if (receipt?.status === "pending" && receipt.id === intentId && receipt.capsuleId === capsuleId &&
    receipt.stateVersionId === input.stateVersionId && receipt.stateGeneration === input.stateGeneration) {
    return receipt;
  }
}

/** A listed failure may have disappeared or changed before its retry click. */
export function isInterfaceMaterializationRetryStale(
  error: unknown,
): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 404 || error.status === 409)
  );
}

export async function listWorkspaceUsagePage(
  workspaceId: string,
  options: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<UsageEventsPage> {
  const body = await controlFetch<UsageEventsPage>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/usage${query({
      cursor: options.cursor,
      limit: options.limit,
    })}`,
    { signal: options.signal },
  );
  return {
    usageEvents: body.usageEvents ?? [],
    ...(typeof body.nextCursor === "string" && body.nextCursor !== ""
      ? { nextCursor: body.nextCursor }
      : {}),
  };
}

/** Per-app showback aggregate (sum of the Capsule's recorded usage). */
export interface CapsuleUsageSummary {
  readonly capsuleId: string;
  readonly usdMicros: number;
  readonly eventCount: number;
  readonly ratedEventCount: number;
  readonly unratedEventCount: number;
}

export async function getCapsuleUsageSummary(
  capsuleId: string,
): Promise<CapsuleUsageSummary> {
  const body = await controlFetch<{ summary: CapsuleUsageSummary }>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/usage-summary`,
  );
  return body.summary;
}

// --- Members (Workspace membership / roles) ------------------------------------
//
// Backs the Members screen over the session-authed
// `/api/v1/workspaces/:id/members[/:subject]` routes (see
// accounts/service/src/control-routes.ts). The Workspace is resolved
// server-side and the membership-ROLE gate is enforced by the backend
// (list = any active member; add/invite = owner/admin; role change + remove =
// owner-only with a last-owner guard). These client fns never send the workspaceId
// in a body — it is always a path segment the server re-resolves and gates.

export type ControlWorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type ControlMembershipStatus = "active" | "invited" | "suspended";

/**
 * Public projection of one Workspace membership (mirror of the deploy-control
 * `PublicWorkspaceMember`). `accountId` is the member's account subject — the same
 * value the session `/api/v1/account/session/me` returns for the signed-in caller —
 * so the view can match the caller against the roster to decide which mutation
 * controls to show. The list read adds the member's account display name for
 * every reader, and the member's email only when the caller is an active owner
 * or admin of the Workspace (the server decides; members and viewers never
 * receive another member's address). Mutation responses carry neither.
 */
export interface PublicWorkspaceMember {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly roles: readonly ControlWorkspaceRole[];
  readonly status: ControlMembershipStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Account profile name; absent when the account has none. */
  readonly displayName?: string;
  /** Present only for owner/admin callers of the member list. */
  readonly email?: string;
}

/**
 * Lists a Workspace's members (`GET /api/v1/workspaces/:id/members`). Any active
 * member of the Workspace may read the roster; the backend gates this server-side.
 */
export async function listMembers(
  workspaceId: string,
): Promise<readonly PublicWorkspaceMember[]> {
  const body = await controlFetch<{
    members?: readonly PublicWorkspaceMember[];
  }>(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members`);
  return body.members ?? [];
}

// --- Capsules ---------------------------------------------------------

export async function listCapsules(
  workspaceId: string,
  options: { readonly includeDestroyed?: boolean } = {},
): Promise<readonly Capsule[]> {
  const qs = query({
    ...(options.includeDestroyed === false
      ? { includeDestroyed: "false" }
      : {}),
  });
  return await fetchAllPages<Capsule>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/capsules${qs}`,
    (body) => (body.capsules as readonly Capsule[]) ?? [],
  );
}

export async function getCapsule(id: string, options: Pick<RequestOpts, "isCurrent" | "signal" | "cache" | "reuseRecentSharedAuthProbe"> = {}): Promise<Capsule> {
  const body = await controlFetch<{ capsule: Capsule }>(
    `${BASE}/capsules/${encodeURIComponent(id)}`,
    {
      isCurrent: options.isCurrent, signal: options.signal, cache: options.cache,
      reuseRecentSharedAuthProbe: options.reuseRecentSharedAuthProbe,
    },
  );
  if (!isCapsuleResponse(body.capsule)) {
    throw new ControlApiError(
      502,
      "invalid_capsule_response",
      "Capsule read returned an invalid response.",
    );
  }
  return body.capsule;
}

/**
 * Reads the Capsule and its exact deployment-intent CAS guard from one server
 * snapshot. Settings must echo this guard into the single Configuration Plan
 * request; separate GETs could accidentally combine different authorities.
 */
export async function getCapsuleConfigurationContext(
  id: string,
  options: Pick<RequestOpts, "signal" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {},
): Promise<{
  readonly capsule: Capsule;
  readonly authorityGuard: string;
  readonly configurationPlanResumable?: true;
}> {
  const body = await withControlDeadline("App settings read", options, (scope) => controlFetch<{
    capsule: Capsule;
    installConfigReAdoption: {
      readonly authorityGuard: string;
      readonly configurationPlanResumable?: true;
    };
  }>(`${BASE}/capsules/${encodeURIComponent(id)}`, {
    ...scope, reuseRecentSharedAuthProbe: options.reuseRecentSharedAuthProbe,
  }));
  if (
    !isCapsuleResponse(body.capsule) ||
    typeof body.installConfigReAdoption?.authorityGuard !== "string" ||
    body.installConfigReAdoption.authorityGuard.length === 0
  ) {
    throw new ControlApiError(
      502,
      "invalid_capsule_authority_response",
      "Capsule authority read returned an invalid response.",
    );
  }
  return {
    capsule: body.capsule,
    authorityGuard: body.installConfigReAdoption.authorityGuard,
    ...(body.installConfigReAdoption.configurationPlanResumable === true
      ? { configurationPlanResumable: true }
      : {}),
  };
}

/** Creates one reviewed successor for the Capsule's complete configuration. */
export async function createCapsuleConfigurationPlan(
  capsuleId: string,
  request: CapsuleConfigurationPlanRequest,
  idempotencyKey: string = randomUuid(),
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<CapsuleConfigurationPlanResponse> {
  return await submitCapsuleConfigurationPlan(capsuleId, request, {
    headers: { "idempotency-key": idempotencyKey },
    ...options,
  });
}

/** Prepares the review of the server's already-saved settings. */
export async function resumeCapsuleConfigurationPlan(
  capsuleId: string,
  resume: { readonly installConfigId: string; readonly authorityGuard: string },
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<CapsuleConfigurationPlanResponse> {
  return await submitCapsuleConfigurationPlan(capsuleId, { resume }, options);
}

async function submitCapsuleConfigurationPlan(
  capsuleId: string,
  request: CapsuleConfigurationPlanRequest | {
    readonly resume: { readonly installConfigId: string; readonly authorityGuard: string };
  },
  options: Pick<RequestOpts, "headers" | "isCurrent">,
): Promise<CapsuleConfigurationPlanResponse> {
  let responseStatus: number | undefined;
  let result: CapsuleConfigurationPlanResponse;
  try {
    result = await withControlDeadline("Settings Plan", options, (scope) =>
      controlFetch<CapsuleConfigurationPlanResponse>(
        `${BASE}/capsules/${encodeURIComponent(capsuleId)}/configuration-plans`,
        {
          ...scope,
          method: "POST",
          body: request,
          headers: options.headers,
          onResponseStatus: (status) => { responseStatus = status; },
        },
      ));
  } catch (failure) {
    throwIfReadRetired(options);
    // The issuer can save the configuration before Control reports a Plan
    // timeout as 409. An unreadable conflict body cannot confirm refusal.
    if (responseStatus === 409 && failure instanceof ControlApiError &&
      (failure.code === "request_timeout" ||
        (failure.status === 409 && failure.code === undefined && failure.isHttpStatusFallback))) {
      throw new ControlApiIndeterminateError("configuration_plan", "The saved settings Plan could not be confirmed.", failure);
    }
    throw clientRejectionOnDeadline(responseStatus, failure) ?? failure;
  }
  const planRunId = result?.configurationPlan?.planRunId;
  if (typeof planRunId !== "string" || !planRunId.trim()) {
    throw new ControlApiError(502, "invalid_configuration_plan_response", "Configuration planning returned no Plan identifier.");
  }
  return result;
}

/** Explicit immutable configuration re-adoption; never plans or applies. */
export async function createCapsuleInstallConfigReAdoption(
  capsuleId: string,
  request: CreateCapsuleInstallConfigReAdoptionRequest,
  idempotencyKey: string,
): Promise<CapsuleInstallConfigReAdoptionResponse> {
  return await controlFetch<CapsuleInstallConfigReAdoptionResponse>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/install-config-re-adoptions`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: request,
    },
  );
}

/** Read-only, target-bound presentation; never fetches repository text. */
export async function getCapsuleInstallConfigReAdoptionContext(
  capsuleId: string,
  revisionPlanId: string,
): Promise<CapsuleInstallConfigReAdoptionInputContext> {
  const body = await controlFetch<CapsuleInstallConfigReAdoptionInputContextResponse>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/install-config-re-adoption-context${query({ revisionPlanId })}`,
  );
  const value = body?.installConfigReAdoptionContext;
  const nonempty = (field: unknown): field is string => typeof field === "string" && field.length > 0;
  const names = new Set<string>();
  if (!isRecord(value) || value.capsuleId !== capsuleId || value.revisionPlanId !== revisionPlanId ||
    ![value.sourceId, value.sourceSnapshotId, value.targetRef, value.resolvedCommit, value.modulePath,
      value.currentInstallConfigId, value.authorityGuard, value.baseInstallConfigId].every(nonempty) ||
    !Number.isSafeInteger(value.currentStateGeneration) || value.currentStateGeneration < 0 ||
    (value.currentStateVersionId !== undefined && !nonempty(value.currentStateVersionId)) ||
    (value.blockedReason !== undefined && !["secret_inputs", "unsupported_inputs", "host_policy_conflict"].includes(value.blockedReason)) ||
    !Array.isArray(value.variables) || !value.variables.every(variable => {
      if (!isRecord(variable) || !nonempty(variable.name) || names.has(variable.name) ||
        variable.userEditable !== true || variable.sensitive !== false || typeof variable.required !== "boolean" ||
        typeof variable.type !== "string" || !["string", "number", "boolean", "json"].includes(variable.type) || !isRecord(variable.currentValue)) return false;
      names.add(variable.name);
      return variable.currentValue.status === "present"
        ? Object.prototype.hasOwnProperty.call(variable.currentValue, "value")
        : variable.currentValue.status === "unset" || variable.currentValue.status === "unavailable";
    })) {
    throw new ControlApiError(502, "invalid_re_adoption_context", "The target inputs could not be confirmed.");
  }
  return value;
}

// --- Install attempts (TASK-0115 Phase 3b) -----------------------------------
//
// The install-plan coordinator owns the whole attempt: Source sync, module
// scan, compatibility, connection matching and the Plan Run. The dashboard
// starts one with the Git address, follows `userAction`, answers with PATCH
// and may throw the whole attempt away with DELETE. Variable values travel
// only in the confirming PATCH and are never stored or echoed.

/**
 * Starts an install attempt. The key makes an unconfirmed POST safe to resend
 * unchanged: the same key and request return the same attempt.
 */
export async function createGitInstallAttempt(
  workspaceId: string | undefined,
  request: CreateGitInstallAttemptRequest,
  idempotencyKey: string,
  { isCurrent, beforeDispatch }: Pick<RequestOpts, "isCurrent" | "beforeDispatch"> = {},
): Promise<GitInstallPlanResponse> {
  const scope = isCurrent ? { isCurrent } : {};
  const options = {
    ...scope,
    ...(beforeDispatch ? { beforeDispatch } : {}),
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: request,
  } as const;
  throwIfReadRetired(scope);
  if (!await appOwnershipAvailable()) {
    const legacyId = await legacyInstallWorkspaceId(workspaceId, scope);
    if (!legacyId) throw new ControlApiError(404, "feature_unavailable", "Legacy installation is unavailable on this server.");
    return await controlFetch<GitInstallPlanResponse>(
      `${BASE}/workspaces/${encodeURIComponent(legacyId)}/install-plans`, options,
    );
  }
  return await controlFetch<GitInstallPlanResponse>(`${BASE}/install-plans`, options);
}

/** Answers an attempt that waits for input (generation CAS). */
export async function answerGitInstallAttempt(
  installPlanId: string,
  answer: PatchGitInstallPlanRequest,
): Promise<GitInstallPlanResponse> {
  return await controlFetch<GitInstallPlanResponse>(
    `${BASE}/install-plans/${encodeURIComponent(installPlanId)}`,
    { method: "PATCH", body: answer },
  );
}

/** Discards an attempt and the never-applied app it created. */
export async function discardGitInstallAttempt(
  installPlanId: string,
  expectedGeneration: number,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<GitInstallPlanResponse> {
  const body: DiscardGitInstallPlanRequest = { expectedGeneration };
  return await controlFetch<GitInstallPlanResponse>(
    `${BASE}/install-plans/${encodeURIComponent(installPlanId)}`,
    { ...options, method: "DELETE", body },
  );
}

/** The caller's own unfinished attempts in one Workspace, newest first. */
export async function listOpenGitInstallAttempts(
  workspaceId?: string,
): Promise<readonly GitInstallPlanResponse[]> {
  const legacyId = await legacyWorkspaceFor404(workspaceId);
  if (!legacyId) return [];
  const body = await controlFetch<Partial<ListOpenGitInstallPlansResponse>>(
    `${BASE}/workspaces/${encodeURIComponent(legacyId)}/install-plans?open=1`,
  );
  return (body.installPlans ?? []).filter(
    (entry) => entry.installPlan?.workspaceId === legacyId,
  );
}

/** Advances exactly one durable install coordinator phase. */
export async function reconcileGitInstallPlan(
  installPlanId: string,
  options: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<GitInstallPlanResponse> {
  throwIfAborted(options.signal);
  throwIfReadRetired(options);
  return await controlFetch<GitInstallPlanResponse>(
    `${BASE}/install-plans/${encodeURIComponent(installPlanId)}/reconcile`,
    { method: "POST", signal: options.signal, isCurrent: options.isCurrent },
  );
}

/** Read one acknowledged coordinator without advancing or claiming it. */
export async function getGitInstallPlan(
  installPlanId: string,
  options: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<GitInstallPlanResponse> {
  throwIfAborted(options.signal);
  return await controlFetch<GitInstallPlanResponse>(
    `${BASE}/install-plans/${encodeURIComponent(installPlanId)}`,
    options,
  );
}

/** Starts the durable Capsule-local Git revision coordinator. */
export async function createGitRevisionPlan(
  capsuleId: string,
  request: CreateGitRevisionPlanRequest,
  idempotencyKey: string = randomUuid(),
  options: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<GitRevisionPlanResponse> {
  throwIfAborted(options.signal);
  throwIfReadRetired(options);
  return await controlFetch<GitRevisionPlanResponse>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/revision-plans`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: request,
      signal: options.signal, isCurrent: options.isCurrent,
    },
  );
}

/** Advances exactly one durable Capsule-local revision coordinator phase. */
export async function reconcileGitRevisionPlan(
  revisionPlanId: string,
  options: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<GitRevisionPlanResponse> {
  throwIfAborted(options.signal);
  throwIfReadRetired(options);
  return await controlFetch<GitRevisionPlanResponse>(
    `${BASE}/revision-plans/${encodeURIComponent(revisionPlanId)}/reconcile`,
    { method: "POST", signal: options.signal, isCurrent: options.isCurrent },
  );
}

/** A lost acknowledgement or concurrent reconciler can leave a settled Plan. */
async function reconcileGitRevisionPlanForReview(
  revisionPlanId: string,
  options: Pick<RequestOpts, "signal" | "isCurrent">,
  capsuleId?: string,
): Promise<GitRevisionPlanResponse> {
  try {
    return await reconcileGitRevisionPlan(revisionPlanId, options);
  } catch (failure) {
    const needsReadback = failure instanceof ControlApiError
      ? failure.status >= 500 ||
        (failure.status === 409 &&
          (failure.code === "reconcile_in_progress" || failure.code === "reconcile_conflict"))
      : failure instanceof TypeError;
    if (!needsReadback) throw failure;
    throwIfAborted(options.signal);
    throwIfReadRetired(options);

    // A GET is enough if this exact coordinator already settled. Pending
    // preparation still requires explicit continuation after the failure.
    const response = await controlFetch<GitRevisionPlanResponse>(
      `${BASE}/revision-plans/${encodeURIComponent(revisionPlanId)}`,
      { ...options, cache: "no-store" },
    );
    throwIfAborted(options.signal);
    throwIfReadRetired(options);
    const plan = response?.revisionPlan;
    if (plan?.id !== revisionPlanId || plan.operation !== "revision" ||
      (capsuleId !== undefined && plan.capsuleId !== capsuleId)) throw failure;
    if (response.nextAction === "review_run" && plan.phase === "reviewable" &&
      typeof plan.planRunId === "string" && plan.planRunId.length > 0) return response;
    if (response.nextAction === "none" && plan.phase === "failed") return response;
    throw failure;
  }
}

function gitPlanTimeout(kind: "install" | "revision"): ControlApiError {
  return new ControlApiError(
    504,
    `${kind}_plan_reconcile_timeout`,
    `The ${kind} plan did not become reviewable in time. It may still be running; retry the same request to resume.`,
  );
}

/**
 * Cadence for the coordinator reconcile loop.
 *
 * Every `reconcile` round trip is a command: it claims the coordinator lease
 * and advances the state machine one step (see the install-plan reconcile
 * route). A round whose phase, request and evidence are unchanged (see
 * {@link gitPlanProgressSignature}; the claim bumps the CAS `generation` even
 * then) advanced nothing — the coordinator is waiting on work the browser
 * does not drive, such as a Source sync Run, a container-backed compatibility
 * analysis, or a Plan Run. Repeating the command at a flat 4 Hz while it waits
 * only re-pages the same durable rows, so the delay doubles from the floor up
 * to the ceiling until a round observes real progress and resets it.
 *
 * The floor is what a *progressing* coordinator waits, so removing the flat
 * delay here never slows a step that is actually advancing.
 */
export interface GitPlanPollCadence {
  /** Delay after a round that advanced the coordinator. Defaults to 250 ms. */
  readonly minDelayMs?: number;
  /** Ceiling for the stalled-round delay. Defaults to 2_000 ms. */
  readonly maxDelayMs?: number;
  /** Jitter source for the stalled-round delay; defaults to `Math.random`. */
  readonly jitter?: () => number;
  /** How the loop spends a delay. Defaults to a real timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_GIT_PLAN_POLL_FLOOR_MS = 250;
const DEFAULT_GIT_PLAN_POLL_CEILING_MS = 2_000;

interface ResolvedGitPlanPollCadence {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

/**
 * Delay before the next reconcile command.
 *
 * `stalledRounds` counts consecutive rounds that observed no coordinator
 * progress; `0` means the previous round advanced, which resets the cadence to
 * its floor. `jitter` is the full-jitter ratio for the current ceiling, so two
 * clients that are both waiting on the same slow step do not re-synchronize.
 */
export function gitPlanReconcileDelayMs(input: {
  readonly stalledRounds: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
}): number {
  // The floor is at least 1 ms: a caller asking for no floor must still not
  // turn a stalled coordinator into a busy loop.
  const floor = Math.max(1, Math.trunc(input.minDelayMs));
  const ceiling = Math.max(floor, Math.trunc(input.maxDelayMs));
  // `stalledRounds` can only grow while a step is stuck; cap the exponent so a
  // pathological loop cannot produce an unbounded multiply.
  const growth = 2 ** Math.min(16, Math.max(0, input.stalledRounds - 1));
  const target = Math.min(ceiling, floor * growth);
  if (target <= floor) return floor;
  const ratio = Math.min(1, Math.max(0, input.jitter));
  return Math.round(floor + ratio * (target - floor));
}

function resolveGitPlanPollCadence(
  cadence: GitPlanPollCadence | undefined,
): ResolvedGitPlanPollCadence {
  const minDelayMs = cadence?.minDelayMs ?? DEFAULT_GIT_PLAN_POLL_FLOOR_MS;
  const maxDelayMs = cadence?.maxDelayMs ?? DEFAULT_GIT_PLAN_POLL_CEILING_MS;
  if (!Number.isSafeInteger(minDelayMs) || minDelayMs < 0) {
    throw new TypeError("Git plan pollCadence.minDelayMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < minDelayMs) {
    throw new TypeError(
      "Git plan pollCadence.maxDelayMs must be an integer that is at least minDelayMs",
    );
  }
  return {
    minDelayMs,
    maxDelayMs,
    jitter: cadence?.jitter ?? Math.random,
    wait:
      cadence?.wait ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        })),
  };
}

/**
 * Drives one Git plan coordinator until it stops asking for reconciliation.
 *
 * Shared by the install and revision coordinators so both spend the same
 * bounded, progress-aware cadence instead of two copies of a flat sleep.
 */
async function driveGitPlanReconcile<T>(input: {
  readonly kind: "install" | "revision";
  readonly maxReconciles: number;
  readonly signal: AbortSignal;
  readonly cadence: ResolvedGitPlanPollCadence;
  readonly initial: T;
  readonly nextAction: (response: T) => GitInstallPlanResponse["nextAction"];
  /** {@link gitPlanProgressSignature} of a response. */
  readonly progress: (response: T) => string;
  readonly reconcile: (response: T) => Promise<T>;
  readonly onProgress?: (response: T) => void;
}): Promise<T> {
  let response = input.initial;
  let observed = input.progress(response);
  let stalledRounds = 0;
  for (
    let attempt = 0;
    input.nextAction(response) === "reconcile";
    attempt += 1
  ) {
    if (attempt >= input.maxReconciles) {
      throw gitPlanTimeout(input.kind);
    }
    response = await input.reconcile(response);
    throwIfAborted(input.signal);
    const nextObserved = input.progress(response);
    stalledRounds = nextObserved !== observed ? 0 : stalledRounds + 1;
    observed = nextObserved;
    input.onProgress?.(response);
    if (input.nextAction(response) !== "reconcile") continue;
    await input.cadence.wait(
      gitPlanReconcileDelayMs({
        stalledRounds,
        minDelayMs: input.cadence.minDelayMs,
        maxDelayMs: input.cadence.maxDelayMs,
        jitter: input.cadence.jitter(),
      }),
    );
    throwIfAborted(input.signal);
  }
  return response;
}

/** Bounds create, reconciliation, and response bodies with one shared deadline. */
async function withGitPlanDeadline<T>(
  kind: "install" | "revision",
  timeoutMs: number = 120_000,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Git plan timeoutMs must be a positive integer");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Stop waiting, not the durable server operation. The caller must retain
      // its key and resume through the coordinator after an uncertain response.
      reject(gitPlanTimeout(kind));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Drives a revision coordinator through explicit reconciliation until its
 * Plan Run is reviewable. Approval and apply stay on the ordinary Run
 * surface; an uncertain create response is allowed to propagate so a caller
 * can retry this exact request with the same idempotency key.
 */
export async function createReviewableGitRevisionPlan(
  capsuleId: string,
  request: CreateGitRevisionPlanRequest,
  options: {
    readonly maxReconciles?: number;
    readonly idempotencyKey?: string;
    readonly isCurrent?: () => boolean;
    /** Bounds the entire coordinator wait; defaults to two minutes. */
    readonly timeoutMs?: number;
    /** Reconcile cadence; see {@link GitPlanPollCadence}. */
    readonly pollCadence?: GitPlanPollCadence;
    /** Observe this request's acknowledged coordinator before reconciliation. */
    readonly onCreated?: (response: GitRevisionPlanResponse) => void;
    /** Observe the coordinator's final response before a failed result is raised. */
    readonly onSettled?: (response: GitRevisionPlanResponse) => void;
  } = {},
): Promise<GitRevisionPlanResponse> {
  const cadence = resolveGitPlanPollCadence(options.pollCadence);
  return await withGitPlanDeadline("revision", options.timeoutMs, async (signal) => {
    const requestScope = { signal, isCurrent: options.isCurrent };
    const first = await createGitRevisionPlan(
      capsuleId,
      request,
      options.idempotencyKey,
      requestScope,
    );
    throwIfAborted(signal);
    throwIfReadRetired(requestScope);
    options.onCreated?.(first);
    const response = await driveGitPlanReconcile<GitRevisionPlanResponse>({
      kind: "revision",
      maxReconciles: options.maxReconciles ?? 120,
      signal,
      cadence,
      initial: first,
      nextAction: (current) => current.nextAction,
      progress: gitPlanProgressSignature,
      reconcile: (current) =>
        reconcileGitRevisionPlanForReview(current.revisionPlan.id, requestScope, capsuleId),
    });
    throwIfReadRetired(requestScope);
    options.onSettled?.(response);
    return requireReviewableRevisionPlan(response);
  });
}

/**
 * The settled revision as a reviewable Plan Run, or its own diagnostic as a
 * `ControlApiError` (e.g. `revision_already_current` when there is nothing to
 * update).
 */
export function requireReviewableRevisionPlan(
  response: GitRevisionPlanResponse,
): GitRevisionPlanResponse & {
  readonly revisionPlan: { readonly planRunId: string };
} {
  const planRunId = response.revisionPlan.planRunId;
  if (response.nextAction !== "review_run" || !planRunId) {
    throw new ControlApiError(
      409,
      response.revisionPlan.diagnostic?.code ?? "revision_plan_failed",
      response.revisionPlan.diagnostic?.message ??
        "The revision plan did not produce a reviewable Run.",
      response,
    );
  }
  return { ...response, revisionPlan: { ...response.revisionPlan, planRunId } };
}

/** Whether a version check found that the app already runs that version. */
export function isRevisionAlreadyCurrent(error: unknown): boolean {
  return error instanceof ControlApiError && error.code === "revision_already_current";
}

const CAPSULE_STATUSES: ReadonlySet<CapsuleStatus> = new Set([
  "pending",
  "active",
  "stale",
  "error",
  "disabled",
  "uninstalled",
  "destroyed",
]);

function isCapsuleResponse(value: unknown): value is Capsule {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.workspaceId === undefined || (typeof value.workspaceId === "string" && value.workspaceId.length > 0)) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.slug === "string" &&
    value.slug.length > 0 &&
    (value.sourceId === undefined ||
      (typeof value.sourceId === "string" && value.sourceId.length > 0)) &&
    typeof value.installConfigId === "string" &&
    value.installConfigId.length > 0 &&
    typeof value.environment === "string" &&
    value.environment.length > 0 &&
    typeof value.currentStateGeneration === "number" &&
    Number.isFinite(value.currentStateGeneration) &&
    CAPSULE_STATUSES.has(value.status as CapsuleStatus) &&
    typeof value.createdAt === "string" &&
    value.createdAt.length > 0 &&
    typeof value.updatedAt === "string" &&
    value.updatedAt.length > 0 &&
    (value.projectId === undefined ||
      (typeof value.projectId === "string" && value.projectId.length > 0))
  );
}

function isMutationOutcomeUnknown(error: unknown): boolean {
  // The guarded transport has not dispatched the mutation if health failed.
  if (error instanceof SharedAuthSessionPreflightError) return false;
  if (error instanceof ControlApiIndeterminateError) return true;
  if (error instanceof ControlApiError) {
    return error.status === 0 || error.status >= 500;
  }
  // `fetch` rejects with a transport error when no HTTP response was
  // observed. A definite HTTP rejection is always represented by
  // ControlApiError and is handled above.
  return true;
}

/** Sets the opt-in once. A lost response leaves the caller to read the app. */
export async function setCapsuleAutoUpdate(
  capsuleId: string,
  enabled: boolean,
  scope: Pick<RequestOpts, "isCurrent"> = {},
): Promise<void> {
  let dispatched = false;
  let responseStatus: number | undefined;
  try {
    await withControlDeadline("Automatic update setting", scope, (requestScope) => controlFetch<unknown>(
      `${BASE}/capsules/${encodeURIComponent(capsuleId)}`,
      {
        ...requestScope,
        method: "PATCH",
        body: { autoUpdate: enabled },
        beforeDispatch: () => { dispatched = true; },
        onResponseStatus: (status) => { responseStatus = status; },
      },
    ));
  } catch (failure) {
    throwIfReadRetired(scope);
    const rejection = clientRejectionOnDeadline(responseStatus, failure);
    if (rejection) throw rejection;
    if (!dispatched || !isMutationOutcomeUnknown(failure)) throw failure;
  }
  throwIfReadRetired(scope);
}

export interface ScheduleCapsuleUninstallResult {
  readonly capsule: Capsule;
  /** Operator grace period in whole days, when the host reports it. */
  readonly graceDays?: number;
  readonly alreadyDeleted?: boolean;
}

/** Retire an unanswered reservation write so the caller can reread the app. */
async function submitUninstallReservation<T>(label: string, path: string, options: RequestOpts): Promise<T> {
  let responseStatus: number | undefined;
  try {
    return await withControlDeadline(label, options, (scope) => controlFetch<T>(path, {
      ...options,
      ...scope,
      onResponseStatus: (status) => { responseStatus = status; },
    }));
  } catch (failure) {
    throw clientRejectionOnDeadline(responseStatus, failure) ?? failure;
  }
}

/**
 * Stage one of the two-stage uninstall: the service and its data stay until
 * the grace period ends, and the owner can cancel until then. Teardown then
 * runs server-side after a data export attempt.
 */
export async function scheduleCapsuleUninstall(
  capsuleId: string,
): Promise<ScheduleCapsuleUninstallResult> {
  return await controlFetch<ScheduleCapsuleUninstallResult>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/uninstall`,
    { method: "POST" },
  );
}

/** Cancels a scheduled uninstall during its grace period. */
export async function cancelCapsuleUninstall(
  capsuleId: string,
  expectedUninstallId: string,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<Capsule> {
  const body = await submitUninstallReservation<{ capsule: Capsule }>(
    "Cancel uninstall reservation",
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/cancel-uninstall-reservation`,
    { ...options, method: "POST", body: { expectedUninstallId } },
  );
  return body.capsule;
}

export interface DeleteCapsuleResult {
  readonly capsule?: Capsule;
  readonly run?: unknown;
  readonly graceDays?: number;
  readonly abandoned?: boolean;
  readonly alreadyDeleted?: boolean;
  readonly projectionStatus?: string;
}

export interface DeleteCapsuleOptions extends Pick<RequestOpts, "isCurrent"> {
  /** Create the legacy reviewable destroy Plan instead of scheduling deletion. */
  readonly immediate?: boolean;
  readonly idempotencyKey?: string;
}

export interface CapsuleAbandonmentExpectation {
  readonly id: string;
  readonly workspaceId?: string;
}

/**
 * Accepts only the authoritative terminal readback for an unapplied Capsule
 * abandonment. The `alreadyDeleted` branch covers a lost acknowledgement, but
 * still requires the server to return the destroyed Capsule projection.
 */
export function capsuleAbandonmentCompleted(
  value: unknown,
  expected: CapsuleAbandonmentExpectation,
): boolean {
  if (!isRecord(value) || !isCapsuleResponse(value.capsule)) return false;
  const firstAcknowledgement =
    value.abandoned === true && value.alreadyDeleted === undefined;
  const lostAcknowledgementRetry =
    value.alreadyDeleted === true && value.abandoned === undefined;
  return (
    value.capsule.id === expected.id &&
    value.capsule.workspaceId === expected.workspaceId &&
    value.capsule.status === "destroyed" &&
    value.capsule.currentStateGeneration === 0 &&
    value.capsule.currentStateVersionId === undefined &&
    (firstAcknowledgement || lostAcknowledgementRetry)
  );
}

/**
 * Atomically abandons only a never-applied Capsule. The server must reject an
 * applied Capsule without creating the destroy Plan used by generic DELETE.
 */
export async function abandonUnappliedCapsule(
  capsuleId: string,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<DeleteCapsuleResult | unknown> {
  return await controlFetch<DeleteCapsuleResult | unknown>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/abandon`,
    { method: "POST", isCurrent: options.isCurrent },
  );
}

/**
 * Schedules deletion by default. Applied Capsules retain their data through the
 * operator-configured grace period and can be restored with cancel-uninstall.
 * Passing `immediate: true` creates the legacy reviewable destroy Plan.
 * Never-applied Capsules keep the existing abandonment behavior.
 */
export async function deleteCapsule(
  capsuleId: string,
  options: DeleteCapsuleOptions = {},
): Promise<DeleteCapsuleResult> {
  const immediate = options.immediate === undefined
    ? ""
    : `?immediate=${options.immediate}`;
  const path = `${BASE}/capsules/${encodeURIComponent(capsuleId)}${immediate}`;
  const request = { method: "DELETE", isCurrent: options.isCurrent };
  if (options.immediate !== true) {
    return await submitUninstallReservation<DeleteCapsuleResult>("Schedule uninstall", path, request);
  }
  return await controlFetch<DeleteCapsuleResult>(path, {
    ...request,
    ...(options.idempotencyKey ? { headers: { "idempotency-key": options.idempotencyKey } } : {}),
  });
}

export async function getCapsuleProviderBindingSet(
  capsuleId: string,
  options: Pick<RequestOpts, "signal" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {},
): Promise<ProviderBindingSet | null> {
  const body = await controlFetch<{
    providerBindingSet: ProviderBindingSet | null;
  }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/provider-bindings`, options);
  return body.providerBindingSet;
}

export function createCapsuleDestroyRecoveryPlan(
  capsuleId: string,
  replacements: readonly DestroyProviderConnectionReplacement[],
  options: Pick<RequestOpts, "isCurrent" | "beforeDispatch"> = {},
): Promise<unknown> {
  return controlFetch(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/destroy-plan`, {
    method: "POST",
    body: { destroyProviderConnectionReplacements: replacements },
    ...options,
  });
}

// --- Capsule configs -------------------------------------------------------

export const STORE_VIEW = "store" as const;

export type InstallConfigView = typeof STORE_VIEW;

export async function listInstallConfigs(
  workspaceId?: string,
  options: { readonly view?: InstallConfigView } = {},
): Promise<readonly InstallConfig[]> {
  return await fetchAllPages<InstallConfig>(
    `${BASE}/capsule-configs${query({
      workspaceId: workspaceId,
      view: options.view,
    })}`,
    (body) => (body.installConfigs as readonly InstallConfig[]) ?? [],
  );
}

export type GetInstallConfigOptions = {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  readonly reuseRecentSharedAuthProbe?: boolean;
};

export function getInstallConfig(
  id: string,
  options?: GetInstallConfigOptions,
): Promise<InstallConfig>;
export function getInstallConfig(
  id: string,
  options?: object,
): Promise<InstallConfig>;
export async function getInstallConfig(
  id: string,
  options?: object,
): Promise<InstallConfig> {
  const signal = isRecord(options)
    ? (options.signal as AbortSignal | undefined)
    : undefined;
  const isCurrent = isRecord(options) && typeof options.isCurrent === "function"
    ? options.isCurrent as () => boolean
    : undefined;
  const body = await controlFetch<{ installConfig: InstallConfig }>(
    `${BASE}/capsule-configs/${encodeURIComponent(id)}`,
    { signal, isCurrent, reuseRecentSharedAuthProbe: isRecord(options) && options.reuseRecentSharedAuthProbe === true },
  );
  return body.installConfig;
}

export async function createCapsuleBackup(
  capsuleId: string,
): Promise<BackupRecord> {
  const body = await controlFetch<{ backup: BackupRecord }>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/backups`,
    { method: "POST" },
  );
  return body.backup;
}

// --- Activity --------------------------------------------------------------

export async function listActivity(
  workspaceId: string,
  limit?: number,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<readonly ActivityEvent[]> {
  const body = await controlFetch<{ events?: readonly ActivityEvent[] }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/activity${query({ limit })}`,
    { signal: opts.signal },
  );
  return body.events ?? [];
}

/** Activity already authorized for one app, including a shared app. */
export async function listCapsuleActivity(
  capsuleId: string,
  limit = 100,
  opts: Pick<RequestOpts, "signal" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {},
): Promise<readonly ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // App Activity can return sparse or empty pages while scanning a partition.
  // Keep this read bounded; an unfinished window is unavailable, never empty.
  for (let page = 0; page < 10; page++) {
    const body = await controlFetch<{
      events?: readonly ActivityEvent[];
      nextCursor?: unknown;
      incomplete?: boolean;
    }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/activity${query({ limit, cursor })}`, opts);
    if (!body || !Array.isArray(body.events) || body.incomplete === true) break;
    events.push(...body.events.slice(0, limit - events.length));
    if (events.length === limit || body.nextCursor === undefined) return events;
    if (typeof body.nextCursor !== "string" || !body.nextCursor || cursors.has(body.nextCursor)) break;
    cursor = body.nextCursor;
    cursors.add(cursor);
  }
  throw new ControlApiError(502, "incomplete_capsule_activity_response", "App activity window could not be read completely.");
}

export async function listRuns(
  workspaceId: string,
  limit?: number,
): Promise<readonly Run[]> {
  const body = await controlFetch<{ runs?: readonly Run[] }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/runs${query({ limit })}`,
  );
  return body.runs ?? [];
}

// --- Installed-app view (TASK-0115 Phase 3a) ---------------------------------
//
// `GET /api/v1/capsules/:id/app` is the control plane's own answer to "what
// state is this app in and what should the person do next": state, the one
// primary action, ordered problems, every launchable screen, version facts,
// progress and uninstall terms. `GET /api/v1/capsules/:id/runs` pages one
// app's Runs newest first, so no app page depends on a Workspace-wide window.
// The DTOs are the contract shapes; the dashboard adds no fields of its own.

export type {
  CapsuleAppAction,
  CapsuleAppIncompleteSection,
  CapsuleAppProblem,
  CapsuleAppProblemCode,
  CapsuleAppRunSummary,
  CapsuleAppScreen,
  CapsuleAppState,
  CapsuleAppUninstall,
  CapsuleAppVersion,
  RunPolicyLayer,
  RunPolicyReasonCode,
} from "takosumi-contract";
export type CapsuleAppView = ContractCapsuleAppView;
export type RunPolicyReason = ContractRunPolicyReason;
export type RunPlanOrigin = ContractRunPlanOrigin;

const INSTALLED_APP_LIST_LIMIT = 200;
const INSTALLED_APP_PAGE_LIMIT = 50;
const INSTALLED_APP_READ_CONCURRENCY = 4;
const INSTALLED_APP_STATES = new Set([
  "installing", "installed", "updating", "needs_attention", "stopped",
  "uninstall_scheduled", "uninstalling", "uninstalled", "update_available",
]);

function safeInstalledAppIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !hasCredentialQueryParams(url.searchParams) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type StoreInstalledApp = InstalledAppSummary & { readonly updateAvailable?: true };

function invalidInstalledAppResponse(): ControlApiError {
  return new ControlApiError(502, "invalid_installed_apps_response", "Installed apps returned an invalid response.");
}

function isStoreInstalledApp(app: unknown): app is StoreInstalledApp {
  if (!isRecord(app) || typeof app.capsuleId !== "string" || !app.capsuleId ||
    typeof app.name !== "string" || !INSTALLED_APP_STATES.has(app.state as string) ||
    app.state === "update_available" || (app.updateAvailable !== undefined && app.updateAvailable !== true) ||
    (app.displayName !== undefined && (!isRecord(app.displayName) ||
      typeof app.displayName.ja !== "string" || typeof app.displayName.en !== "string")) ||
    (app.iconUrl !== undefined && !safeInstalledAppIcon(app.iconUrl)) ||
    !isRecord(app.installedFrom)) return false;
  const source = app.installedFrom;
  return typeof source.url === "string" && source.url !== "" &&
    installedAppSourceUrl(source.url) === source.url &&
    isCanonicalRepositoryDirectoryPath(source.path) &&
    (source.matchable === undefined || source.matchable === false);
}

/** Reads value-free installed app identities for matching Store listings. */
export async function listInstalledApps(workspaceId?: string): Promise<{
  readonly installedApps: readonly StoreInstalledApp[];
  readonly complete: boolean;
}> {
  const installedApps: StoreInstalledApp[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let complete = true;
  for (let page = 0; page < INSTALLED_APP_LIST_LIMIT / INSTALLED_APP_PAGE_LIMIT; page++) {
    const path = `${BASE}/apps${query({ projection: INSTALLED_APP_PROJECTION, limit: INSTALLED_APP_PAGE_LIMIT, cursor })}`;
    try {
      const body = await withControlDeadline("Installed apps read", {}, (scope) =>
        controlFetch<unknown>(path, { ...scope, cache: "no-store", reuseRecentSharedAuthProbe: true }),
      );
      if (page === 0 && isKnownSharedAuthRouteAbsent() && isRecord(body) &&
        body.projection === undefined && Array.isArray(body.apps)) {
        // Older stock OSS understands /apps but ignores the projection.
        return listLegacyInstalledApps(workspaceId, body);
      }
      if (!isRecord(body) || body.projection !== INSTALLED_APP_PROJECTION ||
        typeof body.complete !== "boolean" || !Array.isArray(body.installedApps) ||
        body.installedApps.length > INSTALLED_APP_PAGE_LIMIT ||
        !body.installedApps.every(isStoreInstalledApp) ||
        new Set(body.installedApps.map((app) => app.capsuleId)).size !== body.installedApps.length ||
        body.installedApps.some((app) => seenIds.has(app.capsuleId)) ||
        (body.nextCursor !== undefined && (typeof body.nextCursor !== "string" ||
          !body.nextCursor || body.nextCursor.length > 4096 || seenCursors.has(body.nextCursor)))) {
        throw invalidInstalledAppResponse();
      }
      for (const app of body.installedApps) {
        seenIds.add(app.capsuleId);
        installedApps.push(app);
      }
      complete &&= body.complete;
      cursor = body.nextCursor;
      if (cursor === undefined) return { installedApps, complete };
      seenCursors.add(cursor);
    } catch (error) {
      if (page === 0 && isKnownSharedAuthRouteAbsent() &&
        isMissingControlRoute(normalizeAppsRouteError(path, error))) return listLegacyInstalledApps(workspaceId);
      if (installedApps.length === 0 ||
        (error instanceof ControlApiError && (error.status === 401 || error.status === 403))) throw error;
      return { installedApps, complete: false };
    }
  }
  return { installedApps, complete: false };
}

async function listLegacyInstalledApps(workspaceId?: string, firstPage?: Record<string, unknown>): Promise<{
  readonly installedApps: readonly StoreInstalledApp[];
  readonly complete: boolean;
}> {
  // The account-owned app list is the same authority used by listAccessibleApps,
  // but this discovery read has a strict ceiling so a long account cannot make
  // Store load an unbounded number of detail/config requests.
  const apps: Pick<StoreInstalledApp, "capsuleId" | "state" | "updateAvailable">[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let inspected = 0;
  let complete = true;
  let cursor: string | undefined;
  for (;;) {
    let body: unknown;
    try {
      body = cursor === undefined && firstPage
        ? firstPage
        : await readCachedAppsPage(`${BASE}/apps${cursor ? query({ cursor }) : ""}`);
    } catch (error) {
      if (isMissingControlRoute(error) && cursor === undefined) {
        const legacyId = await legacyWorkspaceFor404(workspaceId);
        if (!legacyId) return { installedApps: [], complete: false };
        const legacy = await controlFetch<ListInstalledAppsResponse>(
          `${BASE}/workspaces/${encodeURIComponent(legacyId)}/installed-apps`,
        );
        if (!Array.isArray(legacy.installedApps) || typeof legacy.complete !== "boolean") {
          throw new ControlApiError(502, "invalid_installed_apps_response", "Installed apps returned an invalid response.");
        }
        return legacy;
      }
      if (cursor === undefined ||
        (error instanceof ControlApiError && (error.status === 401 || error.status === 403))) throw error;
      complete = false;
      break;
    }
    if (!isRecord(body) || !Array.isArray(body.apps) ||
      (body.nextCursor !== undefined && typeof body.nextCursor !== "string")) {
      if (cursor === undefined) {
        throw new ControlApiError(502, "invalid_installed_apps_response", "Installed apps returned an invalid response.");
      }
      complete = false;
      break;
    }
    for (const raw of body.apps) {
      if (inspected === INSTALLED_APP_LIST_LIMIT) {
        complete = false;
        break;
      }
      inspected += 1;
      if (!isRecord(raw) || typeof raw.capsuleId !== "string" || !raw.capsuleId ||
        !INSTALLED_APP_STATES.has(raw.state as string) ||
        (raw.role !== "owner" && raw.role !== "member") ||
        typeof raw.name !== "string" || typeof raw.ownerDisplayName !== "string" ||
        typeof raw.primaryAction !== "string") {
        if (cursor === undefined) {
          throw new ControlApiError(502, "invalid_installed_apps_response", "Installed apps returned an invalid response.");
        }
        complete = false;
        continue;
      }
      if (seenIds.has(raw.capsuleId)) {
        if (cursor === undefined) {
          throw new ControlApiError(502, "invalid_installed_apps_response", "Installed apps returned an invalid response.");
        }
        complete = false;
        continue;
      }
      seenIds.add(raw.capsuleId);
      apps.push({
        capsuleId: raw.capsuleId,
        state: raw.state === "update_available" ? "installed" : raw.state as InstalledAppSummary["state"],
        ...(raw.state === "update_available" ? { updateAvailable: true } : {}),
      });
    }
    if (inspected === INSTALLED_APP_LIST_LIMIT) {
      if (body.nextCursor !== undefined && body.nextCursor !== "") complete = false;
      break;
    }
    if (body.nextCursor === undefined || body.nextCursor === "") break;
    if (typeof body.nextCursor !== "string" || seenCursors.has(body.nextCursor)) {
      complete = false;
      break;
    }
    cursor = body.nextCursor;
    seenCursors.add(cursor);
  }

  const rows: (StoreInstalledApp | undefined)[] = new Array(apps.length);
  let next = 0;
  const readOne = async (index: number) => {
    const app = apps[index]!;
    try {
      const capsule = await getCapsule(app.capsuleId);
      if (capsule.id !== app.capsuleId || capsule.status === "destroyed") {
        complete = false;
        return;
      }
      const config = await getInstallConfig(capsule.installConfigId);
      if (!isRecord(config) || config.id !== capsule.installConfigId ||
        (capsule.workspaceId && config.workspaceId && config.workspaceId !== capsule.workspaceId)) {
        complete = false;
        return;
      }
      const selector = config.sourceSelector;
      const needsSource = !selector?.url || !selector.path;
      const source = needsSource && capsule.sourceId ? await getSource(capsule.sourceId) : undefined;
      if (needsSource && !source ||
        (source && capsule.workspaceId && source.workspaceId !== capsule.workspaceId)) {
        complete = false;
        return;
      }
      const sourceUrl = selector?.url ?? source!.url;
      const displaySourceUrl = installedAppSourceUrl(sourceUrl);
      if (!displaySourceUrl) {
        complete = false;
        return;
      }
      const sourcePath = normalizeInstallConfigSourcePath(selector?.path ?? source!.defaultPath);
      const modulePath = normalizeInstallConfigSourcePath(config.modulePath ?? ".");
      const path = [sourcePath, modulePath].filter((part) => part !== ".").join("/") || ".";
      const storeName = config.store?.name;
      const displayName = storeName && typeof storeName.ja === "string" && typeof storeName.en === "string"
        ? storeName : undefined;
      if (storeName && !displayName) complete = false;
      const iconUrl = safeInstalledAppIcon(config.store?.iconUrl);
      rows[index] = {
        capsuleId: capsule.id,
        name: capsule.name,
        ...(displayName ? { displayName } : {}),
        ...(iconUrl ? { iconUrl } : {}),
        state: app.state,
        ...(app.updateAvailable ? { updateAvailable: true } : {}),
        installedFrom: {
          url: displaySourceUrl,
          path,
          ...(installedAppSourceIsMatchable(sourceUrl) ? {} : { matchable: false as const }),
        },
      };
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 401) throw error;
      complete = false;
    }
  };
  const workers = Array.from({ length: Math.min(INSTALLED_APP_READ_CONCURRENCY, apps.length) }, async () => {
    while (next < apps.length) await readOne(next++);
  });
  await Promise.all(workers);
  return { installedApps: rows.filter((row): row is StoreInstalledApp => row !== undefined), complete };
}

/** The view kind this dashboard build understands. */
const CAPSULE_APP_VIEW_KIND = "takosumi.capsule-app@v1";

/** Reads the server-computed view of one installed app. */
export function getCapsuleApp(capsuleId: string): Promise<CapsuleAppView> {
  return getCapsuleAppWithSignal(capsuleId);
}

export async function getCapsuleAppWithSignal(
  capsuleId: string,
  signal?: AbortSignal,
  options: Pick<ControlReadScope, "isCurrent" | "cache"> & { readonly workspaceId?: string } = {},
): Promise<CapsuleAppView> {
  const body = await withControlDeadline("App read", { signal, ...options }, (scope) =>
    controlFetch<{ app?: CapsuleAppView }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/app`, scope),
  );
  throwIfReadRetired({ signal, ...options });
  const app = body.app;
  if (
    !isRecord(app) ||
    app.kind !== CAPSULE_APP_VIEW_KIND ||
    app.capsuleId !== capsuleId ||
    (options.workspaceId !== undefined && app.workspaceId !== options.workspaceId) ||
    typeof app.state !== "string" ||
    typeof app.primaryAction !== "string" ||
    !Array.isArray(app.problems) ||
    !Array.isArray(app.screens) ||
    !isRecord(app.version) ||
    !isRecord(app.progress) ||
    !isRecord(app.uninstall)
  ) {
    throw new ControlApiError(
      502,
      "invalid_capsule_app_response",
      "App read returned an invalid response.",
    );
  }
  return app;
}

export interface InterfaceLinkCandidate {
  readonly interfaceId: string;
  readonly providerCapsuleId: string;
  readonly providerCapsuleName: string;
  readonly interfaceName: string;
}

const interfaceLinkPath = (capsuleId: string, requirementKey: string) =>
  `${BASE}/capsules/${encodeURIComponent(capsuleId)}/interface-links/${encodeURIComponent(requirementKey)}`;

export function getInterfaceLinkCandidates(
  capsuleId: string,
  requirementKey: string,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<{
  readonly candidates: readonly InterfaceLinkCandidate[];
  readonly generation: number;
}> {
  return controlFetch(`${interfaceLinkPath(capsuleId, requirementKey)}/candidates`, options);
}

export function setInterfaceLink(capsuleId: string, requirementKey: string, input: {
  readonly interfaceId: string;
  readonly expectedGeneration: number;
}, options: Pick<RequestOpts, "isCurrent" | "beforeDispatch"> = {}): Promise<{ readonly link: import("takosumi-contract").InterfaceLink }> {
  return controlFetch(interfaceLinkPath(capsuleId, requirementKey), { ...options, method: "PUT", body: input });
}

export function revokeInterfaceLink(
  capsuleId: string,
  requirementKey: string,
  expectedGeneration: number,
  options: Pick<RequestOpts, "isCurrent" | "beforeDispatch"> = {},
): Promise<{
  readonly link: import("takosumi-contract").InterfaceLink;
}> {
  return controlFetch(interfaceLinkPath(capsuleId, requirementKey), {
    ...options, method: "DELETE", body: { expectedGeneration },
  });
}

/**
 * The provider app's consent to a pending link (`approve`) or its refusal
 * (`decline`). Addressed to the PROVIDER app by link id, guarded by the
 * link generation the page read.
 */
export function decideInterfaceLink(
  providerCapsuleId: string,
  linkId: string,
  decision: "approve" | "decline",
  expectedGeneration: number,
  options: Pick<RequestOpts, "isCurrent" | "beforeDispatch"> = {},
): Promise<{
  readonly link: import("takosumi-contract").InterfaceLink;
}> {
  return controlFetch(
    `${BASE}/capsules/${encodeURIComponent(providerCapsuleId)}/interface-links/${encodeURIComponent(linkId)}/${decision}`,
    { ...options, method: "POST", body: { expectedGeneration } },
  );
}

/**
 * Advances an install attempt bound to a never-applied app through its own
 * reconciliation until it asks for a review (`continue_install`), so the app
 * page never plans the Capsule beside the attempt. Resolves to the attempt's
 * last response; the caller reads `installPlan.planRunId`.
 */
export async function advanceGitInstallPlan(
  installPlanId: string,
  options: { readonly timeoutMs?: number; readonly pollCadence?: GitPlanPollCadence; readonly isCurrent?: () => boolean } = {},
): Promise<GitInstallPlanResponse> {
  const cadence = resolveGitPlanPollCadence(options.pollCadence);
  return await withGitPlanDeadline("install", options.timeoutMs, async (signal) => {
    const requestScope = { signal, isCurrent: options.isCurrent };
    const first = await reconcileGitInstallPlan(installPlanId, requestScope);
    throwIfAborted(signal);
    throwIfReadRetired(requestScope);
    const response = await driveGitPlanReconcile<GitInstallPlanResponse>({
      kind: "install",
      maxReconciles: 120,
      signal,
      cadence,
      initial: first,
      nextAction: (current) => current.nextAction,
      progress: gitPlanProgressSignature,
      reconcile: () => reconcileGitInstallPlan(installPlanId, requestScope),
    });
    throwIfReadRetired(requestScope);
    return response;
  });
}

/**
 * Continues an existing revision coordinator through its own reconciliation
 * until it asks for a review. Resolves to its last response; the caller reads
 * `revisionPlan.planRunId`.
 */
export async function advanceGitRevisionPlan(
  revisionPlanId: string,
  options: {
    readonly timeoutMs?: number;
    readonly pollCadence?: GitPlanPollCadence;
    readonly isCurrent?: () => boolean;
    readonly expectedCapsuleId?: string;
  } = {},
): Promise<GitRevisionPlanResponse> {
  const cadence = resolveGitPlanPollCadence(options.pollCadence);
  return await withGitPlanDeadline("revision", options.timeoutMs, async (signal) => {
    const requestScope = { signal, isCurrent: options.isCurrent };
    const reconcile = () => reconcileGitRevisionPlanForReview(revisionPlanId, requestScope, options.expectedCapsuleId);
    const first = await reconcile();
    throwIfAborted(signal);
    throwIfReadRetired(requestScope);
    const response = await driveGitPlanReconcile<GitRevisionPlanResponse>({
      kind: "revision",
      maxReconciles: 120,
      signal,
      cadence,
      initial: first,
      nextAction: (current) => current.nextAction,
      progress: gitPlanProgressSignature,
      reconcile,
    });
    throwIfReadRetired(requestScope);
    return response;
  });
}

/** Upper bound the per-app Run listing accepts for one page. */
export const CAPSULE_RUN_PAGE_MAX = 100;

export interface CapsuleRunPage {
  readonly runs: readonly Run[];
  readonly nextCursor?: string;
}

/** One page of an app's Runs, newest first. */
export async function listCapsuleRuns(
  capsuleId: string,
  options: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly types?: readonly RunType[];
    readonly planRunId?: string;
    readonly signal?: AbortSignal;
    readonly isCurrent?: () => boolean;
  } = {},
): Promise<CapsuleRunPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(Math.min(Math.max(1, Math.floor(options.limit)), CAPSULE_RUN_PAGE_MAX)));
  }
  if (options.cursor) params.set("cursor", options.cursor);
  for (const type of options.types ?? []) params.append("type", type);
  if (options.planRunId !== undefined) params.set("planRunId", options.planRunId);
  const search = params.toString();
  const body = await controlFetch<{ runs?: unknown; nextCursor?: unknown }>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/runs${search ? `?${search}` : ""}`,
    { signal: options.signal, ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}) },
  );
  // A page without its list is unreadable, never an empty history.
  if (
    !isRecord(body) ||
    !Array.isArray(body.runs) ||
    (body.nextCursor !== undefined && typeof body.nextCursor !== "string")
  ) {
    throw new ControlApiError(
      502,
      "invalid_capsule_runs_response",
      "App history read returned an invalid response.",
    );
  }
  const runs = (body.runs as readonly Run[]).filter(
    (run) => isRecord(run) && run.capsuleId === capsuleId,
  );
  return typeof body.nextCursor === "string" && body.nextCursor
    ? { runs, nextCursor: body.nextCursor }
    : { runs };
}

export type ApplyReviewRun = Pick<Run, "id" | "type" | "capsuleId" | "workspaceId">;

function applyRunTypeForReview(plan: ApplyReviewRun): "apply" | "destroy_apply" | undefined {
  if (!plan.id || !plan.capsuleId || !plan.workspaceId) return;
  if (plan.type === "plan") return "apply";
  if (plan.type === "destroy_plan") return "destroy_apply";
}

export function matchesReviewedApplyRun(plan: ApplyReviewRun, candidate: unknown): boolean {
  const type = applyRunTypeForReview(plan);
  return type !== undefined && isRecord(candidate) &&
    typeof candidate.id === "string" && candidate.id !== "" && candidate.id !== plan.id &&
    candidate.type === type && candidate.workspaceId === plan.workspaceId &&
    candidate.capsuleId === plan.capsuleId && candidate.planRunId === plan.id;
}

/** Read the exact Apply attempts for one review. Older servers may ignore
 * the Plan filter, so check each row and bound the fallback pagination. */
export async function listPlanApplyRuns(
  plan: ApplyReviewRun,
  scope: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<readonly Run[]> {
  const { id, capsuleId } = plan;
  const type = applyRunTypeForReview(plan);
  if (!type || !capsuleId) {
    throw new Error("An app Plan is required to read Apply history.");
  }
  const matches: Run[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    throwIfAborted(scope.signal);
    throwIfReadRetired(scope);
    const page = await listCapsuleRuns(capsuleId, {
      ...scope,
      limit: CAPSULE_RUN_PAGE_MAX,
      ...(cursor ? { cursor } : {}),
      types: [type],
      planRunId: id,
    });
    throwIfAborted(scope.signal);
    throwIfReadRetired(scope);
    if (page.runs.length > CAPSULE_RUN_PAGE_MAX) break;
    matches.push(...page.runs.filter((run) => matchesReviewedApplyRun(plan, run)));
    if (!page.nextCursor) return matches;
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  throw new ControlApiError(502, "incomplete_capsule_runs_response", "Apply history could not be read completely.");
}

// --- Sources ---------------------------------------------------------------

export async function listSources(
  workspaceId: string,
): Promise<readonly Source[]> {
  return await fetchAllPages<Source>(
    `${BASE}/sources${query({ workspaceId: workspaceId })}`,
    (body) => (body.sources as readonly Source[]) ?? [],
  );
}

export async function getSource(
  sourceId: string,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<Source> {
  const body = await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}`,
    options,
  );
  return decodeSourceEnvelope(body);
}

export async function patchSource(
  sourceId: string,
  patch: SourcePatchRequest,
): Promise<Source> {
  const body = await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}`,
    { method: "PATCH", body: patch },
  );
  return decodeSourceEnvelope(body);
}

function sourceIdentityMatches(
  source: Source,
  capsule: Capsule,
  identity: CapsuleSourceIdentity,
): boolean {
  return (
    capsule.workspaceId === identity.workspaceId &&
    capsule.sourceId === identity.sourceId &&
    source.workspaceId === identity.workspaceId &&
    source.id === identity.sourceId &&
    source.url === identity.url &&
    source.defaultPath === identity.defaultPath
  );
}

function sourceRevisionMismatch(message: string): ControlApiError {
  return new ControlApiError(409, "source_revision_mismatch", message);
}

function sameGitRef(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/** Kick a `source_sync` run. Returns the opaque run envelope. */
export async function syncSource(
  sourceId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly intent?: "observe" | "manual_plan";
    readonly expectedRef?: string;
  } = {},
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/sync`,
    {
      method: "POST",
      signal: options.signal,
      body: {
        ...(options.intent ? { intent: options.intent } : {}),
        ...(options.expectedRef === undefined
          ? {}
          : { expectedRef: options.expectedRef }),
      },
    },
  );
}

export async function listSourceSnapshots(
  sourceId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<readonly SourceSnapshot[]> {
  return await fetchAllPages<SourceSnapshot>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/snapshots`,
    (body) => (body.snapshots as readonly SourceSnapshot[]) ?? [],
    { signal: options.signal },
  );
}

/**
 * Resolves one Snapshot identity by paging until the page that contains it.
 *
 * `listSourceSnapshots` answers "what did this Source produce?" and therefore
 * walks every page. Resolving an identity a Run already named does not need
 * the whole history, and stopping at the first matching page is equivalent
 * because Snapshot ids are unique.
 */
async function findSourceSnapshotById(
  sourceId: string,
  sourceSnapshotId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SourceSnapshot | undefined> {
  const basePath = `${BASE}/sources/${encodeURIComponent(sourceId)}/snapshots`;
  let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path =
      cursor === undefined
        ? basePath
        : `${basePath}${sep}cursor=${encodeURIComponent(cursor)}`;
    const body = await controlFetch<{
      nextCursor?: string;
      snapshots?: readonly SourceSnapshot[];
    }>(path, { signal: options.signal });
    const found = (body.snapshots ?? []).find(
      (snapshot) => snapshot.id === sourceSnapshotId,
    );
    if (found) return found;
    if (typeof body.nextCursor !== "string" || body.nextCursor === "") {
      return undefined;
    }
    cursor = body.nextCursor;
  }
  return undefined;
}

export async function resolveStableSourceTag(
  workspaceId: string | undefined,
  url: string,
): Promise<StableSourceTagResolutionResponse> {
  let publicUrl: URL;
  try {
    publicUrl = new URL(url.trim());
  } catch {
    throw new ControlApiError(400, "invalid_request", "A public HTTPS Git URL is required.");
  }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.hash ||
    hasCredentialQueryParams(publicUrl.searchParams) || !installedAppSourceIsMatchable(url)) {
    throw new ControlApiError(400, "invalid_request", "A public HTTPS Git URL is required.");
  }
  const safeUrl = publicUrl.toString();
  const options = { method: "POST", body: { url: safeUrl } } as const;
  if (!await appOwnershipAvailable()) {
    const legacyId = await legacyInstallWorkspaceId(workspaceId);
    if (!legacyId) throw new ControlApiError(404, "feature_unavailable", "Legacy source resolution is unavailable on this server.");
    return await controlFetch<StableSourceTagResolutionResponse>(
      `${BASE}/workspaces/${encodeURIComponent(legacyId)}/source-ref-resolutions/stable-semver`, options,
    );
  }
  try {
    return await controlFetch<StableSourceTagResolutionResponse>(
      `${BASE}/source-ref-resolutions${query({ url: safeUrl })}`,
    );
  } catch (error) {
    if (!isMissingControlRoute(error)) throw error;
    const legacyId = await legacyWorkspaceFor404(workspaceId);
    if (!legacyId) throw error;
    return await controlFetch<StableSourceTagResolutionResponse>(
      `${BASE}/workspaces/${encodeURIComponent(legacyId)}/source-ref-resolutions/stable-semver`,
      options,
    );
  }
}

export async function waitForLatestSourceSnapshot(
  sourceId: string,
  options: {
    readonly runId?: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly maxPollMs?: number;
    readonly signal?: AbortSignal;
    /** Require the returned Run and Snapshot to resolve this exact commit. */
    readonly expectedRef?: string;
    readonly onProgress?: (progress: SourceSnapshotWaitProgress) => void;
  } = {},
): Promise<SourceSnapshot> {
  // Hosted runner source-sync includes container scheduling and git/archive work.
  // Production regularly takes more than 20s, so the dashboard must wait long
  // enough for the normal happy path instead of showing a false failure.
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? 120_000);
  let nextPollMs = options.pollMs ?? 1_500;
  const maxPollMs = options.maxPollMs ?? 5_000;
  let lastSnapshots: readonly SourceSnapshot[] = [];
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    let run: Run | undefined;
    if (options.runId) {
      try {
        run = await getRunWithOptions(options.runId, {
          signal: options.signal,
        });
      } catch (err) {
        const apiError = err instanceof ControlApiError ? err : undefined;
        if (!apiError || apiError.status === 401 || apiError.status === 403) {
          throw err;
        }
      }
      if (
        run?.status === "failed" ||
        run?.status === "cancelled" ||
        run?.status === "expired"
      ) {
        const message = await sourceSyncFailureMessage(run, options.signal);
        throw new ControlApiError(409, "source_sync_failed", message, {
          run,
          // A fresh listing for diagnostics only. The Run failure is the
          // primary error, so a listing that also fails must not replace it.
          snapshots: await sourceSnapshotsForDiagnostics(
            sourceId,
            options.signal,
          ),
        });
      }
      if (
        options.expectedRef !== undefined &&
        run &&
        (!run.ref || !sameGitRef(run.ref, options.expectedRef))
      ) {
        throw sourceRevisionMismatch(
          "Source sync returned a Run for a different revision.",
        );
      }
      if (
        options.expectedRef !== undefined &&
        run?.status === "succeeded" &&
        !run.sourceSnapshotId
      ) {
        throw sourceRevisionMismatch(
          "Source sync succeeded without an authoritative Snapshot relation.",
        );
      }
    }

    if (options.runId) {
      // Do not accept a pre-existing snapshot while this requested sync is
      // queued/running. Update plans must pin the exact immutable snapshot
      // produced by the requested SourceSyncRun.
      if (run?.status === "succeeded" && run.sourceSnapshotId) {
        // The Run already names the exact Snapshot, so page until that
        // identity appears instead of listing the whole history. The listing
        // endpoint is paginated: polling it while the Run was still running
        // re-read every page of the Workspace's Snapshot history at 1/1.5 s
        // without being able to decide the wait.
        const exact = await findSourceSnapshotById(
          sourceId,
          run.sourceSnapshotId,
          { signal: options.signal },
        );
        if (exact) {
          lastSnapshots = [exact];
          if (
            options.expectedRef !== undefined &&
            (!sameGitRef(exact.ref, options.expectedRef) ||
              !sameGitRef(exact.resolvedCommit, options.expectedRef))
          ) {
            throw sourceRevisionMismatch(
              "Source sync returned a Snapshot for a different revision.",
            );
          }
          return exact;
        }
      }
    } else {
      // Without a Run to observe, the Snapshot listing *is* the poll.
      lastSnapshots = await listSourceSnapshots(sourceId, {
        signal: options.signal,
      });
      const latest = [...lastSnapshots].sort((a, b) =>
        b.fetchedAt.localeCompare(a.fetchedAt),
      )[0];
      if (latest) return latest;
    }

    options.onProgress?.({
      elapsedMs: Date.now() - startedAt,
      snapshotsCount: lastSnapshots.length,
      ...(run ? { run } : {}),
    });

    await new Promise((resolve) => setTimeout(resolve, nextPollMs));
    nextPollMs = Math.min(Math.round(nextPollMs * 1.4), maxPollMs);
  }
  throw new ControlApiError(
    409,
    "source_sync_required",
    "Source contents are still being fetched.",
    { sourceId, snapshots: lastSnapshots },
  );
}

/**
 * Best-effort Snapshot listing for an error payload. The Run failure is the
 * primary error, so a diagnostics listing that also fails must not replace it.
 */
async function sourceSnapshotsForDiagnostics(
  sourceId: string,
  signal?: AbortSignal,
): Promise<readonly SourceSnapshot[]> {
  try {
    return await listSourceSnapshots(sourceId, signal ? { signal } : {});
  } catch {
    return [];
  }
}

async function sourceSyncFailureMessage(
  run: Run,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = run.errorCode
    ? `Source sync ${run.status}: ${run.errorCode}`
    : `Source sync ${run.status}.`;
  try {
    const logs = await getRunLogs(run.id, { signal });
    const diagnostic =
      logs.diagnostics.find((entry) => entry.severity === "error") ??
      logs.diagnostics[0];
    if (!diagnostic) return fallback;
    const message = diagnostic.detail
      ? `${diagnostic.message}: ${diagnostic.detail}`
      : diagnostic.message;
    return message.trim() || fallback;
  } catch {
    return fallback;
  }
}

// --- Runs ------------------------------------------------------------------

/** Create a plan run for an Capsule. Returns the opaque Run envelope. */
export async function planCapsule(
  capsuleId: string,
  options: {
    readonly compatibilityReportId?: string;
    readonly timeoutMs?: number;
    readonly isCurrent?: () => boolean;
  } = {},
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller =
    options.timeoutMs && options.timeoutMs > 0
      ? new AbortController()
      : undefined;
  if (controller && options.timeoutMs) {
    timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  }
  try {
    return await controlFetch<unknown>(
      `${BASE}/capsules/${encodeURIComponent(capsuleId)}/plan`,
      {
        method: "POST",
        signal: controller?.signal,
        isCurrent: options.isCurrent,
        body: options.compatibilityReportId
          ? { compatibilityReportId: options.compatibilityReportId }
          : {},
      },
    );
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new ControlApiError(
        0,
        "request_timeout",
        `plan request timed out after ${options.timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Refreshes a Git-backed Capsule and creates an update plan pinned to the
 * exact SourceSnapshot produced by that manual refresh. The sync intent keeps
 * an enabled auto-update policy from racing this explicit review flow.
 */
export async function planCapsuleUpdate(
  capsuleId: string,
  options: {
    readonly timeoutMs?: number;
    /** Require this exact Source revision before starting sync/plan. */
    readonly sourceRevision?: string;
    /** Verify that the existing Source identity remains unchanged. */
    readonly sourceIdentity?: CapsuleSourceIdentity;
  } = {},
): Promise<unknown> {
  const capsule = await getCapsule(capsuleId);
  if (options.sourceRevision !== undefined) {
    if (!isImmutableSourceRevision(options.sourceRevision)) {
      throw new ControlApiError(
        400,
        "invalid_source_revision",
        "Source revision must be an exact 40-character hexadecimal commit.",
      );
    }
    if (!capsule.sourceId) {
      throw sourceRevisionMismatch(
        "This Capsule has no existing Git Source to update.",
      );
    }
    const source = await getSource(capsule.sourceId);
    const identity = options.sourceIdentity ?? {
      workspaceId: capsule.workspaceId,
      sourceId: capsule.sourceId,
      url: source.url,
      defaultPath: source.defaultPath,
    };
    if (!sourceIdentityMatches(source, capsule, identity)) {
      throw sourceRevisionMismatch(
        "The Source URL, path, or Workspace changed; review the current service again.",
      );
    }
    if (!sameGitRef(source.defaultRef, options.sourceRevision)) {
      throw sourceRevisionMismatch(
        "The requested exact Source revision is not the current readback.",
      );
    }
  }
  if (!capsule.sourceId) return await planCapsule(capsuleId, options);

  const syncEnvelope = await syncSource(capsule.sourceId, {
    intent: "manual_plan",
    ...(options.sourceRevision
      ? { expectedRef: options.sourceRevision }
      : {}),
  });
  const sourceSyncRunId = extractRunId(syncEnvelope);
  if (!sourceSyncRunId) {
    throw new ControlApiError(
      500,
      "invalid_source_sync_response",
      "Source sync did not return a Run id.",
      syncEnvelope,
    );
  }
  const snapshot = await waitForLatestSourceSnapshot(capsule.sourceId, {
    runId: sourceSyncRunId,
    ...(options.sourceRevision
      ? { expectedRef: options.sourceRevision }
      : {}),
  });
  const compatibility = await controlFetch<{
    readonly report: { readonly id: string };
  }>(
    `${BASE}/sources/${encodeURIComponent(capsule.sourceId)}/compatibility-check`,
    {
      method: "POST",
      body: {
        sourceSnapshotId: snapshot.id,
        capsuleId,
      },
    },
  );
  return await planCapsule(capsuleId, {
    ...options,
    compatibilityReportId: compatibility.report.id,
  });
}

export async function destroyPlanCapsule(capsuleId: string): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/destroy-plan`,
    { method: "POST" },
  );
}

async function readRun(
  id: string,
  options: ControlReadScope,
  reuseRecentSharedAuthProbe = false,
): Promise<Run> {
  const body = await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(id)}`,
    {
      signal: options.signal,
      cache: options.cache,
      isCurrent: options.isCurrent,
      reuseRecentSharedAuthProbe,
    },
  );
  return body.run;
}

export async function getRunWithOptions(
  id: string,
  options: ControlReadScope = {},
): Promise<Run> {
  return await readRun(id, options);
}

export async function getRun(id: string, options: Pick<RequestOpts, "cache" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {}): Promise<Run> {
  return await withControlDeadline("Run read", options, (scope) =>
    readRun(id, scope, options.reuseRecentSharedAuthProbe));
}

/**
 * Subscribe to a run's status over SSE (`GET /runs/:id/stream`). The server
 * pushes the run on every change and closes at a terminal status, so the run
 * screen updates in real time instead of polling. Same-origin cookie auth
 * (EventSource sends credentials). Returns a disposer; falls back via `onError`
 * when EventSource is unavailable, the stream drops, or a server that
 * advertises heartbeats stops sending them. Quiet older servers keep their
 * existing stream behavior after the initial snapshot.
 */
export function openRunStream(
  id: string,
  handlers: {
    readonly onRun: (run: Run) => void;
    readonly onOpen?: () => void;
    readonly onError?: () => void;
  },
): () => void {
  if (typeof EventSource === "undefined") {
    handlers.onError?.();
    return () => {};
  }
  const source = new EventSource(
    `${BASE}/runs/${encodeURIComponent(id)}/stream`,
    { withCredentials: true },
  );
  let closed = false;
  let supportsHeartbeat = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    source.close();
  };
  const expectFrame = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      close();
      handlers.onError?.();
    }, 30_000);
  };
  source.onopen = () => {
    if (closed) return;
    supportsHeartbeat = false;
    expectFrame();
    handlers.onOpen?.();
  };
  source.addEventListener("run-heartbeat", () => {
    if (!closed && supportsHeartbeat) expectFrame();
  });
  source.onmessage = (event) => {
    if (closed) return;
    try {
      const data = JSON.parse(event.data) as { run?: Run; heartbeat?: boolean };
      if (data?.run?.id !== id) return;
      supportsHeartbeat ||= data.heartbeat === true;
      if (supportsHeartbeat) expectFrame();
      else clearTimeout(idleTimer);
      handlers.onRun(data.run);
    } catch {
      /* ignore a malformed frame */
    }
  };
  source.onerror = () => {
    if (closed) return;
    clearTimeout(idleTimer);
    handlers.onError?.();
  };
  return close;
}

async function postRunDecision(
  id: string,
  action: "approve" | "cancel",
  scope: Pick<RequestOpts, "isCurrent">,
  matches: (observed: Run | undefined) => observed is Run,
  body?: { readonly reason?: string },
): Promise<Run> {
  const label = action === "approve" ? "Plan approval" : "Run cancellation";
  let dispatched = false;
  let responseStatus: number | undefined;
  try {
    const result = await withControlDeadline(label, scope, (requestScope) => controlFetch<{ run: Run }>(
      `${BASE}/runs/${encodeURIComponent(id)}/${action}`,
      {
        ...requestScope,
        method: "POST",
        body,
        beforeDispatch: () => { dispatched = true; },
        onResponseStatus: (status) => { responseStatus = status; },
      },
    ));
    throwIfReadRetired(scope);
    if (matches(result?.run)) return result.run;
    throw action === "approve"
      ? new ControlApiError(502, "invalid_plan_approval_response", "The approval response did not match this Plan.")
      : new ControlApiError(502, "invalid_run_cancellation_response", "The cancellation response did not match this Run.");
  } catch (failure) {
    throwIfReadRetired(scope);
    const rejection = clientRejectionOnDeadline(responseStatus, failure);
    if (rejection) throw rejection;
    if (!dispatched || !isMutationOutcomeUnknown(failure)) throw failure;
    // An uncertain POST is settled by a fresh read of the original Run.
    const observed = await getRun(id, { ...scope, cache: "no-store" });
    throwIfReadRetired(scope);
    if (matches(observed)) return observed;
    throw failure;
  }
}

export async function approveRun(
  plan: Run,
  input: { readonly reason?: string; readonly isCurrent?: () => boolean } = {},
): Promise<Run> {
  return await postRunDecision(plan.id, "approve", { isCurrent: input.isCurrent },
    (observed): observed is Run =>
      observed?.id === plan.id && observed.type === plan.type &&
      observed.workspaceId === plan.workspaceId && observed.capsuleId === plan.capsuleId &&
      observed.planDigest === plan.planDigest &&
      observed.baseStateGeneration === plan.baseStateGeneration &&
      observed.status === "succeeded",
    input.reason ? { reason: input.reason } : {},
  );
}

export async function getRunLogs(
  id: string,
  options: Pick<RequestOpts, "signal" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {},
): Promise<RunLogs> {
  return await controlFetch<RunLogs>(`${BASE}/runs/${encodeURIComponent(id)}/logs`, options);
}

/**
 * Reads a plan / destroy_plan Run's public cost projection (`GET
 * /api/v1/runs/:id/cost`). Used by the Run view to surface, before apply,
 * the estimated USD amount and any host extension decision that would block the
 * apply. The values are the ones the controller already computed
 * at plan time; this never computes cost and returns no secret material.
 */
export async function getRunCostInfo(
  id: string,
  options: Pick<RequestOpts, "isCurrent"> = {},
): Promise<RunCostInfo> {
  const body = await controlFetch<{ cost: RunCostInfo }>(
    `${BASE}/runs/${encodeURIComponent(id)}/cost`, { ...options, reuseRecentSharedAuthProbe: true },
  );
  return body.cost;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Applies a reviewed app Plan through the unified Run surface. The backend
 * rebuilds its apply guard and the browser accepts only the linked Apply.
 */
export async function createApplyRun(
  plan: ApplyReviewRun,
  input: {
    readonly timeoutMs?: number;
    readonly isCurrent?: () => boolean;
  } = {},
): Promise<{ readonly run: Run }> {
  if (!applyRunTypeForReview(plan)) {
    throw new ControlApiError(400, "invalid_apply_plan", "An app Plan is required to create an Apply.");
  }
  const planRunId = plan.id;
  throwIfReadRetired(input);
  const controller = input.timeoutMs && input.timeoutMs > 0 ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;
  let dispatched = false;
  try {
    const body = await controlFetch<unknown>(
      `${BASE}/runs/${encodeURIComponent(planRunId)}/apply`,
      {
        method: "POST",
        signal: controller?.signal,
        isCurrent: input.isCurrent,
        beforeDispatch: () => { dispatched = true; },
        acceptResponseAfterAbort: true,
        body: {},
      },
    );
    throwIfReadRetired(input);
    if (!isRecord(body) || !matchesReviewedApplyRun(plan, body.run)) {
      throw new ControlApiError(502, "invalid_apply_response", "Apply returned an invalid response.");
    }
    return { run: body.run as Run };
  } catch (error) {
    const cause = controller?.signal.aborted && isAbortError(error)
      ? new ControlApiError(0, "request_timeout", `apply request timed out after ${input.timeoutMs}ms`)
      : error;
    if (!dispatched || (cause instanceof ControlApiError && cause.status > 0 &&
      cause.status < 500 && cause.status !== 408 && cause.code !== "request_timeout")) {
      throw cause;
    }
    // The server may have queued an Apply before its response was lost.
    // Callers now reconcile through read-only Run history.
    throw new ControlApiIndeterminateError(
      "apply",
      "Apply request outcome is indeterminate; reconcile the exact PlanRun before trying again.",
      cause,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Cancel a queued or waiting-for-approval Run and verify its settled state. */
export async function cancelRun(
  run: Run,
  scope: Pick<RequestOpts, "isCurrent"> = {},
): Promise<Run> {
  return await postRunDecision(run.id, "cancel", scope, (observed): observed is Run =>
    observed?.id === run.id && observed.type === run.type &&
    observed.workspaceId === run.workspaceId && observed.capsuleId === run.capsuleId &&
    observed.status === "cancelled",
  );
}

// --- StateVersions ---------------------------------------------------------

/**
 * Lists a Capsule's StateVersion history for the dashboard session. Rows are
 * browser-safe metadata and arrive newest-first.
 */
type ListStateVersionsOptions = Pick<RequestOpts, "signal" | "isCurrent" | "reuseRecentSharedAuthProbe">;
// Existing dashboard resources pass Solid's fetcher info as argument two.
type ResourceFetcherInfoCompatibility = {
  readonly value: unknown;
  readonly refetching: unknown;
};

export function listStateVersions(
  capsuleId: string,
  opts?: ListStateVersionsOptions,
): Promise<readonly PublicStateVersion[]>;
export function listStateVersions(
  capsuleId: string,
  info: ResourceFetcherInfoCompatibility,
): Promise<readonly PublicStateVersion[]>;
export async function listStateVersions(
  capsuleId: string,
  optsOrInfo?: ListStateVersionsOptions | ResourceFetcherInfoCompatibility,
): Promise<readonly PublicStateVersion[]> {
  const opts = optsOrInfo && "refetching" in optsOrInfo ? undefined : optsOrInfo;
  return await fetchAllPages<PublicStateVersion>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/state-versions`,
    (body) => (body.stateVersions as readonly PublicStateVersion[]) ?? [],
    opts,
  );
}

/**
 * Reads one browser-safe StateVersion ledger record by id.
 */
export async function getStateVersion(
  stateVersionId: string,
): Promise<PublicStateVersion> {
  const body = await controlFetch<{ stateVersion: PublicStateVersion }>(
    `${BASE}/state-versions/${encodeURIComponent(stateVersionId)}`,
  );
  return body.stateVersion;
}

export type CapsuleCurrentResourceInventory =
  ContractCapsuleCurrentResourceInventory;

/**
 * Reads the value-free OpenTofu resource inventory recorded by the current
 * Capsule apply lineage. This is not a provider health check.
 */
export async function getCurrentResourceInventory(
  capsuleId: string,
): Promise<CapsuleCurrentResourceInventory> {
  const body = await controlFetch<{
    readonly inventory: CapsuleCurrentResourceInventory;
  }>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/current-resource-inventory`,
  );
  return body.inventory;
}

/**
 * Creates a rollback PLAN run from a StateVersion's creating Run provenance.
 */
export async function createStateVersionRollbackPlan(
  stateVersionId: string,
  options: { readonly idempotencyKey?: string; readonly isCurrent?: () => boolean } = {},
): Promise<unknown> {
  let responseStatus: number | undefined;
  try {
    const result = await withControlDeadline("Rollback Plan", { isCurrent: options.isCurrent }, (scope) =>
      controlFetch<unknown>(`${BASE}/state-versions/${encodeURIComponent(stateVersionId)}/rollback-plan`, {
        ...scope,
        method: "POST",
        onResponseStatus: (status) => { responseStatus = status; },
        ...(options.idempotencyKey === undefined ? {} : { headers: { "idempotency-key": options.idempotencyKey } }),
      }),
    );
    if (!extractRunId(result)) {
      throw new ControlApiIndeterminateError("rollback_plan", "The saved rollback Plan could not be confirmed.");
    }
    return result;
  } catch (failure) {
    throwIfReadRetired(options);
    // A rollback 409 can report that saving the Plan timed out. If its body
    // is unreadable, leave the outcome open for the app's read-only recovery.
    if (responseStatus === 409 && failure instanceof ControlApiError &&
      (failure.code === "request_timeout" ||
        (failure.status === 409 && failure.code === undefined && failure.isHttpStatusFallback))) {
      throw new ControlApiIndeterminateError("rollback_plan", "The saved rollback Plan could not be confirmed.", failure);
    }
    throw clientRejectionOnDeadline(responseStatus, failure) ?? failure;
  }
}

export async function getRunGroup(id: string): Promise<RunGroupWithRuns> {
  return await controlFetch<RunGroupWithRuns>(
    `${BASE}/run-groups/${encodeURIComponent(id)}`,
  );
}

// --- Connections -----------------------------------------------------------

function normalizedWorkspaceId(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function listConnections(
  workspaceId?: string,
): Promise<readonly ProviderConnection[]> {
  return await listConnectionsWithSignal(workspaceId);
}

export async function listConnectionsWithSignal(
  workspaceId?: string,
  signal?: AbortSignal,
  options: Pick<RequestOpts, "cache" | "isCurrent"> = {},
): Promise<readonly ProviderConnection[]> {
  return await readConnectionsForOwnership(workspaceId, { signal, ...options }, await appOwnershipAvailable(signal));
}

async function readConnectionsForOwnership(
  workspaceId: string | undefined,
  scope: Pick<RequestOpts, "signal" | "cache" | "isCurrent" | "reuseRecentSharedAuthProbe">,
  accountOwned: boolean,
): Promise<readonly ProviderConnection[]> {
  if (accountOwned) {
    try {
      return await fetchAllPages<ProviderConnection>(
        `${BASE}/connections`,
        (body) => (body.connections as readonly ProviderConnection[]) ?? [],
        scope,
      );
    } catch (error) {
      if (!isMissingControlRoute(error)) throw error;
    }
  }
  throwIfReadRetired(scope);
  const normalized = await legacyWorkspaceFor404(workspaceId, scope);
  if (!normalized) return [];
  return await fetchAllPages<ProviderConnection>(
    `${BASE}/connections${query({ workspaceId: normalized })}`,
    (body) => (body.connections as readonly ProviderConnection[]) ?? [],
    { signal: scope.signal, cache: scope.cache, isCurrent: scope.isCurrent },
  );
}

export async function listProviderConnections(
  workspaceId?: string,
  options: Pick<RequestOpts, "cache" | "isCurrent" | "reuseRecentSharedAuthProbe" | "signal"> = {},
): Promise<readonly ProviderConnection[]> {
  if (!options.isCurrent) return await listProviderConnectionsWithSignal(workspaceId, options.signal, options);
  return await withControlDeadline("Connection list", options, (scope) =>
    listProviderConnectionsWithSignal(workspaceId, scope.signal, { ...options, ...scope }));
}

export async function listProviderConnectionsWithSignal(
  workspaceId?: string,
  signal?: AbortSignal,
  options: Pick<RequestOpts, "cache" | "isCurrent" | "reuseRecentSharedAuthProbe"> = {},
): Promise<readonly ProviderConnection[]> {
  const scope = { signal, ...options };
  // A caller-owned preflight must be able to retire its entire read and
  // retry even if a shared account capability request is still pending.
  const accountOwned = options.isCurrent
    ? (await listAccessibleAppsPage(undefined, signal, "", options)) !== undefined
    : await appOwnershipAvailable(signal);
  throwIfReadRetired(scope);
  if (accountOwned) return await readConnectionsForOwnership(workspaceId, scope, true);
  const normalized = await legacyWorkspaceFor404(workspaceId, scope);
  if (!normalized) return [];
  return await listLegacyProviderConnectionsWithSignal(normalized, signal, {
    cache: options.cache, isCurrent: options.isCurrent,
  });
}

/** Only for a legacy OAuth start that explicitly returned this client context. */
export async function listLegacyProviderConnectionsWithSignal(
  workspaceId: string,
  signal?: AbortSignal,
  options: Pick<RequestOpts, "cache" | "isCurrent"> = {},
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  const body = await controlFetch<{
    providerConnections?: readonly ProviderConnection[];
  }>(`${BASE}/provider-connections${query({ workspaceId: normalized })}`, {
    signal, ...options,
  });
  return body.providerConnections ?? [];
}

export async function listReleaseOwnedProviderConnectionsWithSignal(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId ?? "");
  if (!normalized) return [];
  const body = await controlFetch<{
    providerConnections?: readonly ProviderConnection[];
  }>(
    `${BASE}/provider-connections${query({
      workspaceId: normalized,
      projection: "release-owned",
    })}`,
    { signal },
  );
  return body.providerConnections ?? [];
}

/**
 * Registers a Workspace-owned provider-credential ProviderConnection. `values` are
 * write-only credential material (e.g. `{ CLOUDFLARE_API_TOKEN }`) and must be
 * cleared from caller memory immediately after this resolves; the returned
 * {@link ProviderConnection} projection carries no secret values. The backend forces
 * `scope: "workspace"`, so this creates only a Workspace-owned ProviderConnection.
 */
export async function createConnection(input: {
  readonly workspaceId?: string;
  readonly provider: string;
  readonly credentialRecipe: {
    readonly id: string;
    readonly authMode: string;
    readonly secretPartition: string;
  };
  readonly kind?: string;
  readonly displayName?: string;
  readonly scopeHints?: ConnectionScopeHints;
  readonly values: Readonly<Record<string, string>>;
}): Promise<ProviderConnection> {
  const personal = await appOwnershipAvailable();
  const legacyId = personal ? undefined : await legacyWorkspaceFor404(input.workspaceId);
  if (!personal && !legacyId) throw new ControlApiError(404, "feature_unavailable", "Personal connections are not available on this server.");
  const body = await controlFetch<{ connection: ProviderConnection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        ...(legacyId ? { workspaceId: legacyId } : {}),
        provider: input.provider,
        credentialRecipe: input.credentialRecipe,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
        values: input.values,
      },
    },
  );
  return body.connection;
}

export async function createSourceHttpsTokenConnection(input: {
  readonly workspaceId?: string;
  readonly displayName?: string;
  readonly repoUrl?: string;
  readonly username?: string;
  readonly token: string;
}): Promise<ProviderConnection> {
  const providerSettings: Readonly<Record<string, ContractJsonValue>> = {
    ...(input.repoUrl ? { repositoryUrl: input.repoUrl } : {}),
    ...(input.username ? { username: input.username } : {}),
  };
  const scopeHints: ConnectionScopeHints =
    Object.keys(providerSettings).length > 0 ? { providerSettings } : {};
  const personal = await appOwnershipAvailable();
  const legacyId = personal ? undefined : await legacyWorkspaceFor404(input.workspaceId);
  if (!personal && !legacyId) throw new ControlApiError(404, "feature_unavailable", "Personal connections are not available on this server.");
  const body = await controlFetch<{ connection: ProviderConnection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        ...(legacyId ? { workspaceId: legacyId } : {}),
        provider: "source_git_https_token",
        kind: "source_git_https_token",
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(Object.keys(scopeHints).length > 0 ? { scopeHints } : {}),
        values: { GIT_HTTPS_TOKEN: input.token },
      },
    },
  );
  return body.connection;
}

/**
 * Re-verifies a Workspace-owned ProviderConnection's stored credential
 * (`POST /api/v1/connections/:id/test`). Returns the backend's verification
 * projection (status etc.); secret values never round-trip.
 */
export async function testConnection(connectionId: string): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/test`,
    { method: "POST" },
  );
}

/**
 * Revokes the selected ProviderConnection once. An unknown outcome requires
 * a list read, never another POST. Only a 204 acknowledges the removal.
 */
export async function revokeConnection(connectionId: string, scope: ControlReadScope): Promise<"acknowledged" | "unconfirmed"> {
  let dispatched = false;
  let responseStatus: number | undefined;
  try {
    await withControlDeadline("Connection removal", scope, (requestScope) => controlFetch<void>(
      `${BASE}/connections/${encodeURIComponent(connectionId)}/revoke`,
      {
        ...requestScope,
        method: "POST",
        beforeDispatch: () => { dispatched = true; },
        onResponseStatus: (status) => { responseStatus = status; },
      },
    ));
  } catch (failure) {
    throwIfReadRetired(scope);
    const rejection = clientRejectionOnDeadline(responseStatus, failure);
    if (rejection && responseStatus !== 408) throw rejection;
    if (!dispatched || (responseStatus !== 408 && !isMutationOutcomeUnknown(failure))) throw failure;
  }
  throwIfReadRetired(scope);
  return responseStatus === 204 ? "acknowledged" : "unconfirmed";
}

export interface ConnectionOAuthStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
  /** Client-only context of the legacy start route, when used. */
  readonly legacyWorkspaceId?: string;
}

/**
 * Begins an OPTIONAL provider-owned credential OAuth helper flow. Resolves with the
 * provider authorize URL the browser is sent to; the backend callback then
 * mints the ProviderConnection and redirects back to `/connections`. When the operator
 * has NOT wired the upstream OAuth client, the backend answers 501 — callers
 * detect this via {@link isOAuthUnavailable} and fall back to the guided-token
 * deep-link path (so no dead OAuth button is ever shown).
 */
export async function startConnectionOAuth(input: {
  readonly helperId: string;
  readonly workspaceId?: string;
  readonly displayName?: string;
  readonly scopeHints?: ConnectionScopeHints;
}): Promise<ConnectionOAuthStart> {
  const personal = await appOwnershipAvailable();
  const legacyId = personal ? undefined : await legacyWorkspaceFor404(input.workspaceId);
  if (!personal && !legacyId) throw new ControlApiError(404, "feature_unavailable", "Personal connections are not available on this server.");
  const start = async (workspaceId?: string): Promise<ConnectionOAuthStart> => {
    const started = await controlFetch<ConnectionOAuthStart>(`${BASE}/connections/oauth/${encodeURIComponent(input.helperId)}/start`, {
      method: "POST", body: {
        ...(workspaceId ? { workspaceId } : {}),
        ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
    });
    return { ...started, ...(workspaceId ? { legacyWorkspaceId: workspaceId } : {}) };
  };
  try {
    return await start(legacyId);
  } catch (error) {
    if (!personal || !isMissingControlRoute(error)) throw error;
    const fallbackId = await legacyWorkspaceFor404(input.workspaceId);
    if (fallbackId) return await start(fallbackId);
    throw new ControlApiError(404, "feature_unavailable", "Provider authorization is unavailable on this server.");
  }
}

/** True when a control error means the OAuth helper is not configured (501). */
export function isOAuthUnavailable(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 501 || error.code === "feature_unavailable")
  );
}

// --- Credential Recipes ----------------------------------------------------

export async function listCredentialRecipes(): Promise<
  readonly CredentialRecipe[]
> {
  return (await connectionSetupCatalog()).recipes;
}

export interface ConnectionOAuthSetup {
  readonly id: string;
  readonly providerSource: string;
  readonly credentialRecipe: { readonly id: string; readonly authMode: string };
  readonly setupFields?: readonly { readonly key: string; readonly envName: string }[];
}

export async function connectionSetupCatalog(): Promise<{
  readonly recipes: readonly CredentialRecipe[];
  readonly oauthHelpers: readonly ConnectionOAuthSetup[];
}> {
  const body = await controlFetch<{
    recipes?: readonly CredentialRecipe[];
    oauthHelpers?: readonly ConnectionOAuthSetup[];
  }>(`${BASE}/credential-recipes`);
  return { recipes: body.recipes ?? [], oauthHelpers: body.oauthHelpers ?? [] };
}

// ===========================================================================
// Helpers shared by the control views
// ===========================================================================

/** A best-effort run id extractor for the opaque plan/sync run envelopes. */
export function extractRunId(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const obj = envelope as Record<string, unknown>;
  // Current public response: { run: { id } }. Older/internal wrappers stay here
  // for operator-only seams and tests; a bare { id } is accepted too.
  for (const wrap of ["planRun", "applyRun", "planPreview", "run"] as const) {
    const nested = obj[wrap];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  return typeof obj.id === "string" ? obj.id : undefined;
}

async function legacyWorkspaceFor404(
  workspaceId?: string,
  scope: Pick<RequestOpts, "signal" | "isCurrent"> = {},
): Promise<string | undefined> {
  const explicit = normalizedWorkspaceId(workspaceId ?? "");
  if (explicit) return explicit;
  try {
    return (await listWorkspaces({}, scope)).find((workspace) => !workspace.archivedAt)?.id;
  } catch (error) {
    if (isMissingControlRoute(error)) return undefined;
    throw error;
  }
}

export function isMissingControlRoute(error: unknown): boolean {
  if (!(error instanceof ControlApiError) || error.status !== 404) return false;
  if (error.code === "route_not_found" || error.code === "fixture_route_not_found") return true;
  if (error.code === "not_found" && isRecord(error.body) && error.body.error === "not_found") return true;
  // Generic not_found is also used for business/resource lookup failures.
  // Compatibility requires an explicit machine-readable route marker.
  return error.code === "not_found" && isRecord(error.details) &&
    error.details.reason === "route_not_found";
}

// TASK-0118 additive app ownership client. Compatibility is selected only by
// an absent route (404), never an authorization or service failure.
export type AppRole = "owner" | "member";
export interface AccessibleApp {
  readonly capsuleId: string;
  readonly name: string;
  readonly displayName?: string | Readonly<Record<string, string>>;
  readonly iconUrl?: string;
  readonly role: AppRole;
  readonly ownerDisplayName: string;
  /** Whether the app has persisted deployment state; absent on older servers. */
  readonly applied?: boolean;
  readonly state: CapsuleAppView["state"] | "update_available";
  readonly primaryAction: CapsuleAppView["primaryAction"];
  /** Authorized launcher metadata, absent only on older servers. */
  readonly screens?: CapsuleAppView["screens"];
  readonly incomplete?: CapsuleAppView["incomplete"];
}
let accessibleAppsCache: Promise<readonly AccessibleApp[] | undefined> | undefined;
let appOwnershipCache: Promise<boolean> | undefined;
const ACCESSIBLE_APPS_CACHE_MS = 10_000;
let appsDataExpiresAt = 0;
const appsPageCache = new Map<string, Promise<{ nextCursor?: string } & Record<string, unknown>>>();

function expireAccessibleAppsData(): void {
  if (appsDataExpiresAt === 0 || Date.now() < appsDataExpiresAt) return;
  accessibleAppsCache = undefined;
  appsPageCache.clear();
  appsDataExpiresAt = 0;
}

function normalizeAppsRouteError(path: string, error: unknown): unknown {
  // The old first-page dispatcher has no resource id and predates route_not_found.
  const appUrl = new URL(path, "https://dashboard.invalid");
  if (appUrl.pathname === `${BASE}/apps` && !appUrl.searchParams.has("cursor") &&
    error instanceof ControlApiError && error.status === 404 &&
    error.code === "not_found" && error.details === undefined && isRecord(error.body) && isRecord(error.body.error)) {
    return new ControlApiError(404, "route_not_found", error.message, error.body, error.isHttpStatusFallback);
  }
  return error;
}

/** Validate fields consumed by Home, allowing old role-only summary records. */
function isHomeAppSummary(value: unknown): boolean {
  if (!isRecord(value) || typeof value.capsuleId !== "string" || !value.capsuleId ||
    (value.role !== "owner" && value.role !== "member")) return false;
  for (const field of ["name", "state", "ownerDisplayName", "iconUrl"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.applied !== undefined && typeof value.applied !== "boolean") return false;
  if (value.displayName !== undefined && typeof value.displayName !== "string" &&
    (!isRecord(value.displayName) || !Object.values(value.displayName).every((label) => typeof label === "string"))) return false;
  if (value.incomplete !== undefined && (!Array.isArray(value.incomplete) ||
    !value.incomplete.every((part) => typeof part === "string"))) return false;
  return value.screens === undefined || (Array.isArray(value.screens) && value.screens.every((screen) =>
    isRecord(screen) && typeof screen.url === "string" && typeof screen.interfaceId === "string" &&
    (screen.title === undefined || typeof screen.title === "string") &&
    (screen.category === undefined || typeof screen.category === "string") &&
    (screen.clients === undefined || (isRecord(screen.clients) &&
      (screen.clients.preferred === "web" || screen.clients.preferred === "native") &&
      (screen.clients.ios === undefined || isRecord(screen.clients.ios)) &&
      (screen.clients.android === undefined || isRecord(screen.clients.android)))) &&
    (screen.icon === undefined || (isRecord(screen.icon) &&
      (screen.icon.kind === "image" ? typeof screen.icon.url === "string" :
        screen.icon.kind === "glyph" && typeof screen.icon.glyph === "string")))));
}

function readCachedAppsPage(path: string): Promise<{ nextCursor?: string } & Record<string, unknown>> {
  expireAccessibleAppsData();
  const cached = appsPageCache.get(path);
  if (cached) return cached;
  // Bound the shared transport, so every waiter sees the same result and an
  // expired request is evicted. Each view still cancels only its own wait.
  const request = withControlDeadline("Apps read", {}, (scope) =>
    controlFetch<{ nextCursor?: string } & Record<string, unknown>>(path, { ...scope, reuseRecentSharedAuthProbe: true }),
  ).then((body) => {
    if (appsPageCache.get(path) === request) appsDataExpiresAt = Date.now() + ACCESSIBLE_APPS_CACHE_MS;
    return body;
  }).catch((error: unknown) => {
    error = normalizeAppsRouteError(path, error);
    if (!isMissingControlRoute(error) && appsPageCache.get(path) === request) appsPageCache.delete(path);
    if (isMissingControlRoute(error) && appsPageCache.get(path) === request) appsDataExpiresAt = Date.now() + ACCESSIBLE_APPS_CACHE_MS;
    throw error;
  });
  appsPageCache.set(path, request);
  return request;
}

/** Reset after signing out, changing accounts, or changing app access. */
export function resetAppOwnershipCache(): void {
  accessibleAppsCache = undefined;
  appOwnershipCache = undefined;
  appsDataExpiresAt = 0;
  appsPageCache.clear();
  legacyInstallWorkspace = undefined;
}

/** Read one page of account summaries. Only a missing first-page route means legacy. */
export async function listAccessibleAppsPage(
  cursor?: string,
  signal?: AbortSignal,
  q = "",
  owner: Pick<RequestOpts, "cache" | "isCurrent"> = {},
): Promise<{
  readonly apps: readonly AccessibleApp[];
  readonly nextCursor?: string;
  /** Absent on legacy servers that ignore q. */
  readonly appliedQuery?: string;
} | undefined> {
  throwIfAborted(signal);
  const search = q.trim().toLowerCase();
  const path = `${BASE}/apps${query({ cursor, q: search || undefined })}`;
  let body;
  try {
    // Keep typed searches and scoped reads out of the account-wide cache.
    body = search || owner.isCurrent
      ? await withControlDeadline("Apps read", { signal, ...owner }, (scope) =>
        controlFetch<{ nextCursor?: string } & Record<string, unknown>>(path, { ...scope, reuseRecentSharedAuthProbe: true }),
      )
      : await withAppReadSignal(readCachedAppsPage(path), signal);
  } catch (error) {
    throwIfReadRetired({ signal, ...owner });
    error = normalizeAppsRouteError(path, error);
    if (!isMissingControlRoute(error)) throw error;
    if (cursor === undefined) return undefined;
    throw new ControlApiError(502, "invalid_apps_response", "Apps pagination became unavailable.");
  }
  throwIfAborted(signal);
  throwIfReadRetired({ signal, ...owner });
  if (!isRecord(body) || !Array.isArray(body.apps) || !body.apps.every(isHomeAppSummary) ||
    (body.nextCursor !== undefined && (typeof body.nextCursor !== "string" || !body.nextCursor)) ||
    (body.appliedQuery !== undefined && body.appliedQuery !== search)) {
    if (!owner.isCurrent) appsPageCache.delete(path);
    throw new ControlApiError(502, "invalid_apps_response", "Apps returned an invalid response.");
  }
  return { apps: body.apps as readonly AccessibleApp[], nextCursor: body.nextCursor || undefined,
    ...(typeof body.appliedQuery === "string" ? { appliedQuery: body.appliedQuery } : {}) };
}

/** One account app read is shared by role, provider and OAuth consumers. */
export async function listAccessibleApps(signal?: AbortSignal): Promise<readonly AccessibleApp[] | undefined> {
  throwIfAborted(signal);
  expireAccessibleAppsData();
  if (!accessibleAppsCache) {
    const request = fetchAllPages<AccessibleApp>(`${BASE}/apps`, (body) => {
      if (!Array.isArray(body.apps)) {
        throw new ControlApiError(502, "invalid_apps_response", "Apps returned an invalid response.");
      }
      return body.apps as readonly AccessibleApp[];
    }, { readPage: async (path) => {
      try {
        return await readCachedAppsPage(path);
      } catch (error) {
        if (path !== `${BASE}/apps` && isMissingControlRoute(error)) {
          throw new ControlApiError(502, "invalid_apps_response", "Apps pagination became unavailable.");
        }
        throw error;
      }
    } }).catch((error: unknown) => {
      if (isMissingControlRoute(error)) return undefined;
      if (accessibleAppsCache === request) accessibleAppsCache = undefined;
      throw error;
    });
    accessibleAppsCache = request;
  }
  return await withAppReadSignal(accessibleAppsCache, signal);
}

async function withAppReadSignal<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await request;
  // A view leaving must not abort the shared account capability read.
  return await new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("Request was aborted.", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.then((apps) => { cleanup(); resolve(apps); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function appOwnershipAvailable(signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  if (!appOwnershipCache) {
    const request = listAccessibleAppsPage().then((page) => page !== undefined).catch((error: unknown) => {
      if (appOwnershipCache === request) appOwnershipCache = undefined;
      throw error;
    });
    appOwnershipCache = request;
  }
  return await withAppReadSignal(appOwnershipCache, signal);
}

let legacyInstallWorkspace: Promise<string> | undefined;

/** Only a legacy server may create the Workspace needed by its install route. */
export async function legacyInstallWorkspaceId(
  workspaceId?: string,
  scope: Pick<RequestOpts, "isCurrent"> = {},
): Promise<string | undefined> {
  throwIfReadRetired(scope);
  if (await appOwnershipAvailable()) return undefined;
  throwIfReadRetired(scope);
  const existing = await legacyWorkspaceFor404(workspaceId, scope);
  throwIfReadRetired(scope);
  if (existing) return existing;
  if (!legacyInstallWorkspace) {
    // The current page may begin the shared bootstrap. Its acknowledgement
    // remains available to other current callers after the page leaves.
    const request = createWorkspace({
      handle: `personal-${randomUuid().replaceAll("-", "").slice(0, 16)}`,
      type: "personal",
    }, { beforeDispatch: () => throwIfReadRetired(scope) }).then((workspace) => workspace.id).catch((error: unknown) => {
      if (legacyInstallWorkspace === request) legacyInstallWorkspace = undefined;
      throw error;
    });
    legacyInstallWorkspace = request;
  }
  const id = await legacyInstallWorkspace;
  throwIfReadRetired(scope);
  return id;
}
export interface AppMember {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly status: "active" | "invited";
}
export interface AppMembers {
  readonly owner: { readonly accountId: string; readonly displayName: string; readonly email?: string };
  readonly members: readonly AppMember[];
}
export async function getAppMembers(id: string): Promise<AppMembers | undefined> {
  try {
    return await controlFetch<AppMembers>(`${BASE}/capsules/${encodeURIComponent(id)}/members`);
  } catch (error) {
    if (isMissingControlRoute(error)) return undefined;
    throw error;
  }
}
export async function inviteAppMember(id: string, email: string, consent: "connections_and_code"): Promise<void> {
  await controlFetch(`${BASE}/capsules/${encodeURIComponent(id)}/members`, { method: "POST", body: { email, consent } });
  resetAppOwnershipCache();
}
export async function removeAppMember(id: string, accountId: string): Promise<void> {
  await controlFetch(`${BASE}/capsules/${encodeURIComponent(id)}/members/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  resetAppOwnershipCache();
}
export async function transferAppOwnership(id: string, toAccountId: string): Promise<{ readonly transferId: string; readonly state: "pending" }> {
  const transfer = await controlFetch<{ readonly transferId: string; readonly state: "pending" }>(`${BASE}/capsules/${encodeURIComponent(id)}/ownership-transfers`, { method: "POST", body: { toAccountId } });
  resetAppOwnershipCache();
  return transfer;
}
export async function acceptAppOwnershipTransfer(id: string): Promise<void> {
  await controlFetch(`${BASE}/ownership-transfers/${encodeURIComponent(id)}/accept`, { method: "POST" });
  resetAppOwnershipCache();
}
export async function cancelAppOwnershipTransfer(id: string): Promise<void> {
  await controlFetch(`${BASE}/ownership-transfers/${encodeURIComponent(id)}`, { method: "DELETE" });
  resetAppOwnershipCache();
}

export interface AppOwnershipTransfer {
  readonly transferId: string;
  readonly capsuleId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly state: "pending";
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

async function listOwnershipTransfers(
  path: string,
  options: Pick<RequestOpts, "signal" | "reuseRecentSharedAuthProbe">,
): Promise<readonly AppOwnershipTransfer[] | undefined> {
  try {
    return await fetchAllPages<AppOwnershipTransfer>(path, (body) => {
      if (!Array.isArray(body.ownershipTransfers)) {
        throw new ControlApiError(502, "invalid_ownership_transfers_response", "Ownership transfers returned an invalid response.");
      }
      return body.ownershipTransfers.filter((row): row is AppOwnershipTransfer => isRecord(row) && row.state === "pending" &&
        [row.transferId, row.capsuleId, row.fromAccountId, row.toAccountId].every((value) => typeof value === "string" && value.length > 0));
    }, options);
  } catch (error) {
    if (isMissingControlRoute(error)) return undefined;
    throw error;
  }
}

export async function listAppOwnershipTransfers(capsuleId: string, signal?: AbortSignal): Promise<readonly AppOwnershipTransfer[] | undefined> {
  return await listOwnershipTransfers(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/ownership-transfers?state=pending`, { signal });
}

export async function listIncomingOwnershipTransfers(signal?: AbortSignal): Promise<readonly AppOwnershipTransfer[] | undefined> {
  return await listOwnershipTransfers(`${BASE}/ownership-transfers?state=pending`, {
    signal, reuseRecentSharedAuthProbe: true,
  });
}

export async function listPersonalUsagePage(workspaceId?: string, options: { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal } = {}): Promise<UsageEventsPage> {
  // Kept as a positional compatibility argument for existing views only.
  void workspaceId;
  const body = await controlFetch<UsageEventsPage>(`${BASE}/usage${query({ cursor: options.cursor, limit: options.limit })}`, { signal: options.signal });
  return { usageEvents: body.usageEvents ?? [], ...(body.nextCursor ? { nextCursor: body.nextCursor } : {}) };
}

/** The app-authorized label projection never carries credential/owner metadata. */
export interface AppConnectionChoice {
  readonly id: string;
  readonly displayName?: string;
  readonly providerSource: string;
}
export async function getAppConnectionChoices(capsuleId: string): Promise<readonly AppConnectionChoice[] | undefined> {
  try {
    return await fetchAllPages<AppConnectionChoice>(`${BASE}/connections${query({ capsuleId, projection: "labels" })}`, (body) => {
      if (!isRecord(body) || Object.keys(body).some((key) => key !== "connections" && key !== "nextCursor") ||
        !Array.isArray(body.connections) || (body.nextCursor !== undefined && typeof body.nextCursor !== "string")) {
        throw new ControlApiError(502, "invalid_connection_labels_response", "Connection labels returned an invalid response.");
      }
      return body.connections.map((row: unknown) => {
        // Old servers may ignore projection=labels and return complete rows.
        // Reject that response rather than treating private metadata as labels.
        if (!isRecord(row) || Object.keys(row).some((key) => !["id", "provider", "displayName"].includes(key)) ||
          typeof row.id !== "string" || row.id.trim() === "" || typeof row.provider !== "string" || row.provider.trim() === "" ||
          (row.displayName !== undefined && typeof row.displayName !== "string")) {
          throw new ControlApiError(502, "invalid_connection_labels_response", "Connection labels returned an invalid response.");
        }
        return {
          id: row.id,
          providerSource: normalizeProviderSourceAddress(row.provider),
          ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
        };
      });
    });
  } catch (error) {
    if (isMissingControlRoute(error)) return undefined;
    throw error;
  }
}

export const getAppConnectionLabels = getAppConnectionChoices;
