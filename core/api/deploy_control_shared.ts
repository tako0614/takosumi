/**
 * Shared primitives for the §30 OpenTofu deployment-control-plane internal
 * HTTP seam. The internal route table is split into per-resource-group sibling
 * modules (`deploy_control_*_routes.ts`); each owns its handlers + its slice of
 * the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory. This module
 * holds the cross-group glue: the dependency / principal types, the auth +
 * id-validation + body-limit helpers, the {@link defineRoute} wrapper that
 * collapses the per-handler authorize -> validate-id -> runHandler prologue, and
 * the error-envelope plumbing. Everything here is service-local to the
 * `deployControl-internal` family.
 */

import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEndpoint, ApiEndpointMethod } from "./route_families.ts";
import { DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE } from "@takosumi/internal/deploy-control-api";
import type {
  ConnectionScopeHints,
  ConnectionScopeKind,
  CreateConnectionRequest,
  DeployControlErrorCode,
  DeployControlErrorEnvelope,
  DeployControlErrorHttpStatus,
  ListRunnerProfilesResponse,
  OpenTofuOperation,
} from "@takosumi/internal/deploy-control-api";
import type { CreatePlanRunRequest } from "@takosumi/internal/deploy-control-api";
import {
  clampPageLimit,
  decodeCursor,
  type PageParams,
} from "takosumi-contract/pagination";
import type { WorkspacesService } from "../domains/workspaces/mod.ts";
import type { CapsulesService } from "../domains/capsules/mod.ts";
import type { ConnectionsService } from "../domains/connections/mod.ts";
import type { DependenciesService } from "../domains/dependencies/mod.ts";
import type { OutputSharesService } from "../domains/output-shares/mod.ts";
import type { RunGroupsService } from "../domains/run-groups/mod.ts";
import type { ActivityService } from "../domains/activity/mod.ts";
import type { BackupsService } from "../domains/backups/mod.ts";
import {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
  type OpenTofuDeploymentController,
} from "../domains/deploy-control/mod.ts";
import { log } from "../shared/log.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";

export const DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * A {@link ApiEndpoint} descriptor enriched with the 501 message used by the
 * controller-absent fallback. The per-resource-group modules export these; the
 * barrel projects them down to plain {@link ApiEndpoint}s for `route_families`
 * (the extra `notImplementedMessage` field is structurally compatible) and
 * iterates them to mount the `not_implemented` fallback, so the descriptor and
 * the 501 stub list can no longer drift.
 */
export interface DeployControlEndpoint extends ApiEndpoint {
  /** Message the controller-absent 501 stub returns for this route. */
  readonly notImplementedMessage: string;
}

/**
 * Mounts a `not_implemented` (501) stub for every descriptor entry, driven by
 * iterating {@link DeployControlEndpoint}s instead of a hand-maintained third
 * route list. The stub authorizes first (so a disabled/invalid bearer still
 * yields 404 / 401), then returns the descriptor's `notImplementedMessage`.
 */
export function mountNotImplementedFromDescriptor(
  app: Hono,
  dependencies: DeployControlInternalRouteDependencies,
  endpoints: readonly DeployControlEndpoint[],
): void {
  const stub =
    (message: string) =>
    async (c: Context): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      return auth.ok ? c.json(notImplemented(c, message), 501) : auth.response;
    };
  for (const endpoint of endpoints) {
    const handler = stub(endpoint.notImplementedMessage);
    mountByMethod(app, endpoint.method, endpoint.path, handler);
  }
}

function mountByMethod(
  app: Hono,
  method: ApiEndpointMethod,
  path: string,
  handler: (c: Context) => Promise<Response>,
): void {
  switch (method) {
    case "GET":
      app.get(path, handler);
      return;
    case "HEAD":
      app.on("HEAD", path, handler);
      return;
    case "POST":
      app.post(path, handler);
      return;
    case "PUT":
      app.put(path, handler);
      return;
    case "PATCH":
      app.patch(path, handler);
      return;
    case "DELETE":
      app.delete(path, handler);
      return;
  }
}

