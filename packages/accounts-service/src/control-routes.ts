/**
 * Account-plane session-authed deploy-control pass-through routes (spec §31 UI
 * backing surface, conformance M10).
 *
 * The dashboard SPA (served by the platform worker) authenticates with the
 * ACCOUNTS-plane session cookie, not the operator deploy-control bearer. The
 * §30 `/api` deploy-control surface stays operator-bearer-gated; this NEW
 * `/v1/control/*` family is the account-plane namespace the dashboard calls
 * same-origin. Each handler:
 *
 *   1. requires an authenticated account session (anonymous -> 401), and
 *   2. calls the in-process deploy-control operations facade directly (the same
 *      wired controller + domain services backing the §30 routes), rendering
 *      the controller's typed `OpenTofuControllerError` codes to HTTP via the
 *      contract's code->status map.
 *
 * Authorization MVP: any authenticated session may act. This is a
 * single-operator instance; Space-membership enforcement (binding the §30
 * deploy-control Space DAG to the accounts-plane LedgerAccount ownership model)
 * is post-MVP. The accounts-plane Space ledger (SpaceRecord keyed by
 * accountId/legalOwnerSubject) is a SEPARATE namespace from the deploy-control
 * Space model (`space_...` ids); the two are not yet reconciled, so we do not
 * cross-check the deploy-control spaceId against the accounts ledger here.
 */

import {
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
} from "takosumi-contract/deploy-control-api";
import type {
  Connection,
  DeployControlErrorCode,
  ListConnectionsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
} from "takosumi-contract/deploy-control-api";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourcesResponse,
} from "takosumi-contract/sources";
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  InstallConfig,
  Installation,
} from "takosumi-contract/installations";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { OperatorConnectionDefault } from "takosumi-contract/capability-bindings";
import type { Run } from "takosumi-contract/runs";
import { json, methodNotAllowed, readJsonObject, stringValue } from "./http-helpers.ts";
import { requireAccountSession } from "./account-session.ts";
import type { AccountsStore } from "./store.ts";

/**
 * Structural subset of the host's `TakosumiOperations` facade the control
 * routes call. `TakosumiOperations` (wired in `src/service/bootstrap.ts`)
 * already satisfies this shape, so the platform worker passes its existing
 * `operations` facade with no extra wiring. Genuine remote deploy-control is
 * NOT reachable through this interface — the control routes are an in-process
 * convenience for the same-origin dashboard only.
 */
export interface ControlPlaneOperations {
  // --- Spaces (§4) ---
  readonly spaces: {
    listSpaces(): Promise<readonly Space[]>;
    getSpace(id: string): Promise<Space>;
    createSpace(request: {
      readonly handle: string;
      readonly displayName: string;
      readonly type: SpaceType;
      readonly ownerUserId: string;
    }): Promise<Space>;
  };
  // --- Installations + InstallConfigs (§5 / §11) ---
  readonly installations: {
    getInstallation(id: string): Promise<Installation>;
    listInstallations(spaceId: string): Promise<readonly Installation[]>;
    createInstallation(request: {
      readonly spaceId: string;
      readonly name: string;
      readonly environment: string;
      readonly sourceId: string;
      readonly installConfigId: string;
    }): Promise<Installation>;
    listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]>;
  };
  // --- Dependencies (§14 / §15) ---
  readonly dependencies: {
    createDependency(request: {
      readonly spaceId: string;
      readonly producerInstallationId: string;
      readonly consumerInstallationId: string;
      readonly mode: DependencyMode;
      readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
      readonly visibility: DependencyVisibility;
    }): Promise<Dependency>;
    getDependency(id: string): Promise<Dependency | undefined>;
    deleteDependency(id: string): Promise<boolean>;
  };
  /**
   * Space-wide dependency edge listing for the graph projection. Added to the
   * facade in M10 (mirrors the store's `listDependenciesBySpace`).
   */
  listDependenciesBySpace(spaceId: string): Promise<readonly Dependency[]>;
  // --- RunGroups (§19 / §24) ---
  readonly runGroups: {
    createSpaceUpdate(spaceId: string): Promise<RunGroupWithRunsLike>;
    getRunGroup(id: string): Promise<RunGroupWithRunsLike | undefined>;
    approveRunGroup(id: string): Promise<RunGroupWithRunsLike | undefined>;
  };
  // --- Activity (§27 / §34) ---
  readonly activity: {
    list(spaceId: string, limit?: number): Promise<readonly ActivityEvent[]>;
  };
  // --- Connections (§9) ---
  readonly connections: {
    listOperatorConnectionDefaults(): Promise<readonly OperatorConnectionDefault[]>;
  };
  listConnections(spaceId: string): Promise<ListConnectionsResponse>;
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  getConnection(connectionId: string): Promise<Connection>;
  // --- Runs (§6.8 / §19 / §23) ---
  createInstallationPlan(installationId: string): Promise<PlanRunResponse>;
  createInstallationDestroyPlan(installationId: string): Promise<PlanRunResponse>;
  getRun(id: string): Promise<Run>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  getRunLogs(id: string): Promise<unknown>;
  // --- Sources (§6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(spaceId: string): Promise<ListSourcesResponse>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<unknown>;
  // --- Runner profiles (read; used by operator-connection-defaults view) ---
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
}

