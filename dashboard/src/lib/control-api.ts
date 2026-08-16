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

export { shapeKindForPortableType } from "takosumi-contract";
import type {
  ActivityEvent as ContractActivityEvent,
  BackupRecord as ContractBackupRecord,
  CredentialRecipe as ContractCredentialRecipe,
  Dependency as ContractDependency,
  InstallConfig as ContractInstallConfig,
  InstallConfigVariableDefault as ContractInstallConfigVariableDefault,
  Capsule as ContractCapsule,
  JsonValue as ContractJsonValue,
  ManagedPublicHostnameAllocation,
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
  SourceSnapshotFileResponse,
  StableSourceTagResolutionResponse,
  Workspace as ContractWorkspace,
  PublicWorkspaceListPage as ContractPublicWorkspaceListPage,
  UsageEvent as ContractUsageEvent,
  CapsuleCurrentResourceInventory as ContractCapsuleCurrentResourceInventory,
} from "takosumi-contract";

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

  /** True when a requested public app hostname is already reserved. */
  get isAppHostnameUnavailable(): boolean {
    return this.status === 409 && this.reason === "app_hostname_unavailable";
  }

  /** True when the owner has no remaining short managed-hostname slot. */
  get isManagedPublicHostnameSlotLimitReached(): boolean {
    return this.reason === "managed_public_hostname_slot_limit_reached";
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
  readonly operation:
    | "apply"
    | "capsule_create"
    | "source_create"
    | "source_patch";
  readonly isIndeterminate = true;
  readonly causeSummary?: ControlApiErrorSummary;

  constructor(
    operation: "apply" | "capsule_create" | "source_create" | "source_patch",
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

export async function controlFetch<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(opts.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body,
    credentials: "include",
    signal: opts.signal,
  });

  if (res.status === 401) {
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
  // 204 No Content (dependency delete) resolves to undefined.
  return data as T;
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
  opts: { readonly signal?: AbortSignal } = {},
): Promise<readonly T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path =
      cursor === undefined
        ? basePath
        : `${basePath}${sep}cursor=${encodeURIComponent(cursor)}`;
    const body = await controlFetch<
      { nextCursor?: string } & Record<string, unknown>
    >(path, { signal: opts.signal });
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

export interface PolicyConfig {
  readonly allowedProviders?: readonly string[];
  readonly allowedResourceTypes?: readonly string[];
  readonly destructiveChanges?: {
    readonly requireExplicitConfirmation: boolean;
  };
  readonly scopeBoundary?: ScopeBoundaryPolicy;
  readonly quota?: Readonly<Record<string, number>>;
}

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

export type CapsuleStatus =
  "pending" | "active" | "stale" | "error" | "disabled" | "destroyed";

export interface Capsule {
  readonly id: string;
  readonly workspaceId: string;
  /** Owning Project, when exposed by the public Capsule projection. */
  readonly projectId?: string;
  readonly name: string;
  readonly slug: string;
  readonly sourceId?: string;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
  readonly status: CapsuleStatus;
  /**
   * Read-time DERIVED freshness relative to producer Dependencies (spec §24).
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
  readonly managedPublicHostname?: ManagedPublicHostnameAllocation;
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

export type DependencyMode =
  "remote_state" | "variable_injection" | "published_output";

export type DependencyVisibility = "workspace" | "cross_workspace";

export interface DependencyOutputMapping {
  readonly from: string;
  readonly to: string;
  readonly required: boolean;
  readonly type?: string;
}

export interface Dependency {
  readonly id: string;
  readonly workspaceId: string;
  readonly producerCapsuleId: string;
  readonly consumerCapsuleId: string;
  readonly mode: DependencyMode;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
  readonly visibility: DependencyVisibility;
  readonly createdAt: string;
}

/** `GET /api/v1/workspaces/:id/graph` projection. */
export interface WorkspaceGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface DashboardOverview {
  readonly workspaces: readonly Workspace[];
  readonly workspace: Workspace | null;
  readonly capsules: readonly Capsule[];
  readonly currentStateVersions: readonly PublicStateVersion[];
  readonly activity: readonly ActivityEvent[];
  readonly installConfigs: readonly InstallConfig[];
  readonly nextCapsuleCursor?: string;
}

export interface GraphNode {
  readonly capsuleId: string;
  readonly name: string;
  readonly environment: string;
  readonly status: CapsuleStatus;
}

export interface GraphEdge {
  readonly id: string;
  readonly producerCapsuleId: string;
  readonly consumerCapsuleId: string;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
}

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
  | "restore";

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
  readonly workspaceId: string;
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

export interface OutputShareEntry {
  readonly name: string;
  readonly alias?: string;
  readonly sensitive: boolean;
}

export interface OutputShare {
  readonly id: string;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputs: readonly OutputShareEntry[];
  readonly status: "pending" | "active" | "revoked";
  readonly createdAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
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

export interface CapsuleCompatibilityProvider {
  readonly source: string;
  readonly localName?: string;
  readonly versionConstraint?: string;
  readonly aliases: readonly string[];
  readonly allowed: boolean;
  readonly credentialRequired?: boolean;
}

export interface CapsuleCompatibilityResource {
  readonly type: string;
  readonly count?: number;
  readonly allowed: boolean;
}

export type RepositoryInstallUxPreview =
  ContractRepositoryInstallUxCompatibilityResult;

export interface CapsuleCompatibilityResult {
  readonly reportId?: string;
  readonly sourceSnapshotId?: string;
  readonly level: CapsuleCompatibilityLevel;
  readonly summary: string;
  readonly diagnostics: readonly CapsuleCompatibilityDiagnostic[];
  readonly providers: readonly CapsuleCompatibilityProvider[];
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
  AssertAssignable<Dependency, ContractDependency>,
  AssertAssignable<Run, ContractRun>,
  AssertAssignable<RunLogs, ContractRunLogsResponse>,
  AssertAssignable<Source, ContractSource>,
  AssertAssignable<SourceSnapshot, ContractSourceSnapshot>,
  AssertAssignable<PublicStateVersion, ContractPublicStateVersion>,
  // Accounts normalizes the internal OutputShare contract into a canonical
  // Workspace/Capsule-only public view before the dashboard sees it.
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
  );
}

export async function listWorkspaces(
  options: {
    readonly selectedWorkspaceId?: string;
    readonly limit?: number;
  } = {},
): Promise<readonly Workspace[]> {
  return (
    await listWorkspacePage({
      limit: options.limit,
      order: "updated_desc",
      selectedWorkspaceId: options.selectedWorkspaceId,
    })
  ).workspaces;
}

export async function getDashboardOverview(
  workspaceId?: string,
  options: {
    readonly includeWorkspaces?: boolean;
    readonly capsuleLimit?: number;
  } = {},
): Promise<DashboardOverview> {
  return await controlFetch<DashboardOverview>(
    `${BASE}/dashboard/overview${query({
      workspaceId,
      includeWorkspaces: options.includeWorkspaces,
      capsuleLimit: options.capsuleLimit,
    })}`,
  );
}

export async function createWorkspace(input: {
  readonly handle: string;
  readonly displayName?: string;
  readonly type?: WorkspaceType;
}): Promise<Workspace> {
  const body = await controlFetch<WorkspaceEnvelope>(`${BASE}/workspaces`, {
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

export async function updateWorkspace(
  workspaceId: string,
  input: {
    readonly displayName?: string;
    readonly policy?: PolicyConfig;
    readonly archived?: boolean;
  },
): Promise<Workspace> {
  const body = await controlFetch<WorkspaceEnvelope>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: "PATCH", body: input },
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
 * value the session `/v1/account/session/me` returns for the signed-in caller —
 * so the view can match the caller against the roster to decide which mutation
 * controls to show. Carries no credential / email / PII beyond the handle.
 */
export interface PublicWorkspaceMember {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly roles: readonly ControlWorkspaceRole[];
  readonly status: ControlMembershipStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
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

/**
 * Adds (or re-activates) a member by verified account email or account subject
 * (`POST /api/v1/workspaces/:id/members`). This is not an outbound email
 * notification flow: the target must already have signed in once so the
 * account plane can resolve a verified email to a Takosumi subject.
 */
export async function inviteMember(
  workspaceId: string,
  input: {
    readonly email?: string;
    readonly accountId?: string;
    readonly role?: ControlWorkspaceRole;
  },
): Promise<PublicWorkspaceMember> {
  const body = await controlFetch<{ member: PublicWorkspaceMember }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members`,
    {
      method: "POST",
      body: {
        ...(input.email ? { email: input.email } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.role ? { role: input.role } : {}),
      },
    },
  );
  return body.member;
}

/**
 * Changes a member's role set (`PATCH /api/v1/workspaces/:id/members/:subject`).
 * Owner-only. The backend's last-owner guard rejects demoting the sole
 * remaining owner with 403, so a Workspace is never left unmanaged.
 */
export async function setMemberRole(
  workspaceId: string,
  subject: string,
  roles: ControlWorkspaceRole | readonly ControlWorkspaceRole[],
): Promise<PublicWorkspaceMember> {
  const body = await controlFetch<{ member: PublicWorkspaceMember }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(subject)}`,
    { method: "PATCH", body: { roles } },
  );
  return body.member;
}

/**
 * Removes a member (`DELETE /api/v1/workspaces/:id/members/:subject`).
 * Owner-only. The membership store has no hard delete, so the backend soft-
 * removes (sets `status: "suspended"`) and returns the updated projection. The
 * last-owner guard rejects removing the sole remaining owner with 403.
 */
export async function removeMember(
  workspaceId: string,
  subject: string,
): Promise<PublicWorkspaceMember> {
  const body = await controlFetch<{ member: PublicWorkspaceMember }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(subject)}`,
    { method: "DELETE" },
  );
  return body.member;
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

/**
 * Strict Capsule inventory used only around a create mutation. Unlike the
 * general dashboard list helper, this cannot turn a missing/malformed array
 * into `[]`: a complete before/after inventory is required for safe
 * acknowledgement recovery.
 */
async function listCapsulesForCreateRecovery(
  workspaceId: string,
): Promise<readonly Capsule[]> {
  return await fetchAllPages<Capsule>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/capsules?includeDestroyed=false`,
    (body) => {
      if (!Array.isArray(body.capsules)) {
        throw new ControlApiError(
          502,
          "invalid_capsule_list_response",
          "Capsule list returned an invalid response.",
        );
      }
      return body.capsules as readonly Capsule[];
    },
  );
}

/**
 * Complete, runtime-validated Capsule inventory used to bind a Source-global
 * revision mutation to the Workloads it affects. The ordinary list helper is
 * intentionally forgiving for presentation; this seam must fail closed when
 * the membership projection is incomplete or malformed.
 */
async function listCapsulesForSourceMembership(
  workspaceId: string,
): Promise<readonly Capsule[]> {
  return await fetchAllPages<Capsule>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/capsules?includeDestroyed=false`,
    (body) => {
      if (
        !Array.isArray(body.capsules) ||
        !body.capsules.every(isCapsuleResponse) ||
        (body.nextCursor !== undefined && typeof body.nextCursor !== "string")
      ) {
        throw new ControlApiError(
          502,
          "invalid_capsule_list_response",
          "Capsule membership returned an invalid response.",
        );
      }
      return body.capsules;
    },
  );
}

export async function listWorkspaceCurrentStateVersions(
  workspaceId: string,
  options: { readonly includeDestroyed?: boolean } = {},
): Promise<readonly PublicStateVersion[]> {
  const qs = query({
    ...(options.includeDestroyed === false
      ? { includeDestroyed: "false" }
      : {}),
  });
  return await fetchAllPages<PublicStateVersion>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/current-state-versions${qs}`,
    (body) => (body.stateVersions as readonly PublicStateVersion[]) ?? [],
  );
}

export async function getCapsule(id: string): Promise<Capsule> {
  const body = await controlFetch<{
    capsule: Capsule;
  }>(`${BASE}/capsules/${encodeURIComponent(id)}`);
  return body.capsule;
}

const CAPSULE_STATUSES: ReadonlySet<CapsuleStatus> = new Set([
  "pending",
  "active",
  "stale",
  "error",
  "disabled",
  "destroyed",
]);

function isCapsuleResponse(value: unknown): value is Capsule {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
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

function isActiveCapsuleIdentity(value: unknown): value is Capsule {
  return (
    isCapsuleResponse(value) &&
    value.status === "active" &&
    typeof value.name === "string" &&
    typeof value.environment === "string" &&
    typeof value.sourceId === "string"
  );
}

function capsuleMatchesCreateInput(
  capsule: Capsule,
  input: {
    readonly workspaceId: string;
    readonly projectId?: string;
    readonly name: string;
    readonly environment: string;
    readonly sourceId: string;
  },
): boolean {
  return (
    capsule.workspaceId === input.workspaceId &&
    capsule.name === input.name &&
    capsule.environment === input.environment &&
    capsule.sourceId === input.sourceId &&
    (input.projectId === undefined || capsule.projectId === input.projectId)
  );
}

function isMutationOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ControlApiIndeterminateError) return true;
  if (error instanceof ControlApiError) {
    return error.status === 0 || error.status >= 500;
  }
  // `fetch` rejects with a transport error when no HTTP response was
  // observed. A definite HTTP rejection is always represented by
  // ControlApiError and is handled above.
  return true;
}

function invalidCapsuleResponse(): ControlApiError {
  return new ControlApiError(
    502,
    "invalid_capsule_response",
    "Capsule create returned an invalid response.",
  );
}

function capsuleCreateIndeterminate(
  message: string,
  cause?: unknown,
): ControlApiIndeterminateError {
  return new ControlApiIndeterminateError("capsule_create", message, cause);
}

export async function createCapsule(input: {
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly installConfigId: string;
  readonly modulePath?: string;
  readonly sourceBuild?: SourceBuildConfig;
  readonly vars?: Readonly<Record<string, ContractJsonValue>>;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly autoUpdate?: boolean;
  readonly managedPublicHostname?: ManagedPublicHostnameAllocation;
}): Promise<Capsule> {
  // Read the active baseline before the one-shot create. If the response is
  // lost, this is the only readback that can prove whether the exact Capsule
  // appeared; proceeding without it would authorize an unrecoverable blind
  // create.
  let baseline: readonly Capsule[];
  try {
    baseline = await listCapsulesForCreateRecovery(input.workspaceId);
  } catch (error) {
    throw capsuleCreateIndeterminate(
      "Capsule create cannot start because the active Capsule baseline was unavailable.",
      error,
    );
  }
  // Inventory every non-destroyed status, not just active rows. A pre-existing
  // pending Capsule may become active while this request is in flight; treating
  // it as a newly-created candidate would make the lost-response proof false.
  if (!baseline.every(isCapsuleResponse)) {
    throw capsuleCreateIndeterminate(
      "Capsule create cannot start because the Capsule baseline was invalid.",
    );
  }
  const baselineIds = new Set(baseline.map((capsule) => capsule.id));

  try {
    const body = await controlFetch<unknown>(
      `${BASE}/workspaces/${encodeURIComponent(input.workspaceId)}/capsules`,
      {
        method: "POST",
        body: {
          name: input.name,
          environment: input.environment,
          ...(input.projectId !== undefined
            ? { projectId: input.projectId }
            : {}),
          sourceId: input.sourceId,
          installConfigId: input.installConfigId,
          ...(input.modulePath && input.modulePath !== "."
            ? { modulePath: input.modulePath }
            : {}),
          ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
          ...(input.vars && Object.keys(input.vars).length > 0
            ? { vars: input.vars }
            : {}),
          ...(input.outputAllowlist && Object.keys(input.outputAllowlist).length > 0
            ? { outputAllowlist: input.outputAllowlist }
            : {}),
          ...(input.autoUpdate === true ? { autoUpdate: true } : {}),
          ...(input.managedPublicHostname
            ? { managedPublicHostname: input.managedPublicHostname }
            : {}),
        },
      },
    );
    if (
      !isRecord(body) ||
      !isCapsuleResponse(body.capsule) ||
      !capsuleMatchesCreateInput(body.capsule, input)
    ) {
      throw invalidCapsuleResponse();
    }
    return body.capsule;
  } catch (error) {
    // A definite HTTP rejection is authoritative: do not issue another POST
    // or turn a user-visible validation/duplicate error into readback noise.
    if (!isMutationOutcomeUnknown(error)) throw error;

    let after: readonly Capsule[];
    try {
      after = await listCapsulesForCreateRecovery(input.workspaceId);
    } catch (readbackError) {
      throw capsuleCreateIndeterminate(
        "Capsule create outcome is indeterminate because the active Capsule readback was unavailable.",
        readbackError,
      );
    }

    if (!after.every(isCapsuleResponse)) {
      throw capsuleCreateIndeterminate(
        "Capsule create outcome is indeterminate: the active Capsule readback was invalid.",
        error,
      );
    }
    const newlyAppearedActive = after.filter(
      (capsule) =>
        isActiveCapsuleIdentity(capsule) && !baselineIds.has(capsule.id),
    );
    if (newlyAppearedActive.length !== 1) {
      throw capsuleCreateIndeterminate(
        `Capsule create outcome is indeterminate: expected exactly one newly appeared active Capsule, observed ${newlyAppearedActive.length}.`,
        error,
      );
    }
    const [candidate] = newlyAppearedActive;
    if (!candidate || !capsuleMatchesCreateInput(candidate, input)) {
      throw capsuleCreateIndeterminate(
        "Capsule create outcome is indeterminate: the newly appeared active Capsule did not match the exact request identity.",
        error,
      );
    }
    return candidate;
  }
}

/** Toggles the Capsule's auto-update opt-in (PATCH /capsules/:id). */
export async function setCapsuleAutoUpdate(
  capsuleId: string,
  enabled: boolean,
): Promise<Capsule> {
  const body = await controlFetch<{ capsule: Capsule }>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "PATCH", body: { autoUpdate: enabled } },
  );
  return body.capsule;
}

