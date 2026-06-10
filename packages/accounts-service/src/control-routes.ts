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
 * Authorization: the session subject must own the target deploy-control Space
 * (`Space.ownerUserId`) or own the accounts-ledger account that contains that
 * Space (`SpaceRecord.accountId -> LedgerAccount.legalOwnerSubject`). Routes
 * addressing Installation / Run / RunGroup / Source / Dependency first resolve
 * the target record and check its `spaceId` before dispatching mutations.
 */

import { DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE } from "@takosumi/internal/deploy-control-api";
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
  PublicPlanRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type { ListProviderTemplatesResponse } from "takosumi-contract/providers";
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  DeploymentProfile,
  InstallConfig,
  Installation,
  PolicyConfig,
  PublicInstallConfig,
  PublicInstallation,
} from "takosumi-contract/installations";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type {
  ProviderBinding,
  ProviderBindingMode,
  ProviderBindings,
  OperatorConnectionDefault,
} from "takosumi-contract/provider-bindings";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
import type {
  BackupRecord,
  CreateBackupResponse,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import type { Run, RunCostInfo } from "takosumi-contract/runs";
import {
  json,
  methodNotAllowed,
  numberValue,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "./http-helpers.ts";
import { requireAccountSession } from "./account-session.ts";
import type { AccountsStore } from "./store.ts";

function publicInstallation(installation: Installation): PublicInstallation {
  const { installType: _installType, ...publicRecord } = installation;
  return publicRecord;
}

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    ...publicRecord
  } = config;
  return publicRecord;
}

/**
 * Public projection of a Deployment for the account-plane session surface. It
 * keeps the allowlist-projected `outputsPublic` map (sensitive outputs never
 * enter the ledger row) and drops the `outputSnapshotId` pointer to the raw
 * encrypted OutputSnapshot, so the dashboard read never exposes a handle to the
 * un-projected output envelope. The raw envelope is reachable only through the
 * explicit OutputShare flow, not this read.
 */
function publicDeployment(deployment: Deployment): PublicDeployment {
  const { outputSnapshotId: _outputSnapshotId, ...rest } = deployment;
  return rest;
}

/** Deployment row with the raw OutputSnapshot pointer projected out. */
type PublicDeployment = Omit<Deployment, "outputSnapshotId">;

// --- Membership (Space members / roles) ------------------------------------
//
// Structural mirror of the in-process membership domain
// (`src/service/domains/membership`). The control routes describe the membership
// shapes structurally (like the rest of `ControlPlaneOperations`) so the
// `packages/` layer never imports back into `src/service/`; the host's wired
// `TakosumiOperations` facade supplies the concrete service.

/** A Space member's role. Mirrors the membership domain's `SpaceRole`. */
export type ControlSpaceRole = "owner" | "admin" | "member" | "viewer";

/** A member's lifecycle status. Mirrors the membership domain's `MembershipStatus`. */
export type ControlMembershipStatus = "active" | "invited" | "suspended";

/**
 * Public projection of one Space membership for the dashboard session surface.
 * It carries the member's account id, roles, status, and timestamps — no
 * credential, email, or other PII beyond the account handle the caller already
 * addresses.
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

/** The mutation actor the control surface passes to the membership service. */
interface MembershipActor {
  readonly actorAccountId: string;
  readonly roles: readonly string[];
  readonly requestId: string;
}

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
    updateSpace(
      id: string,
      patch: {
        readonly displayName?: string;
        readonly policy?: PolicyConfig;
      },
    ): Promise<Space>;
  };
  // --- Members (membership domain: Space members + roles) ---
  //
  // Backed in-process by the membership domain's
  // `MembershipRoleEntitlementService` (`listSpaceMemberships` /
  // `upsertSpaceMembership`). The control surface resolves the Space server-side
  // and enforces the role gate BEFORE calling these; the service's own
  // owner/admin gate is a defense-in-depth backstop. The membership domain has
  // no hard-delete and no invitation/notification machinery, so:
  //   - `addMember` upserts (handle/subject is added directly as an active or
  //     invited member; there is no email invite or notification side-channel),
  //   - `removeMember` is a SOFT remove (`status: "suspended"`), since the
  //     membership store exposes no delete.
  readonly members?: {
    /** Lists a Space's memberships (membership domain `listSpaceMemberships`). */
    listMembers(spaceId: string): Promise<readonly PublicSpaceMember[]>;
    /**
     * Adds or updates one Space membership (membership domain
     * `upsertSpaceMembership`). Used for invite/add and for role changes; a
     * `status: "suspended"` upsert is the soft-remove path. Returns the upserted
     * membership projection.
     */
    upsertMember(input: {
      readonly spaceId: string;
      readonly accountId: string;
      readonly roles?: readonly ControlSpaceRole[];
      readonly status?: ControlMembershipStatus;
      readonly actor: MembershipActor;
    }): Promise<PublicSpaceMember>;
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
    putDeploymentProfile(
      profile: DeploymentProfile,
    ): Promise<DeploymentProfile>;
    getDeploymentProfileByInstallation(
      installationId: string,
      environment: string,
    ): Promise<DeploymentProfile | undefined>;
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
  // --- Backups (§29) ---
  readonly backups: {
    createBackup(input: {
      readonly spaceId: string;
      readonly createdByRunId?: string;
    }): Promise<BackupRecord>;
    listBackups(spaceId: string): Promise<readonly BackupRecord[]>;
  };
  // --- Billing (§28) ---
  getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: CreditBalance;
    };
  }>;
  listSpaceUsage(spaceId: string): Promise<{
    readonly usageEvents: readonly UsageEvent[];
  }>;
  listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }>;
  topUpSpaceCredits(
    spaceId: string,
    input: { readonly credits: number },
  ): Promise<{ readonly balance: CreditBalance }>;
  changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
  reconcileStripeSpaceSubscription(
    spaceId: string,
    input: {
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
      readonly stripePriceId?: string;
      readonly planCode: string;
      readonly status: string;
      readonly currentPeriodEndUnix?: number;
    },
  ): Promise<unknown>;
  // --- Connections (§9) ---
  readonly connections: {
    listOperatorConnectionDefaults(): Promise<
      readonly OperatorConnectionDefault[]
    >;
  };
  // --- OutputShares (§18) ---
  readonly outputShares: {
    createShare(request: {
      readonly fromSpaceId: string;
      readonly toSpaceId: string;
      readonly producerInstallationId: string;
      readonly outputs: readonly {
        readonly name: string;
        readonly alias?: string;
        readonly sensitive?: boolean;
      }[];
    }): Promise<OutputShare>;
    listForSpace(spaceId: string): Promise<readonly OutputShare[]>;
    getShare(id: string): Promise<OutputShare | undefined>;
    approveShare(id: string): Promise<OutputShare>;
    revokeShare(id: string): Promise<OutputShare>;
  };
  listConnections(spaceId: string): Promise<ListConnectionsResponse>;
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  getConnection(connectionId: string): Promise<Connection>;
  /**
   * Registers a Space-owned provider-credential Connection (§9 / §8 Provider
   * Env Set). The control surface only ever builds Space-scoped requests here
   * (the guided-token / OAuth credential-helper paths); the response is the
   * public {@link Connection} projection, which carries NO secret `values`.
   */
  createConnection(request: CreateConnectionRequest): Promise<ConnectionResponse>;
  /**
   * OPTIONAL Cloudflare credential OAuth helper. Present only when the operator
   * has wired the upstream OAuth client (the `TAKOSUMI_CLOUDFLARE_OAUTH_*`
   * env set); absent otherwise, so the dashboard falls back to the guided-token
   * deep-link path and never shows a dead OAuth button. `start` returns the
   * provider authorize URL + signed state; `complete` exchanges the callback
   * code and yields a Space-owned `provider_env_set` create request.
   */
  readonly connectionOAuth?: {
    readonly cloudflare?: {
      /**
       * `subject` is the authenticated account subject of the cookie-gated
       * caller. The helper signs it INTO the OAuth state so the cross-site
       * callback (which carries no session cookie) can authorize from the
       * signed state alone. See {@link handleControlRoute}.
       */
      start(input: {
        readonly subject: string;
        readonly spaceId: string;
        readonly displayName?: string;
        readonly successRedirectUri?: string;
      }): Promise<ConnectionOAuthStartResponse>;
      /**
       * Verifies the signed state and returns BOTH the connection-create
       * request and the `subject` that was signed in at `start` time. The
       * callback authorizes the Space against that `subject`; `subject` is
       * absent only for legacy/unsigned states, which the callback rejects.
       */
      complete(input: {
        readonly code: string;
        readonly state: string;
        readonly query: Readonly<Record<string, string>>;
      }): Promise<{
        readonly request: CreateConnectionRequest;
        readonly subject?: string;
      }>;
    };
  };
  // --- Runs (§6.8 / §19 / §23) ---
  createInstallationPlan(installationId: string): Promise<PlanRunResponse>;
  createInstallationDestroyPlan(
    installationId: string,
  ): Promise<PlanRunResponse>;
  /**
   * Reads the internal PlanRun projection by id. The control surface uses it to
   * resolve a plan run's owning Space (for the apply space-permission gate) and
   * the reviewed plan fields the apply guard is built from.
   */
  getPlanRun(id: string): Promise<PlanRunResponse>;
  /**
   * Applies a reviewed PlanRun (§31 GUI deploy). The controller revalidates
   * every apply precondition (plan succeeded / policy passed / immutable plan
   * artifact present / not a drift_check / not already applied / destructive
   * confirmation) and rejects with a typed `failed_precondition` otherwise.
   */
  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse>;
  // --- Deployments (§21 / §30) ---
  /**
   * Lists an Installation's Deployment ledger (§30 `GET
   * /api/installations/:id/deployments`). The control surface resolves the
   * Installation's owning Space first and space-permission gates before calling
   * this; the returned `Deployment` rows only carry the allowlist-projected
   * `outputsPublic` map (sensitive outputs never enter the ledger row).
   */
  listDeployments(installationId: string): Promise<ListDeploymentsResponse>;
  /**
   * Reads one Deployment ledger record by id (§30 `GET /api/deployments/:id`).
   * Used by the control surface to resolve a Deployment's owning Space (for the
   * space-permission gate) and to project its public fields. A missing id is a
   * typed `not_found`.
   */
  getDeployment(id: string): Promise<Deployment>;
  /**
   * Creates a rollback PLAN run for a Deployment (§30 `POST
   * /api/deployments/:id/rollback-plan`): re-plans the Deployment's Installation
   * pinned to that Deployment's source snapshot. The plan then flows through the
   * normal approve/apply path, so the response is a `PlanRunResponse`.
   */
  createDeploymentRollbackPlan(
    deploymentId: string,
  ): Promise<PlanRunResponse>;
  getRun(id: string): Promise<Run>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  getRunLogs(id: string): Promise<unknown>;
  /**
   * Reads a plan / destroy_plan Run's public cost projection (`GET
   * /v1/control/runs/:id/cost`). The control surface resolves the Run's owning
   * Space first and space-permission gates before calling this. The returned
   * {@link RunCostInfo} carries only the billing reservation values the
   * controller already computed at plan time (estimated / available credits,
   * reservation status, credit-shortfall + plan-limit reasons) — no cost is
   * computed here and no secret material is returned.
   */
  getRunCost(id: string): Promise<RunCostInfo>;
  // --- Sources (§6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(spaceId: string): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<Source>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<unknown>;
  listSourceSnapshots(sourceId: string): Promise<ListSourceSnapshotsResponse>;
  createSourceCompatibilityCheck(
    sourceId: string,
    request?: CreateSourceCompatibilityCheckRequest,
  ): Promise<CapsuleCompatibilityReportResponse>;
  // --- Providers (§7 / §8) ---
  listProviderTemplates(): Promise<ListProviderTemplatesResponse>;
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
  return (
    pathname === CONTROL_PREFIX || pathname.startsWith(`${CONTROL_PREFIX}/`)
  );
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
        error_description:
          error instanceof Error ? error.message : String(error),
      },
      DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
    );
  }
  return json({ error: "internal_error" }, 500);
}

