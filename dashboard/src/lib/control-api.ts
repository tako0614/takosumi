/**
 * Typed client for the account-plane `/v1/control/*` route family (spec §31 UI
 * backing surface, conformance M10).
 *
 * The dashboard SPA authenticates with the ACCOUNTS-plane HttpOnly
 * `takosumi_session` cookie, NOT the operator deploy-control bearer. The §30
 * `/api` deploy-control surface stays operator-bearer-gated; this client talks
 * same-origin to the NEW session-authed `/v1/control/*` pass-through routes
 * (see packages/accounts-service/src/control-routes.ts), which call the
 * in-process operations facade and render the deploy-control contract types.
 *
 * Unlike the legacy account-plane `/v1/installations` routes (snake_case wire
 * shape — see views/account/lib/installations.ts), the `/v1/control/*` routes
 * pass the deploy-control contract types through `JSON.stringify` UNCHANGED, so
 * the wire shape is the camelCase contract shape. The type mirrors below are a
 * local copy of the relevant contract fields: the dashboard build only aliases
 * `@takosjp/takosumi-accounts-contract`, not `takosumi-contract/*`, so we cannot
 * import the deploy-control contract types directly here. Keep these in sync
 * with packages/schema/src/{spaces,installations,dependencies,runs,sources,
 * activity,deploy-control-api,provider-bindings}.ts.
 */

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
        this.code === "failed_precondition")
    );
  }
}

interface RequestOpts {
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
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
    const deployControlError = (data as {
      error?: { code?: string; message?: string };
    } | undefined)?.error;
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

const BASE = "/v1/control";

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
  | "managed_compute"
  | "managed_storage_gb_hour"
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
  readonly sourceId: string;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentDeploymentId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputSnapshotId?: string;
  readonly status: InstallationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderBindingMode =
  | "default"
  | "connection"
  | "manual"
  | "disabled";

export interface ProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly mode: ProviderBindingMode;
  readonly connectionId?: string;
  readonly region?: string;
  readonly values?: Readonly<Record<string, unknown>>;
}

export type ProviderBindings = readonly ProviderBinding[];