const ID_PATTERNS = {
  planRunId: /^plan_[0-9a-zA-Z]{8,64}$/,
  applyRunId: /^apply_[0-9a-zA-Z]{8,64}$/,
  // The InstallationsService mints `inst_...`.
  installationId: /^inst_[0-9a-zA-Z]{8,64}$/,
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const CONNECTION_ID_PATTERN = /^conn_[0-9a-zA-Z]{8,64}$/;
export const PROVIDER_ENV_ID_PATTERN = /^(?:penv|conn)_[0-9a-zA-Z]{8,64}$/;
export const SOURCE_ID_PATTERN = /^src_[0-9a-zA-Z]{8,64}$/;
export const SPACE_ID_PATTERN = /^space_[0-9a-zA-Z]{8,64}$/;
export const RUN_ID_PATTERN =
  /^(?:(?:plan|apply|ssr|ccr)_[0-9a-zA-Z]{8,64}|(?:backup|restore)_[0-9a-zA-Z]{4,64})$/;
export const DEPENDENCY_ID_PATTERN = /^dep_[0-9a-zA-Z]{8,64}$/;
export const OUTPUT_SHARE_ID_PATTERN = /^oshare_[0-9a-zA-Z]{8,64}$/;
export const RUN_GROUP_ID_PATTERN = /^rg_[0-9a-zA-Z]{8,64}$/;
export const DEPLOYMENT_ID_PATTERN = /^dep(loy)?_[0-9a-zA-Z]{8,64}$/;
export const COMPATIBILITY_REPORT_ID_PATTERN = /^caprep_[0-9a-zA-Z]{8,64}$/;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
export const CUSTOM_PROVIDER_PACK_ID_PATTERN = /^cpp_[0-9a-zA-Z]{8,64}$/;

export const ALLOWED_KEYS: Record<
  DeployControlRouteName,
  ReadonlySet<string>
> = {
  planRunCreate: new Set([
    "spaceId",
    "source",
    "runnerProfileId",
    "installationId",
    "operation",
    "variables",
    "requiredProviders",
    "templateId",
    "templateVersion",
    "inputs",
  ]),
  applyRunCreate: new Set([
    "planRunId",
    "approval",
    "expected",
    "confirmDestructive",
  ]),
  connectionCreate: new Set([
    "spaceId",
    "provider",
    "kind",
    "authMethod",
    "displayName",
    "scope",
    "scopeHints",
    "expiresAt",
    "values",
    "files",
  ]),
  connectionOAuthStart: new Set([
    "spaceId",
    "displayName",
    "scope",
    "scopeHints",
    "expiresAt",
    "redirectUri",
    "successRedirectUri",
  ]),
  connectionGcpImpersonation: new Set([
    "spaceId",
    "displayName",
    "scope",
    "scopeHints",
    "expiresAt",
    "values",
  ]),
  sourceCreate: new Set([
    "spaceId",
    "name",
    "url",
    "defaultRef",
    "defaultPath",
    "authConnectionId",
  ]),
  sourcePatch: new Set([
    "name",
    "defaultRef",
    "defaultPath",
    "authConnectionId",
    "status",
  ]),
  sourceCompatibilityCheck: new Set([
    "sourceSnapshotId",
    "modulePath",
    "installationId",
    "installConfigId",
  ]),
  artifactSnapshot: new Set(["url", "digest", "format", "path"]),
  providerEnvPut: new Set([
    "spaceId",
    "providerSource",
    "displayName",
    "materialization",
    "status",
    "requiredEnvNames",
    "secretRef",
    "expiresAt",
  ]),
  spaceCreate: new Set([
    "handle",
    "displayName",
    "type",
    "ownerUserId",
    "billingAccountId",
  ]),
  spacePatch: new Set(["displayName"]),
  installationCreate: new Set([
    "name",
    "environment",
    "sourceId",
    "installConfigId",
    "modulePath",
    "runnerId",
    "outputAllowlist",
    "vars",
  ]),
  installationPatch: new Set(["status"]),
  installationPlan: new Set(["runnerId"]),
  installationDestroyPlan: new Set(["runnerId"]),
  runApprove: new Set(["reason"]),
  dependencyCreate: new Set([
    "producerInstallationId",
    "mode",
    "outputs",
    "visibility",
  ]),
  serviceExportCreate: new Set([
    "id",
    "producerCapsuleId",
    "outputId",
    "outputGeneration",
    "stateVersionId",
    "applyRunId",
    "name",
    "capabilities",
    "visibility",
    "status",
    "endpoints",
    "auth",
    "labels",
    "metadata",
  ]),
  serviceBindingCreate: new Set([
    "id",
    "target",
    "selector",
    "dependencyMode",
    "grantRequest",
    "dependencySnapshotId",
  ]),
  serviceGrantCreate: new Set(["id", "material", "expiresAt", "rotatedAt"]),
  outputShareCreate: new Set([
    "fromSpaceId",
    "toSpaceId",
    "producerInstallationId",
    "outputs",
    "sensitivePolicy",
  ]),
  creditsTopUp: new Set(["usdMicros", "credits"]),
  subscriptionChange: new Set(["billingSettings"]),
  deploy: new Set([
    "spaceId",
    "name",
    "environment",
    "snapshotId",
    "vars",
    "providerEnvBindings",
    "planOnly",
    "autoApprove",
  ]),
};

export type DeployControlRouteName =
  | "planRunCreate"
  | "applyRunCreate"
  | "connectionCreate"
  | "connectionOAuthStart"
  | "connectionGcpImpersonation"
  | "sourceCreate"
  | "sourcePatch"
  | "sourceCompatibilityCheck"
  | "artifactSnapshot"
  | "spaceCreate"
  | "spacePatch"
  | "installationCreate"
  | "installationPatch"
  | "installationPlan"
  | "installationDestroyPlan"
  | "providerEnvPut"
  | "runApprove"
  | "dependencyCreate"
  | "serviceExportCreate"
  | "serviceBindingCreate"
  | "serviceGrantCreate"
  | "outputShareCreate"
  | "creditsTopUp"
  | "subscriptionChange"
  | "deploy";

export interface DeployControlInternalRouteDependencies {
  /**
   * DeployControl bearer resolver. When unset or empty, deploy control routes are
   * disabled and return 404 so hosts do not leak an unconfigured
   * surface.
   */
  readonly getDeployControlToken?: () => string | undefined;
  /**
   * Optional scoped bearer resolver supplied by an operator/account-plane. When
   * present it receives the raw bearer value and must return the principal
   * scopes allowed for this request, or undefined to reject the bearer.
   */
  readonly authorizeDeployControlBearer?: (
    input: DeployControlBearerAuthorizationInput,
  ) =>
    | DeployControlPrincipal
    | undefined
    | Promise<DeployControlPrincipal | undefined>;
  /**
   * OpenTofu deployment controller. When unset, mounted endpoints return 501
   * after successful auth.
   */
  readonly controller?: OpenTofuDeploymentController;
  /**
   * Optional provider OAuth helpers. These are helper flows for creating
   * write-only Provider Connection backing material; they are not a third
   * credential source. When a helper is absent, its route still authenticates
   * first and returns `501 not_implemented`.
   */
  readonly connectionOAuthHelpers?: ConnectionOAuthHelpers;
  /**
   * Internal compatibility seam for legacy `/v1/*` ledger routes consumed by
   * in-process accounts / CLI code. Public platform API hosts leave this off so
   * PlanRun / ApplyRun / RunnerProfile / DeploymentOutput DTOs are not
   * externally callable.
   */
  readonly mountInternalLedgerRoutes?: boolean;
  /**
   * Spaces domain service (Core Specification §4). When unset, the Space routes
   * return 501 after successful auth.
   */
  readonly spacesService?: WorkspacesService;
  /**
   * Installations domain service (Core Specification §5 / §11). When unset, the
   * Installation / InstallConfig routes return 501 after successful auth.
   */
  readonly installationsService?: CapsulesService;
  /** Internal provider resolver creation plus provider connection resolution. */
  readonly connectionsService?: ConnectionsService;
  /**
   * Dependencies domain service (Core Specification §14 / §15). When unset, the
   * Dependency routes return 501 after successful auth.
   */
  readonly dependenciesService?: DependenciesService;
  /**
   * OutputShares domain service (Core Specification §18). When unset, the
   * cross-Space OutputShare routes return 501 after successful auth.
   */
  readonly outputSharesService?: OutputSharesService;
  /**
   * RunGroups domain service (Core Specification §19 / §24). When unset, the
   * plan-update / run-group routes return 501 after successful auth.
   */
  readonly runGroupsService?: RunGroupsService;
  /**
   * Activity domain service (Core Specification §27 / §34). When unset, the
   * Activity listing route returns 501 after successful auth, and the connection
   * route skips its Space-scoped audit emission.
   */
  readonly activityService?: ActivityService;
  /**
   * Control-backups domain service (Core Specification §33 / §26). When unset,
   * the backup routes return 501 after successful auth. The service is itself
   * disabled (createBackup -> 501) until a host wires the R2_BACKUPS artifact
   * store + crypto seam.
   */
  readonly backupsService?: BackupsService;
  /**
   * Raw writer for internal/operator upload-compat source archives into
   * R2_SOURCE. The internal upload route streams bytes here at the SAME raw key
   * the OpenTofu runner restores from (no logical-bucket prefix). When unset,
   * the upload + deploy compatibility routes return 501. Runtime-neutral by
   * design: the worker wires `env.R2_SOURCE.put`.
   */
  readonly writeSourceArchive?: SourceArchiveWriter;
}

/**
 * Writes upload Capsule archive bytes to R2_SOURCE at the exact `key` the runner
 * restores from. Resolves once the bytes are durably stored.
 */
export type SourceArchiveWriter = (
  key: string,
  bytes: Uint8Array,
) => Promise<void>;

export interface ConnectionOAuthHelpers {
  readonly cloudflare?: ConnectionOAuthHelper;
  readonly gcp?: ConnectionOAuthHelper;
}

export interface ConnectionOAuthStartBody {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "space";
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly redirectUri?: string;
  readonly successRedirectUri?: string;
  /**
   * Authenticated account subject of the cookie-gated caller that started the
   * flow. The helper signs it INTO the HMAC OAuth state so the cross-site
   * callback (which carries no session cookie) can authorize from the signed
   * state alone, instead of from a `SameSite=Strict` session cookie that does
   * not ride a top-level cross-site redirect.
   */
  readonly subject?: string;
}

export interface ConnectionOAuthStartResponse {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
}

export interface ConnectionOAuthStartInput {
  readonly provider: "cloudflare" | "gcp";
  readonly request: Request;
  readonly principal: DeployControlPrincipal;
  readonly body: ConnectionOAuthStartBody;
}

export interface ConnectionOAuthCallbackInput {
  readonly provider: "cloudflare" | "gcp";
  readonly request: Request;
  readonly principal: DeployControlPrincipal;
  readonly code: string;
  readonly state: string;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * Result of completing an OAuth helper callback: the connection-create request
 * plus the authenticated `subject` that was signed into the OAuth state at
 * `start` time. The dashboard control surface authorizes the cross-site
 * callback against this `subject` (it carries no session cookie); `subject` is
 * absent only for legacy/unsigned states.
 */
export interface ConnectionOAuthCompletion {
  readonly request: CreateConnectionRequest;
  readonly subject?: string;
}

export interface ConnectionOAuthHelper {
  start(
    input: ConnectionOAuthStartInput,
  ): Promise<ConnectionOAuthStartResponse>;
  complete(
    input: ConnectionOAuthCallbackInput,
  ): Promise<ConnectionOAuthCompletion>;
}

export interface DeployControlBearerAuthorizationInput {
  readonly token: string;
  readonly request: Request;
}

export interface DeployControlPrincipal {
  readonly actor: string;
  readonly spaceIds?: readonly string[] | "*";
  readonly operations?: readonly OpenTofuOperation[] | "*";
  readonly runnerProfileIds?: readonly string[] | "*";
}

export type DeployControlAuthResult =
  | { readonly ok: true; readonly principal: DeployControlPrincipal }
  | { readonly ok: false; readonly response: Response };

/**
 * The cross-group context handed to every per-resource-group mount function. It
 * pairs the resolved {@link OpenTofuDeploymentController} (guaranteed present —
 * the controller-absent path is handled by the descriptor-driven 501 fallback)
 * with the raw {@link DeployControlInternalRouteDependencies} (for the optional
 * per-domain services + the bearer resolver) and the shared body-limit
 * middleware.
 */
export interface DeployControlRouteContext {
  readonly app: Hono;
  readonly dependencies: DeployControlInternalRouteDependencies;
  readonly controller: OpenTofuDeploymentController;
  /** Hono body-limit middleware shared by every JSON-body route. */
  readonly deployControlBodyLimit: ReturnType<typeof bodyLimit>;
}

export function createDeployControlBodyLimit(): ReturnType<typeof bodyLimit> {
  return bodyLimit({
    maxSize: DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(
        errorEnvelope(
          c,
          "resource_exhausted",
          `request body exceeds ${DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES} byte limit`,
        ),
        413,
      ),
  });
}

type IdValidatedResult =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response };

/**
 * Declarative description of a route's param validation. `id` keys validate
 * through {@link ID_PATTERNS}; `param` validates an arbitrary path param against
 * a regex (mirrors the former `ensureValidParam`).
 */
export type RouteParamSpec =
  | { readonly id: keyof typeof ID_PATTERNS }
  | { readonly param: string; readonly pattern: RegExp };

/**
 * The inner-handler arguments a {@link defineRoute} controller receives after
 * the shared prologue (auth + optional service-guard + optional id-validation)
 * has passed.
 */
export interface RouteHandlerArgs {
  readonly c: Context;
  readonly principal: DeployControlPrincipal;
  /** The validated path id, when the route declared a `param`. */
  readonly id: string;
}

export interface DefineRouteOptions {
  readonly ctx: DeployControlRouteContext;
  /** Optional path-param validation run before the handler body. */
  readonly param?: RouteParamSpec;
  /**
   * When true, the JSON body-limit `content-length` pre-check runs before the
   * handler body (mirrors the former `enforceBodyLimit` calls on body routes).
   */
  readonly enforceBody?: boolean;
  /**
   * Optional service-wiring guard. Returns the disabled message when the route's
   * backing domain service is unwired; the route then answers 501 after auth.
   */
  readonly requireService?: (
    dependencies: DeployControlInternalRouteDependencies,
  ) => string | undefined;
  readonly handler: (args: RouteHandlerArgs) => Promise<Response>;
}

/**
 * Composes the shared per-handler prologue: authorize -> optional service-guard
 * -> optional id-validate -> optional body-limit -> {@link runHandler}. Each
 * route supplies only its inner controller call (which may run
 * {@link ensureSpacePermission} on the resolved entity). This collapses the
 * ~10-line authorize/validate/runHandler boilerplate that was repeated across
 * every handler.
 */
export function defineRoute(
  options: DefineRouteOptions,
): (c: Context) => Promise<Response> {
  const { ctx, param, enforceBody, requireService, handler } = options;
  return async (c: Context): Promise<Response> => {
    const auth = await authorizeDeployControl(c, ctx.dependencies);
    if (!auth.ok) return auth.response;
    if (requireService) {
      const disabledMessage = requireService(ctx.dependencies);
      if (disabledMessage !== undefined) {
        return c.json(notImplemented(c, disabledMessage), 501);
      }
    }
    let id = "";
    if (param) {
      const idCheck = validateRouteParam(c, param);
      if (idCheck.kind === "invalid") return idCheck.response;
      id = idCheck.value;
    }
    if (enforceBody) {
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
    }
    return await runHandler(c, () =>
      handler({ c, principal: auth.principal, id }),
    );
  };
}

function validateRouteParam(
  c: Context,
  spec: RouteParamSpec,
): IdValidatedResult {
  if ("id" in spec) return ensureValidId(c, spec.id);
  return ensureValidParam(c, spec.param, spec.pattern);
}

export async function authorizeDeployControl(
  c: Context,
  dependencies: DeployControlInternalRouteDependencies,
): Promise<DeployControlAuthResult> {
  const configuredToken = dependencies.getDeployControlToken?.();
  if (!configuredToken && !dependencies.authorizeDeployControlBearer) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "not_found", "deploy control routes disabled"),
        404,
      ),
    };
  }
  const header = c.req.header("authorization") ?? "";
  const bearer = bearerTokenFromAuthorization(header);
  if (!bearer) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  if (dependencies.authorizeDeployControlBearer) {
    const principal = await dependencies.authorizeDeployControlBearer({
      token: bearer,
      request: c.req.raw,
    });
    if (principal) return { ok: true, principal };
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  if (!configuredToken || !constantTimeEqualsString(bearer, configuredToken)) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  return {
    ok: true,
    principal: {
      actor: "deploy-control-bearer",
      spaceIds: "*",
      operations: "*",
      runnerProfileIds: "*",
    },
  };
}