function controllerErrorCode(
  error: unknown,
): DeployControlErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    code in DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE
    ? (code as DeployControlErrorCode)
    : undefined;
}

function controlPlaneUnavailable(): Response {
  return json(
    {
      error: "feature_unavailable",
      error_description: "The control plane is temporarily unavailable.",
    },
    503,
  );
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

  // The credential-OAuth callback is the ONE control route reached by a
  // top-level CROSS-SITE redirect (dash.cloudflare.com -> this origin). The
  // browser sends no Authorization header and, because the `takosumi_session`
  // cookie is `SameSite=Strict`, does NOT send the session cookie either, so
  // `requireAccountSession` here would always 401 and the user would land on a
  // raw 401 JSON instead of being redirected back to /connections. The callback
  // therefore authenticates from the authenticated subject embedded in the
  // HMAC-signed OAuth state (minted by the cookie-authenticated `start`), not
  // from the session cookie. Route it BEFORE the session gate.
  if (isCloudflareOAuthCallbackPath(url.pathname, request.method)) {
    const operations = context.operations;
    if (!operations) return controlPlaneUnavailable();
    try {
      return await completeCloudflareOAuth(operations, store, url);
    } catch (error) {
      return controllerErrorResponse(error);
    }
  }

  // Authn gate: every other control route requires a live account session. The
  // dashboard presents the HttpOnly `takosumi_session` cookie; PAT/header
  // callers are accepted by `requireAccountSession` too. Space authorization is
  // enforced per route below after the target Space is known.
  const session = await requireAccountSession({ request, store });
  if (!session.ok) return session.response;

  const operations = context.operations;
  if (!operations) return controlPlaneUnavailable();

  const tail = url.pathname.slice(CONTROL_PREFIX.length); // e.g. "/spaces"
  try {
    return await dispatch({ request, url, tail, operations, store, session });
  } catch (error) {
    return controllerErrorResponse(error);
  }
}

/**
 * True for `GET /v1/control/connections/cloudflare/oauth/callback`. This is the
 * only control route reached cross-site, so it is dispatched before the
 * `SameSite=Strict` session-cookie gate and authorizes from the signed OAuth
 * state instead (see {@link handleControlRoute}).
 */
function isCloudflareOAuthCallbackPath(
  pathname: string,
  method: string,
): boolean {
  return (
    method === "GET" &&
    pathname ===
      `${CONTROL_PREFIX}/connections/cloudflare/oauth/callback`
  );
}

interface DispatchInput {
  readonly request: Request;
  readonly url: URL;
  readonly tail: string;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: { readonly subject: string };
}

