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
 * Unlike the account-plane `/v1/installation-projections` routes (snake_case wire
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
  Installation as ContractInstallation,
  InstallationProviderConnectionSet as ContractInstallationProviderConnectionSet,
  OutputShare as ContractOutputShare,
  ProviderCatalogEntry as ContractProviderCatalogEntry,
  ProviderConnection as ContractProviderConnection,
  PublicDeployment as ContractPublicDeployment,
  Run as ContractRun,
  RunCostInfo as ContractRunCostInfo,
  RunLogsResponse as ContractRunLogsResponse,
  Source as ContractSource,
  SourceSnapshot as ContractSourceSnapshot,
  Space as ContractSpace,
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

function query(params: Record<string, string | number | undefined>): string {
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

export type SpaceType = "personal" | "organization";

export interface PolicyConfig {
  readonly allowedProviders?: readonly string[];
  readonly allowedResourceTypes?: readonly string[];
  readonly destructiveChanges?: {
    readonly requireExplicitConfirmation: boolean;
  };
  readonly scopeBoundary?: Readonly<Record<string, unknown>>;
  readonly quota?: Readonly<Record<string, number>>;
}

export interface Space {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: SpaceType;
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
    };

export interface CreditBalance {
  readonly spaceId: string;
  readonly availableCredits: number;
  readonly reservedCredits: number;
  readonly monthlyIncludedCredits: number;
  readonly purchasedCredits: number;
  readonly updatedAt: string;
}

export interface CreditReservation {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string;
  readonly estimatedCredits: number;
  readonly status: "reserved" | "captured" | "released" | "expired";
  readonly mode: BillingMode;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BackupRecord {
  readonly id: string;
  readonly spaceId: string;
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
  | "artifact_storage_gb_hour"
  | "backup_storage_gb_hour"
  | "egress_gb"
  | "operation";

export interface UsageEvent {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly runId?: string;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly credits: number;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface SpaceBilling {
  readonly settings: BillingSettings;
  readonly balance?: CreditBalance;
}

export type TrustLevel = "official" | "trusted" | "space" | "raw";

export type InstallationStatus =
  | "pending"
  | "active"
  | "stale"
  | "error"
  | "disabled"
  | "destroyed";

export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly sourceId?: string;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentDeploymentId?: string;
  readonly currentStateGeneration: number;
  readonly status: InstallationStatus;
  /**
   * Read-time DERIVED freshness relative to producer Dependencies (spec §24).
   * Newer backends stop STORING `status: "stale"` and surface this field
   * instead; older backends omit it. Views must treat
   * `status === "stale" || freshness === "stale"` as the stale presentation
   * (see `effectiveInstallationStatus` in installations-ui.ts) so the
   * dashboard renders correctly against both.
   */
  readonly freshness?: "fresh" | "stale";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstallationProviderConnectionBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly connectionId: string;
  readonly region?: string;
}

export type InstallationProviderConnectionBindings =
  readonly InstallationProviderConnectionBinding[];

export interface InstallationProviderConnectionSet {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly connections: InstallationProviderConnectionBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
  readonly sourceKind: "generic_capsule" | "first_party_capsule";
  readonly trustLevel: TrustLevel;
  readonly modulePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DependencyMode =
  | "remote_state"
  | "variable_injection"
  | "published_output";

export type DependencyVisibility = "space" | "cross_space";

export interface DependencyOutputMapping {
  readonly from: string;
  readonly to: string;
  readonly required: boolean;
  readonly type?: string;
}

export interface Dependency {
  readonly id: string;
  readonly spaceId: string;
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
  readonly mode: DependencyMode;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
  readonly visibility: DependencyVisibility;
  readonly createdAt: string;
}

/** `GET /api/v1/spaces/:id/graph` projection. */
export interface SpaceGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphNode {
  readonly installationId: string;
  readonly name: string;
  readonly environment: string;
  readonly status: InstallationStatus;
}

export interface GraphEdge {
  readonly id: string;
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
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

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactKey?: string;
  readonly policyStatus?: RunPolicyStatus;
  readonly requiresApproval?: boolean;
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
 * blocked under `enforce` mode (a credit shortfall or a billing-plan limit). It
 * carries no cost formula and no secret material.
 */
export interface RunCostInfo {
  readonly runId: string;
  /** The Space's billing mode at plan time. */
  readonly billingMode: "disabled" | "showback" | "enforce";
  /** Credits the controller estimated this plan would consume on apply. */
  readonly estimatedCredits: number;
  /** Available credit balance observed when a reservation was attempted. */
  readonly availableCredits?: number;
  /** `reserved` when credits were held; `insufficient_credits` when not. */
  readonly reservationStatus?: "reserved" | "insufficient_credits";
  /** Missing credits (`estimated - available`) when positive. */
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
    readonly spaceId: string;
    readonly status?: RunGroupStatus;
    readonly type?: string;
  };
  readonly runs: readonly Run[];
}

export interface Source {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef: string;
  readonly defaultPath: string;
  readonly authConnectionId?: string;
  readonly status: "active" | "disabled" | "error";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SourceSnapshotOrigin = "git" | "upload";

export interface SourceSnapshot {
  readonly id: string;
  readonly origin: SourceSnapshotOrigin;
  readonly spaceId: string;
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
  | "active"
  | "superseded"
  | "rolled_back"
  | "destroyed";

/**
 * Public projection of a Deployment as returned by the session control surface
 * (`GET /api/v1/installations/:id/deployments` and
 * `GET /api/v1/deployments/:id`). The backend intentionally drops the raw
 * `outputSnapshotId` pointer and returns ONLY the allowlist-projected
 * `outputsPublic` map (sensitive outputs never enter the ledger row), so the
 * dashboard read never exposes a handle to the un-projected output envelope.
 * Mirror of `takosumi-contract/deployments.PublicDeployment`.
 */
export interface PublicDeployment {
  readonly id: string;
  readonly spaceId: string;
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
  readonly spaceId: string;
  readonly actorId?: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly runId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export type ConnectionStatus =
  | "pending"
  | "verified"
  | "revoked"
  | "expired"
  | "error";
export type ConnectionScopeKind = "operator" | "space";

export interface Connection {
  readonly id: string;
  readonly spaceId?: string;
  readonly provider: string;
  readonly kind?: string;
  readonly credentialDriver?: string;
  readonly scope: ConnectionScopeKind;
  readonly authMethod: string;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly envNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
}

export type ProviderEnvMaterialization = "oauth" | "secret";
export type ProviderConnectionStatus =
  | "ready"
  | "needs_setup"
  | "expired"
  | "blocked";
export type ProviderCredentialOwnership = "own_key" | "takos_provided";

export interface ProviderConnection {
  readonly id: string;
  readonly spaceId?: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly ownership: ProviderCredentialOwnership;
  readonly status: ProviderConnectionStatus;
  readonly requiredEnvNames: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly helpers: readonly string[];
  readonly ownershipOptions: readonly ProviderCredentialOwnership[];
  readonly allowedResources: readonly string[];
  readonly allowedDataSources: readonly string[];
  readonly policyPackId?: string;
  readonly costEstimatorId?: string;
  readonly docsUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CapsuleCompatibilityLevel =
  | "ready"
  | "auto_capsulized"
  | "needs_patch"
  | "unsupported";

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
  readonly ownershipOptions: readonly ProviderCredentialOwnership[];
}

export interface CapsuleCompatibilityResource {
  readonly type: string;
  readonly count?: number;
  readonly allowed: boolean;
}

export interface CapsuleCompatibilityResult {
  readonly level: CapsuleCompatibilityLevel;
  readonly summary: string;
  readonly diagnostics: readonly CapsuleCompatibilityDiagnostic[];
  readonly providers: readonly CapsuleCompatibilityProvider[];
  readonly resources: readonly CapsuleCompatibilityResource[];
  readonly installConfigId?: string;
  readonly sourceId?: string;
  readonly source?: "api";
}

type AssertAssignable<Expected, Actual extends Expected> = true;

type _ContractResponseAssignableToDashboardMirrors = [
  AssertAssignable<Space, ContractSpace>,
  AssertAssignable<Installation, ContractInstallation>,
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
  AssertAssignable<ProviderCatalogEntry, ContractProviderCatalogEntry>,
  AssertAssignable<CreditReservation, ContractCreditReservation>,
  AssertAssignable<UsageEvent, ContractUsageEvent>,
  AssertAssignable<RunCostInfo, ContractRunCostInfo>,
  AssertAssignable<BackupRecord, ContractBackupRecord>,
  AssertAssignable<
    InstallationProviderConnectionSet,
    ContractInstallationProviderConnectionSet
  >,
];

// ===========================================================================
// Typed methods (one per route the dashboard calls)
// ===========================================================================

// --- Spaces ----------------------------------------------------------------

export async function listSpaces(): Promise<readonly Space[]> {
  const body = await controlFetch<{ spaces?: readonly Space[] }>(
    `${BASE}/spaces`,
  );
  return body.spaces ?? [];
}

export async function createSpace(input: {
  readonly handle: string;
  readonly displayName?: string;
  readonly type?: SpaceType;
}): Promise<Space> {
  const body = await controlFetch<{ space: Space }>(`${BASE}/spaces`, {
    method: "POST",
    body: {
      handle: input.handle,
      displayName: input.displayName ?? input.handle,
      type: input.type ?? "personal",
    },
  });
  return body.space;
}

export async function getSpace(spaceId: string): Promise<Space> {
  const body = await controlFetch<{ space: Space }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}`,
  );
  return body.space;
}

export async function updateSpace(
  spaceId: string,
  input: {
    readonly displayName?: string;
    readonly policy?: PolicyConfig;
  },
): Promise<Space> {
  const body = await controlFetch<{ space: Space }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}`,
    { method: "PATCH", body: input },
  );
  return body.space;
}

export async function getSpaceBilling(spaceId: string): Promise<SpaceBilling> {
  const body = await controlFetch<{ billing: SpaceBilling }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/billing`,
  );
  return body.billing;
}

export async function listSpaceUsage(
  spaceId: string,
): Promise<readonly UsageEvent[]> {
  return await fetchAllPages<UsageEvent>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/usage`,
    (body) => (body.usageEvents as readonly UsageEvent[]) ?? [],
  );
}

export async function listSpaceCreditReservations(
  spaceId: string,
): Promise<readonly CreditReservation[]> {
  const body = await controlFetch<{
    creditReservations?: readonly CreditReservation[];
  }>(`${BASE}/spaces/${encodeURIComponent(spaceId)}/credit-reservations`);
  return body.creditReservations ?? [];
}

// NOTE: top-up / subscription-change are operator mutations on the bearer-gated
// `/internal/v1` surface (spec §32: billing mode is operator-selected and
// credits enter through paid checkout). The session surface has no client fns
// for them on purpose.

/**
 * Public projection of one operator-offered billing plan
 * (`GET /api/v1/billing/plans`, spec §32). `kind: "subscription"` grants
 * `credits` per paid invoice; `kind: "pack"` grants once per purchase. Carries
 * no Stripe price id — checkout is started by `planId` and the server resolves
 * the price.
 */
export interface PublicBillingPlan {
  readonly id: string;
  readonly kind: "subscription" | "pack";
  readonly credits: number;
  readonly name: { readonly ja: string; readonly en: string };
  readonly priceDisplay: { readonly ja: string; readonly en: string };
}

export async function listBillingPlans(): Promise<
  readonly PublicBillingPlan[]
> {
  const body = await controlFetch<{
    plans?: readonly PublicBillingPlan[];
  }>(`${BASE}/billing/plans`);
  return body.plans ?? [];
}

// --- Members (Space membership / roles) ------------------------------------
//
// Backs the Members screen over the session-authed
// `/api/v1/spaces/:id/members[/:subject]` routes (see
// accounts/service/src/control-routes.ts). The Space is resolved
// server-side and the membership-ROLE gate is enforced by the backend
// (list = any active member; add/invite = owner/admin; role change + remove =
// owner-only with a last-owner guard). These client fns never send the spaceId
// in a body — it is always a path segment the server re-resolves and gates.

export type ControlSpaceRole = "owner" | "admin" | "member" | "viewer";
export type ControlMembershipStatus = "active" | "invited" | "suspended";

/**
 * Public projection of one Space membership (mirror of the deploy-control
 * `PublicSpaceMember`). `accountId` is the member's account subject — the same
 * value the session `/v1/account/session/me` returns for the signed-in caller —
 * so the view can match the caller against the roster to decide which mutation
 * controls to show. Carries no credential / email / PII beyond the handle.
 */
export interface PublicSpaceMember {
  readonly id: string;
  readonly spaceId: string;
  readonly accountId: string;
  readonly roles: readonly ControlSpaceRole[];
  readonly status: ControlMembershipStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Lists a Space's members (`GET /api/v1/spaces/:id/members`). Any active
 * member of the Space may read the roster; the backend gates this server-side.
 */
export async function listMembers(
  spaceId: string,
): Promise<readonly PublicSpaceMember[]> {
  const body = await controlFetch<{ members?: readonly PublicSpaceMember[] }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/members`,
  );
  return body.members ?? [];
}

/**
 * Adds (or re-activates) a member by account subject
 * (`POST /api/v1/spaces/:id/members`). The membership domain has no email
 * invite / notification side-channel, so this adds an EXISTING account handle /
 * subject directly as an active member. Owner/admin only; only an owner may
 * grant `role: "owner"` (the backend rejects an admin doing so with 403).
 */
export async function inviteMember(
  spaceId: string,
  input: {
    readonly accountId: string;
    readonly role?: ControlSpaceRole;
  },
): Promise<PublicSpaceMember> {
  const body = await controlFetch<{ member: PublicSpaceMember }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/members`,
    {
      method: "POST",
      body: {
        accountId: input.accountId,
        ...(input.role ? { role: input.role } : {}),
      },
    },
  );
  return body.member;
}

/**
 * Changes a member's role set (`PATCH /api/v1/spaces/:id/members/:subject`).
 * Owner-only. The backend's last-owner guard rejects demoting the sole
 * remaining owner with 403, so a Space is never left unmanaged.
 */
export async function setMemberRole(
  spaceId: string,
  subject: string,
  roles: ControlSpaceRole | readonly ControlSpaceRole[],
): Promise<PublicSpaceMember> {
  const body = await controlFetch<{ member: PublicSpaceMember }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(subject)}`,
    { method: "PATCH", body: { roles } },
  );
  return body.member;
}

/**
 * Removes a member (`DELETE /api/v1/spaces/:id/members/:subject`).
 * Owner-only. The membership store has no hard delete, so the backend soft-
 * removes (sets `status: "suspended"`) and returns the updated projection. The
 * last-owner guard rejects removing the sole remaining owner with 403.
 */
export async function removeMember(
  spaceId: string,
  subject: string,
): Promise<PublicSpaceMember> {
  const body = await controlFetch<{ member: PublicSpaceMember }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(subject)}`,
    { method: "DELETE" },
  );
  return body.member;
}

// --- Installations ---------------------------------------------------------

export async function listInstallations(
  spaceId: string,
): Promise<readonly Installation[]> {
  return await fetchAllPages<Installation>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/installations`,
    (body) => (body.installations as readonly Installation[]) ?? [],
  );
}

export async function getInstallation(id: string): Promise<Installation> {
  const body = await controlFetch<{ installation: Installation }>(
    `${BASE}/installations/${encodeURIComponent(id)}`,
  );
  return body.installation;
}

export async function createInstallation(input: {
  readonly spaceId: string;
  readonly name: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly installConfigId: string;
}): Promise<Installation> {
  const body = await controlFetch<{ installation: Installation }>(
    `${BASE}/spaces/${encodeURIComponent(input.spaceId)}/installations`,
    {
      method: "POST",
      body: {
        name: input.name,
        environment: input.environment,
        sourceId: input.sourceId,
        installConfigId: input.installConfigId,
      },
    },
  );
  return body.installation;
}

export async function getInstallationProviderConnectionSet(
  installationId: string,
): Promise<InstallationProviderConnectionSet | null> {
  const body = await controlFetch<{
    providerConnectionSet: InstallationProviderConnectionSet | null;
  }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/provider-connections`,
  );
  return body.providerConnectionSet;
}

export async function putInstallationProviderConnectionSet(
  installationId: string,
  connections: InstallationProviderConnectionBindings,
): Promise<InstallationProviderConnectionSet> {
  const body = await controlFetch<{
    providerConnectionSet: InstallationProviderConnectionSet;
  }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/provider-connections`,
    { method: "PUT", body: { connections } },
  );
  return body.providerConnectionSet;
}

// --- InstallConfigs --------------------------------------------------------

export async function listInstallConfigs(
  spaceId?: string,
): Promise<readonly InstallConfig[]> {
  return await fetchAllPages<InstallConfig>(
    `${BASE}/install-configs${query({ spaceId })}`,
    (body) => (body.installConfigs as readonly InstallConfig[]) ?? [],
  );
}

// --- OpenTofu Capsule compatibility ---------------------------------------

export async function checkCapsuleCompatibility(input: {
  readonly spaceId: string;
  readonly sourceId?: string;
  readonly gitUrl: string;
  readonly ref: string;
  readonly path: string;
  readonly name: string;
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
        spaceId: input.spaceId,
        name: input.name,
        url: input.gitUrl,
        defaultRef: input.ref,
        defaultPath: input.path,
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
        readonly ownershipOptions?: readonly ProviderCredentialOwnership[];
      }[];
    };
  }>(`${BASE}/sources/${encodeURIComponent(sourceId)}/compatibility-check`, {
    method: "POST",
    body: {
      sourceSnapshotId: snapshot.id,
      // Gate the pre-install check against the selected InstallConfig's policy
      // when one is supplied (the install view passes the Space's resolved
      // profile), otherwise fall back to the instance-wide default policy.
      ...(input.installConfigId
        ? { installConfigId: input.installConfigId }
        : {}),
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
      ownershipOptions: provider.ownershipOptions ?? ["own_key"],
    }));
  return {
    level: body.report.level,
    summary:
      diagnostics[0]?.message ??
      "Compatibility check completed for the synced SourceSnapshot.",
    diagnostics,
    providers,
    resources: [],
    ...(input.installConfigId
      ? { installConfigId: input.installConfigId }
      : {}),
    sourceId,
    source: "api",
  };
}

// --- Graph -----------------------------------------------------------------

export async function getSpaceGraph(spaceId: string): Promise<SpaceGraph> {
  return await controlFetch<SpaceGraph>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/graph`,
  );
}

// --- Backups ---------------------------------------------------------------

export async function createSpaceBackup(
  spaceId: string,
): Promise<BackupRecord> {
  const body = await controlFetch<{ backup: BackupRecord }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/backups`,
    { method: "POST" },
  );
  return body.backup;
}

export async function createInstallationBackup(
  installationId: string,
): Promise<BackupRecord> {
  const body = await controlFetch<{ backup: BackupRecord }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/backups`,
    { method: "POST" },
  );
  return body.backup;
}

