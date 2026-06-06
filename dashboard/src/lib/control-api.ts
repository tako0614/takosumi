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
 * activity,deploy-control-api,capability-bindings}.ts.
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
    return this.status === 409 &&
      (this.code === "source_sync_required" ||
        this.code === "failed_precondition");
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
    const code = (data as { error?: string } | undefined)?.error;
    const desc = (data as { error_description?: string } | undefined)
      ?.error_description;
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
  params: Record<string, string | number | undefined>,
): string {
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

export interface Space {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: SpaceType;
  readonly ownerUserId: string;
  readonly billingAccountId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InstallType =
  | "core"
  | "opentofu_module"
  | "opentofu_root"
  | "app_source";

export type TrustLevel = "official" | "trusted" | "space" | "raw";

export type InstallationStatus =
  | "installing"
  | "active"
  | "stale"
  | "error"
  | "destroying"
  | "destroyed";

export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly sourceId: string;
  readonly installType: InstallType;
  readonly installConfigId: string;
  readonly environment: string;
  readonly currentDeploymentId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputSnapshotId?: string;
  readonly status: InstallationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstallConfig {
  readonly id: string;
  readonly spaceId?: string;
  readonly name: string;
  readonly installType: InstallType;
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

export type ConnectionStatus = "pending" | "verified" | "revoked";
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
}

export interface OperatorConnectionDefault {
  readonly id: string;
  readonly capability: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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

// --- InstallConfigs --------------------------------------------------------

export async function listInstallConfigs(
  spaceId?: string,
): Promise<readonly InstallConfig[]> {
  const body = await controlFetch<{ installConfigs?: readonly InstallConfig[] }>(
    `${BASE}/install-configs${query({ spaceId })}`,
  );
  return body.installConfigs ?? [];
}

// --- Graph -----------------------------------------------------------------

export async function getSpaceGraph(spaceId: string): Promise<SpaceGraph> {
  return await controlFetch<SpaceGraph>(
    `${BASE}/spaces/${encodeURIComponent(spaceId)}/graph`,
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

export async function listSources(
  spaceId: string,
): Promise<readonly Source[]> {
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
}): Promise<CreateSourceResult> {
  return await controlFetch<CreateSourceResult>(`${BASE}/sources`, {
    method: "POST",
    body: {
      spaceId: input.spaceId,
      name: input.name,
      url: input.url,
      ...(input.defaultRef ? { defaultRef: input.defaultRef } : {}),
      ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
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

// --- Runs ------------------------------------------------------------------

/** Create a plan Run for an Installation. Returns the opaque PlanRun envelope. */
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

export async function listOperatorConnectionDefaults(): Promise<
  readonly OperatorConnectionDefault[]
> {
  const body = await controlFetch<
    { operatorConnectionDefaults?: readonly OperatorConnectionDefault[] }
  >(`${BASE}/operator-connection-defaults`);
  return body.operatorConnectionDefaults ?? [];
}

// ===========================================================================
// Helpers shared by the control views
// ===========================================================================

/** A best-effort run id extractor for the opaque plan/sync run envelopes. */
export function extractRunId(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const obj = envelope as Record<string, unknown>;
  // PlanRunResponse: { planRun: { id } }; source sync: { run: { id } }; or a
  // bare { id }.
  for (const wrap of ["planRun", "run"] as const) {
    const nested = obj[wrap];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  return typeof obj.id === "string" ? obj.id : undefined;
}