async function dispatch(input: DispatchInput): Promise<Response> {
  const { request, url, tail, operations, store } = input;
  const method = request.method;
  const segments = tail.split("/").filter(Boolean); // ["spaces", ":id", ...]

  // GET/POST /v1/control/spaces
  if (segments.length === 1 && segments[0] === "spaces") {
    if (method === "GET") {
      return await listSpaces(operations, store, input.session.subject);
    }
    if (method === "POST") {
      return await createSpace(request, operations, input.session.subject);
    }
    return methodNotAllowed("GET, POST");
  }

  // /v1/control/spaces/:spaceId ; /v1/control/spaces/:spaceId/...
  if (segments[0] === "spaces" && segments.length >= 2) {
    const spaceId = decodeURIComponent(segments[1] ?? "");
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method === "GET")
        return json({ space: await operations.spaces.getSpace(spaceId) });
      if (method === "PATCH")
        return await updateSpace(request, operations, spaceId);
      return methodNotAllowed("GET, PATCH");
    }
    const leaf = segments[2];
    if (leaf === "members") {
      // /v1/control/spaces/:spaceId/members[/:subject]. The Space is already
      // resolved server-side and namespace-gated above; the member handlers add
      // the membership-ROLE gate (list = any member; mutate = owner/admin;
      // role-change + remove = owner-only with a last-owner guard).
      if (segments.length === 3) {
        if (method === "GET") {
          return await listSpaceMembers(
            operations,
            spaceId,
            input.session.subject,
          );
        }
        if (method === "POST") {
          return await addSpaceMember(
            request,
            operations,
            spaceId,
            input.session.subject,
          );
        }
        return methodNotAllowed("GET, POST");
      }
      if (segments.length === 4) {
        const targetSubject = decodeURIComponent(segments[3] ?? "");
        if (method === "PATCH") {
          return await changeSpaceMemberRole(
            request,
            operations,
            spaceId,
            input.session.subject,
            targetSubject,
          );
        }
        if (method === "DELETE") {
          return await removeSpaceMember(
            operations,
            spaceId,
            input.session.subject,
            targetSubject,
          );
        }
        return methodNotAllowed("PATCH, DELETE");
      }
    }
    if (leaf === "installations" && segments.length === 3) {
      if (method === "GET")
        return await listSpaceInstallations(operations, spaceId);
      if (method === "POST") {
        return await createInstallation(
          request,
          operations,
          store,
          input.session.subject,
          spaceId,
        );
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
    if (leaf === "backups" && segments.length === 3) {
      if (method === "GET") {
        const backups = await operations.backups.listBackups(spaceId);
        return json({ backups } satisfies ListBackupsResponse);
      }
      if (method === "POST") {
        const backup = await operations.backups.createBackup({ spaceId });
        return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
      }
      return methodNotAllowed("GET, POST");
    }
    if (leaf === "billing" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getSpaceBilling(spaceId));
    }
    if (leaf === "usage" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.listSpaceUsage(spaceId));
    }
    if (leaf === "credit-reservations" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.listSpaceCreditReservations(spaceId));
    }
    if (
      leaf === "credits" &&
      segments.length === 4 &&
      segments[3] === "top-up"
    ) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await topUpSpaceCredits(request, operations, spaceId);
    }
    if (
      leaf === "subscription" &&
      segments.length === 4 &&
      segments[3] === "change"
    ) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await changeSpaceSubscription(request, operations, spaceId);
    }
    if (leaf === "plan-update" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await spacePlanUpdate(operations, spaceId);
    }
  }

  // /v1/control/installations/:id ; .../plan ; .../destroy-plan ; .../dependencies
  if (segments[0] === "installations" && segments.length >= 2) {
    const installationId = decodeURIComponent(segments[1] ?? "");
    const installation =
      await operations.installations.getInstallation(installationId);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: installation.spaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ installation: publicInstallation(installation) });
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
    if (leaf === "backups" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backup = await operations.backups.createBackup({
        spaceId: installation.spaceId,
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "deployments" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listInstallationDeployments(operations, installationId);
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await createDependency(
        request,
        operations,
        store,
        input.session.subject,
        installationId,
      );
    }
    if (leaf === "deployment-profile" && segments.length === 3) {
      if (method === "GET") {
        return await getDeploymentProfile(operations, installation);
      }
      if (method === "PUT") {
        return await putDeploymentProfile(request, operations, installation);
      }
      return methodNotAllowed("GET, PUT");
    }
  }

  // /v1/control/install-configs
  if (segments.length === 1 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listInstallConfigs(
      operations,
      store,
      input.session.subject,
      url,
    );
  }

  // /v1/control/providers
  if (segments.length === 1 && segments[0] === "providers") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json(await operations.listProviderTemplates());
  }

  // /v1/control/dependencies/:id
  if (segments[0] === "dependencies" && segments.length === 2) {
    const dependencyId = decodeURIComponent(segments[1] ?? "");
    if (method !== "DELETE") return methodNotAllowed("DELETE");
    return await deleteDependency(
      operations,
      store,
      input.session.subject,
      dependencyId,
    );
  }

  // /v1/control/sources ; /v1/control/sources/:id/sync ; .../snapshots ; .../compatibility-check
  if (segments[0] === "sources") {
    if (segments.length === 1) {
      if (method === "GET") {
        return await listSources(operations, store, input.session.subject, url);
      }
      if (method === "POST") {
        return await createSource(
          request,
          operations,
          store,
          input.session.subject,
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3 && segments[2] === "sync") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const source = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      return jsonStatus(await operations.createSourceSync(sourceId), 201);
    }
    if (segments.length === 3 && segments[2] === "snapshots") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "GET") return methodNotAllowed("GET");
      const source = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      return json(await operations.listSourceSnapshots(sourceId));
    }
    if (segments.length === 3 && segments[2] === "compatibility-check") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const source = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      const body = await readOptionalJsonObject(request);
      if (body === null) {
        return json({ error: "invalid_json" }, 400);
      }
      const sourceSnapshotId = stringValue(body.sourceSnapshotId);
      const installationId = stringValue(body.installationId);
      // Curated catalog deep-link path: when no Installation exists yet, gate
      // the pre-install check against the catalog's bounded InstallConfig so a
      // vetted first-party module is judged by its own minimal allowlist
      // (the instance-wide default allowlist is never widened — see
      // CreateSourceCompatibilityCheckRequest.installConfigId).
      const installConfigId = stringValue(body.installConfigId);
      const compatibilityRequest: CreateSourceCompatibilityCheckRequest = {
        ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
        ...(installationId ? { installationId } : {}),
        ...(installConfigId ? { installConfigId } : {}),
      };
      return jsonStatus(
        await operations.createSourceCompatibilityCheck(
          sourceId,
          compatibilityRequest,
        ),
        201,
      );
    }
  }

  // /v1/control/plan-runs/:planRunId/apply — session-authed GUI deploy (§31).
  if (segments[0] === "plan-runs" && segments.length === 3) {
    const planRunId = decodeURIComponent(segments[1] ?? "");
    if (segments[2] !== "apply") return json({ error: "not_found" }, 404);
    if (method !== "POST") return methodNotAllowed("POST");
    return await applyPlanRun(
      request,
      operations,
      store,
      input.session.subject,
      planRunId,
    );
  }

  // /v1/control/deployments/:deploymentId ; .../rollback-plan — session-authed
  // deployment read + rollback (§30 GUI deploy). Each resolves the Deployment to
  // learn its owning Space, then space-permission gates before projecting /
  // mutating. The read returns ONLY the allowlist-projected outputsPublic (no
  // raw output envelope, no outputSnapshotId pointer, no sensitive values).
  if (segments[0] === "deployments" && segments.length >= 2) {
    const deploymentId = decodeURIComponent(segments[1] ?? "");
    const deployment = await operations.getDeployment(deploymentId);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: deployment.spaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ deployment: publicDeployment(deployment) });
    }
    if (segments[2] === "rollback-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return jsonStatus(
        await operations.createDeploymentRollbackPlan(deploymentId),
        201,
      );
    }
    return json({ error: "not_found" }, 404);
  }

  // /v1/control/runs/:id ; .../approve ; .../logs ; .../cost
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    const run = await operations.getRun(runId);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: run.spaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ run });
    }
    const leaf = segments[2];
    if (leaf === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRun(
        request,
        operations,
        runId,
        input.session.subject,
      );
    }
    if (leaf === "logs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunLogs(runId));
    }
    if (leaf === "cost" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Public, non-secret cost projection: the billing reservation values the
      // controller already computed at plan time (estimated / available credits,
      // reservation status, credit-shortfall reasons). Space-gated above.
      return json({ cost: await operations.getRunCost(runId) });
    }
  }

  // /v1/control/run-groups/:id ; .../approve
  if (segments[0] === "run-groups" && segments.length >= 2) {
    const runGroupId = decodeURIComponent(segments[1] ?? "");
    const existing = await operations.runGroups.getRunGroup(runGroupId);
    if (!existing) return json({ error: "not_found" }, 404);
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: existing.runGroup.spaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(existing);
    }
    if (segments[2] === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRunGroup(operations, runGroupId);
    }
  }

  // /v1/control/connections?spaceId=  (GET list / POST create)
  if (segments.length === 1 && segments[0] === "connections") {
    if (method === "GET") {
      return await listControlConnections(
        operations,
        store,
        input.session.subject,
        url,
      );
    }
    if (method === "POST") {
      return await createControlConnection(
        request,
        operations,
        store,
        input.session.subject,
      );
    }
    return methodNotAllowed("GET, POST");
  }

  // /v1/control/connections/cloudflare/oauth/start — credential OAuth helper
  // (present only when the operator wired the upstream client). The cookie-
  // authenticated `start` embeds the authenticated subject into the signed
  // OAuth state. The matching `callback` is handled BEFORE the session gate in
  // `handleControlRoute` (cross-site redirect, no strict cookie), so it never
  // reaches this dispatcher.
  if (
    segments[0] === "connections" &&
    segments[1] === "cloudflare" &&
    segments[2] === "oauth" &&
    segments.length === 4
  ) {
    if (segments[3] === "start") {
      if (method !== "POST") return methodNotAllowed("POST");
      return await startCloudflareOAuth(
        request,
        operations,
        store,
        input.session.subject,
        url,
      );
    }
  }

  // /v1/control/output-shares ; /v1/control/output-shares/:id/{approve,revoke}
  if (segments[0] === "output-shares") {
    if (segments.length === 1) {
      if (method === "GET") {
        return await listOutputShares(
          operations,
          store,
          input.session.subject,
          url,
        );
      }
      if (method === "POST") {
        return await createOutputShare(
          request,
          operations,
          store,
          input.session.subject,
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 3) {
      const shareId = decodeURIComponent(segments[1] ?? "");
      const action = segments[2];
      if (action === "approve") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await approveOutputShare(
          operations,
          store,
          input.session.subject,
          shareId,
        );
      }
      if (action === "revoke") {
        if (method !== "POST") return methodNotAllowed("POST");
        return await revokeOutputShare(
          operations,
          store,
          input.session.subject,
          shareId,
        );
      }
    }
  }

  // /v1/control/operator-connection-defaults?spaceId=
  if (segments.length === 1 && segments[0] === "operator-connection-defaults") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listOperatorConnectionDefaults(
      operations,
      store,
      input.session.subject,
      url,
    );
  }

  return json({ error: "not_found" }, 404);
}