export async function listSpaceBackups(
  spaceId: string,
): Promise<readonly BackupRecord[]> {
  return await fetchAllPages<BackupRecord>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/backups`,
    (body) => (body.backups as readonly BackupRecord[]) ?? [],
  );
}

// --- Dependencies ----------------------------------------------------------

export async function createDependency(
  consumerInstallationId: string,
  input: {
    readonly producerInstallationId: string;
    readonly mode?: DependencyMode;
    readonly outputs?: Readonly<Record<string, DependencyOutputMapping>>;
    readonly visibility?: DependencyVisibility;
  },
): Promise<Dependency> {
  const body = await controlFetch<{ dependency: Dependency }>(
    `${BASE}/installations/${encodeURIComponent(consumerInstallationId)}/dependencies`,
    {
      method: "POST",
      body: {
        producerInstallationId: input.producerInstallationId,
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
  spaceId: string,
  limit?: number,
): Promise<readonly ActivityEvent[]> {
  const body = await controlFetch<{ events?: readonly ActivityEvent[] }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/activity${query({ limit })}`,
  );
  return body.events ?? [];
}

// --- Sources ---------------------------------------------------------------

export async function listSources(spaceId: string): Promise<readonly Source[]> {
  return await fetchAllPages<Source>(
    `${BASE}/sources${query({ spaceId })}`,
    (body) => (body.sources as readonly Source[]) ?? [],
  );
}