/** Loose RunGroup-with-runs projection (avoids importing the service type). */
export interface RunGroupWithRunsLike {
  readonly runGroup: { readonly id: string; readonly spaceId: string };
  readonly runs: readonly Run[];
}

const CONTROL_PREFIX = "/v1/control";

/**
 * True for any path the control-routes family owns. Used by the dispatcher in
 * `mod.ts` to route into {@link handleControlRoute} before the generic 404.
 */
export function isControlRoutePath(pathname: string): boolean {
  return pathname === CONTROL_PREFIX || pathname.startsWith(`${CONTROL_PREFIX}/`);
}

interface ControlRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
}

/**
 * Renders an `OpenTofuControllerError` (carrying a `.code`) to the contract's
 * code->HTTP-status mapping. Non-controller errors collapse to 500.
 */
function controllerErrorResponse(error: unknown): Response {
  const code = controllerErrorCode(error);
  if (code) {
    return json(
      {
        error: code,
        error_description: error instanceof Error ? error.message : String(error),
      },
      DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
    );
  }
  return json({ error: "internal_error" }, 500);
}

function controllerErrorCode(error: unknown): DeployControlErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
      code in DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE
    ? code as DeployControlErrorCode
    : undefined;
}

function controlPlaneUnavailable(): Response {
  return json({
    error: "feature_unavailable",
    error_description: "The control plane is temporarily unavailable.",
  }, 503);
}

/**
 * Single entry point for the `/v1/control/*` family. Authenticates the account
 * session ONCE (anonymous -> 401), then dispatches to the matched sub-route.
 * Returns `undefined` only when the path is not owned by this family (so the
 * caller can fall through to its own 404).
 */
export async function handleControlRoute(
  context: ControlRouteContext,
): Promise<Response | undefined> {
  const { request, url, store } = context;
  if (!isControlRoutePath(url.pathname)) return undefined;

  // Authn gate: every control route requires a live account session. The
  // dashboard presents the HttpOnly `takosumi_session` cookie; PAT/header
  // callers are accepted by `requireAccountSession` too. Authorization MVP:
  // any authenticated session may act (single-operator; Space membership is
  // post-MVP — see module header).
  const session = await requireAccountSession({ request, store });
  if (!session.ok) return session.response;

  const operations = context.operations;
  if (!operations) return controlPlaneUnavailable();

  const tail = url.pathname.slice(CONTROL_PREFIX.length); // e.g. "/spaces"
  try {
    return await dispatch({ request, url, tail, operations, session });
  } catch (error) {
    return controllerErrorResponse(error);
  }
}

interface DispatchInput {
  readonly request: Request;
  readonly url: URL;
  readonly tail: string;
  readonly operations: ControlPlaneOperations;
  readonly session: { readonly subject: string };
}