// --- Spaces ----------------------------------------------------------------

async function listSpaces(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const spaces = await operations.spaces.listSpaces();
  const visible: Space[] = [];
  for (const space of spaces) {
    if (
      await canAccessSpace({
        operations,
        store,
        subject: sessionSubject,
        spaceId: space.id,
        space,
      })
    ) {
      visible.push(space);
    }
  }
  return json({ spaces: visible });
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
    return json(
      {
        error: "invalid_request",
        error_description: "handle is required",
      },
      400,
    );
  }
  // ownerUserId is the session account id (the authenticated subject); the
  // dashboard never supplies it. The membership ledger seeds no row here; the
  // member handlers grant the namespace owner an implicit active-owner row (see
  // `effectiveMembers`) so they can bootstrap the first membership.
  const space = await operations.spaces.createSpace({
    handle,
    displayName: displayName ?? handle,
    type,
    ownerUserId: sessionSubject,
  });
  return jsonStatus({ space }, 201);
}

async function updateSpace(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const patch: {
    displayName?: string;
    policy?: PolicyConfig;
  } = {};
  if (body.displayName !== undefined) {
    const displayName = stringValue(body.displayName)?.trim();
    if (!displayName) {
      return json(
        {
          error: "invalid_argument",
          error_description: "displayName is required",
        },
        400,
      );
    }
    patch.displayName = displayName;
  }
  if (body.policy !== undefined) {
    if (!isPlainJsonObject(body.policy)) {
      return json(
        {
          error: "invalid_argument",
          error_description: "policy must be an object",
        },
        400,
      );
    }
    patch.policy = body.policy as PolicyConfig;
  }
  if (patch.displayName === undefined && patch.policy === undefined) {
    return json(
      {
        error: "invalid_argument",
        error_description: "displayName or policy is required",
      },
      400,
    );
  }
  return json({ space: await operations.spaces.updateSpace(spaceId, patch) });
}

// --- Members (Space membership / roles) ------------------------------------
//
// The Space is resolved server-side and namespace-gated by `requireSpaceAccess`
// in dispatch BEFORE these run. On top of that namespace gate, every member
// handler enforces the membership-ROLE gate from the membership ledger itself:
//
//   - list:        any active member of the Space (member 可),
//   - add/invite:  owner or admin only; a POST that overwrites an EXISTING
//                  active owner is owner-only and last-owner-guarded (same as
//                  the PATCH path) so POST cannot escalate or orphan,
//   - role change: owner only,
//   - remove:      owner only, and the LAST remaining owner can never be removed
//                  or demoted (last-owner guard) so a Space is never left
//                  unmanaged.
//
// The spaces domain seeds NO membership row when a Space is created, so the
// roster starts empty. To keep the mutation gate aligned with the namespace
// gate (which already trusts `Space.ownerUserId`) and to let the namespace owner
// bootstrap the first membership, every handler reads the roster via
// `effectiveMembers`, which adds an IMPLICIT active owner row for the namespace
// owner whenever the ledger has no active row for them. The first real
// `upsertMember` the owner performs persists a concrete row.
//
// `targetSubject` / the session subject are matched against the membership
// ledger's `accountId`; the spaceId is never taken from the client body.

const MEMBER_ROLES: readonly ControlSpaceRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

function controlRoleValue(value: unknown): ControlSpaceRole | undefined {
  return typeof value === "string" &&
    (MEMBER_ROLES as readonly string[]).includes(value)
    ? (value as ControlSpaceRole)
    : undefined;
}

function membersUnavailable(): Response {
  return json(
    {
      error: "feature_unavailable",
      error_description: "Space membership management is not available.",
    },
    503,
  );
}

function memberForbidden(description: string): Response {
  return json({ error: "forbidden", error_description: description }, 403);
}

/** True when the membership has an active owner role. */
function isActiveOwner(member: PublicSpaceMember): boolean {
  return member.status === "active" && member.roles.includes("owner");
}

/** The caller's membership in the Space, matched by session subject. */
function findCaller(
  members: readonly PublicSpaceMember[],
  subject: string,
): PublicSpaceMember | undefined {
  return members.find((member) => member.accountId === subject);
}

/**
 * The membership ledger does not seed a row when a Space is created (the spaces
 * domain records only `Space.ownerUserId`), so a brand-new Space starts with an
 * EMPTY roster. To let the namespace owner bootstrap the first membership and to
 * keep the mutation gate aligned with the namespace gate (`canAccessSpace`,
 * which already trusts `Space.ownerUserId`), synthesize an implicit ACTIVE owner
 * row for the namespace owner whenever the ledger has no active row for them.
 *
 * This is read-only: it does not write to the ledger. The first real
 * `upsertMember` the owner performs persists a concrete row; once any active
 * owner row exists for the namespace owner, the synthetic row is not added.
 */