export interface CreateSourceResult {
  readonly source: Source;
  readonly hookSecret: string;
}

export async function createSource(input: {
  readonly spaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
}): Promise<CreateSourceResult> {
  return await controlFetch<CreateSourceResult>(`${BASE}/sources`, {
    method: "POST",
    body: {
      spaceId: input.spaceId,
      name: input.name,
      url: input.url,
      ...(input.defaultRef ? { defaultRef: input.defaultRef } : {}),
      ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
      ...(input.authConnectionId
        ? { authConnectionId: input.authConnectionId }
        : {}),
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
        throw new ControlApiError(
          409,
          "source_sync_failed",
          run.errorCode
            ? `Source sync ${run.status}: ${run.errorCode}`
            : `Source sync ${run.status}.`,
          { run, snapshots: lastSnapshots },
        );
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

// --- Runs ------------------------------------------------------------------

/** Create a plan run for an Installation. Returns the opaque Run envelope. */
export async function planInstallation(
  installationId: string,
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/plan`,
    { method: "POST" },
  );
}

export async function destroyPlanInstallation(
  installationId: string,
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/destroy-plan`,
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

export async function getRunLogs(id: string): Promise<RunLogs> {
  return await controlFetch<RunLogs>(
    `${BASE}/runs/${encodeURIComponent(id)}/logs`,
  );
}

/**
 * Reads a plan / destroy_plan Run's public cost projection (`GET
 * /api/v1/runs/:id/cost`). Used by the Run view to surface, before apply,
 * the estimated credits and any credit shortfall that would block the apply
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
  input: { readonly confirmDestructive?: boolean } = {},
): Promise<{ readonly run: Run }> {
  return await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(planRunId)}/apply`,
    {
      method: "POST",
      body: input.confirmDestructive ? { confirmDestructive: true } : {},
    },
  );
}

// --- Deployments -----------------------------------------------------------

/**
 * Lists an Installation's Deployment ledger (current + past) for the dashboard
 * session (`GET /api/v1/installations/:id/deployments`). The backend
 * resolves the Installation's owning Space and space-permission gates first;
 * each row carries only the allowlist-projected `outputsPublic` (no sensitive
 * outputs, no raw output-snapshot pointer). Rows arrive newest-first.
 */
export async function listDeployments(
  installationId: string,
): Promise<readonly PublicDeployment[]> {
  return await fetchAllPages<PublicDeployment>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/deployments`,
    (body) => (body.deployments as readonly PublicDeployment[]) ?? [],
  );
}

/**
 * Reads one Deployment ledger record by id (`GET
 * /api/v1/deployments/:id`). Space-permission gated server-side; the
 * returned record is the public projection (outputsPublic only, no
 * outputSnapshotId, no sensitive values).
 */
export async function getDeployment(
  deploymentId: string,
): Promise<PublicDeployment> {
  const body = await controlFetch<{ deployment: PublicDeployment }>(
    `${BASE}/deployments/${encodeURIComponent(deploymentId)}`,
  );
  return body.deployment;
}

/**
 * Creates a rollback PLAN run for a Deployment ("この状態に戻す" —
 * `POST /api/v1/deployments/:id/rollback-plan`): re-plans the Deployment's
 * Installation pinned to that Deployment's source snapshot. The plan then flows
 * through the normal approve -> apply path, so the response is the public Run
 * envelope (`{ run: { id, ... } }`) and the caller navigates to the Run
 * screen (extract the id with {@link extractRunId}).
 */
export async function createDeploymentRollbackPlan(
  deploymentId: string,
): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/deployments/${encodeURIComponent(deploymentId)}/rollback-plan`,
    { method: "POST" },
  );
}

// --- RunGroups -------------------------------------------------------------

export async function createSpacePlanUpdate(
  spaceId: string,
): Promise<RunGroupWithRuns> {
  return await controlFetch<RunGroupWithRuns>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/plan-update`,
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

export async function listConnections(
  spaceId: string,
): Promise<readonly Connection[]> {
  return await fetchAllPages<Connection>(
    `${BASE}/connections${query({ spaceId })}`,
    (body) => (body.connections as readonly Connection[]) ?? [],
  );
}

export async function listProviderConnections(
  spaceId: string,
): Promise<readonly ProviderConnection[]> {
  const body = await controlFetch<{
    providerConnections?: readonly ProviderConnection[];
  }>(`${BASE}/provider-connections${query({ spaceId })}`);
  return body.providerConnections ?? [];
}

/**
 * Registers a Space-owned provider-credential Connection. `values` are
 * write-only credential material (e.g. `{ CLOUDFLARE_API_TOKEN }`) and must be
 * cleared from caller memory immediately after this resolves; the returned
 * {@link Connection} projection carries no secret values. The backend forces
 * `scope: "space"`, so this creates only a Space-owned ProviderConnection.
 */
export async function createConnection(input: {
  readonly spaceId: string;
  readonly provider: string;
  readonly displayName?: string;
  readonly scopeHints?: { readonly accountId?: string };
  readonly values: Readonly<Record<string, string>>;
}): Promise<Connection> {
  const body = await controlFetch<{ connection: Connection }>(
    `${BASE}/connections`,
    {
      method: "POST",
      body: {
        spaceId: input.spaceId,
        provider: input.provider,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
        values: input.values,
      },
    },
  );
  return body.connection;
}

/**
 * Re-verifies a Space-owned Connection's stored credential
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
 * Revokes a Space-owned Connection (`POST /api/v1/connections/:id/revoke`,
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
  readonly spaceId: string;
  readonly displayName?: string;
}): Promise<CloudflareOAuthStart> {
  return await controlFetch<CloudflareOAuthStart>(
    `${BASE}/connections/cloudflare/oauth/start`,
    {
      method: "POST",
      body: {
        spaceId: input.spaceId,
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
  readonly ProviderCatalogEntry[]
> {
  const body = await controlFetch<{
    providers?: readonly ProviderCatalogEntry[];
  }>(`${BASE}/providers`);
  return body.providers ?? [];
}

// --- OutputShares ----------------------------------------------------------

export async function listOutputShares(
  spaceId: string,
): Promise<readonly OutputShare[]> {
  return await fetchAllPages<OutputShare>(
    `${BASE}/output-shares${query({ spaceId })}`,
    (body) => (body.shares as readonly OutputShare[]) ?? [],
  );
}

export async function createOutputShare(input: {
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
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
