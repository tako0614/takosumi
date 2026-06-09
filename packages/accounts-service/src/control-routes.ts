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
  Connection,
  DeployControlErrorCode,
  ListConnectionsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
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
import type { Run } from "takosumi-contract/runs";
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
  // --- Runs (§6.8 / §19 / §23) ---
  createInstallationPlan(installationId: string): Promise<PlanRunResponse>;
  createInstallationDestroyPlan(
    installationId: string,
  ): Promise<PlanRunResponse>;
  getRun(id: string): Promise<Run>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  getRunLogs(id: string): Promise<unknown>;
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

  // Authn gate: every control route requires a live account session. The
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
      const compatibilityRequest: CreateSourceCompatibilityCheckRequest = {
        ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
        ...(installationId ? { installationId } : {}),
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

  // /v1/control/runs/:id ; .../approve ; .../logs
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

  // /v1/control/connections?spaceId=
  if (segments.length === 1 && segments[0] === "connections") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listControlConnections(
      operations,
      store,
      input.session.subject,
      url,
    );
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
  // dashboard never supplies it. Space-membership reconciliation is post-MVP.
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