async function dispatch(input: DispatchInput): Promise<Response> {
  const { request, url, tail, operations } = input;
  const method = request.method;
  const segments = tail.split("/").filter(Boolean); // ["spaces", ":id", ...]

  // GET/POST /v1/control/spaces
  if (segments.length === 1 && segments[0] === "spaces") {
    if (method === "GET") return await listSpaces(operations);
    if (method === "POST") {
      return await createSpace(request, operations, input.session.subject);
    }
    return methodNotAllowed("GET, POST");
  }

  // /v1/control/spaces/:spaceId/...
  if (segments[0] === "spaces" && segments.length >= 3) {
    const spaceId = decodeURIComponent(segments[1] ?? "");
    const leaf = segments[2];
    if (leaf === "installations" && segments.length === 3) {
      if (method === "GET") return await listSpaceInstallations(operations, spaceId);
      if (method === "POST") {
        return await createInstallation(request, operations, spaceId);
      }
      return methodNotAllowed("GET, POST");
    }
    if (leaf === "graph" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await spaceGraph(operations, spaceId);
    }
    if (leaf === "activity" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await spaceActivity(operations, spaceId, url);
    }
    if (leaf === "plan-update" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await spacePlanUpdate(operations, spaceId);
    }
  }

  // /v1/control/installations/:id ; .../plan ; .../destroy-plan ; .../dependencies
  if (segments[0] === "installations" && segments.length >= 2) {
    const installationId = decodeURIComponent(segments[1] ?? "");
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await getInstallation(operations, installationId);
    }
    const leaf = segments[2];
    if (leaf === "plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return jsonStatus(
        await operations.createInstallationPlan(installationId),
        201,
      );
    }
    if (leaf === "destroy-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return jsonStatus(
        await operations.createInstallationDestroyPlan(installationId),
        201,
      );
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await createDependency(request, operations, installationId);
    }
  }

  // /v1/control/install-configs
  if (segments.length === 1 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listInstallConfigs(operations, url);
  }

  // /v1/control/dependencies/:id
  if (segments[0] === "dependencies" && segments.length === 2) {
    const dependencyId = decodeURIComponent(segments[1] ?? "");
    if (method !== "DELETE") return methodNotAllowed("DELETE");
    return await deleteDependency(operations, dependencyId);
  }

  // /v1/control/sources ; /v1/control/sources/:id/sync
  if (segments[0] === "sources") {
    if (segments.length === 1) {
      if (method === "GET") return await listSources(operations, url);
      if (method === "POST") return await createSource(request, operations);
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3 && segments[2] === "sync") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      return jsonStatus(await operations.createSourceSync(sourceId), 201);
    }
  }

  // /v1/control/runs/:id ; .../approve ; .../logs
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ run: await operations.getRun(runId) });
    }
    const leaf = segments[2];
    if (leaf === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRun(request, operations, runId, input.session.subject);
    }
    if (leaf === "logs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunLogs(runId));
    }
  }

  // /v1/control/run-groups/:id ; .../approve
  if (segments[0] === "run-groups" && segments.length >= 2) {
    const runGroupId = decodeURIComponent(segments[1] ?? "");
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await getRunGroup(operations, runGroupId);
    }
    if (segments[2] === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRunGroup(operations, runGroupId);
    }
  }

  // /v1/control/connections?spaceId=
  if (segments.length === 1 && segments[0] === "connections") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listControlConnections(operations, url);
  }

  // /v1/control/operator-connection-defaults
  if (segments.length === 1 && segments[0] === "operator-connection-defaults") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json({
      operatorConnectionDefaults: await operations.connections
        .listOperatorConnectionDefaults(),
    });
  }

  return json({ error: "not_found" }, 404);
}

// --- Spaces ----------------------------------------------------------------

async function listSpaces(operations: ControlPlaneOperations): Promise<Response> {
  // MVP: list ALL deploy-control Spaces. The account-plane membership model
  // (binding deploy-control Spaces to the accounts LedgerAccount owner) is
  // post-MVP; until then a single-operator instance sees every Space.
  return json({ spaces: await operations.spaces.listSpaces() });
}

