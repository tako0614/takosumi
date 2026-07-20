/**
 * Typed client for the session-authenticated Takosumi control-plane
 * `/api/v1/*` route family and the origin-level Resource Shape `/v1/*`
 * provider API.
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

import type {
  ActivityEvent as ContractActivityEvent,
  BackupRecord as ContractBackupRecord,
  FormAvailability as ContractFormAvailability,
  CredentialRecipe as ContractCredentialRecipe,
  Dependency as ContractDependency,
  InstallConfig as ContractInstallConfig,
  InstallConfigVariableDefault as ContractInstallConfigVariableDefault,
  InstalledFormReference as ContractInstalledFormReference,
  Capsule as ContractCapsule,
  JsonObject as ContractJsonObject,
  JsonValue as ContractJsonValue,
  ManagedPublicHostnameAllocation,
  NativeResourceRef as ContractNativeResourceRef,
  ProviderBinding as ContractProviderBinding,
  ProviderBindings as ContractProviderBindings,
  ProviderBindingSet as ContractProviderBindingSet,
  ProviderConnection as ContractProviderConnection,
  ProviderResolution as ContractProviderResolution,
  PublicStateVersion as ContractPublicStateVersion,
  ResourceEvent as ContractResourceEvent,
  ResourceDeploymentQuote as ContractResourceDeploymentQuote,
  ResourceDeploymentReview as ContractResourceDeploymentReview,
  ResourceObject as ContractResourceObject,
  ResourceShapeKind as ContractResourceShapeKind,
  Run as ContractRun,
  RunCostInfo as ContractRunCostInfo,
  RunLogsResponse as ContractRunLogsResponse,
  Source as ContractSource,
  SourceBuildConfig,
  SourceSnapshot as ContractSourceSnapshot,
  SourceSnapshotFileResponse,
  StableSourceTagResolutionResponse,
  SpacePolicySpec as ContractSpacePolicySpec,
  TargetPoolSpec as ContractTargetPoolSpec,
  Workspace as ContractWorkspace,
  UsageEvent as ContractUsageEvent,
} from "takosumi-contract";

// ===========================================================================
// Transport — same-origin fetch with the session cookie (mirrors the account
// plane's lib/http.ts apiFetch, kept local so the control client has no
// dependency on the account-plane RPC internals).
// ===========================================================================

/** Error thrown for any non-2xx control-plane response. */
export class ControlApiError extends Error {
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
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Request was aborted.", "AbortError");
  }
}

async function controlFetch<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
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
const RESOURCE_SHAPE_BASE = "/v1";

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
  readonly restoreTarget?: {
    readonly capsuleId: string;
    readonly environment: string;
    readonly stateGeneration: number;
    readonly stateVersionId: string;
  };
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
  readonly sourceId?: string;
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

type WorkspaceListEnvelope = {
  readonly workspaces: readonly Workspace[];
};
type WorkspaceEnvelope = {
  readonly workspace: Workspace;
};

