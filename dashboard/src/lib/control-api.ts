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
 * Unlike the account-plane `/v1/capsule-projections` routes (snake_case wire
 * shape for identity/billing/export projections), the `/api/v1/*` routes
 * pass the deploy-control contract types through `JSON.stringify` UNCHANGED, so
 * the wire shape is the camelCase contract shape. The exported DTOs below are
 * the dashboard's local view-model mirrors of the deploy-control contract. The
 * type-only assertions near the mirror definitions ensure contract response
 * types remain assignable to the dashboard view models.
 */

import type {
  ActivityEvent as ContractActivityEvent,
  BackupRecord as ContractBackupRecord,
  Connection as ContractConnection,
  CreditReservation as ContractCreditReservation,
  Dependency as ContractDependency,
  InstallConfig as ContractInstallConfig,
  Capsule as ContractCapsule,
  CapsuleProviderConnectionSet as ContractCapsuleProviderConnectionSet,
  JsonValue as ContractJsonValue,
  OutputShare as ContractOutputShare,
  ProviderListing as ContractProviderListing,
  ProviderConnection as ContractProviderConnection,
  ProviderResolution as ContractProviderResolution,
  Run as ContractRun,
  RunCostInfo as ContractRunCostInfo,
  RunLogsResponse as ContractRunLogsResponse,
  Source as ContractSource,
  SourceSnapshot as ContractSourceSnapshot,
  Workspace as ContractWorkspace,
  UsageEvent as ContractUsageEvent,
} from "takosumi-contract";
import type { PublicDeployment as ContractPublicDeployment } from "takosumi-contract/deployments";

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
  ) {
    super(message);
    this.name = "ControlApiError";
  }

  /** True when the backend rejected because the Source has no synced snapshot. */
  get isSourceSyncRequired(): boolean {
    return (
      this.status === 409 &&
      (this.code === "source_sync_required" ||
        (this.code === "failed_precondition" &&
          /source_sync_required/u.test(this.message)))
    );
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

  /** True when creating a service hit the Workspace/name/environment guard. */
  get isDuplicateService(): boolean {
    return (
      this.reason === "duplicate_installation" ||
      (this.status === 409 &&
        /installation\s+.+\s+already exists/iu.test(this.message))
    );
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
const BILLING_PLANS_CACHE_TTL_MS = 60_000;
let billingPlansCache:
  | {
      readonly expiresAt: number;
      readonly plans: readonly PublicBillingPlan[];
    }
  | undefined;
let billingPlansRequest: Promise<readonly PublicBillingPlan[]> | undefined;

// ===========================================================================
// Wire shapes (local mirror of the deploy-control contract — see module header)
// ===========================================================================

export type WorkspaceType = "personal" | "organization";

export interface PolicyConfig {
  readonly allowedProviders?: readonly string[];
  readonly allowedResourceTypes?: readonly string[];
  readonly destructiveChanges?: {
    readonly requireExplicitConfirmation: boolean;
  };
  readonly scopeBoundary?: Readonly<Record<string, unknown>>;
  readonly quota?: Readonly<Record<string, number>>;
}

export interface Workspace {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
  readonly billingAccountId?: string;
  readonly billingSettings?: BillingSettings;
  readonly policy?: PolicyConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type BillingMode = "disabled" | "showback" | "enforce";
export type BillingProvider = "stripe" | "manual" | "none";

export type BillingSettings =
  | {
      readonly mode: "disabled";
      readonly provider: "none";
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "showback";
      readonly provider: BillingProvider;
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "enforce";
      readonly provider: Exclude<BillingProvider, "none">;
      readonly reservationRequired: true;
      readonly autoRecharge?: {
        readonly enabled: boolean;
        readonly thresholdUsdMicros: number;
        readonly rechargeUsdMicros: number;
        readonly monthlyLimitUsdMicros?: number;
      };
    };

export interface CreditBalance {
  readonly workspaceId: string;
  readonly availableUsdMicros?: number;
  readonly reservedUsdMicros?: number;
  readonly monthlyIncludedUsdMicros?: number;
  readonly purchasedUsdMicros?: number;
  readonly availableCredits: number;
  readonly reservedCredits: number;
  readonly monthlyIncludedCredits: number;
  readonly purchasedCredits: number;
  readonly updatedAt: string;
}

export interface CreditReservation {
  readonly id: string;
  // Rename convergence: contract carries both as optional during transition.
  readonly workspaceId?: string;
  readonly spaceId?: string;
  readonly runId: string;
  readonly estimatedCredits: number;
  readonly status: "reserved" | "captured" | "released" | "expired";
  readonly mode: BillingMode;
  readonly createdAt: string;
  readonly expiresAt: string;
}

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
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly serviceData?: {
    readonly objectKey: string;
    readonly digest: string;
    readonly sizeBytes: number;
    readonly exportedCount: number;
    readonly unsupportedCount: number;
    readonly missingCount: number;
  };
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

export type UsageEventKind =
  | "runner_minute"
  | "gateway_compute"
  | "gateway_storage_gb_hour"
  | "ai_request"
  | "ai_input_token"
  | "ai_output_token"
  | "artifact_storage_gb_hour"
  | "backup_storage_gb_hour"
  | "egress_gb"
  | "operation";

export interface UsageEvent {
  readonly id: string;
  // Rename convergence: contract carries both as optional during transition.
  readonly workspaceId?: string;
  readonly spaceId?: string;
  readonly capsuleId?: string;
  readonly runId?: string;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly usdMicros?: number;
  readonly credits: number;
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
  readonly balance?: CreditBalance;
}

export type TrustLevel = "official" | "trusted" | "space" | "raw";

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
  /** @deprecated Older rows used Deployment as the state-version ledger id. */
  readonly currentDeploymentId?: string;
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CapsuleProviderConnectionBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly connectionId: string;
  readonly region?: string;
}

export type CapsuleProviderConnectionBindings =
  readonly CapsuleProviderConnectionBinding[];

export interface CapsuleProviderConnectionSet {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly bindings: CapsuleProviderConnectionBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderResolution = ContractProviderResolution;

export interface InstallConfig {
  readonly id: string;
  readonly workspaceId?: string;
  readonly name: string;
  readonly sourceKind: "generic_capsule" | "first_party_capsule";
  readonly trustLevel: TrustLevel;
  readonly modulePath?: string;
  readonly catalog?: {
    readonly templateId?: string;
    readonly templateVersion?: string;
    readonly source?: {
      readonly git: string;
      readonly ref: string;
      readonly path: string;
    };
    readonly order: number;
    readonly surface: "service" | "building_block" | "example";
    readonly kind: "worker" | "storage" | "site";
    readonly provider: string;
    readonly suggestedName: string;
    readonly badge: { readonly ja: string; readonly en: string };
    readonly name: { readonly ja: string; readonly en: string };
    readonly description: { readonly ja: string; readonly en: string };
    readonly iconUrl?: string;
    readonly inputs: readonly {
      readonly name: string;
      readonly type?: "string" | "number" | "boolean" | "json";
      readonly required?: boolean;
      readonly advanced?: boolean;
      readonly secret?: boolean;
      readonly defaultValue?: string;
      readonly label: { readonly ja: string; readonly en: string };
      readonly helper?: { readonly ja: string; readonly en: string };
      readonly placeholder?: string;
    }[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

type OutputAllowlistEntry = ContractInstallConfig["outputAllowlist"][string];

export type DependencyMode =
  "remote_state" | "variable_injection" | "published_output";

export type DependencyVisibility = "space" | "cross_space";

export interface DependencyOutputMapping {
  readonly from: string;
  readonly to: string;
  readonly required: boolean;
  readonly type?: string;
}

export interface Dependency {
  readonly id: string;
  readonly workspaceId: string;
  // Rename convergence: contract keeps `producer/consumerInstallationId`
  // canonical, the `*CapsuleId` aliases optional. Read with `?? *InstallationId`.
  readonly producerCapsuleId?: string;
  readonly consumerCapsuleId?: string;
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
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
  readonly currentStateVersions: readonly PublicDeployment[];
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
    readonly cloudflareAccountId?: string;
    readonly cloudflareZoneId?: string;
    readonly awsAccountId?: string;
    readonly awsRegion?: string;
  };
}

export interface RunApplyExpectedGuard {
  readonly planId: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly resolvedProviderEnvBindingsDigest?: string;
}

export interface RunServiceDataRestoreResult {
  readonly status: "restored";
  readonly objectKey: string;
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
  readonly planArtifactKey?: string;
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

/**
 * `GET /api/v1/runs/:id/cost` projection (RunCostInfo). The public,
 * non-secret billing reservation values the controller already computed at plan
 * time, so the Run view can explain — BEFORE apply — why an apply would be
 * blocked under `enforce` mode (a USD balance shortfall or a billing-plan limit). It
 * carries no cost formula and no secret material.
 */
export interface RunCostInfo {
  readonly runId: string;
  /** The Workspace's billing mode at plan time. */
  readonly billingMode: "disabled" | "showback" | "enforce";
  /** USD amount the controller estimated this plan would consume on apply. */
  readonly estimatedUsdMicros: number;
  /** Available USD balance observed when a reservation was attempted. */
  readonly availableUsdMicros?: number;
  /** Missing USD micros (`estimated - available`) when positive. */
  readonly shortfallUsdMicros?: number;
  /** @deprecated Use estimatedUsdMicros. */
  readonly estimatedCredits: number;
  /** @deprecated Use availableUsdMicros. */
  readonly availableCredits?: number;
  /** `reserved` when credits were held; `insufficient_credits` when not. */
  readonly reservationStatus?: "reserved" | "insufficient_credits";
  /** @deprecated Use shortfallUsdMicros. */
  readonly creditShortfall?: number;
  /** True when billing blocks this plan from applying under `enforce` mode. */
  readonly blocked: boolean;
  /** Public-safe human reasons billing blocked the plan (empty when none). */
  readonly reasons: readonly string[];
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

export type SourceSnapshotOrigin = "git" | "upload" | "artifact";

export interface SourceSnapshot {
  readonly id: string;
  readonly origin: SourceSnapshotOrigin;
  readonly workspaceId: string;
  readonly sourceId?: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly archiveObjectKey: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

export type DeploymentStatus =
  "active" | "superseded" | "rolled_back" | "destroyed";

/**
 * Public projection of a Deployment as returned by the session control surface
 * (`GET /api/v1/capsules/:id/state-versions` and
 * `GET /api/v1/state-versions/:id`). The backend intentionally drops the raw
 * `outputSnapshotId` pointer and returns ONLY the allowlist-projected
 * `outputsPublic` map (sensitive outputs never enter the ledger row), so the
 * dashboard read never exposes a handle to the un-projected output envelope.
 * Mirror of `takosumi-contract/deployments.PublicDeployment` — the RETIRED
 * Deployment ledger deliberately keeps the legacy `spaceId` / `installationId`
 * field names (kept read-only for audit; not part of the 17-noun rename).
 */
export interface PublicDeployment {
  readonly id: string;
  readonly spaceId: string;
  readonly capsuleId?: string;
  readonly installationId: string;
  readonly environment: string;
  readonly applyRunId: string;
  readonly sourceSnapshotId: string;
  readonly dependencySnapshotId?: string;
  readonly stateGeneration: number;
  readonly outputsPublic: Readonly<Record<string, unknown>>;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
}

export interface OutputShareEntry {
  readonly name: string;
  readonly alias?: string;
  readonly sensitive: boolean;
}

export interface OutputShare {
  readonly id: string;
  // Rename convergence: contract keeps `from/toSpaceId` + `producerInstallationId`
  // canonical, the new aliases optional. Read with `?? <legacy>`.
  readonly fromWorkspaceId?: string;
  readonly toWorkspaceId?: string;
  readonly producerCapsuleId?: string;
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
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

export type ConnectionStatus =
  "pending" | "verified" | "revoked" | "expired" | "error";
export type ConnectionScopeKind = "operator" | "space";

export interface ConnectionScopeHints {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly workersSubdomain?: string;
  readonly managedProvider?: boolean;
  readonly providerBaseUrl?: string;
  readonly managedProviderProfile?: string;
  readonly awsRegion?: string;
  readonly gcpProjectId?: string;
  readonly gcpServiceAccountEmail?: string;
  readonly repoUrl?: string;
  readonly username?: string;
  readonly knownHostsEntry?: string;
  readonly templateId?: string;
}

export type ProviderConnectionMaterialization = "oauth" | "secret";

/**
 * Unified Provider Connection credential record (mirrors the collapsed contract
 * `ProviderConnection`). The former separate `Connection` / `ProviderConnection`
 * / `ProviderEnv` shapes are one row now; `Connection` is kept as an alias for
 * call sites that read the operator/workspace connection listing.
 */
export interface Connection {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider: string;
  readonly providerSource: string;
  readonly kind?: string;
  readonly scope: ConnectionScopeKind;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly materialization: ProviderConnectionMaterialization;
  readonly scopeHints?: ConnectionScopeHints;
  readonly envNames: readonly string[];
  readonly fileEnvNames?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
}

export type ProviderConnection = Connection;

export interface ProviderListing {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly requiredEnvGroups: readonly (readonly string[])[];
  readonly genericEnvSupported: boolean;
  readonly connectionKinds: readonly string[];
  readonly credentialRecipeIds: readonly string[];
  readonly allowedResources: readonly string[];
  readonly allowedDataSources: readonly string[];
  readonly docsUrl?: string;
}

export type CapsuleCompatibilityLevel =
  "ready" | "auto_capsulized" | "needs_patch" | "unsupported";

export interface CapsuleCompatibilityDiagnostic {
  readonly code?: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
  readonly path?: string;
}

export interface CapsuleCompatibilityProvider {
  readonly source: string;
  readonly versionConstraint?: string;
  readonly aliases: readonly string[];
  readonly allowed: boolean;
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
  AssertAssignable<PublicDeployment, ContractPublicDeployment>,
  AssertAssignable<OutputShare, ContractOutputShare>,
  AssertAssignable<ActivityEvent, ContractActivityEvent>,
  AssertAssignable<Connection, ContractConnection>,
  AssertAssignable<ProviderConnection, ContractProviderConnection>,
  AssertAssignable<ProviderListing, ContractProviderListing>,
  AssertAssignable<CreditReservation, ContractCreditReservation>,
  AssertAssignable<UsageEvent, ContractUsageEvent>,
  AssertAssignable<RunCostInfo, ContractRunCostInfo>,
  AssertAssignable<BackupRecord, ContractBackupRecord>,
  AssertAssignable<
    CapsuleProviderConnectionSet,
    ContractCapsuleProviderConnectionSet
  >,
];

// ===========================================================================
// Typed methods (one per route the dashboard calls)
// ===========================================================================

// --- Workspaces ----------------------------------------------------------------

// NOTE (rename convergence): the dashboard hits the account-plane control
// routes, which still emit the legacy `{ spaces } / { space } / { installation }`
// response envelope keys (and read legacy `spaceId` request-body keys). The
// reads below prefer the new `workspaces / workspace / capsule(s)` envelope key
// and fall back to the legacy key so the SPA works against both the pre- and
// post-convergence backend; the create bodies send both id keys for the same
// reason. Drop the legacy halves once the backend envelope/body keys converge.
type WorkspaceListEnvelope = {
  readonly workspaces?: readonly Workspace[];
  readonly spaces?: readonly Workspace[];
};
type WorkspaceEnvelope = {
  readonly workspace?: Workspace;
  readonly space?: Workspace;
};

export async function listWorkspaces(): Promise<readonly Workspace[]> {
  const body = await controlFetch<WorkspaceListEnvelope>(`${BASE}/workspaces`);
  return body.workspaces ?? body.spaces ?? [];
}

export async function getDashboardOverview(
  workspaceId?: string,
  options: { readonly includeWorkspaces?: boolean } = {},
): Promise<DashboardOverview> {
  return await controlFetch<DashboardOverview>(
    `${BASE}/dashboard/overview${query({
      workspaceId,
      includeWorkspaces: options.includeWorkspaces,
    })}`,
  );
}

export async function listWorkspacesIncludingArchived(): Promise<
  readonly Workspace[]
> {
  const body = await controlFetch<WorkspaceListEnvelope>(
    `${BASE}/workspaces${query({ includeArchived: "true" })}`,
  );
  return body.workspaces ?? body.spaces ?? [];
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
  return (body.workspace ?? body.space)!;
}

export async function getWorkspace(workspaceId: string): Promise<Workspace> {
  const body = await controlFetch<WorkspaceEnvelope>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  return (body.workspace ?? body.space)!;
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
  return (body.workspace ?? body.space)!;
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

export async function listWorkspaceCreditReservations(
  workspaceId: string,
): Promise<readonly CreditReservation[]> {
  const body = await controlFetch<{
    creditReservations?: readonly CreditReservation[];
  }>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/credit-reservations`,
  );
  return body.creditReservations ?? [];
}

// NOTE: top-up / subscription-change are operator mutations on the bearer-gated
// `/internal/v1` surface (spec §32: billing mode is operator-selected and USD
// balance enters through paid checkout). The session surface has no client fns
// for them on purpose.

/**
 * Public projection of one operator-offered billing plan
 * (`GET /api/v1/billing/plans`, spec §32). The server resolves the Stripe
 * price and internal usage allowance from `planId`; the public projection does
 * not expose Stripe ids or the subscription allowance amount.
 */
export interface PublicBillingPlan {
  readonly id: string;
  readonly kind: "subscription";
  readonly name: { readonly ja: string; readonly en: string };
  readonly priceDisplay: { readonly ja: string; readonly en: string };
}

export async function listBillingPlans(): Promise<
  readonly PublicBillingPlan[]
> {
  const now = Date.now();
  if (billingPlansCache && billingPlansCache.expiresAt > now) {
    return billingPlansCache.plans;
  }
  if (billingPlansRequest) return billingPlansRequest;
  billingPlansRequest = controlFetch<{
    plans?: readonly PublicBillingPlan[];
  }>(`${BASE}/billing/plans`)
    .then((body) => {
      const plans = body.plans ?? [];
      billingPlansCache = {
        expiresAt: Date.now() + BILLING_PLANS_CACHE_TTL_MS,
        plans,
      };
      return plans;
    })
    .finally(() => {
      billingPlansRequest = undefined;
    });
  return billingPlansRequest;
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
): Promise<readonly PublicDeployment[]> {
  const qs = query({
    ...(options.includeDestroyed === false
      ? { includeDestroyed: "false" }
      : {}),
  });
  return await fetchAllPages<PublicDeployment>(
    `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/current-state-versions${qs}`,
    (body) => (body.deployments as readonly PublicDeployment[]) ?? [],
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
  readonly vars?: Readonly<Record<string, ContractJsonValue>>;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly catalog?: NonNullable<InstallConfig["catalog"]>;
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
      ...(input.vars && Object.keys(input.vars).length > 0
        ? { vars: input.vars }
        : {}),
      ...(input.outputAllowlist && Object.keys(input.outputAllowlist).length > 0
        ? { outputAllowlist: input.outputAllowlist }
        : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
    },
  });
  return body.capsule;
}

export async function getCapsuleProviderConnectionSet(
  capsuleId: string,
): Promise<CapsuleProviderConnectionSet | null> {
  const body = await controlFetch<{
    providerConnectionSet: CapsuleProviderConnectionSet | null;
  }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/provider-connections`);
  return body.providerConnectionSet;
}

export async function putCapsuleProviderConnectionSet(
  capsuleId: string,
  connections: CapsuleProviderConnectionBindings,
): Promise<CapsuleProviderConnectionSet> {
  const body = await controlFetch<{
    providerConnectionSet: CapsuleProviderConnectionSet;
  }>(`${BASE}/capsules/${encodeURIComponent(capsuleId)}/provider-connections`, {
    method: "PUT",
    body: { connections },
  });
  return body.providerConnectionSet;
}

// --- Capsule configs -------------------------------------------------------

export const TEMPLATE_CATALOG_VIEW = "template-catalog" as const;

export type InstallConfigView = typeof TEMPLATE_CATALOG_VIEW;

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

export async function listTemplateCatalogInstallConfigs(
  workspaceId?: string,
): Promise<readonly InstallConfig[]> {
  return await listInstallConfigs(workspaceId, { view: TEMPLATE_CATALOG_VIEW });
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
  const body = await controlFetch<{
    report: {
      readonly id: string;
      readonly level: CapsuleCompatibilityLevel;
      readonly findings?: readonly {
        readonly severity?: "info" | "warning" | "error";
        readonly code?: string;
        readonly message?: string;
        readonly path?: string;
        readonly suggestion?: string;
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
    ...(finding.code ? { code: finding.code } : {}),
    message: finding.message ?? finding.code ?? "Compatibility finding",
    ...(finding.suggestion ? { detail: finding.suggestion } : {}),
    ...(finding.path ? { path: finding.path } : {}),
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
      // Legacy backend reads `installationId`; send both until converged.
      body: { ...input, installationId: input.capsuleId },
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
        // Legacy backend reads `producerInstallationId`; send both until converged.
        producerInstallationId: input.producerCapsuleId,
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
      // Legacy backend reads `spaceId`; send both until converged.
      spaceId: input.workspaceId,
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
  options: { readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/sync`,
    { method: "POST", signal: options.signal },
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
    lastSnapshots = await listSourceSnapshots(sourceId, {
      signal: options.signal,
    });
    const latest = [...lastSnapshots].sort((a, b) =>
      b.fetchedAt.localeCompare(a.fetchedAt),
    )[0];
    if (latest) return latest;

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
 * the estimated USD amount and any USD balance shortfall that would block the apply
 * under `enforce` mode. The values are the ones the controller already computed
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
 * the apply guard from the reviewed plan and re-checks every precondition; pass
 * `confirmDestructive: true` only after the operator has confirmed a destructive
 * plan. Returns the public Run wrapper.
 */
export async function createApplyRun(
  planRunId: string,
  input: {
    readonly confirmDestructive?: boolean;
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
        body: input.confirmDestructive ? { confirmDestructive: true } : {},
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

// --- Deployments -----------------------------------------------------------

/**
 * Lists an Capsule's Deployment ledger (current + past) for the dashboard
 * session (`GET /api/v1/capsules/:id/state-versions`). The backend
 * resolves the Capsule's owning Workspace and workspace-permission gates first;
 * each row carries only the allowlist-projected `outputsPublic` (no sensitive
 * outputs, no raw output-snapshot pointer). Rows arrive newest-first.
 */
export async function listDeployments(
  capsuleId: string,
): Promise<readonly PublicDeployment[]> {
  return await fetchAllPages<PublicDeployment>(
    `${BASE}/capsules/${encodeURIComponent(capsuleId)}/state-versions`,
    (body) => (body.deployments as readonly PublicDeployment[]) ?? [],
  );
}

/**
 * Reads one Deployment ledger record by id (`GET
 * /api/v1/state-versions/:id`). Workspace-permission gated server-side; the
 * returned record is the public projection (outputsPublic only, no
 * outputId, no sensitive values).
 */
export async function getDeployment(
  deploymentId: string,
): Promise<PublicDeployment> {
  const body = await controlFetch<{ deployment: PublicDeployment }>(
    `${BASE}/state-versions/${encodeURIComponent(deploymentId)}`,
  );
  return body.deployment;
}

/**
 * Creates a rollback PLAN run for a Deployment ("この状態に戻す" —
 * `POST /api/v1/state-versions/:id/rollback-plan`): re-plans the Deployment's
 * Capsule pinned to that Deployment's source snapshot. The plan then flows
 * through the normal approve -> apply path, so the response is the public Run
 * envelope (`{ run: { id, ... } }`) and the caller navigates to the Run
 * screen (extract the id with {@link extractRunId}).
 */
export async function createDeploymentRollbackPlan(
  deploymentId: string,
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/state-versions/${encodeURIComponent(deploymentId)}/rollback-plan`,
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
): Promise<readonly Connection[]> {
  const normalized = normalizedWorkspaceId(workspaceId);
  if (!normalized) return [];
  return await fetchAllPages<Connection>(
    `${BASE}/connections${query({ workspaceId: normalized })}`,
    (body) => (body.connections as readonly Connection[]) ?? [],
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
 * Registers a Workspace-owned provider-credential Connection. `values` are
 * write-only credential material (e.g. `{ CLOUDFLARE_API_TOKEN }`) and must be
 * cleared from caller memory immediately after this resolves; the returned
 * {@link Connection} projection carries no secret values. The backend forces
 * `scope: "space"`, so this creates only a Workspace-owned ProviderConnection.
 */
export async function createConnection(input: {
  readonly workspaceId: string;
  readonly provider: string;
  readonly kind?: string;
  readonly displayName?: string;
  readonly scopeHints?: ConnectionScopeHints;
  readonly values: Readonly<Record<string, string>>;
}): Promise<Connection> {
  const body = await controlFetch<{ connection: Connection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
        // Legacy backend reads `spaceId`; send both until converged.
        spaceId: input.workspaceId,
        provider: input.provider,
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
}): Promise<Connection> {
  const scopeHints: ConnectionScopeHints = {
    ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    ...(input.username ? { username: input.username } : {}),
  };
  const body = await controlFetch<{ connection: Connection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
        // Legacy backend reads `spaceId`; send both until converged.
        spaceId: input.workspaceId,
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
 * Re-verifies a Workspace-owned Connection's stored credential
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
 * Revokes a Workspace-owned Connection (`POST /api/v1/connections/:id/revoke`,
 * 204). The sealed credential blob is deleted server-side.
 */
export async function revokeConnection(connectionId: string): Promise<void> {
  await controlFetch<void>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/revoke`,
    { method: "POST" },
  );
}

export interface CloudflareOAuthStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
}

/**
 * Begins the OPTIONAL Cloudflare credential OAuth helper flow. Resolves with the
 * provider authorize URL the browser is sent to; the backend callback then
 * mints the Connection and redirects back to `/connections`. When the operator
 * has NOT wired the upstream OAuth client, the backend answers 501 — callers
 * detect this via {@link isOAuthUnavailable} and fall back to the guided-token
 * deep-link path (so no dead OAuth button is ever shown).
 */
export async function startCloudflareOAuth(input: {
  readonly workspaceId: string;
  readonly displayName?: string;
}): Promise<CloudflareOAuthStart> {
  return await controlFetch<CloudflareOAuthStart>(
    `${BASE}/connections/cloudflare/oauth/start`,
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
        // Legacy backend reads `spaceId`; send both until converged.
        spaceId: input.workspaceId,
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

// --- Providers -------------------------------------------------------------

export async function listProviderCatalogEntries(): Promise<
  readonly ProviderListing[]
> {
  const body = await controlFetch<{
    providers?: readonly ProviderListing[];
  }>(`${BASE}/providers`);
  return body.providers ?? [];
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
      // Legacy backend reads `fromSpaceId / toSpaceId / producerInstallationId`;
      // send both until converged.
      body: {
        ...input,
        fromSpaceId: input.fromWorkspaceId,
        toSpaceId: input.toWorkspaceId,
        producerInstallationId: input.producerCapsuleId,
      },
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