async function createSpace(
  request: Request,
  operations: ControlPlaneOperations,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const handle = stringValue(body.handle);
  const displayName = stringValue(body.displayName) ?? handle;
  const type = spaceTypeValue(body.type) ?? "personal";
  if (!handle) {
    return json({
      error: "invalid_request",
      error_description: "handle is required",
    }, 400);
  }
  // ownerUserId is the session account id (the authenticated subject); the
  // dashboard never supplies it. Space-membership reconciliation is post-MVP.
  const space = await operations.spaces.createSpace({
    handle,
    displayName: displayName ?? handle,
    type,
    ownerUserId: sessionSubject,
  });
  return jsonStatus({ space }, 201);
}

// --- Installations ---------------------------------------------------------

async function listSpaceInstallations(
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  return json({
    installations: await operations.installations.listInstallations(spaceId),
  });
}

async function getInstallation(
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  return json({
    installation: await operations.installations.getInstallation(installationId),
  });
}

async function createInstallation(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const name = stringValue(body.name);
  const environment = stringValue(body.environment);
  const sourceId = stringValue(body.sourceId);
  const installConfigId = stringValue(body.installConfigId);
  if (!name || !environment || !sourceId || !installConfigId) {
    return json({
      error: "invalid_request",
      error_description:
        "name, environment, sourceId, and installConfigId are required",
    }, 400);
  }
  const installation = await operations.installations.createInstallation({
    spaceId,
    name,
    environment,
    sourceId,
    installConfigId,
  });
  return jsonStatus({ installation }, 201);
}

async function listInstallConfigs(
  operations: ControlPlaneOperations,
  url: URL,
): Promise<Response> {
  const spaceId = stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  // Without a spaceId only the official catalog (spaceId-less configs) is
  // returned; with one, the official catalog plus that Space's own configs —
  // mirroring the §30 `/api/install-configs` projection.
  const official = (await operations.installations.listInstallConfigs())
    .filter((config) => config.spaceId === undefined);
  const scoped = spaceId === undefined
    ? []
    : await operations.installations.listInstallConfigs(spaceId);
  return json({ installConfigs: [...official, ...scoped] });
}

// --- Graph -----------------------------------------------------------------

async function spaceGraph(
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const [installations, edges] = await Promise.all([
    operations.installations.listInstallations(spaceId),
    operations.listDependenciesBySpace(spaceId),
  ]);
  const nodes = installations.map((installation) => ({
    installationId: installation.id,
    name: installation.name,
    environment: installation.environment,
    status: installation.status,
  }));
  const graphEdges = edges.map((edge) => ({
    id: edge.id,
    producerInstallationId: edge.producerInstallationId,
    consumerInstallationId: edge.consumerInstallationId,
    outputs: edge.outputs,
  }));
  return json({ nodes, edges: graphEdges });
}

// --- Dependencies ----------------------------------------------------------

async function createDependency(
  request: Request,
  operations: ControlPlaneOperations,
  consumerInstallationId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const producerInstallationId = stringValue(body.producerInstallationId);
  if (!producerInstallationId) {
    return json({
      error: "invalid_request",
      error_description: "producerInstallationId is required",
    }, 400);
  }
  // The consumer is the path Installation; resolve its Space so the edge is
  // created in the right Space (mirrors the §30 dependency-create handler).
  const consumer = await operations.installations.getInstallation(
    consumerInstallationId,
  );
  const dependency = await operations.dependencies.createDependency({
    spaceId: consumer.spaceId,
    producerInstallationId,
    consumerInstallationId,
    mode: dependencyModeValue(body.mode) ?? "variable_injection",
    outputs: isOutputsMapping(body.outputs) ? body.outputs : {},
    visibility: dependencyVisibilityValue(body.visibility) ?? "space",
  });
  return jsonStatus({ dependency }, 201);
}