export async function listWorkspaces(): Promise<readonly Workspace[]> {
  const body = await controlFetch<WorkspaceListEnvelope>(`${BASE}/workspaces`);
  return body.workspaces;
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

export async function listWorkspacesIncludingArchived(): Promise<
  readonly Workspace[]
> {
  const body = await controlFetch<WorkspaceListEnvelope>(
    `${BASE}/workspaces${query({ includeArchived: "true" })}`,
  );
  return body.workspaces;
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

export async function createCapsule(input: {
  readonly workspaceId: string;
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
  const body = await controlFetch<{
    capsule: Capsule;
  }>(`${BASE}/workspaces/${encodeURIComponent(input.workspaceId)}/capsules`, {
    method: "POST",
    body: {
      name: input.name,
      environment: input.environment,
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
  });
  return body.capsule;
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

export async function getInstallConfig(id: string): Promise<InstallConfig> {
  const body = await controlFetch<{ installConfig: InstallConfig }>(
    `${BASE}/capsule-configs/${encodeURIComponent(id)}`,
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

export async function checkCapsuleCompatibility(input: {
  readonly workspaceId: string;
  readonly sourceId?: string;
  readonly gitUrl: string;
  readonly ref: string;
  readonly path: string;
  readonly name: string;
  readonly authConnectionId?: string;
  readonly installConfigId?: string;
  readonly signal?: AbortSignal;
  readonly onSourceCreated?: (sourceId: string) => void;
  readonly onSourceSyncProgress?: (
    progress: SourceSnapshotWaitProgress,
  ) => void;
  readonly onSourceSnapshot?: (snapshot: SourceSnapshot) => void;
}): Promise<CapsuleCompatibilityResult> {
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
        ...(input.authConnectionId
          ? { authConnectionId: input.authConnectionId }
          : {}),
      })
    ).source.id;
  input.onSourceCreated?.(sourceId);
  const syncEnvelope = await syncSource(sourceId, { signal: input.signal });
  const snapshot = await waitForLatestSourceSnapshot(sourceId, {
    runId: extractRunId(syncEnvelope),
    signal: input.signal,
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
        readonly versionConstraint?: string;
        readonly aliases?: readonly string[];
        readonly allowed?: boolean;
      }[];
      readonly resources?: readonly {
        readonly type?: string;
        readonly count?: number;
        readonly allowed?: boolean;
      }[];
      readonly rootModuleVariables?: readonly string[];
    };
  }>(`${BASE}/sources/${encodeURIComponent(sourceId)}/compatibility-check`, {
    method: "POST",
    body: {
      sourceSnapshotId: snapshot.id,
      // Gate the pre-install check against the selected InstallConfig's policy
      // when one is supplied (the install view passes the Workspace's resolved
      // profile), otherwise fall back to the instance-wide default policy.
      ...(input.installConfigId
        ? { installConfigId: input.installConfigId }
        : {}),
      ...(input.path && input.path !== "." ? { modulePath: input.path } : {}),
    },
  });
  const diagnostics = (body.report.findings ?? []).map((finding) => ({
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
  const providers = (body.report.providers ?? [])
    .filter((provider) => provider.source !== undefined)
    .map((provider) => ({
      source: provider.source!,
      ...(provider.versionConstraint
        ? { versionConstraint: provider.versionConstraint }
        : {}),
      aliases: provider.aliases ?? [],
      allowed: provider.allowed ?? true,
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
    level: body.report.level,
    summary:
      diagnostics[0]?.message ??
      "Compatibility check completed for the synced SourceSnapshot.",
    diagnostics,
    providers,
    resources,
    rootModuleVariables: body.report.rootModuleVariables ?? [],
    ...(input.installConfigId
      ? { installConfigId: input.installConfigId }
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

export async function createBackupRestore(
  workspaceId: string,
  backupId: string,
  input: {
    readonly capsuleId: string;
    readonly environment: string;
    readonly stateGeneration: number;
    readonly expectedBackupDigest: string;
    readonly restoreServiceData?: boolean;
  },
): Promise<Run> {
  const body = await controlFetch<{ run: Run }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/backups/${encodeURIComponent(backupId)}/restores`,
    {
      method: "POST",
      body: input,
    },
  );
  return body.run;
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

export async function listSources(
  workspaceId: string,
): Promise<readonly Source[]> {
  return await fetchAllPages<Source>(
    `${BASE}/sources${query({ workspaceId: workspaceId })}`,
    (body) => (body.sources as readonly Source[]) ?? [],
  );
}

export interface CreateSourceResult {
  readonly source: Source;
  readonly hookSecret: string;
}

export async function createSource(input: {
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
  readonly autoSync?: boolean;
}): Promise<CreateSourceResult> {
  return await controlFetch<CreateSourceResult>(`${BASE}/sources`, {
    method: "POST",
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
}

/** Kick a `source_sync` run. Returns the opaque run envelope. */
export async function syncSource(
  sourceId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly intent?: "observe" | "manual_plan";
  } = {},
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/sync`,
    {
      method: "POST",
      signal: options.signal,
      body: options.intent ? { intent: options.intent } : {},
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

export async function waitForLatestSourceSnapshot(
  sourceId: string,
  options: {
    readonly runId?: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly maxPollMs?: number;
    readonly signal?: AbortSignal;
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
        if (exact) return exact;
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
  options: { readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const capsule = await getCapsule(capsuleId);
  if (!capsule.sourceId) return await planCapsule(capsuleId, options);

  const syncEnvelope = await syncSource(capsule.sourceId, {
    intent: "manual_plan",
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
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller =
    input.timeoutMs && input.timeoutMs > 0 ? new AbortController() : undefined;
  if (controller && input.timeoutMs) {
    timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  }
  try {
    return await controlFetch<{ run: Run }>(
      `${BASE}/runs/${encodeURIComponent(planRunId)}/apply`,
      {
        method: "POST",
        signal: controller?.signal,
        body: {},
      },
    );
  } catch (error) {
    if (controller?.signal.aborted) {
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
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  return await fetchAllPages<ProviderConnection>(
    `${BASE}/connections${query({ workspaceId: normalized })}`,
    (body) => (body.connections as readonly ProviderConnection[]) ?? [],
  );
}

export async function listProviderConnections(
  workspaceId: string,
): Promise<readonly ProviderConnection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  const body = await controlFetch<{
    providerConnections?: readonly ProviderConnection[];
  }>(`${BASE}/provider-connections${query({ workspaceId: normalized })}`);
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

// --- Resource Shape API ---------------------------------------------------
//
// Resource Shape routes intentionally live at the origin-level `/v1/*`
// provider API, not under the Workspace/Capsule `/api/v1/*` family. The
// platform worker accepts the same HttpOnly dashboard session, re-resolves the
// selected Workspace server-side, then injects the internal deploy-control
// actor. Every call therefore carries both `workspaceId` (authorization owner
// boundary) and `space` (Resource Shape placement/policy namespace).

export type ResourceShape = ContractResourceObject;
export type ResourceShapeKind = ContractResourceShapeKind;
export type ResourceShapeEvent = ContractResourceEvent;
export type ResourceShapeNativeResource = ContractNativeResourceRef;
export type ResourceShapeJsonObject = ContractJsonObject;
export type ResourceDeploymentQuote = ContractResourceDeploymentQuote;
export type ResourceDeploymentReview = ContractResourceDeploymentReview;
export type FormAvailability = ContractFormAvailability;
export type InstalledFormReference = ContractInstalledFormReference;
export type ResourceTargetPoolSpec = ContractTargetPoolSpec;
export type ResourceSpacePolicySpec = ContractSpacePolicySpec;

export interface ResourceShapeWriteInput {
  readonly workspaceId: string;
  readonly space: string;
  readonly kind: ResourceShapeKind;
  readonly form?: InstalledFormReference;
  readonly name: string;
  readonly spec: ResourceShapeJsonObject;
  readonly project?: string;
  readonly environment?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly targetPoolName?: string;
  readonly spacePolicyName?: string;
}

export interface ResourceShapePreview {
  readonly resource: ResourceShape;
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  readonly portability: string;
  readonly nativeResourcePlan: readonly ResourceShapeNativeResource[];
  readonly riskNotes: readonly string[];
  readonly summary: string;
  readonly planDigest: string;
  readonly specDigest: string;
  readonly resolutionFingerprint: string;
  readonly quote?: ResourceDeploymentQuote;
}

export type ResourceShapeResult = ResourceShape & {
  readonly id: string;
  readonly observation?: {
    readonly status: string;
    readonly summary: string;
    readonly runId?: string;
  };
  readonly refresh?: {
    readonly summary: string;
    readonly runId?: string;
  };
  readonly import?: {
    readonly summary: string;
    readonly runId?: string;
  };
};

/** Durable operator configuration projection returned by `/v1/target-pools`. */
export interface ResourceTargetPool {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly spec: ResourceTargetPoolSpec;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Durable operator configuration projection returned by SpacePolicy APIs. */
export interface ResourceSpacePolicy {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly spec: ResourceSpacePolicySpec;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function resourceShapePath(kind: ResourceShapeKind, name: string): string {
  return `${RESOURCE_SHAPE_BASE}/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
}

function resourceShapeWriteBody(
  input: ResourceShapeWriteInput,
  review?: ResourceDeploymentReview,
): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    kind: input.kind,
    ...(input.form ? { form: input.form } : {}),
    metadata: {
      name: input.name,
      space: input.space,
      ...(input.project ? { project: input.project } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
    },
    spec: input.spec,
    ...(input.targetPoolName ? { targetPoolName: input.targetPoolName } : {}),
    ...(input.spacePolicyName
      ? { spacePolicyName: input.spacePolicyName }
      : {}),
    ...(review ? { review } : {}),
  };
}

export async function listResourceShapes(
  workspaceId: string,
  space: string,
): Promise<readonly ResourceShape[]> {
  return await fetchAllPages<ResourceShape>(
    `${RESOURCE_SHAPE_BASE}/resources${query({ workspaceId, space })}`,
    (body) => (body.resources as readonly ResourceShape[]) ?? [],
  );
}

/** Principal-scoped exact FormRef discovery; never a commercial catalog. */
export async function listFormAvailability(
  workspaceId: string,
  space: string,
): Promise<readonly FormAvailability[]> {
  return await fetchAllPages<FormAvailability>(
    `${RESOURCE_SHAPE_BASE}/form-availability${query({ workspaceId, space })}`,
    (body) => (body.forms as readonly FormAvailability[]) ?? [],
  );
}

export async function getResourceShape(
  workspaceId: string,
  space: string,
  kind: ResourceShapeKind,
  name: string,
): Promise<ResourceShapeResult> {
  return await controlFetch<ResourceShapeResult>(
    `${resourceShapePath(kind, name)}${query({ workspaceId, space })}`,
  );
}

export async function listResourceShapeEvents(
  workspaceId: string,
  space: string,
  kind: ResourceShapeKind,
  name: string,
): Promise<readonly ResourceShapeEvent[]> {
  return await fetchAllPages<ResourceShapeEvent>(
    `${resourceShapePath(kind, name)}/events${query({ workspaceId, space })}`,
    (body) => (body.events as readonly ResourceShapeEvent[]) ?? [],
  );
}

export async function previewResourceShape(
  input: ResourceShapeWriteInput,
): Promise<ResourceShapePreview> {
  return await controlFetch<ResourceShapePreview>(
    `${RESOURCE_SHAPE_BASE}/resources/preview`,
    { method: "POST", body: resourceShapeWriteBody(input) },
  );
}

export async function applyResourceShape(
  input: ResourceShapeWriteInput,
  review: ResourceDeploymentReview,
): Promise<ResourceShapeResult> {
  return await controlFetch<ResourceShapeResult>(
    resourceShapePath(input.kind, input.name),
    { method: "PUT", body: resourceShapeWriteBody(input, review) },
  );
}

export async function importResourceShape(
  input: ResourceShapeWriteInput & { readonly nativeId: string },
): Promise<ResourceShapeResult> {
  return await controlFetch<ResourceShapeResult>(
    `${resourceShapePath(input.kind, input.name)}/import`,
    {
      method: "POST",
      body: { ...resourceShapeWriteBody(input), nativeId: input.nativeId },
    },
  );
}

export async function observeResourceShape(
  workspaceId: string,
  space: string,
  kind: ResourceShapeKind,
  name: string,
): Promise<ResourceShapeResult> {
  return await controlFetch<ResourceShapeResult>(
    `${resourceShapePath(kind, name)}/observe${query({ workspaceId, space })}`,
    { method: "POST" },
  );
}

export async function refreshResourceShape(
  workspaceId: string,
  space: string,
  kind: ResourceShapeKind,
  name: string,
): Promise<ResourceShapeResult> {
  return await controlFetch<ResourceShapeResult>(
    `${resourceShapePath(kind, name)}/refresh${query({ workspaceId, space })}`,
    { method: "POST" },
  );
}

export async function deleteResourceShape(
  workspaceId: string,
  space: string,
  kind: ResourceShapeKind,
  name: string,
): Promise<void> {
  await controlFetch<void>(
    `${resourceShapePath(kind, name)}${query({ workspaceId, space })}`,
    { method: "DELETE" },
  );
}

export async function listResourceTargetPools(
  workspaceId: string,
  space: string,
): Promise<readonly ResourceTargetPool[]> {
  return await fetchAllPages<ResourceTargetPool>(
    `${RESOURCE_SHAPE_BASE}/target-pools${query({ workspaceId, space })}`,
    (body) => (body.targetPools as readonly ResourceTargetPool[]) ?? [],
  );
}

export async function putResourceTargetPool(input: {
  readonly workspaceId: string;
  readonly space: string;
  readonly name: string;
  readonly spec: ResourceTargetPoolSpec;
}): Promise<ResourceTargetPool> {
  return await controlFetch<ResourceTargetPool>(
    `${RESOURCE_SHAPE_BASE}/target-pools/${encodeURIComponent(input.name)}`,
    {
      method: "PUT",
      body: {
        workspaceId: input.workspaceId,
        space: input.space,
        spec: input.spec,
      },
    },
  );
}

export async function deleteResourceTargetPool(
  workspaceId: string,
  space: string,
  name: string,
): Promise<void> {
  await controlFetch<void>(
    `${RESOURCE_SHAPE_BASE}/target-pools/${encodeURIComponent(name)}${query({ workspaceId, space })}`,
    { method: "DELETE" },
  );
}

export async function putResourceSpacePolicy(input: {
  readonly workspaceId: string;
  readonly space: string;
  readonly name: string;
  readonly spec: ResourceSpacePolicySpec;
}): Promise<ResourceSpacePolicy> {
  return await controlFetch<ResourceSpacePolicy>(
    `${RESOURCE_SHAPE_BASE}/space-policies/${encodeURIComponent(input.name)}`,
    {
      method: "PUT",
      body: {
        workspaceId: input.workspaceId,
        space: input.space,
        spec: input.spec,
      },
    },
  );
}

export async function listResourceSpacePolicies(
  workspaceId: string,
  space: string,
): Promise<readonly ResourceSpacePolicy[]> {
  return await fetchAllPages<ResourceSpacePolicy>(
    `${RESOURCE_SHAPE_BASE}/space-policies${query({ workspaceId, space })}`,
    (body) =>
      (body.spacePolicies as readonly ResourceSpacePolicy[] | undefined) ?? [],
  );
}

export async function getResourceSpacePolicy(
  workspaceId: string,
  space: string,
  name: string,
): Promise<ResourceSpacePolicy> {
  return await controlFetch<ResourceSpacePolicy>(
    `${RESOURCE_SHAPE_BASE}/space-policies/${encodeURIComponent(name)}${query({ workspaceId, space })}`,
  );
}

export async function deleteResourceSpacePolicy(
  workspaceId: string,
  space: string,
  name: string,
): Promise<void> {
  await controlFetch<void>(
    `${RESOURCE_SHAPE_BASE}/space-policies/${encodeURIComponent(name)}${query({ workspaceId, space })}`,
    { method: "DELETE" },
  );
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