export interface DeploymentProfile {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly bindings: ProviderBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
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

/** `GET /v1/control/spaces/:id/graph` projection. */
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
  readonly errorCode?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface RunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface RunAuditEvent {
  readonly type?: string;
  readonly at?: number;
  readonly message?: string;
  readonly detail?: unknown;
  readonly [key: string]: unknown;
}

/** `GET /v1/control/runs/:id/logs` body (RunLogsResponse). */
export interface RunLogs {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly RunAuditEvent[];
}

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

/** `GET|POST /v1/control/run-groups/:id` body (RunGroupWithRuns projection). */
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

export interface SourceSnapshot {
  readonly id: string;
  readonly sourceId: string;
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
 * (`GET /v1/control/installations/:id/deployments` and
 * `GET /v1/control/deployments/:id`). The backend intentionally drops the raw
 * `outputSnapshotId` pointer and returns ONLY the allowlist-projected
 * `outputsPublic` map (sensitive outputs never enter the ledger row), so the
 * dashboard read never exposes a handle to the un-projected output envelope.
 * Mirror of the deploy-control `PublicDeployment` (Omit<Deployment,
 * "outputSnapshotId">) — keep in sync with packages/schema/src/deployments.ts.
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

export interface OperatorConnectionDefault {
  readonly id: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderCredentialSource = "takosumi_managed" | "user_env_set";

export interface ProviderTemplate {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly helpers: readonly string[];
  readonly credentialSources: readonly ProviderCredentialSource[];
  readonly takosumiManagedAvailable: boolean;
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
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface CapsuleCompatibilityResult {
  readonly level: CapsuleCompatibilityLevel;
  readonly summary: string;
  readonly diagnostics: readonly CapsuleCompatibilityDiagnostic[];
  readonly installConfigId?: string;
  readonly sourceId?: string;
  readonly source?: "api";
}

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
  const body = await controlFetch<{ usageEvents?: readonly UsageEvent[] }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/usage`,
  );
  return body.usageEvents ?? [];
}

export async function listSpaceCreditReservations(
  spaceId: string,
): Promise<readonly CreditReservation[]> {
  const body = await controlFetch<{
    creditReservations?: readonly CreditReservation[];
  }>(`${BASE}/spaces/${encodeURIComponent(spaceId)}/credit-reservations`);
  return body.creditReservations ?? [];
}

export async function topUpSpaceCredits(
  spaceId: string,
  credits: number,
): Promise<CreditBalance> {
  const body = await controlFetch<{ balance: CreditBalance }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/credits/top-up`,
    { method: "POST", body: { credits } },
  );
  return body.balance;
}

export async function changeSpaceSubscription(
  spaceId: string,
  billingSettings: BillingSettings,
): Promise<SpaceBilling> {
  const body = await controlFetch<{ billing: SpaceBilling }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/subscription/change`,
    { method: "POST", body: { billingSettings } },
  );
  return body.billing;
}

// --- Installations ---------------------------------------------------------

export async function listInstallations(
  spaceId: string,
): Promise<readonly Installation[]> {
  const body = await controlFetch<{ installations?: readonly Installation[] }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/installations`,
  );
  return body.installations ?? [];
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

export async function getDeploymentProfile(
  installationId: string,
): Promise<DeploymentProfile | null> {
  const body = await controlFetch<{
    deploymentProfile: DeploymentProfile | null;
  }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/deployment-profile`,
  );
  return body.deploymentProfile;
}

export async function putDeploymentProfile(
  installationId: string,
  bindings: ProviderBindings,
): Promise<DeploymentProfile> {
  const body = await controlFetch<{ deploymentProfile: DeploymentProfile }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/deployment-profile`,
    { method: "PUT", body: { bindings } },
  );
  return body.deploymentProfile;
}

// --- InstallConfigs --------------------------------------------------------

export async function listInstallConfigs(
  spaceId?: string,
): Promise<readonly InstallConfig[]> {
  const body = await controlFetch<{
    installConfigs?: readonly InstallConfig[];
  }>(`${BASE}/install-configs${query({ spaceId })}`);
  return body.installConfigs ?? [];
}

// --- OpenTofu Capsule compatibility ---------------------------------------

export async function checkCapsuleCompatibility(input: {
  readonly spaceId: string;
  readonly gitUrl: string;
  readonly ref: string;
  readonly path: string;
  readonly name: string;
  readonly installConfigId?: string;
}): Promise<CapsuleCompatibilityResult> {
  const { source } = await createSource({
    spaceId: input.spaceId,
    name: input.name,
    url: input.gitUrl,
    defaultRef: input.ref,
    defaultPath: input.path,
  });
  await syncSource(source.id);
  const snapshot = await waitForLatestSourceSnapshot(source.id);
  const body = await controlFetch<{
    report: {
      readonly level: CapsuleCompatibilityLevel;
      readonly findings?: readonly {
        readonly severity?: "info" | "warning" | "error";
        readonly code?: string;
        readonly message?: string;
        readonly suggestion?: string;
      }[];
    };
  }>(`${BASE}/sources/${encodeURIComponent(source.id)}/compatibility-check`, {
    method: "POST",
    body: {
      sourceSnapshotId: snapshot.id,
      // Gate the pre-install check against the curated InstallConfig's bounded
      // policy (catalog deep-link path) so a vetted first-party module is judged
      // by its own minimal allowlist, not only the instance-wide default.
      ...(input.installConfigId
        ? { installConfigId: input.installConfigId }
        : {}),
    },
  });
  const diagnostics = (body.report.findings ?? []).map((finding) => ({
    severity: finding.severity ?? "info",
    message: finding.message ?? finding.code ?? "Compatibility finding",
    ...(finding.suggestion ? { detail: finding.suggestion } : {}),
  }));
  return {
    level: body.report.level,
    summary:
      diagnostics[0]?.message ??
      "Compatibility check completed for the synced SourceSnapshot.",
    diagnostics,
    ...(input.installConfigId ? { installConfigId: input.installConfigId } : {}),
    sourceId: source.id,
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

export async function createSpaceBackup(spaceId: string): Promise<BackupRecord> {
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
  const body = await controlFetch<{ backups: readonly BackupRecord[] }>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/backups`,
  );
  return body.backups ?? [];
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
  const body = await controlFetch<{ sources?: readonly Source[] }>(
    `${BASE}/sources${query({ spaceId })}`,
  );
  return body.sources ?? [];
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
export async function syncSource(sourceId: string): Promise<unknown> {
  return await controlFetch<unknown>(
    `${BASE}/sources/${encodeURIComponent(sourceId)}/sync`,
    { method: "POST" },
  );
}

export async function listSourceSnapshots(
  sourceId: string,
): Promise<readonly SourceSnapshot[]> {
  const body = await controlFetch<{
    snapshots?: readonly SourceSnapshot[];
  }>(`${BASE}/sources/${encodeURIComponent(sourceId)}/snapshots`);
  return body.snapshots ?? [];
}

export async function waitForLatestSourceSnapshot(
  sourceId: string,
): Promise<SourceSnapshot> {
  const deadline = Date.now() + 20_000;
  let lastSnapshots: readonly SourceSnapshot[] = [];
  while (Date.now() < deadline) {
    lastSnapshots = await listSourceSnapshots(sourceId);
    const latest = [...lastSnapshots].sort((a, b) =>
      b.fetchedAt.localeCompare(a.fetchedAt),
    )[0];
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ControlApiError(
    409,
    "source_sync_required",
    "Source sync has not produced a SourceSnapshot yet.",
    { snapshots: lastSnapshots },
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

export async function getRun(id: string): Promise<Run> {
  const body = await controlFetch<{ run: Run }>(
    `${BASE}/runs/${encodeURIComponent(id)}`,
  );
  return body.run;
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
 * Applies a reviewed plan run (§31 GUI deploy). `planRunId` is the id of the
 * `plan` Run shown in the Run detail view. The backend rebuilds the apply guard
 * from the reviewed plan and re-checks every precondition; pass
 * `confirmDestructive: true` only after the operator has confirmed a destructive
 * plan. Returns the queued apply Run wrapper.
 */
export async function createApplyRun(
  planRunId: string,
  input: { readonly confirmDestructive?: boolean } = {},
): Promise<{ readonly applyRun: { readonly id: string } }> {
  return await controlFetch<{ applyRun: { id: string } }>(
    `${BASE}/plan-runs/${encodeURIComponent(planRunId)}/apply`,
    {
      method: "POST",
      body: input.confirmDestructive ? { confirmDestructive: true } : {},
    },
  );
}

// --- Deployments -----------------------------------------------------------

/**
 * Lists an Installation's Deployment ledger (current + past) for the dashboard
 * session (`GET /v1/control/installations/:id/deployments`). The backend
 * resolves the Installation's owning Space and space-permission gates first;
 * each row carries only the allowlist-projected `outputsPublic` (no sensitive
 * outputs, no raw output-snapshot pointer). Rows arrive newest-first.
 */
export async function listDeployments(
  installationId: string,
): Promise<readonly PublicDeployment[]> {
  const body = await controlFetch<{ deployments?: readonly PublicDeployment[] }>(
    `${BASE}/installations/${encodeURIComponent(installationId)}/deployments`,
  );
  return body.deployments ?? [];
}

/**
 * Reads one Deployment ledger record by id (`GET
 * /v1/control/deployments/:id`). Space-permission gated server-side; the
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
 * `POST /v1/control/deployments/:id/rollback-plan`): re-plans the Deployment's
 * Installation pinned to that Deployment's source snapshot. The plan then flows
 * through the normal approve → apply path, so the response is the plan-run
 * envelope (`{ planRun: { id, ... } }`) and the caller navigates to the Run
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
  const body = await controlFetch<{ connections?: readonly Connection[] }>(
    `${BASE}/connections${query({ spaceId })}`,
  );
  return body.connections ?? [];
}

export async function listOperatorConnectionDefaults(
  spaceId: string,
): Promise<readonly OperatorConnectionDefault[]> {
  const body = await controlFetch<{
    operatorConnectionDefaults?: readonly OperatorConnectionDefault[];
  }>(`${BASE}/operator-connection-defaults${query({ spaceId })}`);
  return body.operatorConnectionDefaults ?? [];
}

/**
 * Registers a Space-owned provider-credential Connection. `values` are
 * write-only credential material (e.g. `{ CLOUDFLARE_API_TOKEN }`) and must be
 * cleared from caller memory immediately after this resolves; the returned
 * {@link Connection} projection carries no secret values. The backend forces
 * `scope: "space"`, so this can never create an operator-default connection.
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

export async function listProviderTemplates(): Promise<
  readonly ProviderTemplate[]
> {
  const body = await controlFetch<{
    providers?: readonly ProviderTemplate[];
    providerTemplates?: readonly ProviderTemplate[];
  }>(`${BASE}/providers`);
  return body.providerTemplates ?? body.providers ?? [];
}

// --- OutputShares ----------------------------------------------------------

export async function listOutputShares(
  spaceId: string,
): Promise<readonly OutputShare[]> {
  const body = await controlFetch<{ shares?: readonly OutputShare[] }>(
    `${BASE}/output-shares${query({ spaceId })}`,
  );
  return body.shares ?? [];
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
  // Plan response: { planRun: { id } }; source sync: { run: { id } }; or a
  // bare { id }.
  for (const wrap of ["planRun", "planPreview", "run"] as const) {
    const nested = obj[wrap];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  return typeof obj.id === "string" ? obj.id : undefined;
}