function bearerTokenFromAuthorization(header: string): string | undefined {
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

export function ensurePlanCreatePermission(
  principal: DeployControlPrincipal,
  request: CreatePlanRunRequest,
): void {
  const operation =
    request.operation ??
    (request.capsuleId ?? request.installationId ? "update" : "create");
  ensureSpacePermission(principal, request.workspaceId ?? request.spaceId);
  ensureOperationPermission(principal, operation);
  if (request.runnerProfileId) {
    ensureRunnerProfilePermission(principal, request.runnerProfileId);
  } else if (principal.runnerProfileIds !== "*") {
    throw new OpenTofuControllerError(
      "permission_denied",
      `deploy control principal ${principal.actor} must choose an allowed runner profile`,
    );
  }
}

export function ensureApplyPermission(
  principal: DeployControlPrincipal,
  planRun: {
    readonly workspaceId: string;
    readonly operation: OpenTofuOperation;
    readonly runnerProfileId: string;
  },
): void {
  ensureSpacePermission(principal, planRun.workspaceId);
  ensureOperationPermission(principal, planRun.operation);
  ensureRunnerProfilePermission(principal, planRun.runnerProfileId);
}

export function ensureSpacePermission(
  principal: DeployControlPrincipal,
  spaceId: string | undefined,
): void {
  if (spaceId && spacePermissionAllows(principal, spaceId)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot access space ${
      spaceId ?? "<unknown>"
    }`,
  );
}

export function spacePermissionAllows(
  principal: DeployControlPrincipal,
  spaceId: string,
): boolean {
  return scopeAllows(principal.spaceIds, spaceId);
}

/**
 * Space creation is not gated by an existing space id, so a space-scoped
 * principal (`spaceIds: string[]`) cannot mint arbitrary Spaces; only the
 * unrestricted deploy-control bearer (`spaceIds: "*"`) may.
 */
export function ensureSpaceCreatePermission(
  principal: DeployControlPrincipal,
): void {
  if (principal.spaceIds === "*") return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot create spaces`,
  );
}

/**
 * Operator-scoped connections (spec §8: no owning Space) are instance-wide;
 * only the unrestricted bearer may touch them. A space-scoped connection
 * falls back to the normal space permission check.
 *
 * An explicit `scope: "operator"` request must come from the unrestricted
 * bearer (`spaceIds === "*"`) even when a spaceId is also supplied: a hybrid
 * `{ spaceId, scope: "operator" }` request must not let a space session mint an
 * operator-scoped provider connection (privilege-escalation guard; the vault
 * rejects the row too).
 */
export function ensureConnectionPermission(
  principal: DeployControlPrincipal,
  spaceId: string | undefined,
  scope?: ConnectionScopeKind,
): void {
  if (scope === "operator" && principal.spaceIds !== "*") {
    throw new OpenTofuControllerError(
      "permission_denied",
      `deploy control principal ${principal.actor} cannot manage operator-scoped connections`,
    );
  }
  if (spaceId !== undefined) {
    ensureSpacePermission(principal, spaceId);
    return;
  }
  if (principal.spaceIds === "*") return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot manage operator-scoped connections`,
  );
}

function ensureOperationPermission(
  principal: DeployControlPrincipal,
  operation: OpenTofuOperation,
): void {
  if (scopeAllows(principal.operations, operation)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot run ${operation}`,
  );
}