async function deleteDependency(
  operations: ControlPlaneOperations,
  dependencyId: string,
): Promise<Response> {
  const existing = await operations.dependencies.getDependency(dependencyId);
  if (!existing) return json({ error: "not_found" }, 404);
  await operations.dependencies.deleteDependency(dependencyId);
  return new Response(null, { status: 204 });
}

// --- Activity --------------------------------------------------------------

async function spaceActivity(
  operations: ControlPlaneOperations,
  spaceId: string,
  url: URL,
): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === "invalid") {
    return json({
      error: "invalid_request",
      error_description: "limit must be a positive integer",
    }, 400);
  }
  const events = await operations.activity.list(spaceId, limit);
  return json({ events });
}

// --- Sources ---------------------------------------------------------------

async function listSources(
  operations: ControlPlaneOperations,
  url: URL,
): Promise<Response> {
  const spaceId = stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return json({
      error: "invalid_request",
      error_description: "spaceId query parameter is required",
    }, 400);
  }
  return json(await operations.listSources(spaceId));
}

async function createSource(
  request: Request,
  operations: ControlPlaneOperations,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const spaceId = stringValue(body.spaceId);
  const name = stringValue(body.name);
  const sourceUrl = stringValue(body.url);
  if (!spaceId || !name || !sourceUrl) {
    return json({
      error: "invalid_request",
      error_description: "spaceId, name, and url are required",
    }, 400);
  }
  const requestBody: CreateSourceRequest = {
    spaceId,
    name,
    url: sourceUrl,
    ...(stringValue(body.defaultRef) ? { defaultRef: stringValue(body.defaultRef) } : {}),
    ...(stringValue(body.defaultPath)
      ? { defaultPath: stringValue(body.defaultPath) }
      : {}),
  };
  return jsonStatus(await operations.createSource(requestBody), 201);
}

// --- Runs ------------------------------------------------------------------

async function approveRun(
  request: Request,
  operations: ControlPlaneOperations,
  runId: string,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const approvedBy = (body && stringValue(body.approvedBy)) ?? sessionSubject;
  const reason = body ? stringValue(body.reason) : undefined;
  const run = await operations.approveRun(runId, {
    approvedBy,
    ...(reason ? { reason } : {}),
  });
  return json({ run });
}

// --- RunGroups -------------------------------------------------------------

async function spacePlanUpdate(
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  return jsonStatus(await operations.runGroups.createSpaceUpdate(spaceId), 201);
}

async function getRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.getRunGroup(runGroupId);
  if (!result) return json({ error: "not_found" }, 404);
  return json(result);
}

async function approveRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.approveRunGroup(runGroupId);
  if (!result) return json({ error: "not_found" }, 404);
  return json(result);
}

// --- Connections -----------------------------------------------------------

async function listControlConnections(
  operations: ControlPlaneOperations,
  url: URL,
): Promise<Response> {
  const spaceId = stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  // The accounts plane has no admin notion distinct from a normal session, so
  // a spaceId is REQUIRED here; operator-scoped Connection listing stays on the
  // operator-bearer §30 surface. (If/when the accounts plane grows an admin
  // role, this can branch to listOperatorConnections.)
  if (!spaceId) {
    return json({
      error: "invalid_request",
      error_description: "spaceId query parameter is required",
    }, 400);
  }
  return json(await operations.listConnections(spaceId));
}

// --- value coercion --------------------------------------------------------

function jsonStatus(body: unknown, status: number): Response {
  return json(body, status);
}

function spaceTypeValue(value: unknown): SpaceType | undefined {
  return value === "personal" || value === "organization" ? value : undefined;
}

function dependencyModeValue(value: unknown): DependencyMode | undefined {
  return value === "variable_injection" || value === "remote_state" ||
      value === "published_output"
    ? value
    : undefined;
}

function dependencyVisibilityValue(
  value: unknown,
): DependencyVisibility | undefined {
  return value === "space" || value === "cross_space" ? value : undefined;
}

function isOutputsMapping(
  value: unknown,
): value is Readonly<Record<string, DependencyOutputMapping>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(value: string | null): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}