function withImplicitNamespaceOwner(
  members: readonly PublicSpaceMember[],
  spaceId: string,
  ownerUserId: string,
): readonly PublicSpaceMember[] {
  const existing = members.find(
    (member) => member.accountId === ownerUserId,
  );
  // Only synthesize when the namespace owner has NO active row. A suspended /
  // invited row for the owner is left as-is (the owner explicitly changed it),
  // and an existing active row already grants them management.
  if (existing && existing.status === "active") return members;
  if (existing) {
    // Replace a non-active owner row with the implicit active-owner view so the
    // namespace owner is never locked out of their own Space.
    return members.map((member) =>
      member.accountId === ownerUserId ? implicitOwner(spaceId, ownerUserId) : member,
    );
  }
  return [implicitOwner(spaceId, ownerUserId), ...members];
}

/** The synthetic active-owner projection for a namespace owner with no row. */
function implicitOwner(
  spaceId: string,
  ownerUserId: string,
): PublicSpaceMember {
  const now = new Date(0).toISOString();
  return {
    id: `implicit-owner:${ownerUserId}`,
    spaceId,
    accountId: ownerUserId,
    roles: ["owner"],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolves the Space's namespace owner (`Space.ownerUserId`) server-side and
 * returns the effective member roster (ledger rows + the implicit namespace
 * owner). The Space is already namespace-gated by `requireSpaceAccess` in
 * dispatch; we re-read it here only to learn the owner subject, never from the
 * client body.
 */
async function effectiveMembers(
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<readonly PublicSpaceMember[]> {
  const members = await operations.members!.listMembers(spaceId);
  const space = await operations.spaces.getSpace(spaceId);
  return withImplicitNamespaceOwner(members, spaceId, space.ownerUserId);
}

async function listSpaceMembers(
  operations: ControlPlaneOperations,
  spaceId: string,
  subject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
  const members = await effectiveMembers(operations, spaceId);
  // List is member-visible: the caller must be an active member of THIS Space.
  // The namespace gate (requireSpaceAccess) already passed, but membership is a
  // separate ledger — a namespace owner who is not a recorded member still sees
  // the roster (they own the Space via the implicit owner row), otherwise an
  // active member must be present.
  const caller = findCaller(members, subject);
  if (caller && caller.status !== "active") {
    return memberForbidden("Your membership in this Space is not active.");
  }
  return json({ members });
}

async function addSpaceMember(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
  subject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const accountId = stringValue(body.accountId) ?? stringValue(body.subject);
  if (!accountId) {
    return json(
      {
        error: "invalid_argument",
        error_description: "accountId is required",
      },
      400,
    );
  }
  const role = body.role === undefined ? "member" : controlRoleValue(body.role);
  if (!role) {
    return json(
      {
        error: "invalid_argument",
        error_description: "role must be one of owner, admin, member, viewer",
      },
      400,
    );
  }
  // Mutation gate: only an active owner/admin of this Space may add members. The
  // roster includes the implicit namespace-owner row so the Space owner can
  // always bootstrap the first membership.
  const members = await effectiveMembers(operations, spaceId);
  const caller = findCaller(members, subject);
  if (!caller || caller.status !== "active") {
    return memberForbidden("Only an active member can manage members.");
  }
  if (!caller.roles.includes("owner") && !caller.roles.includes("admin")) {
    return memberForbidden("Only an owner or admin can add members.");
  }
  // Only an owner may grant the owner role (admins cannot escalate).
  if (role === "owner" && !caller.roles.includes("owner")) {
    return memberForbidden("Only an owner can grant the owner role.");
  }
  // The membership store is keyed by `spaceId:accountId` and `upsertMember`
  // OVERWRITES, so a POST against an EXISTING member is a role change in
  // disguise. Route an existing-active-owner upsert through the SAME gates the
  // dedicated PATCH path (`changeSpaceMemberRole`) enforces, otherwise an admin
  // could demote a sitting owner and either role could strip the last owner —
  // privilege escalation / Space orphaning straight through POST. This also
  // covers the implicit namespace-owner row (active owner), so a POST can never
  // silently strip the namespace owner who has no ledger row yet.
  const target = findCaller(members, accountId);
  if (target && isActiveOwner(target)) {
    // Changing an existing active OWNER's role is owner-only (admins cannot
    // touch an owner), matching `changeSpaceMemberRole`.
    if (!caller.roles.includes("owner")) {
      return memberForbidden(
        "Only an owner can change an existing owner's role.",
      );
    }
    // Last-owner guard: never let a POST drop the sole remaining owner.
    if (role !== "owner" && activeOwnerCount(members) <= 1) {
      return memberForbidden(
        "Cannot demote the last owner; promote another owner first.",
      );
    }
  }
  const member = await operations.members.upsertMember({
    spaceId,
    accountId,
    roles: [role],
    status: "active",
    actor: actorFor(caller),
  });
  return jsonStatus({ member }, 201);
}

async function changeSpaceMemberRole(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
  subject: string,
  targetSubject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const roles = parseRolesField(body.roles ?? body.role);
  if (!roles) {
    return json(
      {
        error: "invalid_argument",
        error_description:
          "roles must be one or more of owner, admin, member, viewer",
      },
      400,
    );
  }
  const members = await effectiveMembers(operations, spaceId);
  const caller = findCaller(members, subject);
  // Role change is owner-only.
  if (!caller || !isActiveOwner(caller)) {
    return memberForbidden("Only an owner can change member roles.");
  }
  const target = findCaller(members, targetSubject);
  if (!target) {
    return json({ error: "not_found", error_description: "member not found" }, 404);
  }
  // Last-owner guard: demoting the sole remaining owner would leave the Space
  // unmanaged. Reject if the target is currently the only active owner and the
  // new role set drops the owner role.
  if (
    isActiveOwner(target) &&
    !roles.includes("owner") &&
    activeOwnerCount(members) <= 1
  ) {
    return memberForbidden(
      "Cannot demote the last owner; promote another owner first.",
    );
  }
  const member = await operations.members.upsertMember({
    spaceId,
    accountId: targetSubject,
    roles,
    status: "active",
    actor: actorFor(caller),
  });
  return json({ member });
}

async function removeSpaceMember(
  operations: ControlPlaneOperations,
  spaceId: string,
  subject: string,
  targetSubject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
  const members = await effectiveMembers(operations, spaceId);
  const caller = findCaller(members, subject);
  // Remove is owner-only.
  if (!caller || !isActiveOwner(caller)) {
    return memberForbidden("Only an owner can remove members.");
  }
  const target = findCaller(members, targetSubject);
  if (!target) {
    return json({ error: "not_found", error_description: "member not found" }, 404);
  }
  // Last-owner guard: never remove the sole remaining owner.
  if (isActiveOwner(target) && activeOwnerCount(members) <= 1) {
    return memberForbidden(
      "Cannot remove the last owner; promote another owner first.",
    );
  }
  // The membership store has no hard-delete, so removal is a soft-remove: the
  // membership is suspended (its roles are preserved for audit but it no longer
  // grants access).
  const member = await operations.members.upsertMember({
    spaceId,
    accountId: targetSubject,
    roles: target.roles,
    status: "suspended",
    actor: actorFor(caller),
  });
  return json({ member });
}

/** Active owners in the Space (used by the last-owner guard). */
function activeOwnerCount(members: readonly PublicSpaceMember[]): number {
  return members.filter(isActiveOwner).length;
}

/**
 * Parses a `roles` field that may be a single role string or an array. Returns
 * a de-duplicated, non-empty role list, or `undefined` when any entry is not a
 * known role.
 */
function parseRolesField(
  value: unknown,
): readonly ControlSpaceRole[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (raw.length === 0) return undefined;
  const roles: ControlSpaceRole[] = [];
  for (const entry of raw) {
    const role = controlRoleValue(entry);
    if (!role) return undefined;
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

/** Builds the membership-service actor from the caller's membership. */
function actorFor(caller: PublicSpaceMember): MembershipActor {
  return {
    actorAccountId: caller.accountId,
    roles: [...caller.roles],
    requestId: `ctrl-${caller.accountId}-${Date.now()}`,
  };
}

// --- Installations ---------------------------------------------------------

async function listSpaceInstallations(
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const records = await operations.installations.listInstallations(spaceId);
  return json({
    installations: records.map(publicInstallation),
  });
}

/**
 * Lists an Installation's Deployment ledger for the dashboard session. The
 * caller has already resolved the Installation and space-permission gated on its
 * Space (see dispatch); each row is projected to drop the raw OutputSnapshot
 * pointer and carries only the allowlist-projected `outputsPublic`.
 */
async function listInstallationDeployments(
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  const { deployments } = await operations.listDeployments(installationId);
  return json({ deployments: deployments.map(publicDeployment) });
}

async function getInstallation(
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  const installation =
    await operations.installations.getInstallation(installationId);
  return json({
    installation: publicInstallation(installation),
  });
}

async function createInstallation(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const name = stringValue(body.name);
  const environment = stringValue(body.environment);
  const sourceId = stringValue(body.sourceId);
  const installConfigId = stringValue(body.installConfigId);
  if (!name || !environment || !sourceId || !installConfigId) {
    return json(
      {
        error: "invalid_request",
        error_description:
          "name, environment, sourceId, and installConfigId are required",
      },
      400,
    );
  }
  const source = await operations.getSource(sourceId);
  if (source.spaceId !== spaceId) {
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: source.spaceId,
      subject: sessionSubject,
    });
    if (!auth.ok) return auth.response;
    return json(
      {
        error: "invalid_request",
        error_description: "sourceId must belong to the target Space.",
      },
      400,
    );
  }
  const installation = await operations.installations.createInstallation({
    spaceId,
    name,
    environment,
    sourceId,
    installConfigId,
  });
  return jsonStatus({ installation: publicInstallation(installation) }, 201);
}

async function getDeploymentProfile(
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const profile =
    await operations.installations.getDeploymentProfileByInstallation(
      installation.id,
      installation.environment,
    );
  return json({ deploymentProfile: profile ?? null });
}

async function putDeploymentProfile(
  request: Request,
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const parsed = parseProviderBindings(body.bindings);
  if (!parsed.ok) {
    return json(
      {
        error: "invalid_request",
        error_description: parsed.message,
      },
      400,
    );
  }
  const existing =
    await operations.installations.getDeploymentProfileByInstallation(
      installation.id,
      installation.environment,
    );
  const now = new Date().toISOString();
  const profile = await operations.installations.putDeploymentProfile({
    id:
      existing?.id ??
      `dpf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    spaceId: installation.spaceId,
    installationId: installation.id,
    environment: installation.environment,
    bindings: parsed.bindings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  return json({ deploymentProfile: profile });
}

async function listInstallConfigs(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  // Without a spaceId only built-in shared configs (spaceId-less configs) are
  // returned; with one, built-ins plus that Space's own configs —
  // mirroring the §30 `/api/install-configs` projection.
  const official = (await operations.installations.listInstallConfigs()).filter(
    (config) => config.spaceId === undefined,
  );
  if (spaceId !== undefined) {
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId,
      subject: sessionSubject,
    });
    if (!auth.ok) return auth.response;
  }
  const scoped =
    spaceId === undefined
      ? []
      : await operations.installations.listInstallConfigs(spaceId);
  return json({
    installConfigs: [...official, ...scoped].map(publicInstallConfig),
  });
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
  store: AccountsStore,
  sessionSubject: string,
  consumerInstallationId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const producerInstallationId = stringValue(body.producerInstallationId);
  if (!producerInstallationId) {
    return json(
      {
        error: "invalid_request",
        error_description: "producerInstallationId is required",
      },
      400,
    );
  }
  // The consumer is the path Installation; resolve its Space so the edge is
  // created in the right Space (mirrors the §30 dependency-create handler).
  const consumer = await operations.installations.getInstallation(
    consumerInstallationId,
  );
  const consumerAuth = await requireSpaceAccess({
    operations,
    store,
    spaceId: consumer.spaceId,
    subject: sessionSubject,
  });
  if (!consumerAuth.ok) return consumerAuth.response;
  const producer = await operations.installations.getInstallation(
    producerInstallationId,
  );
  const producerAuth = await requireSpaceAccess({
    operations,
    store,
    spaceId: producer.spaceId,
    subject: sessionSubject,
  });
  if (!producerAuth.ok) return producerAuth.response;
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
  store: AccountsStore,
  sessionSubject: string,
  dependencyId: string,
): Promise<Response> {
  const existing = await operations.dependencies.getDependency(dependencyId);
  if (!existing) return json({ error: "not_found" }, 404);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: existing.spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
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
    return json(
      {
        error: "invalid_request",
        error_description: "limit must be a positive integer",
      },
      400,
    );
  }
  const events = await operations.activity.list(spaceId, limit);
  return json({ events });
}

// --- Billing ---------------------------------------------------------------

async function topUpSpaceCredits(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const credits = numberValue(body.credits);
  if (credits === undefined || credits <= 0) {
    return json(
      {
        error: "invalid_argument",
        error_description: "credits must be a positive integer",
      },
      400,
    );
  }
  return json(await operations.topUpSpaceCredits(spaceId, { credits }));
}

async function changeSpaceSubscription(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  if (!isPlainJsonObject(body.billingSettings)) {
    return json(
      {
        error: "invalid_argument",
        error_description: "billingSettings must be an object",
      },
      400,
    );
  }
  return json(
    await operations.changeSpaceSubscription(spaceId, {
      billingSettings: body.billingSettings as BillingSettings,
    }),
  );
}

// --- Sources ---------------------------------------------------------------

async function listSources(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId query parameter is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json(await operations.listSources(spaceId));
}

async function createSource(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const spaceId = stringValue(body.spaceId);
  const name = stringValue(body.name);
  const sourceUrl = stringValue(body.url);
  if (!spaceId || !name || !sourceUrl) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId, name, and url are required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const authConnectionId = stringValue(body.authConnectionId);
  if (authConnectionId) {
    const connection = await operations.getConnection(authConnectionId);
    if (connection.scope !== "space" || connection.spaceId !== spaceId) {
      const connectionSpaceId = connection.spaceId;
      if (connectionSpaceId) {
        const connectionAuth = await requireSpaceAccess({
          operations,
          store,
          spaceId: connectionSpaceId,
          subject: sessionSubject,
        });
        if (!connectionAuth.ok) return connectionAuth.response;
      }
      return json(
        {
          error: "invalid_request",
          error_description:
            "authConnectionId must belong to the target Space.",
        },
        400,
      );
    }
  }
  const requestBody: CreateSourceRequest = {
    spaceId,
    name,
    url: sourceUrl,
    ...(stringValue(body.defaultRef)
      ? { defaultRef: stringValue(body.defaultRef) }
      : {}),
    ...(stringValue(body.defaultPath)
      ? { defaultPath: stringValue(body.defaultPath) }
      : {}),
    ...(authConnectionId ? { authConnectionId } : {}),
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
  const reason = body ? stringValue(body.reason) : undefined;
  const run = await operations.approveRun(runId, {
    approvedBy: sessionSubject,
    ...(reason ? { reason } : {}),
  });
  return json({ run });
}

/**
 * Applies a reviewed PlanRun on behalf of the dashboard session (§31 GUI
 * deploy). The plan run is resolved first so the apply is space-permission gated
 * via the plan's OWNING Space (a session may not apply another Space's plan);
 * only then is the reviewed apply guard rebuilt server-side from that same plan
 * and handed to the controller, which independently re-checks every apply
 * precondition (succeeded plan / passed policy / immutable plan artifact / not a
 * drift_check / apply-once / destructive confirmation).
 */
async function applyPlanRun(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  planRunId: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const confirmDestructive = body?.confirmDestructive === true;
  const { planRun } = await operations.getPlanRun(planRunId);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: planRun.spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const applyRequest: CreateApplyRunRequest = {
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
    ...(confirmDestructive ? { confirmDestructive: true } : {}),
  };
  return jsonStatus(await operations.createApplyRun(applyRequest), 201);
}

/**
 * Rebuilds the `ApplyExpectedGuard` from the reviewed PlanRun. Mirrors the
 * service-side `applyExpectedGuardFromPlanRun` (deploy-control domain): the guard
 * pins the apply to the exact reviewed plan (digests + artifact + state guard),
 * and the controller structurally re-derives + compares it, so a tampered guard
 * cannot widen what is applied. Missing plan digest / artifact surface as a typed
 * `failed_precondition` from the controller (the plan has not completed).
 */
function applyExpectedGuardFromPlanRun(
  planRun: PublicPlanRun,
): ApplyExpectedGuard {
  return {
    planRunId: planRun.id,
    ...(planRun.installationId
      ? { installationId: planRun.installationId }
      : {}),
    ...(planRun.installationId
      ? { currentDeploymentId: planRun.installationCurrentDeploymentId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest ?? "",
    planArtifactDigest: planRun.planArtifact?.digest ?? "",
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
  };
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
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  // The accounts plane has no admin notion distinct from a normal session, so
  // a spaceId is REQUIRED here; operator-scoped Connection listing stays on the
  // operator-bearer §30 surface. (If/when the accounts plane grows an admin
  // role, this can branch to listOperatorConnections.)
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId query parameter is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json(await operations.listConnections(spaceId));
}

/**
 * Registers a Space-owned provider-credential Connection from the dashboard
 * session (§9 / §8 Provider Env Set). This is the credential-helper write path
 * the §31 connections screen calls same-origin: the guided-token paste and the
 * raw-token "詳細設定" fallback both POST here.
 *
 * Invariants enforced here (independent of any client coercion):
 *   - the session subject must own the target Space (space-permission gate);
 *   - the created Connection is ALWAYS `scope: "space"` — this surface can never
 *     create an operator-default connection (operator defaults stay on the
 *     bearer-gated §30 surface), so we force `scope` server-side;
 *   - the secret `values` are write-only: they are forwarded to the controller
 *     and NEVER read, logged, or echoed; the response is the public
 *     {@link Connection} projection, which has no `values` field.
 */
async function createControlConnection(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const spaceId = stringValue(body.spaceId) ?? stringValue(body.space_id);
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const provider = stringValue(body.provider) ?? "cloudflare";
  const values = stringRecord(body.values);
  if (!values || Object.keys(values).length === 0) {
    return json(
      {
        error: "invalid_request",
        error_description: "values is required",
      },
      400,
    );
  }
  const createRequest: CreateConnectionRequest = {
    spaceId,
    provider,
    // Cloudflare gets the dedicated api-token kind; anything else is a generic
    // user provider env set. Both are Space-scoped Provider Env Sets.
    kind: provider === "cloudflare" ? "cloudflare_api_token" : "provider_env_set",
    authMethod: "static_secret",
    // Force Space scope: the dashboard session surface never mints an operator
    // default. Any caller-supplied `scope` is ignored.
    scope: "space",
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
    ...(connectionScopeHints(body.scopeHints)
      ? { scopeHints: connectionScopeHints(body.scopeHints) }
      : {}),
    values,
  };
  const response = await operations.createConnection(createRequest);
  // `response.connection` is the public projection (no secret values).
  return jsonStatus(response, 201);
}

/**
 * Begins the optional Cloudflare credential OAuth helper flow. Returns the
 * provider authorize URL the dashboard sends the user to. When the operator has
 * NOT wired the upstream OAuth client, the helper is absent and we return a
 * typed `feature_unavailable` (501) so the dashboard hides the OAuth button and
 * keeps the guided-token path; the dashboard never renders a dead OAuth button.
 */
async function startCloudflareOAuth(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const helper = operations.connectionOAuth?.cloudflare;
  if (!helper) return connectionOAuthUnavailable();
  const body = (await readJsonObject(request)) ?? {};
  const spaceId =
    stringValue(body.spaceId) ??
    stringValue(body.space_id) ??
    stringValue(url.searchParams.get("spaceId") ?? undefined);
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const started = await helper.start({
    // Bind the OAuth state to the authenticated subject so the cross-site
    // callback can authorize without the SameSite=Strict session cookie.
    subject: sessionSubject,
    spaceId,
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
  });
  return json(started);
}

/**
 * Completes the Cloudflare OAuth helper flow. This is the BACKEND callback the
 * upstream redirects to via a top-level CROSS-SITE redirect, so the browser
 * sends no Authorization header and (because the session cookie is
 * `SameSite=Strict`) no session cookie either. This handler therefore does NOT
 * call `requireAccountSession`; it authorizes from the authenticated subject
 * that the cookie-gated `start` signed INTO the HMAC OAuth state. It exchanges
 * the code, registers the resulting Space-owned `provider_env_set` Connection,
 * and then REDIRECTS the browser back to the dashboard `/connections` screen
 * with a result query (never a JSON body, never the token). No new SPA route is
 * introduced — the dashboard owns `/connections` already and reads the
 * `connected` / `connection_error` query.
 *
 * Called directly by {@link handleControlRoute} BEFORE the session gate (it is
 * the one cross-site control route); it is never reached through `dispatch`.
 */
async function completeCloudflareOAuth(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  url: URL,
): Promise<Response> {
  const helper = operations.connectionOAuth?.cloudflare;
  if (!helper) return connectionOAuthUnavailable();
  const code = stringValue(url.searchParams.get("code") ?? undefined);
  const state = stringValue(url.searchParams.get("state") ?? undefined);
  if (!code || !state) {
    return redirectToConnections(url, { error: "missing_code" });
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  let completed: {
    readonly request: CreateConnectionRequest;
    readonly subject?: string;
  };
  try {
    completed = await helper.complete({ code, state, query });
  } catch {
    // Do not surface upstream/state failure detail in the redirect query. This
    // also covers a bad HMAC signature on the state (forged/stolen callback).
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  const createRequest = completed.request;
  const spaceId = createRequest.spaceId;
  // The subject is the account that initiated `start` (signed into the state).
  // Its absence means an unsigned/legacy state we will not trust for a mint.
  const subject = completed.subject;
  if (!spaceId || !subject) {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  // Re-check Space ownership against the SIGNED state's subject + spaceId so a
  // stolen or forged callback cannot mint a Connection into a Space the
  // authenticated initiator does not own. This is the callback's only authz —
  // there is no session cookie on a cross-site redirect.
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject,
  });
  if (!auth.ok) return redirectToConnections(url, { error: "forbidden" });
  try {
    // Force Space scope regardless of what the helper produced.
    await operations.createConnection({ ...createRequest, scope: "space" });
  } catch {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  return redirectToConnections(url, { connected: spaceId });
}

function connectionOAuthUnavailable(): Response {
  return json(
    {
      error: "feature_unavailable",
      error_description:
        "Cloudflare OAuth is not configured on this deployment.",
    },
    501,
  );
}

/**
 * Same-origin redirect back to the dashboard connections screen. Only opaque
 * status keys (`connected` / `connection_error`) ride the query — never the
 * token or any error detail.
 */
function redirectToConnections(
  url: URL,
  result: { readonly connected?: string; readonly error?: string },
): Response {
  const target = new URL("/connections", url.origin);
  if (result.connected) target.searchParams.set("connected", "1");
  if (result.error) target.searchParams.set("connection_error", result.error);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString() },
  });
}

async function listOperatorConnectionDefaults(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId query parameter is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({
    operatorConnectionDefaults:
      await operations.connections.listOperatorConnectionDefaults(),
  });
}

// --- OutputShares ----------------------------------------------------------

async function listOutputShares(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return json(
      {
        error: "invalid_request",
        error_description: "spaceId query parameter is required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({ shares: await operations.outputShares.listForSpace(spaceId) });
}

async function createOutputShare(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const fromSpaceId = stringValue(body.fromSpaceId);
  const toSpaceId = stringValue(body.toSpaceId);
  const producerInstallationId = stringValue(body.producerInstallationId);
  const outputs = outputShareEntries(body.outputs);
  const sensitivePolicy = outputShareSensitivePolicy(body.sensitivePolicy);
  if (!fromSpaceId || !toSpaceId || !producerInstallationId || !outputs) {
    return json(
      {
        error: "invalid_request",
        error_description:
          "fromSpaceId, toSpaceId, producerInstallationId, and outputs are required",
      },
      400,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: fromSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const producer = await operations.installations.getInstallation(
    producerInstallationId,
  );
  if (producer.spaceId !== fromSpaceId) {
    const producerAuth = await requireSpaceAccess({
      operations,
      store,
      spaceId: producer.spaceId,
      subject: sessionSubject,
    });
    if (!producerAuth.ok) return producerAuth.response;
    return json(
      {
        error: "invalid_request",
        error_description:
          "producerInstallationId must belong to the source Space.",
      },
      400,
    );
  }
  const share = await operations.outputShares.createShare({
    fromSpaceId,
    toSpaceId,
    producerInstallationId,
    outputs,
    ...(sensitivePolicy ? { sensitivePolicy } : {}),
  });
  return jsonStatus({ share }, 201);
}

async function approveOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return json({ error: "not_found" }, 404);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: existing.toSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({ share: await operations.outputShares.approveShare(shareId) });
}

async function revokeOutputShare(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  shareId: string,
): Promise<Response> {
  const existing = await operations.outputShares.getShare(shareId);
  if (!existing) return json({ error: "not_found" }, 404);
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId: existing.fromSpaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  return json({ share: await operations.outputShares.revokeShare(shareId) });
}

// --- Space authorization ---------------------------------------------------

type SpaceAccessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly response: Response;
    };

async function requireSpaceAccess(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly subject: string;
  readonly spaceId: string;
  readonly space?: Space;
}): Promise<SpaceAccessResult> {
  if (
    await canAccessSpace({
      operations: input.operations,
      store: input.store,
      subject: input.subject,
      spaceId: input.spaceId,
      ...(input.space ? { space: input.space } : {}),
    })
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    response: json(
      {
        error: "forbidden",
        error_description:
          "The authenticated session cannot access this Space.",
      },
      403,
    ),
  };
}

async function canAccessSpace(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly subject: string;
  readonly spaceId: string;
  readonly space?: Space;
}): Promise<boolean> {
  const space =
    input.space ?? (await input.operations.spaces.getSpace(input.spaceId));
  if (space.ownerUserId === input.subject) return true;

  const ledgerSpace = await input.store.findSpace(input.spaceId);
  if (!ledgerSpace) return false;
  const ledgerAccount = await input.store.findLedgerAccount(
    ledgerSpace.accountId,
  );
  return ledgerAccount?.legalOwnerSubject === input.subject;
}

// --- value coercion --------------------------------------------------------

function jsonStatus(body: unknown, status: number): Response {
  return json(body, status);
}

function parseProviderBindings(value: unknown):
  | { readonly ok: true; readonly bindings: ProviderBindings }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "bindings must be an array" };
  }
  const bindings: ProviderBinding[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseProviderBinding(item);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `bindings[${index}]: ${parsed.message}`,
      };
    }
    bindings.push(parsed.binding);
  }
  return { ok: true, bindings };
}

function parseProviderBinding(value: unknown):
  | { readonly ok: true; readonly binding: ProviderBinding }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "binding must be an object" };
  }
  const input = value as Record<string, unknown>;
  const mode = capabilityBindingModeValue(input.mode);
  if (!mode) return { ok: false, message: "mode is invalid" };
  const provider = stringValue(input.provider);
  if (!provider) return { ok: false, message: "provider is required" };
  const binding: {
    provider: string;
    alias?: string;
    mode: ProviderBindingMode;
    connectionId?: string;
    region?: string;
    values?: Readonly<Record<string, unknown>>;
  } = { provider, mode };
  const alias = stringValue(input.alias);
  if (alias) binding.alias = alias;
  const connectionId = stringValue(input.connectionId);
  if (connectionId) binding.connectionId = connectionId;
  const region = stringValue(input.region);
  if (region) binding.region = region;
  if (input.values !== undefined) {
    if (
      typeof input.values !== "object" ||
      input.values === null ||
      Array.isArray(input.values)
    ) {
      return { ok: false, message: "values must be an object" };
    }
    binding.values = input.values as Readonly<Record<string, unknown>>;
  }
  if (mode === "connection" && !binding.connectionId) {
    return { ok: false, message: "connectionId is required" };
  }
  if (mode === "manual" && !binding.values) {
    return { ok: false, message: "values is required" };
  }
  return { ok: true, binding };
}

function capabilityBindingModeValue(
  value: unknown,
): ProviderBindingMode | undefined {
  return value === "default" ||
    value === "connection" ||
    value === "manual" ||
    value === "disabled"
    ? value
    : undefined;
}

function isPlainJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces a JSON object of write-only credential `values` into a string map.
 * Non-string entries are dropped. NOTE: never log the returned map — it holds
 * secret credential material.
 */
function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

/**
 * Extracts the non-secret connection scope hints (account/zone ids) the UI may
 * pass. Only the well-known string fields are forwarded.
 */
function connectionScopeHints(
  value: unknown,
): ConnectionScopeHints | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const hints: Record<string, string> = {};
  for (const key of ["accountId", "zoneId"] as const) {
    const v = stringValue(value[key]);
    if (v) hints[key] = v;
  }
  return Object.keys(hints).length > 0
    ? (hints as ConnectionScopeHints)
    : undefined;
}

function spaceTypeValue(value: unknown): SpaceType | undefined {
  return value === "personal" || value === "organization" ? value : undefined;
}

function dependencyModeValue(value: unknown): DependencyMode | undefined {
  return value === "variable_injection" ||
    value === "remote_state" ||
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

function outputShareEntries(value: unknown):
  | readonly {
      readonly name: string;
      readonly alias?: string;
      readonly sensitive?: boolean;
    }[]
  | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: {
    name: string;
    alias?: string;
    sensitive?: boolean;
  }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const name = stringValue(record.name);
    if (!name) return undefined;
    out.push({
      name,
      ...(stringValue(record.alias)
        ? { alias: stringValue(record.alias) }
        : {}),
      ...(record.sensitive === true ? { sensitive: true } : {}),
    });
  }
  return out;
}

function outputShareSensitivePolicy(
  value: unknown,
): { readonly allow: boolean; readonly reason?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.allow !== true) return undefined;
  const reason = stringValue(record.reason);
  return {
    allow: true,
    ...(reason ? { reason } : {}),
  };
}

function parseLimit(value: string | null): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}