export function ensureRunnerProfilePermission(
  principal: DeployControlPrincipal,
  runnerProfileId: string,
): void {
  if (scopeAllows(principal.runnerProfileIds, runnerProfileId)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot use runner profile ${runnerProfileId}`,
  );
}

export function scopeAllows(
  scope: readonly string[] | "*" | undefined,
  value: string,
): boolean {
  return scope === "*" || scope?.includes(value) === true;
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function filterRunnerProfilesForPrincipal(
  response: ListRunnerProfilesResponse,
  principal: DeployControlPrincipal,
): ListRunnerProfilesResponse {
  if (principal.runnerProfileIds === "*") return response;
  const allowed = new Set(principal.runnerProfileIds ?? []);
  return {
    runnerProfiles: response.runnerProfiles.filter((profile) =>
      allowed.has(profile.id),
    ),
  };
}

export function notImplemented(
  c: Context,
  message: string,
): DeployControlErrorEnvelope {
  return {
    error: {
      code: "not_implemented" satisfies DeployControlErrorCode,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

export async function runHandler(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpenTofuControllerError) {
      return c.json(
        errorEnvelope(c, err.code, err.message),
        controllerHttpStatus(err.code),
      );
    }
    const requestId = resolveRequestId(c);
    log.error("deployControl.public_routes.internal_error", {
      requestId,
      path: c.req.path,
      method: c.req.method,
      error: err,
    });
    return c.json(
      {
        error: {
          code: "internal_error" satisfies DeployControlErrorCode,
          message: "internal error",
          requestId,
        },
      } satisfies DeployControlErrorEnvelope,
      500,
    );
  }
}

export async function readJsonBody<T>(
  c: Context,
  route: DeployControlRouteName,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be a JSON object",
    );
  }
  const allowed = ALLOWED_KEYS[route];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `unknown_field: ${key}`,
      );
    }
  }
  return raw as T;
}

/**
 * Reads an OPTIONAL JSON body (the approve route allows an empty body). Returns
 * `{}` when there is no body or it is empty; otherwise validates it like
 * {@link readJsonBody} (object shape + allowed-key allowlist).
 */
export async function readOptionalJsonBody<T>(
  c: Context,
  route: DeployControlRouteName,
): Promise<T> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {} as T;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be a JSON object",
    );
  }
  const allowed = ALLOWED_KEYS[route];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `unknown_field: ${key}`,
      );
    }
  }
  return raw as T;
}

export function enforceBodyLimit(
  c: Context,
  limitBytes: number,
): Response | undefined {
  const header = c.req.header("content-length");
  if (header === undefined) return undefined;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return c.json(
      errorEnvelope(c, "invalid_argument", "invalid content-length header"),
      400,
    );
  }
  if (parsed > limitBytes) {
    return c.json(
      errorEnvelope(
        c,
        "resource_exhausted",
        `request body exceeds ${limitBytes} byte limit`,
      ),
      413,
    );
  }
  return undefined;
}

export function ensureValidId(
  c: Context,
  param: keyof typeof ID_PATTERNS,
): IdValidatedResult {
  const raw = c.req.param(param) ?? "";
  if (!ID_PATTERNS[param].test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          `${param} has an unsupported shape`,
        ),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

export function ensureValidParam(
  c: Context,
  param: string,
  pattern: RegExp,
): IdValidatedResult {
  const raw = c.req.param(param) ?? "";
  if (!pattern.test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          `${param} has an unsupported shape`,
        ),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

/**
 * Parses the shared `?limit=` / `?cursor=` keyset-pagination query for a list
 * route, generalizing the Activity `parseActivityLimit`: `limit` must be a
 * positive integer (clamped to {@link MAX_PAGE_LIMIT}); `cursor` must be an
 * opaque token previously emitted as a `nextCursor` (it must decode to a
 * `{ createdAt, id }` keyset). A malformed limit or cursor is a 400; both absent
 * yields `{ limit: undefined, cursor: undefined }` so the store applies the
 * default cap.
 */
export function parsePageParams(
  c: Context,
):
  | { readonly kind: "ok"; readonly value: PageParams }
  | { readonly kind: "invalid"; readonly response: Response } {
  const rawLimit = c.req.query("limit");
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      return {
        kind: "invalid",
        response: c.json(
          errorEnvelope(
            c,
            "invalid_argument",
            "limit must be a positive integer",
          ),
          400,
        ),
      };
    }
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        kind: "invalid",
        response: c.json(
          errorEnvelope(
            c,
            "invalid_argument",
            "limit must be a positive integer",
          ),
          400,
        ),
      };
    }
    limit = clampPageLimit(parsed);
  }
  const rawCursor = c.req.query("cursor");
  if (rawCursor !== undefined && rawCursor !== "") {
    if (decodeCursor(rawCursor) === undefined) {
      return {
        kind: "invalid",
        response: c.json(
          errorEnvelope(c, "invalid_argument", "cursor is malformed"),
          400,
        ),
      };
    }
  }
  return {
    kind: "ok",
    value: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== undefined && rawCursor !== ""
        ? { cursor: rawCursor }
        : {}),
    },
  };
}

function controllerHttpStatus(
  code: OpenTofuControllerErrorCode,
): DeployControlErrorHttpStatus {
  return DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code];
}

export function errorEnvelope(
  c: Context,
  code: DeployControlErrorCode,
  message: string,
): DeployControlErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

function resolveRequestId(c: Context): string {
  const fromHeader =
    c.req.header("x-request-id") ?? c.req.header("x-correlation-id");
  if (fromHeader && isValidRequestIdShape(fromHeader)) return fromHeader;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return UUID_PATTERN.test(value) || ULID_PATTERN.test(value);
}