export interface DeleteCapsuleResult {
  readonly capsule: Capsule;
  readonly abandoned?: boolean;
  readonly alreadyDeleted?: boolean;
  readonly projectionStatus?: string;
}

/**
 * Deletes an Capsule from the dashboard flow.
 *
 * Applied Capsules still return a destroy-plan Run envelope; unapplied failed
 * Capsules may be abandoned immediately by the backend so broken first installs
 * do not get stuck behind provider/state prerequisites.
 */
export async function deleteCapsule(
  capsuleId: string,
): Promise<DeleteCapsuleResult | unknown> {
  return await controlFetch<DeleteCapsuleResult | unknown>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}`,
    { method: "DELETE" },
  );
}

export async function getCapsuleProviderBindingSet(
  capsuleId: string,
): Promise<ProviderBindingSet | null> {
  const body = await controlFetch<{
    providerBindingSet: ProviderBindingSet | null;
  }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/provider-bindings`);
  return body.providerBindingSet;
}

export async function putCapsuleProviderBindingSet(
  capsuleId: string,
  bindings: ProviderBindings,
): Promise<ProviderBindingSet> {
  const body = await controlFetch<{
    providerBindingSet: ProviderBindingSet;
  }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/provider-bindings`, {
    method: "PUT",
    body: { bindings },
  });
  return body.providerBindingSet;
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
  const body = await controlFetch<{ installConfig: InstallConfig }>(
    `${BASE}/capsule-configs/${encodeURIComponent(id)}`,
    { signal },
  );
  return body.installConfig;
}

export async function patchInstallConfig(
  id: string,
  input: {
    readonly variableMapping?: Readonly<Record<string, ContractJsonValue>>;
    readonly removeVariables?: readonly string[];
    readonly variablePresentationDefaults?: Readonly<
      Record<string, ContractInstallConfigVariableDefault>
    >;
    readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
    readonly interfaceBlueprints?: ContractInstallConfig["interfaceBlueprints"];
    readonly lifecycleActions?: ContractInstallConfig["lifecycleActions"];
    readonly lifecycleActionPolicy?: NonNullable<
      ContractInstallConfig["policy"]["lifecycleActions"]
    > | null;
  },
): Promise<InstallConfig> {
  const body = await controlFetch<{ installConfig: InstallConfig }>(
    `${BASE}/capsule-configs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: {
        ...(input.variableMapping
          ? { variableMapping: input.variableMapping }
          : {}),
        ...(input.removeVariables && input.removeVariables.length > 0
          ? { removeVariables: input.removeVariables }
          : {}),
        ...(input.variablePresentationDefaults
          ? { variablePresentationDefaults: input.variablePresentationDefaults }
          : {}),
        ...(input.outputAllowlist &&
        Object.keys(input.outputAllowlist).length > 0
          ? { outputAllowlist: input.outputAllowlist }
          : {}),
        ...(input.interfaceBlueprints !== undefined
          ? { interfaceBlueprints: input.interfaceBlueprints }
          : {}),
        ...(input.lifecycleActions !== undefined
          ? { lifecycleActions: input.lifecycleActions }
          : {}),
        ...(input.lifecycleActionPolicy !== undefined
          ? { lifecycleActionPolicy: input.lifecycleActionPolicy }
          : {}),
      },
    },
  );
  return body.installConfig;
}

// --- OpenTofu Capsule compatibility ---------------------------------------

export interface CheckCapsuleCompatibilityInput {
  readonly workspaceId: string;
  readonly sourceId?: string;
  readonly gitUrl: string;
  readonly ref: string;
  readonly path: string;
  readonly name: string;
  readonly authConnectionId?: string;
  readonly installConfigId?: string;
  /**
   * Compile the exact SourceSnapshot's optional repository-owned install
   * declaration into a DB-owned InstallConfig before the dashboard renders it.
   * The repository document itself is never returned to this client.
   */
  readonly compileInstallUx?: boolean;
  /** Opaque DB-owned profile choice; meaningful only with compileInstallUx. */
  readonly deploymentProfileKey?: string;
  readonly signal?: AbortSignal;
  /**
   * Bounds the complete Source sync and compatibility response. The final
   * compatibility POST is included; a server-side Run completing must never
   * leave the dashboard waiting forever for a lost HTTP response.
   */
  readonly timeoutMs?: number;
  /** Absolute outer preparation deadline shared with Source create/readback. */
  readonly deadlineAt?: number;
  /** Continue a previously ambiguous Source create without issuing another POST. */
  readonly sourceCreateReconciliationToken?: SourceCreateReconciliationToken;
  readonly onSourceCreated?: (sourceId: string) => void;
  readonly onSourceSyncProgress?: (
    progress: SourceSnapshotWaitProgress,
  ) => void;
  readonly onSourceSnapshot?: (snapshot: SourceSnapshot) => void;
}

export async function checkCapsuleCompatibility(
  input: CheckCapsuleCompatibilityInput,
): Promise<CapsuleCompatibilityResult> {
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw new TypeError("compatibility timeoutMs must be a positive integer");
  }
  const deadlineAt =
    input.deadlineAt ??
    (input.timeoutMs === undefined
      ? undefined
      : Date.now() + input.timeoutMs);
  if (deadlineAt === undefined) {
    return await checkCapsuleCompatibilityRequest(input, input.signal);
  }
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
    throw new TypeError("compatibility deadlineAt must be a positive integer");
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new ControlApiError(
      0,
      "request_timeout",
      "compatibility preparation deadline has expired",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remainingMs);
  try {
    return await checkCapsuleCompatibilityRequest(
      input,
      controller.signal,
      deadlineAt,
    );
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new ControlApiError(
        0,
        "request_timeout",
        "compatibility preparation deadline expired",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function checkCapsuleCompatibilityRequest(
  input: CheckCapsuleCompatibilityInput,
  signal: AbortSignal | undefined,
  deadlineAt?: number,
): Promise<CapsuleCompatibilityResult> {
  if (
    input.deploymentProfileKey !== undefined &&
    input.compileInstallUx !== true
  ) {
    throw new TypeError(
      "deploymentProfileKey requires repository install UX compilation",
    );
  }
  const sourceId =
    input.sourceId ??
    (
      await createSource({
        workspaceId: input.workspaceId,
        name: input.name,
        url: input.gitUrl,
        defaultRef: input.ref,
        defaultPath: ".",
        autoSync: true,
        signal,
        ...(input.sourceCreateReconciliationToken
          ? { reconciliationToken: input.sourceCreateReconciliationToken }
          : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(input.authConnectionId
          ? { authConnectionId: input.authConnectionId }
          : {}),
      })
    ).source.id;
  input.onSourceCreated?.(sourceId);
  const syncEnvelope = await syncSource(sourceId, { signal });
  const sourceSyncRunId = extractRunId(syncEnvelope);
  if (!sourceSyncRunId) {
    throw new ControlApiError(
      500,
      "invalid_source_sync_response",
      "Source sync did not return a Run id.",
      syncEnvelope,
    );
  }
  const snapshot = await waitForLatestSourceSnapshot(sourceId, {
    runId: sourceSyncRunId,
    signal,
    onProgress: input.onSourceSyncProgress,
  });
  input.onSourceSnapshot?.(snapshot);
  const body = await controlFetch<{
    report: {
      readonly id: string;
      readonly level: CapsuleCompatibilityLevel;
      readonly findings?: readonly {
        readonly severity?: "info" | "warning" | "error";
        readonly compatibilityImpact?: "none" | "needs_patch" | "unsupported";
        readonly code?: string;
        readonly message?: string;
        readonly path?: string;
        readonly suggestion?: string;
        readonly context?: Readonly<Record<string, string>>;
      }[];
      readonly providers?: readonly {
        readonly source?: string;
        readonly localName?: string;
        readonly versionConstraint?: string;
        readonly aliases?: readonly string[];
        readonly allowed?: boolean;
        readonly credentialRequired?: boolean;
      }[];
      readonly resources?: readonly {
        readonly type?: string;
        readonly count?: number;
        readonly allowed?: boolean;
      }[];
      readonly rootModuleVariables?: readonly string[];
    };
    readonly repositoryInstallUx?: RepositoryInstallUxPreview;
  }>(`${BASE}/sources/${encodeURIComponent(sourceId)}/compatibility-check`, {
    method: "POST",
    signal,
    body: {
      sourceSnapshotId: snapshot.id,
      // Gate the pre-install check against the selected InstallConfig's policy
      // when one is supplied (the install view passes the Workspace's resolved
      // profile), otherwise fall back to the instance-wide default policy.
      ...(input.compileInstallUx
        ? {
            compileInstallUx: true,
            capsuleName: input.name,
            ...(input.deploymentProfileKey !== undefined
              ? { deploymentProfileKey: input.deploymentProfileKey }
              : {}),
          }
        : {
            ...(input.installConfigId
              ? { installConfigId: input.installConfigId }
              : {}),
            ...(input.path && input.path !== "."
              ? { modulePath: input.path }
              : {}),
          }),
    },
  });
  const diagnostics: CapsuleCompatibilityDiagnostic[] = (
    body.report.findings ?? []
  ).map((finding) => ({
    severity: finding.severity ?? "info",
    ...(finding.compatibilityImpact
      ? { compatibilityImpact: finding.compatibilityImpact }
      : {}),
    ...(finding.code ? { code: finding.code } : {}),
    message: finding.message ?? finding.code ?? "Compatibility finding",
    ...(finding.suggestion ? { detail: finding.suggestion } : {}),
    ...(finding.path ? { path: finding.path } : {}),
    ...(finding.context ? { context: finding.context } : {}),
  }));
  if (
    body.repositoryInstallUx?.status === "invalid" &&
    !diagnostics.some(
      (diagnostic) => diagnostic.code === "repository_install_ux_invalid",
    )
  ) {
    diagnostics.push({
      code: "repository_install_ux_invalid",
      severity: "error",
      compatibilityImpact: "unsupported",
      // The install view maps this typed code to fixed localized copy and never
      // renders the repository/compiler message.
      message: "The repository install setup declaration is invalid.",
    });
  }
  const providers = (body.report.providers ?? [])
    .filter((provider) => provider.source !== undefined)
    .map((provider) => ({
      source: provider.source!,
      ...(provider.localName ? { localName: provider.localName } : {}),
      ...(provider.versionConstraint
        ? { versionConstraint: provider.versionConstraint }
        : {}),
      aliases: provider.aliases ?? [],
      allowed: provider.allowed ?? true,
      ...(provider.credentialRequired === true
        ? { credentialRequired: true }
        : {}),
    }));
  const resources = (body.report.resources ?? [])
    .filter((resource) => resource.type !== undefined)
    .map((resource) => ({
      type: resource.type!,
      ...(typeof resource.count === "number" ? { count: resource.count } : {}),
      allowed: resource.allowed ?? true,
    }));
  return {
    reportId: body.report.id,
    sourceSnapshotId: snapshot.id,
    level:
      body.repositoryInstallUx?.status === "invalid"
        ? "unsupported"
        : body.report.level,
    summary:
      diagnostics[0]?.message ??
      "Compatibility check completed for the synced SourceSnapshot.",
    diagnostics,
    providers,
    resources,
    rootModuleVariables: body.report.rootModuleVariables ?? [],
    ...(body.repositoryInstallUx?.status === "accepted"
      ? { installConfigId: body.repositoryInstallUx.installConfigId }
      : input.installConfigId
        ? { installConfigId: input.installConfigId }
        : {}),
    ...(body.repositoryInstallUx
      ? { repositoryInstallUx: body.repositoryInstallUx }
      : {}),
    sourceId,
    source: "api",
  };
}

// --- Graph -----------------------------------------------------------------

export async function getWorkspaceGraph(
  workspaceId: string,
): Promise<WorkspaceGraph> {
  return await controlFetch<WorkspaceGraph>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/graph`,
  );
}

// --- Backups ---------------------------------------------------------------

export async function createWorkspaceBackup(
  workspaceId: string,
): Promise<BackupRecord> {
  const body = await controlFetch<{ backup: BackupRecord }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/backups`,
    { method: "POST" },
  );
  return body.backup;
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

export async function listWorkspaceBackups(
  workspaceId: string,
): Promise<readonly BackupRecord[]> {
  return await fetchAllPages<BackupRecord>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/backups`,
    (body) => (body.backups as readonly BackupRecord[]) ?? [],
  );
}

// --- Dependencies ----------------------------------------------------------

export async function createDependency(
  consumerCapsuleId: string,
  input: {
    readonly producerCapsuleId: string;
    readonly mode?: DependencyMode;
    readonly outputs?: Readonly<Record<string, DependencyOutputMapping>>;
    readonly visibility?: DependencyVisibility;
  },
): Promise<Dependency> {
  const body = await controlFetch<{ dependency: Dependency }>(
    `${BASE}/capsules/${encodeURIComponent(consumerCapsuleId)}/dependencies`,
    {
      method: "POST",
      body: {
        producerCapsuleId: input.producerCapsuleId,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.outputs ? { outputs: input.outputs } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      },
    },
  );
  return body.dependency;
}

export async function deleteDependency(dependencyId: string): Promise<void> {
  await controlFetch<void>(
    `${BASE}/dependencies/${encodeURIComponent(dependencyId)}`,
    { method: "DELETE" },
  );
}

// --- Activity --------------------------------------------------------------

export async function listActivity(
  workspaceId: string,
  limit?: number,
): Promise<readonly ActivityEvent[]> {
  const body = await controlFetch<{ events?: readonly ActivityEvent[] }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/activity${query({ limit })}`,
  );
  return body.events ?? [];
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

// --- Sources ---------------------------------------------------------------

const SOURCE_CREATE_DEFAULT_REF = "HEAD";
const SOURCE_CREATE_DEFAULT_PATH = ".";
const SOURCE_CREATE_PAGE_LIMIT = 100;
const SOURCE_CREATE_MAX_PAGES = 100;
const SOURCE_CREATE_BASELINE_MAX_ATTEMPTS = 2;
const SOURCE_CREATE_BASELINE_ATTEMPT_TIMEOUT_MS = 15_000;
/**
 * A Source create is the first mutation in the install preparation flow. Keep
 * a small part of that flow's deadline available for the authoritative
 * readback when the POST's response is lost.
 */
const SOURCE_CREATE_READBACK_BUDGET_MS = 5_000;

export async function listSources(
  workspaceId: string,
): Promise<readonly Source[]> {
  return await fetchAllPages<Source>(
    `${BASE}/sources${query({ workspaceId: workspaceId })}`,
    (body) => (body.sources as readonly Source[]) ?? [],
  );
}

interface SourceCreateBaselineAttempt {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly clearAttemptTimer: () => void;
  readonly cleanup: () => void;
}

interface SourceCreateBaselineResult {
  readonly sources: readonly Source[];
  /** Kept until the complete create/readback flow has finished. */
  readonly cleanup: () => void;
}

/**
 * Gives one strict baseline read a short, attempt-local timeout. The shared
 * mutation signal is still authoritative: a parent or mutation-window abort
 * cancels the attempt but can never be mistaken for a retryable timeout.
 */
function sourceCreateBaselineAttempt(
  mutationSignal: AbortSignal | undefined,
): SourceCreateBaselineAttempt {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromMutation = () => {
    controller.abort(mutationSignal?.reason);
  };
  if (mutationSignal?.aborted) {
    abortFromMutation();
  } else {
    mutationSignal?.addEventListener("abort", abortFromMutation, {
      once: true,
    });
  }
  let timeoutActive = true;
  const timeout =
    mutationSignal?.aborted === true
      ? undefined
      : setTimeout(() => {
          if (!timeoutActive) return;
          timedOut = true;
          controller.abort();
        }, SOURCE_CREATE_BASELINE_ATTEMPT_TIMEOUT_MS);
  const clearAttemptTimer = () => {
    timeoutActive = false;
    if (timeout !== undefined) clearTimeout(timeout);
  };
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearAttemptTimer,
    cleanup: () => {
      clearAttemptTimer();
      mutationSignal?.removeEventListener("abort", abortFromMutation);
    },
  };
}

/**
 * Reads the complete strict Source baseline, retrying only when the current
 * attempt's own timer aborted an otherwise pending GET. HTTP/invalid response
 * errors and the shared parent/mutation abort are never replayed.
 */
async function listSourcesForCreateBaseline(
  workspaceId: string,
  mutationSignal: AbortSignal | undefined,
): Promise<SourceCreateBaselineResult> {
  for (
    let attempt = 0;
    attempt < SOURCE_CREATE_BASELINE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    // A shared parent/mutation abort that arrives between attempts is
    // authoritative; do not start another GET after it has fired.
    throwIfAborted(mutationSignal);
    const attemptSignals = sourceCreateBaselineAttempt(mutationSignal);
    try {
      const sources = await listSourcesForCreateRecovery(workspaceId, {
        signal: attemptSignals.signal,
      });
      if (attemptSignals.timedOut()) {
        attemptSignals.cleanup();
        if (mutationSignal?.aborted) throwIfAborted(mutationSignal);
        if (attempt + 1 >= SOURCE_CREATE_BASELINE_MAX_ATTEMPTS) {
          throw new ControlApiError(
            0,
            "request_timeout",
            "Source baseline attempt timed out.",
          );
        }
        continue;
      }
      // The child signal must remain linked to the mutation window until the
      // POST/readback flow is complete, but its local timer is no longer
      // needed once this complete baseline has returned.
      attemptSignals.clearAttemptTimer();
      return { sources, cleanup: attemptSignals.cleanup };
    } catch (error) {
      attemptSignals.cleanup();
      if (
        mutationSignal?.aborted ||
        !attemptSignals.timedOut() ||
        !isAbortError(error) ||
        attempt + 1 >= SOURCE_CREATE_BASELINE_MAX_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new Error("Source baseline attempts exhausted.");
}

/**
 * Strict Source inventory used only around the one-shot create mutation.
 *
 * The ordinary dashboard list helper intentionally tolerates an absent or
 * malformed array because it powers presentation views. A create baseline and
 * readback are proof obligations instead: every page and every row must be
 * valid, pagination must terminate with an omitted cursor, and the Workspace
 * projection must remain scoped to the requested Workspace.
 */
async function listSourcesForCreateRecovery(
  workspaceId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<readonly Source[]> {
  const all: Source[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < SOURCE_CREATE_MAX_PAGES; page += 1) {
    const path = `${BASE}/sources${query({
      workspaceId,
      limit: SOURCE_CREATE_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    })}`;
    const body = await controlFetch<unknown>(path, {
      signal: options.signal,
    });
    if (!isRecord(body) || !Array.isArray(body.sources)) {
      throw new ControlApiError(
        502,
        "invalid_source_list_response",
        "Source list returned an invalid response.",
      );
    }
    const pageSources = body.sources;
    if (
      !pageSources.every(isSourceResponse) ||
      pageSources.some((source) => source.workspaceId !== workspaceId)
    ) {
      throw new ControlApiError(
        502,
        "invalid_source_list_response",
        "Source list returned an invalid response.",
      );
    }
    for (const source of pageSources) {
      if (ids.has(source.id)) {
        throw new ControlApiError(
          502,
          "invalid_source_list_response",
          "Source list returned duplicate records.",
        );
      }
      ids.add(source.id);
      all.push(source);
    }

    // The pagination contract omits `nextCursor` on the final page. An
    // explicit empty, null, or non-string cursor is incomplete and cannot
    // prove that the inventory is complete.
    if (!("nextCursor" in body)) return all;
    const nextCursor = body.nextCursor;
    if (
      typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      cursors.has(nextCursor)
    ) {
      throw new ControlApiError(
        502,
        "invalid_source_list_pagination",
        "Source list pagination was incomplete.",
      );
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new ControlApiError(
    502,
    "invalid_source_list_pagination",
    "Source list pagination did not terminate.",
  );
}

export async function getSource(sourceId: string): Promise<Source> {
  const body = await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}`,
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

function sourceMembershipMismatch(message: string): ControlApiError {
  return new ControlApiError(409, "source_membership_changed", message);
}

function sourcePatchIndeterminate(
  message: string,
  cause?: unknown,
): ControlApiIndeterminateError {
  return new ControlApiIndeterminateError("source_patch", message, cause);
}

/**
 * Advances one existing Capsule Source to an exact commit. The Source URL,
 * path, identity, and Workspace are read before the write and checked again
 * after it. There is one PATCH at most; an uncertain PATCH gets one GET
 * readback and is never blindly replayed.
 */
export async function updateCapsuleSourceRevision(
  capsuleId: string,
  identity: CapsuleSourceIdentity,
  revision: string,
  options: {
    /** Source-global Capsule membership captured and confirmed by the UI. */
    readonly affectedCapsuleIds: readonly string[];
  },
): Promise<Source> {
  if (!isImmutableSourceRevision(revision)) {
    throw new ControlApiError(
      400,
      "invalid_source_revision",
      "Source revision must be an exact 40-character hexadecimal commit.",
    );
  }
  const expectedCapsuleIds = normalizeCapsuleIds(
    (options as { readonly affectedCapsuleIds?: unknown } | undefined)
      ?.affectedCapsuleIds,
  );
  const capsule = await getCapsule(capsuleId);
  if (
    capsule.workspaceId !== identity.workspaceId ||
    capsule.sourceId !== identity.sourceId
  ) {
    throw sourceRevisionMismatch(
      "The requested Source does not belong to this Capsule and Workspace.",
    );
  }
  const before = await getSource(identity.sourceId);
  if (!sourceIdentityMatches(before, capsule, identity)) {
    throw sourceRevisionMismatch(
      "The Source URL, path, or Workspace changed; the version was not updated.",
    );
  }

  if (!expectedCapsuleIds.includes(capsuleId)) {
    throw sourceMembershipMismatch(
      "The requested Source membership does not include this Workload.",
    );
  }
  const beforeMembers = await listCapsulesForSourceMembership(
    identity.workspaceId,
  );
  assertSourceMembership(
    beforeMembers,
    identity.workspaceId,
    identity.sourceId,
    expectedCapsuleIds,
    "before the Source revision update",
  );

  let patchError: unknown;
  try {
    await patchSource(identity.sourceId, { defaultRef: revision });
  } catch (error) {
    if (!isMutationOutcomeUnknown(error)) throw error;
    patchError = error;
  }

  let readback: Source | undefined;
  let readbackError: unknown;
  try {
    readback = await getSource(identity.sourceId);
  } catch (error) {
    readbackError = error;
  }
  let membershipError: unknown;
  try {
    const afterMembers = await listCapsulesForSourceMembership(
      identity.workspaceId,
    );
    assertSourceMembership(
      afterMembers,
      identity.workspaceId,
      identity.sourceId,
      expectedCapsuleIds,
      "during the Source revision update",
    );
  } catch (error) {
    membershipError = error;
  }
  if (membershipError) {
    throw sourcePatchIndeterminate(
      "Source revision update outcome is indeterminate because affected Workload membership changed or was unavailable.",
      patchError ?? readbackError ?? membershipError,
    );
  }
  if (readbackError || !readback) {
    throw sourcePatchIndeterminate(
      "Source revision update outcome is indeterminate because the authoritative readback was unavailable.",
      patchError ?? readbackError,
    );
  }
  const exact =
    sourceIdentityMatches(readback, capsule, identity) &&
    sameGitRef(readback.defaultRef, revision);
  if (patchError) {
    if (exact) return readback;
    throw sourcePatchIndeterminate(
      "Source revision update outcome is indeterminate; reconcile the Source before trying again.",
      patchError,
    );
  }
  if (!exact) {
    throw sourceRevisionMismatch(
      "The Source did not read back with the requested exact revision.",
    );
  }
  return readback;
}

function normalizeCapsuleIds(
  ids: unknown,
): readonly string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every(
      (id) =>
        typeof id === "string" && id.length > 0 && id.trim() === id,
    )
  ) {
    throw new ControlApiError(
      400,
      "invalid_source_membership",
      "Source revision updates require a non-empty exact Workload membership.",
    );
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new ControlApiError(
      400,
      "invalid_source_membership",
      "Source revision updates require each affected Workload exactly once.",
    );
  }
  return [...unique].sort();
}

function assertSourceMembership(
  capsules: readonly Capsule[],
  workspaceId: string,
  sourceId: string,
  expectedIds: readonly string[],
  phase: string,
): void {
  const actualIds = capsules
    .filter(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.sourceId === sourceId &&
        candidate.status !== "destroyed",
    )
    .map((candidate) => candidate.id)
    .sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw sourceMembershipMismatch(
      `Source membership changed ${phase}; review the affected Workloads again.`,
    );
  }
}

function sameGitRef(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export interface AcknowledgedSourceCreateResult {
  readonly source: Source;
  readonly hookSecret: string;
  readonly recovery?: never;
}

/**
 * A lost Source-create acknowledgement can prove the durable Source row but
 * can never recover the one-shot hook secret. Callers must not mistake this
 * result for an acknowledged response or attempt to use it as a webhook
 * credential.
 */
export interface RecoveredSourceCreateResult {
  readonly source: Source;
  readonly recovery: "authoritative_readback";
  readonly hookSecret?: never;
}

export type CreateSourceResult =
  | AcknowledgedSourceCreateResult
  | RecoveredSourceCreateResult;

export interface SourceCreateIdentity {
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef: string;
  readonly defaultPath: string;
  readonly authConnectionId?: string;
  readonly autoSync: boolean;
}

/**
 * Client-owned proof context for a Source create whose acknowledgement was
 * ambiguous. It is intentionally opaque to the install UI: only the control
 * client may inspect the exact identity and original baseline ids.
 */
export interface SourceCreateReconciliationToken {
  readonly kind: "source_create_reconciliation";
  readonly identity: SourceCreateIdentity;
  readonly baselineIds: readonly string[];
}

export class SourceCreateIndeterminateError extends ControlApiIndeterminateError {
  readonly reconciliationToken: SourceCreateReconciliationToken;

  constructor(
    message: string,
    reconciliationToken: SourceCreateReconciliationToken,
    cause?: unknown,
  ) {
    super("source_create", message, cause);
    this.name = "SourceCreateIndeterminateError";
    this.reconciliationToken = reconciliationToken;
  }
}

function sourceCreateIdentity(input: {
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
  readonly autoSync?: boolean;
}): SourceCreateIdentity {
  return {
    workspaceId: input.workspaceId,
    name: input.name,
    // The control plane trims URL/ref/path before storing them. Keep the
    // dashboard's identity check aligned with those durable values while
    // preserving the exact name and connection id sent by the caller.
    url: input.url.trim(),
    defaultRef:
      input.defaultRef?.trim() || SOURCE_CREATE_DEFAULT_REF,
    defaultPath:
      input.defaultPath?.trim() || SOURCE_CREATE_DEFAULT_PATH,
    ...(input.authConnectionId
      ? { authConnectionId: input.authConnectionId }
      : {}),
    autoSync: input.autoSync === true,
  };
}

function sourceMatchesCreateIdentity(
  source: Source,
  identity: SourceCreateIdentity,
): boolean {
  return (
    source.workspaceId === identity.workspaceId &&
    source.name === identity.name &&
    source.url === identity.url &&
    source.defaultRef === identity.defaultRef &&
    source.defaultPath === identity.defaultPath &&
    source.authConnectionId === identity.authConnectionId &&
    source.autoSync === identity.autoSync
  );
}

function projectSource(source: Source): Source {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    name: source.name,
    url: source.url,
    defaultRef: source.defaultRef,
    defaultPath: source.defaultPath,
    ...(source.authConnectionId
      ? { authConnectionId: source.authConnectionId }
      : {}),
    status: source.status,
    autoSync: source.autoSync,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function sourceCreateIdentitiesEqual(
  left: SourceCreateIdentity,
  right: SourceCreateIdentity,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.name === right.name &&
    left.url === right.url &&
    left.defaultRef === right.defaultRef &&
    left.defaultPath === right.defaultPath &&
    left.authConnectionId === right.authConnectionId &&
    left.autoSync === right.autoSync
  );
}

function sourceCreateReconciliationToken(
  identity: SourceCreateIdentity,
  baselineIds: ReadonlySet<string>,
): SourceCreateReconciliationToken {
  return Object.freeze({
    kind: "source_create_reconciliation" as const,
    identity: Object.freeze({ ...identity }),
    baselineIds: Object.freeze([...baselineIds]),
  });
}

function isSourceCreateReconciliationToken(
  value: unknown,
): value is SourceCreateReconciliationToken {
  if (!isRecord(value) || value.kind !== "source_create_reconciliation") {
    return false;
  }
  const identity = value.identity;
  const baselineIds = value.baselineIds;
  if (!isRecord(identity) || !Array.isArray(baselineIds)) return false;
  if (
    typeof identity.workspaceId !== "string" ||
    typeof identity.name !== "string" ||
    typeof identity.url !== "string" ||
    typeof identity.defaultRef !== "string" ||
    typeof identity.defaultPath !== "string" ||
    (identity.authConnectionId !== undefined &&
      typeof identity.authConnectionId !== "string") ||
    typeof identity.autoSync !== "boolean"
  ) {
    return false;
  }
  return (
    baselineIds.length === new Set(baselineIds).size &&
    baselineIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.trim() === id,
    )
  );
}

function invalidSourceCreateResponse(): ControlApiError {
  return new ControlApiError(
    502,
    "invalid_source_response",
    "Source create returned an invalid response.",
  );
}

function sourceCreateIndeterminate(
  message: string,
  reconciliationToken: SourceCreateReconciliationToken,
  cause?: unknown,
): SourceCreateIndeterminateError {
  return new SourceCreateIndeterminateError(
    message,
    reconciliationToken,
    cause,
  );
}

function sourceCreateBaselineUnavailable(cause: unknown): ControlApiError {
  // Baseline failure happens before the mutation is dispatched. It is a
  // definite precondition failure, not an indeterminate mutation outcome.
  void cause;
  return new ControlApiError(
    0,
    "source_create_baseline_unavailable",
    "Source create cannot start because the authoritative Source baseline was unavailable.",
  );
}

interface SourceCreateRequestSignals {
  readonly mutationSignal?: AbortSignal;
  readonly readbackSignal?: AbortSignal;
  readonly cleanup: () => void;
}

/**
 * Splits the install deadline into a mutation window and a readback window.
 * The parent signal still cancels both windows (for user cancellation or an
 * outer navigation), while the mutation window is stopped early enough that a
 * lost POST response cannot consume the readback budget.
 */
function sourceCreateRequestSignals(
  parentSignal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): SourceCreateRequestSignals {
  if (deadlineAt === undefined) {
    return {
      mutationSignal: parentSignal,
      readbackSignal: parentSignal,
      cleanup: () => undefined,
    };
  }

  const mutationController = new AbortController();
  const readbackController = new AbortController();
  const abortFromParent = () => {
    const reason = parentSignal?.reason;
    mutationController.abort(reason);
    readbackController.abort(reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const remaining = Math.max(0, deadlineAt - Date.now());
  const readbackBudget = Math.min(SOURCE_CREATE_READBACK_BUDGET_MS, remaining);
  const mutationWindow = Math.max(0, remaining - readbackBudget);
  if (mutationWindow === 0) mutationController.abort();
  const mutationTimer =
    mutationWindow > 0
      ? setTimeout(() => mutationController.abort(), mutationWindow)
      : undefined;
  if (remaining === 0) readbackController.abort();
  const readbackTimer =
    remaining > 0
      ? setTimeout(() => readbackController.abort(), remaining)
      : undefined;

  return {
    mutationSignal: mutationController.signal,
    readbackSignal: readbackController.signal,
    cleanup: () => {
      if (mutationTimer) clearTimeout(mutationTimer);
      if (readbackTimer) clearTimeout(readbackTimer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * Completes a previously ambiguous Source create without ever issuing a POST.
 * The original baseline ids are part of the token, so a pre-existing exact
 * Source can never be mistaken for the result of the ambiguous mutation.
 */
export async function reconcileSourceCreate(
  reconciliationToken: SourceCreateReconciliationToken,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RecoveredSourceCreateResult> {
  if (!isSourceCreateReconciliationToken(reconciliationToken)) {
    throw new ControlApiError(
      400,
      "invalid_source_create_reconciliation_token",
      "Source create reconciliation token is invalid.",
    );
  }
  let after: readonly Source[];
  try {
    after = await listSourcesForCreateRecovery(
      reconciliationToken.identity.workspaceId,
      { signal: options.signal },
    );
  } catch (error) {
    throw sourceCreateIndeterminate(
      "Source create outcome is indeterminate because the authoritative Source readback was unavailable.",
      reconciliationToken,
      error,
    );
  }
  const baselineIds = new Set(reconciliationToken.baselineIds);
  const newlyAppeared = after.filter((source) => !baselineIds.has(source.id));
  if (newlyAppeared.length !== 1) {
    throw sourceCreateIndeterminate(
      `Source create outcome is indeterminate: expected exactly one newly appeared Source, observed ${newlyAppeared.length}.`,
      reconciliationToken,
    );
  }
  const [candidate] = newlyAppeared;
  if (
    !candidate ||
    candidate.status !== "active" ||
    !sourceMatchesCreateIdentity(candidate, reconciliationToken.identity)
  ) {
    throw sourceCreateIndeterminate(
      "Source create outcome is indeterminate: the newly appeared Source did not match the exact active request identity.",
      reconciliationToken,
    );
  }
  return { source: projectSource(candidate), recovery: "authoritative_readback" };
}

export async function createSource(input: {
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
  readonly autoSync?: boolean;
  readonly signal?: AbortSignal;
  /** Internal install deadline; reserves time for lost-ack readback. */
  readonly deadlineAt?: number;
  readonly reconciliationToken?: SourceCreateReconciliationToken;
}): Promise<CreateSourceResult> {
  const identity = sourceCreateIdentity(input);
  if (input.reconciliationToken !== undefined) {
    if (
      !isSourceCreateReconciliationToken(input.reconciliationToken) ||
      !sourceCreateIdentitiesEqual(
        identity,
        input.reconciliationToken.identity,
      )
    ) {
      throw new ControlApiError(
        409,
        "source_create_reconciliation_token_mismatch",
        "Source create reconciliation does not match the current request.",
      );
    }
    const signals = sourceCreateRequestSignals(
      input.signal,
      input.deadlineAt,
    );
    try {
      return await reconcileSourceCreate(input.reconciliationToken, {
        signal: signals.readbackSignal,
      });
    } finally {
      signals.cleanup();
    }
  }
  const baselineAndReadbackSignals = sourceCreateRequestSignals(
    input.signal,
    input.deadlineAt,
  );
  let mutationDispatched = false;
  let baselineCleanup: (() => void) | undefined;
  try {
    let baseline: readonly Source[];
    try {
      if (input.deadlineAt === undefined) {
        baseline = await listSourcesForCreateRecovery(input.workspaceId, {
          signal: baselineAndReadbackSignals.mutationSignal,
        });
      } else {
        const result = await listSourcesForCreateBaseline(
          input.workspaceId,
          baselineAndReadbackSignals.mutationSignal,
        );
        baseline = result.sources;
        baselineCleanup = result.cleanup;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw sourceCreateBaselineUnavailable(error);
    }
    const baselineIds = new Set(baseline.map((source) => source.id));

    try {
      mutationDispatched = true;
      const body = await controlFetch<unknown>(`${BASE}/sources`, {
        method: "POST",
        signal: baselineAndReadbackSignals.mutationSignal,
        body: {
          workspaceId: input.workspaceId,
          name: input.name,
          url: input.url,
          ...(input.defaultRef ? { defaultRef: input.defaultRef } : {}),
          ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
          ...(input.authConnectionId
            ? { authConnectionId: input.authConnectionId }
            : {}),
          ...(input.autoSync !== undefined ? { autoSync: input.autoSync } : {}),
        },
      });
      if (
        !isRecord(body) ||
        !isSourceResponse(body.source) ||
        body.source.status !== "active" ||
        !sourceMatchesCreateIdentity(body.source, identity) ||
        baselineIds.has(body.source.id) ||
        !isNonEmptyString(body.hookSecret)
      ) {
        throw invalidSourceCreateResponse();
      }
      // Project the public acknowledgement deliberately. The hook secret is
      // one-shot, while arbitrary server fields (request ids, recovery hints,
      // or caller-controlled extras) are not part of this client contract.
      return {
        source: projectSource(body.source),
        hookSecret: body.hookSecret,
      };
    } catch (error) {
      // A definite HTTP rejection is authoritative. Do not turn a 4xx
      // validation/authorization result into readback noise or a retry.
      if (!isMutationOutcomeUnknown(error)) throw error;
      const reconciliationToken = sourceCreateReconciliationToken(
        identity,
        baselineIds,
      );
      // Spend the reserved readback window before surfacing the token. This
      // can adopt exactly one newly appeared active Source, while zero,
      // multiple, mismatched, incomplete, or unavailable readbacks retain the
      // opaque token for the next read-only reconciliation attempt.
      try {
        return await reconcileSourceCreate(reconciliationToken, {
          signal: baselineAndReadbackSignals.readbackSignal,
        });
      } catch (readbackError) {
        if (input.signal?.aborted && !mutationDispatched) throw readbackError;
        if (input.signal?.aborted) {
          throw sourceCreateIndeterminate(
            "Source create acknowledgement was ambiguous; retrying will only reconcile this exact attempt.",
            reconciliationToken,
            error ?? readbackError,
          );
        }
        throw sourceCreateIndeterminate(
          "Source create acknowledgement was ambiguous; retrying will only reconcile this exact attempt.",
          reconciliationToken,
          error ?? readbackError,
        );
      }
    }
  } finally {
    baselineCleanup?.();
    baselineAndReadbackSignals.cleanup();
  }
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

export async function resolveStableSourceTag(
  workspaceId: string,
  url: string,
): Promise<StableSourceTagResolutionResponse> {
  return await controlFetch<StableSourceTagResolutionResponse>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/source-ref-resolutions/stable-semver`,
    { method: "POST", body: { url } },
  );
}

export async function readSourceSnapshotPresentationFile(
  sourceId: string,
  sourceSnapshotId: string,
  path: string,
): Promise<SourceSnapshotFileResponse> {
  return await controlFetch<SourceSnapshotFileResponse>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(sourceSnapshotId)}/file?${new URLSearchParams({ path }).toString()}`,
  );
}

/** Reads one bounded manifest file from a SourceSnapshot pinned by source_sync. */
export async function readSourceSnapshotFile(
  sourceId: string,
  sourceSnapshotId: string,
  path: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<{
  readonly sourceSnapshotId: string;
  readonly path: string;
  readonly text: string;
}> {
  return await controlFetch<{
    readonly sourceSnapshotId: string;
    readonly path: string;
    readonly text: string;
  }>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(sourceSnapshotId)}/file${query({ path })}`,
    { signal: options.signal },
  );
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
          snapshots: lastSnapshots,
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

    lastSnapshots = await listSourceSnapshots(sourceId, {
      signal: options.signal,
    });
    if (options.runId) {
      // Do not accept a pre-existing snapshot while this requested sync is
      // queued/running. Update plans must pin the exact immutable snapshot
      // produced by the requested SourceSyncRun.
      if (run?.status === "succeeded" && run.sourceSnapshotId) {
        const exact = lastSnapshots.find(
          (snapshot) => snapshot.id === run.sourceSnapshotId,
        );
        if (exact) {
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

async function sourceSyncFailureMessage(
  run: Run,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = run.errorCode
    ? `Source sync ${run.status}: ${run.errorCode}`
    : `Source sync ${run.status}.`;
  try {
    const logs = await getRunLogsWithOptions(run.id, { signal });
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

async function getRunWithOptions(
  id: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Run> {
  const body = await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  return body.run;
}

export async function getRun(id: string): Promise<Run> {
  return await getRunWithOptions(id);
}

/**
 * Subscribe to a run's status over SSE (`GET /runs/:id/stream`). The server
 * pushes the run on every change and closes at a terminal status, so the run
 * screen updates in real time instead of polling. Same-origin cookie auth
 * (EventSource sends credentials). Returns a disposer; falls back via `onError`
 * when EventSource is unavailable or the stream drops.
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
  source.onopen = () => handlers.onOpen?.();
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { run?: Run };
      if (data?.run) handlers.onRun(data.run);
    } catch {
      /* ignore a malformed frame */
    }
  };
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}

export async function approveRun(
  id: string,
  input: { readonly reason?: string } = {},
): Promise<Run> {
  const body = await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: input.reason ? { reason: input.reason } : {} },
  );
  return body.run;
}

async function getRunLogsWithOptions(
  id: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RunLogs> {
  return await controlFetch<RunLogs>(
    `${BASE}/runs/${encodeURIComponent(id)}/logs`,
    { signal: options.signal },
  );
}

export async function getRunLogs(id: string): Promise<RunLogs> {
  return await getRunLogsWithOptions(id);
}

/**
 * Reads a plan / destroy_plan Run's public cost projection (`GET
 * /api/v1/runs/:id/cost`). Used by the Run view to surface, before apply,
 * the estimated USD amount and any host extension decision that would block the
 * apply. The values are the ones the controller already computed
 * at plan time; this never computes cost and returns no secret material.
 */
export async function getRunCostInfo(id: string): Promise<RunCostInfo> {
  const body = await controlFetch<{ cost: RunCostInfo }>(
    `${BASE}/runs/${encodeURIComponent(id)}/cost`,
  );
  return body.cost;
}

function isApplyRetryableTransportError(error: unknown): boolean {
  if (error instanceof ControlApiIndeterminateError) return false;
  if (!(error instanceof ControlApiError)) return true;
  return error.status === 0 || error.code === "request_timeout";
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Applies a reviewed plan Run through the unified Run surface. `planRunId` is
 * the id of the `plan` Run shown in the Run detail view. The backend rebuilds
 * the apply guard from the reviewed plan and re-checks every precondition.
 */
export async function createApplyRun(
  planRunId: string,
  input: {
    readonly timeoutMs?: number;
  } = {},
): Promise<{ readonly run: Run }> {
  const attempt = async (): Promise<{ readonly run: Run }> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller =
      input.timeoutMs && input.timeoutMs > 0
        ? new AbortController()
        : undefined;
    if (controller && input.timeoutMs) {
      timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    }
    try {
      const body = await controlFetch<unknown>(
        `${BASE}/runs/${encodeURIComponent(planRunId)}/apply`,
        {
          method: "POST",
          signal: controller?.signal,
          body: {},
        },
      );
      if (!isRecord(body) || !isRecord(body.run) || typeof body.run.id !== "string") {
        throw new ControlApiError(
          502,
          "invalid_apply_response",
          "Apply returned an invalid response.",
        );
      }
      return { run: body.run as unknown as Run };
    } catch (error) {
      if (controller?.signal.aborted && isAbortError(error)) {
        throw new ControlApiError(
          0,
          "request_timeout",
          `apply request timed out after ${input.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  try {
    return await attempt();
  } catch (firstError) {
    // Only a missing HTTP response or our explicit timeout is safe to retry.
    // HTTP 4xx/5xx and malformed success envelopes are already typed and are
    // not replayed here.
    if (!isApplyRetryableTransportError(firstError)) throw firstError;
    try {
      return await attempt();
    } catch (secondError) {
      if (!isApplyRetryableTransportError(secondError)) throw secondError;
      throw new ControlApiIndeterminateError(
        "apply",
        "Apply request outcome is indeterminate after the bounded retry; reconcile the exact PlanRun before trying again.",
        secondError,
      );
    }
  }
}

/**
 * Requests cancellation of a queued/running Run (`POST /api/v1/runs/:id/cancel`).
 * The backend moves the run to a terminal `cancelled` state when it is still
 * cancellable; already-terminal runs return their current state.
 */
export async function cancelRun(runId: string): Promise<{ readonly run: Run }> {
  return await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

// --- StateVersions ---------------------------------------------------------

/**
 * Lists a Capsule's StateVersion history for the dashboard session. Rows are
 * browser-safe metadata and arrive newest-first.
 */
export async function listStateVersions(
  capsuleId: string,
): Promise<readonly PublicStateVersion[]> {
  return await fetchAllPages<PublicStateVersion>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/state-versions`,
    (body) => (body.stateVersions as readonly PublicStateVersion[]) ?? [],
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
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/state-versions/${encodeURIComponent(stateVersionId)}/rollback-plan`,
    { method: "POST" },
  );
}

// --- RunGroups -------------------------------------------------------------

export async function createWorkspacePlanUpdate(
  workspaceId: string,
): Promise<RunGroupWithRuns> {
  return await controlFetch<RunGroupWithRuns>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/plan-update`,
    { method: "POST" },
  );
}

export async function getRunGroup(id: string): Promise<RunGroupWithRuns> {
  return await controlFetch<RunGroupWithRuns>(
    `${BASE}/run-groups/${encodeURIComponent(id)}`,
  );
}

export async function approveRunGroup(id: string): Promise<RunGroupWithRuns> {
  return await controlFetch<RunGroupWithRuns>(
    `${BASE}/run-groups/${encodeURIComponent(id)}/approve`,
    { method: "POST" },
  );
}

// --- Connections -----------------------------------------------------------

function normalizedWorkspaceId(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function listConnections(
  workspaceId: string,
): Promise<readonly ProviderConnection[]> {
  return await listConnectionsWithSignal(workspaceId);
}

export async function listConnectionsWithSignal(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  return await fetchAllPages<ProviderConnection>(
    `${BASE}/connections${query({ workspaceId: normalized })}`,
    (body) => (body.connections as readonly ProviderConnection[]) ?? [],
    { signal },
  );
}

export async function listProviderConnections(
  workspaceId: string,
): Promise<readonly ProviderConnection[]> {
  return await listProviderConnectionsWithSignal(workspaceId);
}

export async function listProviderConnectionsWithSignal(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  const body = await controlFetch<{
    providerConnections?: readonly ProviderConnection[];
  }>(`${BASE}/provider-connections${query({ workspaceId: normalized })}`, {
    signal,
  });
  return body.providerConnections ?? [];
}

export async function listReleaseOwnedProviderConnectionsWithSignal(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
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
  readonly workspaceId: string;
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
  const body = await controlFetch<{ connection: ProviderConnection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
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
  readonly workspaceId: string;
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
  const body = await controlFetch<{ connection: ProviderConnection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
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
 * Revokes a Workspace-owned ProviderConnection (`POST /api/v1/connections/:id/revoke`,
 * 204). The sealed credential blob is deleted server-side.
 */
export async function revokeConnection(connectionId: string): Promise<void> {
  await controlFetch<void>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/revoke`,
    { method: "POST" },
  );
}

export interface ConnectionOAuthStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
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
  readonly workspaceId: string;
  readonly displayName?: string;
}): Promise<ConnectionOAuthStart> {
  return await controlFetch<ConnectionOAuthStart>(
    `${BASE}/connections/oauth/${encodeURIComponent(input.helperId)}/start`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
    },
  );
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
  const body = await controlFetch<{
    recipes?: readonly CredentialRecipe[];
  }>(`${BASE}/credential-recipes`);
  return body.recipes ?? [];
}

// --- OutputShares ----------------------------------------------------------

export async function listOutputShares(
  workspaceId: string,
): Promise<readonly OutputShare[]> {
  return await fetchAllPages<OutputShare>(
    `${BASE}/output-shares${query({ workspaceId: workspaceId })}`,
    (body) => (body.shares as readonly OutputShare[]) ?? [],
  );
}

export async function createOutputShare(input: {
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputs: readonly {
    readonly name: string;
    readonly alias?: string;
    readonly sensitive?: boolean;
  }[];
  readonly sensitivePolicy?: {
    readonly allow: boolean;
    readonly reason?: string;
  };
}): Promise<OutputShare> {
  const body = await controlFetch<{ share: OutputShare }>(
    `${BASE}/output-shares`,
    {
      method: "POST",
      body: input,
    },
  );
  return body.share;
}

export async function approveOutputShare(id: string): Promise<OutputShare> {
  const body = await controlFetch<{ share: OutputShare }>(
    `${BASE}/output-shares/${encodeURIComponent(id)}/approve`,
    { method: "POST" },
  );
  return body.share;
}

export async function revokeOutputShare(id: string): Promise<OutputShare> {
  const body = await controlFetch<{ share: OutputShare }>(
    `${BASE}/output-shares/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
  );
  return body.share;
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
