/**
 * Account-plane session-authed deploy-control pass-through routes (spec §31 UI
 * backing surface, conformance M10).
 *
 * The dashboard SPA (served by the platform worker) authenticates with the
 * ACCOUNTS-plane session cookie, not the operator deploy-control bearer. This
 * is the edge-public `/api/v1/*` deploy-control surface the dashboard calls
 * same-origin; the operator-bearer-gated contract is served in-process under
 * the `/internal/v1` seam. Each handler:
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
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  DeployResponse,
  InternalDeployRequest,
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProviderCatalogEntriesResponse } from "takosumi-contract/providers";
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  InstallConfig,
  Installation,
  OutputAllowlistEntry,
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
import { defaultCapsuleOutputAllowlist } from "../../../core/domains/installations/official_seed.ts";
import {
  decodeCursor,
  type Page,
  type PageParams,
  pageSorted,
} from "takosumi-contract/pagination";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  InstallationProviderConnectionSet,
  ProviderEnv,
  ProviderConnection,
  PublicProviderEnv,
} from "takosumi-contract/provider-envs";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import { maybeEnsurePersonalSpaceForSession } from "./control-personal-space.ts";
import type {
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import { API_V1_PREFIX, isApiV1Path, type JsonValue } from "takosumi-contract";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "./http-helpers.ts";
import {
  type BillingPlan,
  parseBillingPlans,
  publicBillingPlans,
} from "./billing-plans.ts";
import { readEnvVar } from "./read-env.ts";
import { requireAccountSession } from "./account-session.ts";
import type { AccountsStore } from "./store.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  canTransitionAppInstallationStatus,
  type AppInstallationStatus,
  type InstallationRecord,
  type SpaceKind,
} from "./ledger.ts";
import { appendLedgerEvent } from "./installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "./encoding.ts";

/** 64 MiB cap on a single local Capsule upload archive. */
const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PublicInstallationInput = PublicInstallation &
  Partial<Pick<Installation, "installType" | "currentOutputSnapshotId">>;

function publicInstallation(
  installation: PublicInstallationInput,
): PublicInstallation {
  const {
    installType: _installType,
    currentOutputSnapshotId: _currentOutputSnapshotId,
    ...publicRecord
  } = installation;
  return publicRecord;
}

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    sourceKind: _sourceKind,
    ...publicRecord
  } = config;
  return {
    ...publicRecord,
    sourceKind: publicInstallConfigSourceKind(config),
  };
}

function publicInstallConfigSourceKind(
  config: InstallConfig,
): PublicInstallConfig["sourceKind"] {
  if (config.sourceKind === "generic_capsule") return "generic_capsule";
  if (
    config.sourceKind === "first_party_capsule" ||
    config.sourceKind === "official_template" ||
    config.templateBinding
  ) {
    return "first_party_capsule";
  }
  return "generic_capsule";
}

const API_PATCHABLE_INSTALLATION_STATUSES: ReadonlySet<Installation["status"]> =
  new Set(["active", "stale", "error"]);

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

async function publicRun(
  operations: ControlPlaneOperations,
  run: Run,
): Promise<PublicRun> {
  const { providerResolutions, ...rest } = run;
  if (!providerResolutions || providerResolutions.length === 0) {
    return rest;
  }
  return {
    ...rest,
    providerResolutions: await Promise.all(
      providerResolutions.map((resolution) =>
        publicProviderResolution(operations, resolution),
      ),
    ),
  };
}

async function publicProviderResolution(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution> {
  const connectionId = resolution.envId
    ? await publicProviderConnectionId(resolution.envId)
    : undefined;
  const ownership = resolution.envId
    ? await providerConnectionOwnershipForEnvId(operations, resolution.envId)
    : resolution.materialization
      ? "own_key"
      : undefined;
  return {
    requirement: resolution.requirement,
    status: publicProviderResolutionStatus(resolution),
    ...(connectionId ? { connectionId } : {}),
    ...(ownership ? { ownership } : {}),
    ...(resolution.blockedReason
      ? { blockedReason: publicProviderBlockedReason(resolution.blockedReason) }
      : {}),
    evidence: await publicProviderResolutionEvidence(operations, resolution),
  };
}

function publicProviderResolutionStatus(
  resolution: ProviderResolution,
): PublicProviderResolution["status"] {
  if (resolution.status === "resolved_provider_env") {
    return "resolved_provider_connection";
  }
  if (resolution.status === "blocked_missing_env") {
    return "blocked_missing_connection";
  }
  return resolution.status;
}

async function publicProviderResolutionEvidence(
  operations: ControlPlaneOperations,
  resolution: ProviderResolution,
): Promise<PublicProviderResolution["evidence"]> {
  const evidence = resolution.evidence;
  if (evidence.kind === "provider_env") {
    const ownership = await providerConnectionOwnershipForEnvId(
      operations,
      evidence.envId,
    );
    return {
      kind: "provider_connection",
      provider: evidence.provider,
      connectionId: await publicProviderConnectionId(evidence.envId),
      ownership,
      requiredEnvNames: evidence.requiredEnvNames,
    };
  }
  return {
    kind: "blocked",
    provider: evidence.provider,
    reason: publicProviderBlockedReason(evidence.reason),
  };
}

function publicProviderBlockedReason(reason: string): string {
  return reason.replace(/\bProvider Env\b/g, "Provider Connection");
}

async function providerConnectionOwnershipForEnvId(
  operations: ControlPlaneOperations,
  providerEnvId: string,
): Promise<ProviderConnection["ownership"]> {
  const providerEnv = await operations.connections
    .getProviderEnv?.(providerEnvId)
    .catch(() => undefined);
  if (!providerEnv) return "own_key";
  return await providerConnectionOwnership(operations, providerEnv);
}

async function providerConnectionOwnership(
  operations: ControlPlaneOperations,
  providerEnv: ProviderEnv,
): Promise<ProviderConnection["ownership"]> {
  void operations;
  void providerEnv;
  return "own_key";
}

async function publicCompatibilityReportResponse(
  operations: ControlPlaneOperations,
  response: CapsuleCompatibilityReportResponse,
): Promise<PublicCapsuleCompatibilityReportResponse> {
  const { providerResolutions: internalProviderResolutions, ...report } =
    response.report;
  const providerResolutions = internalProviderResolutions
    ? await Promise.all(
        internalProviderResolutions.map((resolution) =>
          publicProviderResolution(operations, resolution),
        ),
      )
    : undefined;
  return {
    report: {
      ...report,
      ...(providerResolutions ? { providerResolutions } : {}),
    },
    ...(response.run ? { run: await publicRun(operations, response.run) } : {}),
  };
}

async function publicDeployResponse(
  operations: ControlPlaneOperations,
  response: DeployResponse,
): Promise<PublicDeployResponse> {
  const { run, planRun, applyRun, ...rest } = response;
  return {
    ...rest,
    run: await publicRun(operations, run),
    ...(planRun ? { planRun: await publicRun(operations, planRun) } : {}),
    ...(applyRun ? { applyRun: await publicRun(operations, applyRun) } : {}),
  };
}

interface PublicPlanActionResponse {
  readonly run: PublicRun;
  readonly planSummary?: PublicPlanRun["summary"];
  readonly cost?: RunCostInfo;
}

interface PublicApplyActionResponse {
  readonly run: PublicRun;
  readonly installation?: PublicInstallation;
  readonly deployment?: PublicDeployment;
}

async function publicPlanActionResponse(
  operations: ControlPlaneOperations,
  response: PlanRunResponse,
): Promise<PublicPlanActionResponse> {
  const run = await operations.getRun(response.planRun.id);
  const cost = await operations
    .getRunCost(response.planRun.id)
    .catch(() => undefined);
  return {
    run: await publicRun(operations, run),
    ...(response.planRun.summary
      ? { planSummary: response.planRun.summary }
      : {}),
    ...(cost ? { cost } : {}),
  };
}

async function publicApplyActionResponse(
  operations: ControlPlaneOperations,
  response: ApplyRunResponse,
): Promise<PublicApplyActionResponse> {
  const run = await operations.getRun(response.applyRun.id);
  return {
    run: await publicRun(operations, run),
    ...(response.installation
      ? { installation: publicInstallation(response.installation) }
      : {}),
    ...(response.deployment
      ? { deployment: publicDeployment(response.deployment) }
      : {}),
  };
}

// --- Membership (Space members / roles) ------------------------------------
//
// Structural mirror of the in-process membership domain
// (`core/domains/membership`). The control routes describe the membership
// shapes structurally (like the rest of `ControlPlaneOperations`) so the
// accounts/service never imports back into `core/`; the host's wired
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
 * routes call. `TakosumiOperations` (wired by the host worker/bootstrap)
 * already satisfies this shape, so the platform worker passes its existing
 * `operations` facade with no extra wiring. Genuine remote deploy-control is
 * NOT reachable through this interface — the control routes are an in-process
 * convenience for the same-origin dashboard only.
 */
export interface ControlPlaneOperations {
  // --- Spaces (§4) ---
  readonly spaces: {
    listSpaces(): Promise<readonly Space[]>;
    listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]>;
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
    listInstallationsPage(
      spaceId: string,
      params: PageParams,
    ): Promise<Page<Installation>>;
    createInstallation(request: {
      readonly spaceId: string;
      readonly name: string;
      readonly environment: string;
      readonly sourceId: string;
      readonly installConfigId: string;
    }): Promise<Installation>;
    putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
    getInstallConfig(id: string): Promise<InstallConfig>;
    listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]>;
    patchInstallationStatus(
      id: string,
      status: Installation["status"],
    ): Promise<Installation>;
    putInstallationProviderEnvBindingSet(
      profile: InstallationProviderEnvBindingSet,
    ): Promise<InstallationProviderEnvBindingSet>;
    getInstallationProviderEnvBindingSetByInstallation(
      installationId: string,
      environment: string,
    ): Promise<InstallationProviderEnvBindingSet | undefined>;
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
    listForInstallation(installationId: string): Promise<{
      readonly asProducer: readonly Dependency[];
      readonly asConsumer: readonly Dependency[];
    }>;
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
    createSpaceDriftCheck(
      spaceId: string,
      options?: { readonly limit?: number },
    ): Promise<RunGroupWithRunsLike>;
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
      readonly installationId?: string;
      readonly environment?: string;
    }): Promise<BackupRecord>;
    listBackups(
      spaceId: string,
      params?: PageParams,
    ): Promise<ListBackupsResponse>;
  };
  createRestoreRun(
    spaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context?: { readonly actor?: string },
  ): Promise<Run>;
  recordUploadArchive(input: {
    readonly spaceId: string;
    readonly bytes: Uint8Array;
    readonly path?: string;
  }): Promise<SourceSnapshot>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot>;
  deployUpload(request: InternalDeployRequest): Promise<DeployResponse>;
  // --- Billing (§28) ---
  getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: CreditBalance;
    };
  }>;
  listSpaceUsage(
    spaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
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
    listProviderEnvs(spaceId?: string): Promise<readonly ProviderEnv[]>;
    getProviderEnv?(id: string): Promise<ProviderEnv>;
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
    listForSpacePage(
      spaceId: string,
      params: PageParams,
    ): Promise<Page<OutputShare>>;
    getShare(id: string): Promise<OutputShare | undefined>;
    approveShare(id: string): Promise<OutputShare>;
    revokeShare(id: string): Promise<OutputShare>;
  };
  listConnections(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse>;
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  getConnection(connectionId: string): Promise<Connection>;
  /**
   * Registers a Space-owned provider credential Connection (§9). The control
   * surface only ever builds Space-scoped requests here (guided-token / OAuth /
   * generic-env helper paths); the response is the public {@link Connection}
   * projection, which carries NO secret `values`.
   */
  createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse>;
  /**
   * Re-verifies a Connection's stored credential with the provider (§30
   * `POST /internal/v1/connections/:id/test`). The control surface resolves the
   * Connection's owning Space (via {@link getConnection}) and space-permission
   * gates BEFORE calling this; the response carries no secret values.
   */
  testConnection(connectionId: string): Promise<TestConnectionResponse>;
  /**
   * Revokes a Connection and deletes its sealed secret blob (§30
   * `POST /internal/v1/connections/:id/revoke`). The control surface resolves the
   * Connection's owning Space (via {@link getConnection}) and space-permission
   * gates BEFORE calling this. The wiring records the §27 / §34
   * `connection.revoked` Space activity, mirroring the deploy-control route.
   */
  revokeConnection(connectionId: string): Promise<void>;
  /**
   * OPTIONAL Cloudflare credential OAuth helper. Present only when the operator
   * has wired the upstream OAuth client (the `TAKOSUMI_CLOUDFLARE_OAUTH_*`
   * generic-env provider); absent otherwise, so the dashboard falls back to the guided-token
   * deep-link path and never shows a dead OAuth button. `start` returns the
   * provider authorize URL + signed state; `complete` exchanges the callback
   * code and yields a Space-owned `generic_env_provider` create request.
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
  createInstallationDriftCheck(
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
   * /internal/v1/installations/:id/deployments`). The control surface resolves the
   * Installation's owning Space first and space-permission gates before calling
   * this; the returned `Deployment` rows only carry the allowlist-projected
   * `outputsPublic` map (sensitive outputs never enter the ledger row).
   */
  listDeployments(
    installationId: string,
    params?: PageParams,
  ): Promise<ListDeploymentsResponse>;
  /**
   * Reads one Deployment ledger record by id (§30 `GET /internal/v1/deployments/:id`).
   * Used by the control surface to resolve a Deployment's owning Space (for the
   * space-permission gate) and to project its public fields. A missing id is a
   * typed `not_found`.
   */
  getDeployment(id: string): Promise<Deployment>;
  /**
   * Creates a rollback PLAN run for a Deployment (§30 `POST
   * /internal/v1/deployments/:id/rollback-plan`): re-plans the Deployment's Installation
   * pinned to that Deployment's source snapshot. The plan then flows through the
   * normal approve/apply path, so the response is a `PlanRunResponse`.
   */
  createDeploymentRollbackPlan(deploymentId: string): Promise<PlanRunResponse>;
  getRun(id: string): Promise<Run>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  getRunLogs(id: string): Promise<RunLogsResponse>;
  getRunEvents(id: string): Promise<RunEventsResponse>;
  /**
   * Reads a plan / destroy_plan Run's public cost projection (`GET
   * /api/v1/runs/:id/cost`). The control surface resolves the Run's owning
   * Space first and space-permission gates before calling this. The returned
   * {@link RunCostInfo} carries only the billing reservation values the
   * controller already computed at plan time (estimated / available credits,
   * reservation status, credit-shortfall + plan-limit reasons) — no cost is
   * computed here and no secret material is returned.
   */
  getRunCost(id: string): Promise<RunCostInfo>;
  // --- Sources (§6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<unknown>;
  listSourceSnapshots(
    sourceId: string,
    params?: PageParams,
  ): Promise<ListSourceSnapshotsResponse>;
  createSourceCompatibilityCheck(
    sourceId: string,
    request?: CreateSourceCompatibilityCheckRequest,
  ): Promise<CapsuleCompatibilityReportResponse>;
  getCompatibilityReport(
    reportId: string,
  ): Promise<CapsuleCompatibilityReportResponse>;
  // --- Providers (§7 / §8) ---
  listProviderCatalogEntries(): Promise<ListProviderCatalogEntriesResponse>;
  // --- Runner profiles (read; used by Provider Connection / Gateway views) ---
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
}

/** Loose RunGroup-with-runs projection (avoids importing the service type). */
export interface RunGroupWithRunsLike {
  readonly runGroup: { readonly id: string; readonly spaceId: string };
  readonly runs: readonly Run[];
}

/**
 * True for any path this session-authed control surface owns: the edge-public
 * {@link API_V1_PREFIX} (`/api/v1`). Used by `mod.ts` to route into
 * {@link handleControlRoute} before the generic 404.
 */
export function isControlRoutePath(pathname: string): boolean {
  return isApiV1Path(pathname);
}

interface ControlRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  /**
   * Operator billing plan catalog (spec §32) for `GET /api/v1/billing/plans`.
   * Falls back to the `TAKOSUMI_BILLING_PLANS` env var when omitted.
   */
  readonly billingPlans?: readonly BillingPlan[];
}

/**
 * Renders an `OpenTofuControllerError` (carrying a `.code`) to the contract's
 * code->HTTP-status mapping. Non-controller errors collapse to 500.
 */
function controllerErrorResponse(error: unknown): Response {
  const code = controllerErrorCode(error);
  if (code) {
    return errorJson(
      code,
      error instanceof Error ? error.message : String(error),
      DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
      undefined,
      {},
      isRecord(error) ? error.details : undefined,
    );
  }
  return errorJson("internal_error", "internal error", 500);
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
  return errorJson(
    "feature_unavailable",
    "The control plane is temporarily unavailable.",
    503,
  );
}

/**
 * Single entry point for the `/api/v1/*` family. Authenticates the account
 * session ONCE (anonymous -> 401), then dispatches to the matched sub-route.
 * Returns `undefined` only when the path is not owned by this family (so the
 * caller can fall through to its own 404).
 */
export async function handleControlRoute(
  context: ControlRouteContext,
): Promise<Response | undefined> {
  const { request, url, store } = context;
  if (!isApiV1Path(url.pathname)) return undefined;
  const prefix = API_V1_PREFIX;

  // The credential-OAuth callback is the ONE control route reached by a
  // top-level CROSS-SITE redirect (dash.cloudflare.com -> this origin). The
  // browser sends no Authorization header and, because the `takosumi_session`
  // cookie is `SameSite=Strict`, does NOT send the session cookie either, so
  // `requireAccountSession` here would always 401 and the user would land on a
  // raw 401 JSON instead of being redirected back to /connections. The callback
  // therefore authenticates from the authenticated subject embedded in the
  // HMAC-signed OAuth state (minted by the cookie-authenticated `start`), not
  // from the session cookie. Route it BEFORE the session gate.
  if (isCloudflareOAuthCallbackPath(url.pathname, request.method, prefix)) {
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

  const tail = url.pathname.slice(prefix.length); // e.g. "/spaces"
  try {
    return await dispatch({
      request,
      url,
      tail,
      operations,
      store,
      session,
      billingPlans: context.billingPlans,
    });
  } catch (error) {
    return controllerErrorResponse(error);
  }
}

/**
 * True for `GET /api/v1/connections/cloudflare/oauth/callback`. This is the
 * only control route reached cross-site, so it is dispatched before the
 * `SameSite=Strict` session-cookie gate and authorizes from the signed OAuth
 * state instead (see {@link handleControlRoute}).
 */
function isCloudflareOAuthCallbackPath(
  pathname: string,
  method: string,
  prefix: string,
): boolean {
  return (
    method === "GET" &&
    pathname === `${prefix}/connections/cloudflare/oauth/callback`
  );
}

interface DispatchInput {
  readonly request: Request;
  readonly url: URL;
  readonly tail: string;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: { readonly subject: string };
  readonly billingPlans?: readonly BillingPlan[];
}

async function dispatch(input: DispatchInput): Promise<Response> {
  const { request, url, tail, operations, store } = input;
  const method = request.method;
  const segments = tail.split("/").filter(Boolean); // ["spaces", ":id", ...]

  // GET /api/v1/billing/plans — the instance-wide operator plan catalog
  // (spec §32), public projection (no Stripe price ids). Session-authed but
  // not Space-scoped: the catalog is the same for every Space.
  if (
    segments.length === 2 &&
    segments[0] === "billing" &&
    segments[1] === "plans"
  ) {
    if (method !== "GET") return methodNotAllowed("GET");
    return json({
      plans: publicBillingPlans(
        input.billingPlans && input.billingPlans.length > 0
          ? input.billingPlans
          : parseBillingPlans(readEnvVar("TAKOSUMI_BILLING_PLANS")),
      ),
    });
  }

  // GET/POST /api/v1/spaces
  if (segments.length === 1 && segments[0] === "spaces") {
    if (method === "GET") {
      await maybeEnsurePersonalSpaceForSession({
        request: request.clone(),
        store,
        operations,
      });
      return await listSpaces(operations, store, input.session.subject);
    }
    if (method === "POST") {
      return await createSpace(request, operations, input.session.subject);
    }
    return methodNotAllowed("GET, POST");
  }

  // POST /api/v1/deploy — local-directory deploy uploaded by the CLI. The
  // request carries no credential material; provider access is resolved from
  // public Provider Connection ids before the internal deploy-control dispatch.
  if (segments.length === 1 && segments[0] === "deploy") {
    if (method !== "POST") return methodNotAllowed("POST");
    return await deployUploadedSnapshot(
      request,
      operations,
      store,
      input.session.subject,
    );
  }

  // /api/v1/spaces/:spaceId ; /api/v1/spaces/:spaceId/...
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
      // /api/v1/spaces/:spaceId/members[/:subject]. The Space is already
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
            input.store,
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
    if (leaf === "uploads" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await uploadSpaceArchive(request, url, operations, spaceId);
    }
    if (leaf === "installations" && segments.length === 3) {
      if (method === "GET")
        return await listSpaceInstallations(operations, spaceId, url);
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
        const page = parseControlPageParams(url);
        if (!page.ok) return page.response;
        return json(
          (await operations.backups.listBackups(
            spaceId,
            page.params,
          )) satisfies ListBackupsResponse,
        );
      }
      if (method === "POST") {
        const backup = await operations.backups.createBackup({ spaceId });
        return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
      }
      return methodNotAllowed("GET, POST");
    }
    if (
      leaf === "backups" &&
      segments.length === 5 &&
      segments[4] === "restores"
    ) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backupId = decodeURIComponent(segments[3] ?? "");
      return await createRestoreRun(
        request,
        operations,
        spaceId,
        backupId,
        input.session.subject,
      );
    }
    if (leaf === "billing" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getSpaceBilling(spaceId));
    }
    if (leaf === "usage" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      const page = parseControlPageParams(url);
      if (!page.ok) return page.response;
      return json(await operations.listSpaceUsage(spaceId, page.params));
    }
    if (leaf === "credit-reservations" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.listSpaceCreditReservations(spaceId));
    }
    // NOTE: `credits/top-up` and `subscription/change` are intentionally NOT
    // on this session surface. Billing mode is operator-selected and credits
    // enter through paid Stripe checkout (spec §32); the operator mutations
    // live on the bearer-gated `/internal/v1` surface
    // (core/api/deploy_control_billing_routes.ts).
    if (leaf === "plan-update" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await spacePlanUpdate(operations, spaceId);
    }
    if (leaf === "drift-check" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const body = await readOptionalJsonObject(request);
      if (body === null) {
        return errorJson("invalid_json", "invalid json body", 400);
      }
      const rawLimit = body.limit;
      const limit =
        typeof rawLimit === "number" &&
        Number.isInteger(rawLimit) &&
        rawLimit > 0
          ? rawLimit
          : undefined;
      return jsonStatus(
        await operations.runGroups.createSpaceDriftCheck(
          spaceId,
          limit !== undefined ? { limit } : {},
        ),
        201,
      );
    }
  }

  // /api/v1/installations/:id ; .../plan ; .../destroy-plan ; .../dependencies
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
      if (method === "GET") {
        return json({ installation: publicInstallation(installation) });
      }
      if (method === "PATCH") {
        return await patchInstallation(request, operations, installationId);
      }
      if (method === "DELETE") {
        const response =
          await operations.createInstallationDestroyPlan(installationId);
        return jsonStatus(
          await publicPlanActionResponse(operations, response),
          202,
        );
      }
      return methodNotAllowed("GET, PATCH, DELETE");
    }
    const leaf = segments[2];
    if (leaf === "plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const response = await operations.createInstallationPlan(installationId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "destroy-plan" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const response =
        await operations.createInstallationDestroyPlan(installationId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "drift-check" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const response =
        await operations.createInstallationDriftCheck(installationId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    if (leaf === "backups" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const backup = await operations.backups.createBackup({
        spaceId: installation.spaceId,
        installationId: installation.id,
        environment: installation.environment,
      });
      return jsonStatus({ backup } satisfies CreateBackupResponse, 201);
    }
    if (leaf === "deployments" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listInstallationDeployments(operations, installationId, url);
    }
    if (leaf === "dependencies" && segments.length === 3) {
      if (method === "GET") {
        return json(
          await operations.dependencies.listForInstallation(installationId),
        );
      }
      if (method !== "POST") return methodNotAllowed("GET, POST");
      return await createDependency(
        request,
        operations,
        store,
        input.session.subject,
        installationId,
      );
    }
    if (leaf === "provider-connections" && segments.length === 3) {
      if (method === "GET") {
        return await getInstallationProviderConnectionSet(
          operations,
          installation,
        );
      }
      if (method === "PUT") {
        return await putInstallationProviderConnectionSet(
          request,
          operations,
          installation,
        );
      }
      return methodNotAllowed("GET, PUT");
    }
  }

  // /api/v1/install-configs
  if (segments.length === 1 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listInstallConfigs(
      operations,
      store,
      input.session.subject,
      url,
    );
  }
  if (segments.length === 2 && segments[0] === "install-configs") {
    if (method !== "GET") return methodNotAllowed("GET");
    const installConfigId = decodeURIComponent(segments[1] ?? "");
    const config =
      await operations.installations.getInstallConfig(installConfigId);
    if (config.spaceId !== undefined) {
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: config.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
    }
    return json({ installConfig: publicInstallConfig(config) });
  }

  // /api/v1/providers
  if (segments.length === 1 && segments[0] === "providers") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json(await operations.listProviderCatalogEntries());
  }

  // /api/v1/dependencies/:id
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

  // /api/v1/sources ; /api/v1/sources/:id/sync ; .../snapshots ; .../compatibility-check
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
      const { source } = await operations.getSource(sourceId);
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
      const { source } = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      const page = parseControlPageParams(url);
      if (!page.ok) return page.response;
      return json(await operations.listSourceSnapshots(sourceId, page.params));
    }
    if (segments.length === 3 && segments[2] === "compatibility-check") {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      if (method !== "POST") return methodNotAllowed("POST");
      const { source } = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      const body = await readOptionalJsonObject(request);
      if (body === null) {
        return errorJson("invalid_json", "invalid json body", 400);
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
        await publicCompatibilityReportResponse(
          operations,
          await operations.createSourceCompatibilityCheck(
            sourceId,
            compatibilityRequest,
          ),
        ),
        201,
      );
    }
    if (segments.length === 2) {
      const sourceId = decodeURIComponent(segments[1] ?? "");
      const { source } = await operations.getSource(sourceId);
      const auth = await requireSpaceAccess({
        operations,
        store,
        spaceId: source.spaceId,
        subject: input.session.subject,
      });
      if (!auth.ok) return auth.response;
      if (method === "GET") {
        return json({ source });
      }
      if (method === "PATCH") {
        const body = await readOptionalJsonObject(request);
        if (body === null) {
          return errorJson("invalid_json", "invalid json body", 400);
        }
        return json(
          await operations.patchSource(sourceId, body as PatchSourceRequest),
        );
      }
      return methodNotAllowed("GET, PATCH");
    }
  }

  if (segments[0] === "compatibility-reports" && segments.length === 2) {
    if (method !== "GET") return methodNotAllowed("GET");
    const reportId = decodeURIComponent(segments[1] ?? "");
    const response = await operations.getCompatibilityReport(reportId);
    const report = response.report;
    const reportSpaceId = report.sourceId
      ? (await operations.getSource(report.sourceId)).source.spaceId
      : report.installationId
        ? (
            await operations.installations.getInstallation(
              report.installationId,
            )
          ).spaceId
        : undefined;
    if (!reportSpaceId) {
      return errorJson("not_found", "compatibility report not found", 404);
    }
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: reportSpaceId,
      subject: input.session.subject,
    });
    if (!auth.ok) return auth.response;
    return json(await publicCompatibilityReportResponse(operations, response));
  }

  // /api/v1/deployments/:deploymentId ; .../rollback-plan — session-authed
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
      const response =
        await operations.createDeploymentRollbackPlan(deploymentId);
      return jsonStatus(
        await publicPlanActionResponse(operations, response),
        201,
      );
    }
    return errorJson("not_found", "not found", 404);
  }

  // /api/v1/runs/:id ; .../apply ; .../approve ; .../logs ; .../cost
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
      await syncDeployControlProjectionStatusFromRun({ store, run });
      return json({ run: await publicRun(operations, run) });
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
    if (leaf === "apply" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await applyPlanRun(
        request,
        operations,
        store,
        input.session.subject,
        runId,
      );
    }
    if (leaf === "logs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunLogs(runId));
    }
    if (leaf === "events" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunEvents(runId));
    }
    if (leaf === "cancel" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return json({
        run: await publicRun(operations, await operations.cancelRun(runId)),
      });
    }
    if (leaf === "cost" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Public, non-secret cost projection: the billing reservation values the
      // controller already computed at plan time (estimated / available credits,
      // reservation status, credit-shortfall reasons). Space-gated above.
      return json({ cost: await operations.getRunCost(runId) });
    }
  }

  // /api/v1/run-groups/:id ; .../approve
  if (segments[0] === "run-groups" && segments.length >= 2) {
    const runGroupId = decodeURIComponent(segments[1] ?? "");
    const existing = await operations.runGroups.getRunGroup(runGroupId);
    if (!existing) return errorJson("not_found", "not found", 404);
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

  // /api/v1/connections?spaceId=  (GET list / POST create)
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

  // /api/v1/connections/:id/test ; /api/v1/connections/:id/revoke
  // (the item surface consolidated from the former /v1/connections edge). The
  // cloudflare/oauth subroutes are `segments.length === 4` (handled below), so
  // a 3-segment connections path is always one of these two item ops.
  if (
    segments.length === 3 &&
    segments[0] === "connections" &&
    (segments[2] === "test" || segments[2] === "revoke")
  ) {
    if (method !== "POST") return methodNotAllowed("POST");
    const connectionId = decodeURIComponent(segments[1] ?? "");
    return await connectionItemOp(
      operations,
      store,
      input.session.subject,
      connectionId,
      segments[2],
    );
  }

  // /api/v1/connections/cloudflare/oauth/start — credential OAuth helper
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

  // /api/v1/output-shares ; /api/v1/output-shares/:id/{approve,revoke}
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

  // /api/v1/provider-connections?spaceId=
  if (segments.length === 1 && segments[0] === "provider-connections") {
    if (method !== "GET") return methodNotAllowed("GET");
    return await listProviderConnections(
      operations,
      store,
      input.session.subject,
      url,
    );
  }

  return errorJson("not_found", "not found", 404);
}

// --- Spaces ----------------------------------------------------------------

async function listSpaces(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  // Scope the read to the caller's own spaces instead of loading every tenant's
  // Space and filtering per row. This reproduces `canAccessSpace`'s accept set
  // as a UNION of two scoped queries:
  //   (A) deploy-control Spaces the subject directly owns (ownerUserId), and
  //   (B) Spaces whose account is legally owned by the subject (the accounts
  //       ledger's `legalOwnerSubject`), fetched individually so we never read
  //       another tenant's Space.
  const byId = new Map<string, Space>();
  for (const space of await operations.spaces.listSpacesByOwner(
    sessionSubject,
  )) {
    byId.set(space.id, space);
  }
  for (const ledgerSpace of await store.listSpacesForOwner(
    sessionSubject as TakosumiSubject,
  )) {
    if (byId.has(ledgerSpace.spaceId)) continue;
    try {
      byId.set(
        ledgerSpace.spaceId,
        await operations.spaces.getSpace(ledgerSpace.spaceId),
      );
    } catch {
      // The deploy-control Space may not exist (or is mid-creation); skip it
      // rather than failing the whole list.
    }
  }
  const visible = [...byId.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return json({ spaces: visible });
}

async function createSpace(
  request: Request,
  operations: ControlPlaneOperations,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const handle = stringValue(body.handle);
  const displayName = stringValue(body.displayName) ?? handle;
  const type = spaceTypeValue(body.type) ?? "personal";
  if (!handle) {
    return errorJson("invalid_request", "handle is required", 400);
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
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const patch: {
    displayName?: string;
    policy?: PolicyConfig;
  } = {};
  if (body.displayName !== undefined) {
    const displayName = stringValue(body.displayName)?.trim();
    if (!displayName) {
      return errorJson("invalid_argument", "displayName is required", 400);
    }
    patch.displayName = displayName;
  }
  if (body.policy !== undefined) {
    if (!isPlainJsonObject(body.policy)) {
      return errorJson("invalid_argument", "policy must be an object", 400);
    }
    patch.policy = body.policy as PolicyConfig;
  }
  if (patch.displayName === undefined && patch.policy === undefined) {
    return errorJson(
      "invalid_argument",
      "displayName or policy is required",
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
  return errorJson(
    "feature_unavailable",
    "Space membership management is not available.",
    503,
  );
}

function memberForbidden(description: string): Response {
  return errorJson("forbidden", description, 403);
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
  const existing = members.find((member) => member.accountId === ownerUserId);
  // Only synthesize when the namespace owner has NO active row. A suspended /
  // invited row for the owner is left as-is (the owner explicitly changed it),
  // and an existing active row already grants them management.
  if (existing && existing.status === "active") return members;
  if (existing) {
    // Replace a non-active owner row with the implicit active-owner view so the
    // namespace owner is never locked out of their own Space.
    return members.map((member) =>
      member.accountId === ownerUserId
        ? implicitOwner(spaceId, ownerUserId)
        : member,
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
  store: AccountsStore,
  operations: ControlPlaneOperations,
  spaceId: string,
  subject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const email = stringValue(body.email);
  const accountId =
    email === undefined
      ? (stringValue(body.accountId) ?? stringValue(body.subject))
      : await resolveVerifiedMemberEmail(store, email);
  if (!accountId) {
    return email === undefined
      ? errorJson("invalid_argument", "accountId or email is required", 400)
      : errorJson(
          "not_found",
          "No verified Takosumi account was found for that email.",
          404,
        );
  }
  const role = body.role === undefined ? "member" : controlRoleValue(body.role);
  if (!role) {
    return errorJson(
      "invalid_argument",
      "role must be one of owner, admin, member, viewer",
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

async function resolveVerifiedMemberEmail(
  store: AccountsStore,
  email: string,
): Promise<string | undefined> {
  return (await store.findAccountByVerifiedEmail(email))?.subject;
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
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const roles = parseRolesField(body.roles ?? body.role);
  if (!roles) {
    return errorJson(
      "invalid_argument",
      "roles must be one or more of owner, admin, member, viewer",
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
    return errorJson("not_found", "member not found", 404);
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
    return errorJson("not_found", "member not found", 404);
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

/**
 * Parses the shared `?limit=` / `?cursor=` keyset-pagination query for a
 * dashboard list route (spec §30). Mirrors the deploy-control `parsePageParams`:
 * `limit` is a positive integer clamped to the hard cap by the store; `cursor`
 * must decode to a `{ createdAt, id }` keyset. A malformed value is a 400.
 */
function parseControlPageParams(
  url: URL,
):
  | { readonly ok: true; readonly params: PageParams }
  | { readonly ok: false; readonly response: Response } {
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return {
        ok: false,
        response: errorJson(
          "invalid_request",
          "limit must be a positive integer",
          400,
        ),
      };
    }
    limit = Number(rawLimit);
  }
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    if (decodeCursor(rawCursor) === undefined) {
      return {
        ok: false,
        response: errorJson("invalid_request", "cursor is malformed", 400),
      };
    }
  }
  return {
    ok: true,
    params: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== null && rawCursor !== "" ? { cursor: rawCursor } : {}),
    },
  };
}

// --- Installations ---------------------------------------------------------

async function listSpaceInstallations(
  operations: ControlPlaneOperations,
  spaceId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { items, nextCursor } =
    await operations.installations.listInstallationsPage(spaceId, page.params);
  return json({
    installations: items.map(publicInstallation),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
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
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { deployments, nextCursor } = await operations.listDeployments(
    installationId,
    page.params,
  );
  return json({
    deployments: deployments.map(publicDeployment),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
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

async function patchInstallation(
  request: Request,
  operations: ControlPlaneOperations,
  installationId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const status = stringValue(body.status) as Installation["status"] | undefined;
  if (!status) {
    return errorJson("invalid_request", "status is required", 400);
  }
  if (!API_PATCHABLE_INSTALLATION_STATUSES.has(status)) {
    return errorJson(
      "invalid_request",
      "status may only be patched to active, stale, or error; destroy states must use the destroy flow",
      400,
    );
  }
  const installation = await operations.installations.patchInstallationStatus(
    installationId,
    status,
  );
  return json({ installation: publicInstallation(installation) });
}

async function createInstallation(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  spaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const name = stringValue(body.name);
  const environment = stringValue(body.environment);
  const sourceId = stringValue(body.sourceId);
  const installConfigId = stringValue(body.installConfigId);
  const vars = jsonRecordValue(body.vars);
  if (body.vars !== undefined && vars === undefined) {
    return errorJson(
      "invalid_request",
      "vars must be an object of JSON values keyed by OpenTofu variable names",
      400,
    );
  }
  if (!name || !environment || !sourceId || !installConfigId) {
    return errorJson(
      "invalid_request",
      "name, environment, sourceId, and installConfigId are required",
      400,
    );
  }
  const { source } = await operations.getSource(sourceId);
  if (source.spaceId !== spaceId) {
    const auth = await requireSpaceAccess({
      operations,
      store,
      spaceId: source.spaceId,
      subject: sessionSubject,
    });
    if (!auth.ok) return auth.response;
    return errorJson(
      "invalid_request",
      "sourceId must belong to the target Space.",
      400,
    );
  }
  let resolvedInstallConfigId = installConfigId;
  if (vars !== undefined && Object.keys(vars).length > 0) {
    const baseConfig =
      await operations.installations.getInstallConfig(installConfigId);
    if (baseConfig.spaceId !== undefined && baseConfig.spaceId !== spaceId) {
      return errorJson(
        "invalid_request",
        "installConfigId is not available to the target Space.",
        400,
      );
    }
    const now = new Date().toISOString();
    const config = await operations.installations.putInstallConfig({
      ...baseConfig,
      id: `icfg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      spaceId,
      name: `${name}-config`,
      variableMapping: { ...baseConfig.variableMapping, ...vars },
      outputAllowlist: scopedCloneOutputAllowlist(baseConfig),
      createdAt: now,
      updatedAt: now,
    });
    resolvedInstallConfigId = config.id;
  }
  const installation = await operations.installations.createInstallation({
    spaceId,
    name,
    environment,
    sourceId,
    installConfigId: resolvedInstallConfigId,
  });
  return jsonStatus({ installation: publicInstallation(installation) }, 201);
}

function scopedCloneOutputAllowlist(
  baseConfig: InstallConfig,
): InstallConfig["outputAllowlist"] {
  if (Object.keys(baseConfig.outputAllowlist).length > 0) {
    return baseConfig.outputAllowlist;
  }
  return baseConfig.sourceKind === "generic_capsule"
    ? defaultCapsuleOutputAllowlist()
    : baseConfig.outputAllowlist;
}

async function createRestoreRun(
  request: Request,
  operations: ControlPlaneOperations,
  spaceId: string,
  backupId: string,
  actor: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const stateGeneration = body.stateGeneration;
  if (!Number.isInteger(stateGeneration) || Number(stateGeneration) < 0) {
    return errorJson(
      "invalid_request",
      "stateGeneration must be a non-negative integer",
      400,
    );
  }
  const installationId = stringValue(body.installationId);
  const environment = stringValue(body.environment);
  const expectedBackupDigest = stringValue(body.expectedBackupDigest);
  const restoreRequest: CreateRestoreRequest = {
    stateGeneration: Number(stateGeneration),
    ...(installationId ? { installationId } : {}),
    ...(environment ? { environment } : {}),
    ...(expectedBackupDigest ? { expectedBackupDigest } : {}),
    ...(body.restoreServiceData === true ? { restoreServiceData: true } : {}),
  };
  const run = await operations.createRestoreRun(
    spaceId,
    backupId,
    restoreRequest,
    {
      actor,
    },
  );
  return jsonStatus({ run: await publicRun(operations, run) }, 201);
}

async function getInstallationProviderConnectionSet(
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const profile =
    await operations.installations.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      installation.environment,
    );
  return json({
    providerConnectionSet: profile
      ? await publicInstallationProviderConnectionSet(profile)
      : null,
  });
}

async function putInstallationProviderConnectionSet(
  request: Request,
  operations: ControlPlaneOperations,
  installation: Installation,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const parsed = parseInstallationProviderConnectionBindings(body.connections);
  if (!parsed.ok) {
    return errorJson("invalid_request", parsed.message, 400);
  }
  const resolved = await resolveProviderConnectionBindings(
    operations,
    installation.spaceId,
    parsed.bindings,
  );
  if (!resolved.ok) {
    return errorJson("invalid_request", resolved.message, 400);
  }
  const existing =
    await operations.installations.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      installation.environment,
    );
  const now = new Date().toISOString();
  const profile =
    await operations.installations.putInstallationProviderEnvBindingSet({
      id:
        existing?.id ??
        `dpf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      spaceId: installation.spaceId,
      installationId: installation.id,
      environment: installation.environment,
      bindings: resolved.bindings,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  return json({
    providerConnectionSet:
      await publicInstallationProviderConnectionSet(profile),
  });
}

async function publicInstallationProviderConnectionSet(
  profile: InstallationProviderEnvBindingSet,
): Promise<InstallationProviderConnectionSet> {
  return {
    id: profile.id,
    spaceId: profile.spaceId,
    installationId: profile.installationId,
    environment: profile.environment,
    connections: await Promise.all(
      profile.bindings.map(async (binding) => {
        const connection: {
          provider: string;
          alias?: string;
          connectionId: string;
          region?: string;
        } = {
          provider: binding.provider,
          connectionId: await publicProviderConnectionId(binding.envId),
        };
        if (binding.alias) connection.alias = binding.alias;
        if (binding.region) connection.region = binding.region;
        return connection;
      }),
    ),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
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
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  // Without a spaceId only built-in shared configs (spaceId-less configs) are
  // returned; with one, built-ins plus that Space's own configs —
  // mirroring the §30 `/api/v1/install-configs` projection. The official + scoped
  // union is a small set, so it is materialized, merge-sorted by (createdAt,
  // id), and bounded with the in-memory keyset pager.
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
  const merged = [...official, ...scoped].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const { items, nextCursor } = pageSorted(merged, page.params);
  return json({
    installConfigs: items.map(publicInstallConfig),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
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
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const producerInstallationId = stringValue(body.producerInstallationId);
  if (!producerInstallationId) {
    return errorJson(
      "invalid_request",
      "producerInstallationId is required",
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
  if (!existing) return errorJson("not_found", "not found", 404);
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
    return errorJson(
      "invalid_request",
      "limit must be a positive integer",
      400,
    );
  }
  const events = await operations.activity.list(spaceId, limit);
  return json({ events });
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
    return errorJson(
      "invalid_request",
      "spaceId query parameter is required",
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
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  return json(await operations.listSources(spaceId, page.params));
}

async function createSource(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const spaceId = stringValue(body.spaceId);
  const name = stringValue(body.name);
  const sourceUrl = stringValue(body.url);
  if (!spaceId || !name || !sourceUrl) {
    return errorJson(
      "invalid_request",
      "spaceId, name, and url are required",
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
      return errorJson(
        "invalid_request",
        "authConnectionId must belong to the target Space.",
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

async function uploadSpaceArchive(
  request: Request,
  url: URL,
  operations: ControlPlaneOperations,
  spaceId: string,
): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return errorJson("invalid_argument", "upload body is empty", 400, request);
  }
  if (bytes.byteLength > DEFAULT_UPLOAD_MAX_BYTES) {
    return errorJson(
      "resource_exhausted",
      "upload archive too large",
      413,
      request,
    );
  }
  const path = stringValue(url.searchParams.get("path") ?? undefined);
  const snapshot = await operations.recordUploadArchive({
    spaceId,
    bytes,
    ...(path ? { path } : {}),
  });
  return jsonStatus({ snapshot }, 201);
}

async function deployUploadedSnapshot(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body)
    return errorJson("invalid_argument", "invalid request", 400, request);
  const spaceId = stringValue(body.spaceId);
  const name = stringValue(body.name);
  const snapshotId = stringValue(body.snapshotId);
  if (!spaceId || !name || !snapshotId) {
    return errorJson(
      "invalid_argument",
      "spaceId, name, and snapshotId are required",
      400,
      request,
    );
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const vars = stringRecordValue(body.vars);
  if (body.vars !== undefined && vars === undefined) {
    return errorJson(
      "invalid_argument",
      "vars must be an object of string values",
      400,
      request,
    );
  }
  const outputAllowlist = outputAllowlistValue(body.outputAllowlist);
  if (body.outputAllowlist !== undefined && outputAllowlist === undefined) {
    return errorJson(
      "invalid_argument",
      "outputAllowlist must be an object of { from, type, required? } entries",
      400,
      request,
    );
  }
  const environment = stringValue(body.environment);
  let providerEnvBindings: InstallationProviderEnvBindings | undefined;
  if (body.providerEnvBindings !== undefined) {
    return errorJson(
      "invalid_argument",
      "providerEnvBindings is internal-only; use providerConnections",
      400,
      request,
    );
  }
  if (body.providerConnections !== undefined) {
    const parsed = parseInstallationProviderConnectionBindings(
      body.providerConnections,
    );
    if (!parsed.ok) {
      return errorJson(
        "invalid_argument",
        `providerConnections: ${parsed.message}`,
        400,
        request,
      );
    }
    const resolved = await resolveProviderConnectionBindings(
      operations,
      spaceId,
      parsed.bindings,
    );
    if (!resolved.ok) {
      return errorJson(
        "invalid_argument",
        `providerConnections: ${resolved.message}`,
        400,
        request,
      );
    }
    providerEnvBindings = resolved.bindings;
  }
  const planOnly = booleanValue(body.planOnly);
  const autoApprove = booleanValue(body.autoApprove);
  const deployRequest: InternalDeployRequest = {
    spaceId,
    name,
    ...(environment ? { environment } : {}),
    snapshotId,
    ...(vars ? { vars } : {}),
    ...(outputAllowlist ? { outputAllowlist } : {}),
    ...(providerEnvBindings ? { providerEnvBindings } : {}),
    ...(planOnly !== undefined ? { planOnly } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
  };
  try {
    const deployResponse = await operations.deployUpload(deployRequest);
    await syncDeployControlProjectionFromDeploy({
      operations,
      store,
      sessionSubject: sessionSubject as TakosumiSubject,
      deployResponse,
    });
    return json(await publicDeployResponse(operations, deployResponse));
  } catch (error) {
    logDeployUploadFailure(error, {
      method: request.method,
      path: new URL(request.url).pathname,
      spaceId,
      name,
      snapshotId,
      environment: environment ?? "production",
      hasVars: vars !== undefined,
      providerConnectionCount: Array.isArray(body.providerConnections)
        ? body.providerConnections.length
        : 0,
    });
    throw error;
  }
}

interface DeployControlProjectionSource {
  readonly sourceGitUrl: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly planDigest: string;
  readonly artifactDigest?: string;
}

async function syncDeployControlProjectionFromDeploy(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly deployResponse: DeployResponse;
}): Promise<void> {
  const planRunId =
    input.deployResponse.planRun?.id ?? input.deployResponse.run.id;
  const { planRun } = await input.operations.getPlanRun(planRunId);
  await upsertDeployControlInstallationProjection({
    operations: input.operations,
    store: input.store,
    sessionSubject: input.sessionSubject,
    installation: input.deployResponse.installation,
    planRun,
    fallbackRun: input.deployResponse.planRun ?? input.deployResponse.run,
    requestedStatus: projectionStatusFromDeploy(input.deployResponse),
  });
}

async function syncDeployControlProjectionFromApply(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly planRun: PublicPlanRun;
  readonly response: ApplyRunResponse;
}): Promise<void> {
  const installation =
    input.response.installation ??
    (input.planRun.installationId
      ? await input.operations.installations
          .getInstallation(input.planRun.installationId)
          .catch(() => undefined)
      : undefined);
  if (!installation) return;
  await upsertDeployControlInstallationProjection({
    operations: input.operations,
    store: input.store,
    sessionSubject: input.sessionSubject,
    installation,
    planRun: input.planRun,
    fallbackRun: undefined,
    requestedStatus: projectionStatusFromRunStatus(
      input.response.applyRun.status,
    ),
  });
}

async function syncDeployControlProjectionStatusFromRun(input: {
  readonly store: AccountsStore;
  readonly run: Run;
}): Promise<void> {
  if (input.run.type !== "apply" || !input.run.installationId) return;
  const requestedStatus = projectionStatusFromRunStatus(input.run.status);
  if (requestedStatus === "installing") return;
  const installation = await input.store.findAppInstallation(
    input.run.installationId,
  );
  if (!installation) return;
  await saveProjectionStatusChange({
    store: input.store,
    installation,
    requestedStatus,
    reason: `deploy-control ${input.run.type} run ${input.run.status}`,
  });
}

async function upsertDeployControlInstallationProjection(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly installation: PublicInstallation;
  readonly planRun: PublicPlanRun;
  readonly fallbackRun?: Run;
  readonly requestedStatus: AppInstallationStatus;
}): Promise<void> {
  const source = await projectionSourceFromPlanRun({
    operations: input.operations,
    planRun: input.planRun,
    fallbackRun: input.fallbackRun,
  });
  if (!source) return;
  const existing = await input.store.findAppInstallation(input.installation.id);
  if (existing?.status === "ready" && input.requestedStatus === "installing") {
    return;
  }
  const now = Date.now();
  const accountId =
    existing?.accountId ??
    (await ensureProjectionLedgerScope({
      operations: input.operations,
      store: input.store,
      sessionSubject: input.sessionSubject,
      spaceId: input.installation.spaceId,
      now,
    }));
  if (!accountId) return;
  const status = nextProjectionStatus(existing?.status, input.requestedStatus);
  const record: InstallationRecord = {
    installationId: input.installation.id,
    accountId,
    spaceId: input.installation.spaceId,
    appId: input.installation.name,
    sourceGitUrl: source.sourceGitUrl,
    sourceRef: source.sourceRef,
    sourceCommit: source.sourceCommit,
    planDigest: source.planDigest,
    ...(source.artifactDigest ? { artifactDigest: source.artifactDigest } : {}),
    mode: existing?.mode ?? "self-hosted",
    ...(existing?.runtimeBindingId
      ? { runtimeBindingId: existing.runtimeBindingId }
      : {}),
    ...(existing?.billingAccountId
      ? { billingAccountId: existing.billingAccountId }
      : {}),
    status,
    createdBySubject: existing?.createdBySubject ?? input.sessionSubject,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await input.store.saveAppInstallation(record);
  if (!existing) {
    await appendLedgerEvent(input.store, {
      installationId: record.installationId,
      eventType: "installation.created",
      payload: {
        appId: record.appId,
        accountId: record.accountId,
        spaceId: record.spaceId,
        mode: record.mode,
        status: record.status,
      },
      now,
    });
    return;
  }
  if (record.status !== existing.status) {
    await appendProjectionStatusChangedEvent({
      store: input.store,
      installationId: record.installationId,
      from: existing.status,
      to: record.status,
      reason: "deploy-control projection sync",
      now,
    });
  }
}

async function saveProjectionStatusChange(input: {
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly requestedStatus: AppInstallationStatus;
  readonly reason: string;
}): Promise<void> {
  const status = nextProjectionStatus(
    input.installation.status,
    input.requestedStatus,
  );
  if (status === input.installation.status) return;
  const now = Date.now();
  await input.store.saveAppInstallation({
    ...input.installation,
    status,
    updatedAt: now,
  });
  await appendProjectionStatusChangedEvent({
    store: input.store,
    installationId: input.installation.installationId,
    from: input.installation.status,
    to: status,
    reason: input.reason,
    now,
  });
}

async function appendProjectionStatusChangedEvent(input: {
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly from: AppInstallationStatus;
  readonly to: AppInstallationStatus;
  readonly reason: string;
  readonly now: number;
}): Promise<void> {
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.status_changed",
    payload: {
      from: input.from,
      to: input.to,
      reason: input.reason,
    },
    now: input.now,
  });
}

async function ensureProjectionLedgerScope(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly spaceId: string;
  readonly now: number;
}): Promise<string | undefined> {
  const existingSpace = await input.store.findSpace(input.spaceId);
  if (existingSpace) {
    const existingAccount = await input.store.findLedgerAccount(
      existingSpace.accountId,
    );
    if (
      existingAccount &&
      existingAccount.legalOwnerSubject !== input.sessionSubject
    ) {
      return undefined;
    }
    if (!existingAccount) {
      await input.store.saveLedgerAccount({
        accountId: existingSpace.accountId,
        legalOwnerSubject: input.sessionSubject,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return existingSpace.accountId;
  }
  const accountId = await projectionAccountIdForSubject(input.sessionSubject);
  const existingAccount = await input.store.findLedgerAccount(accountId);
  if (!existingAccount) {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: input.sessionSubject,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  const space = await input.operations.spaces
    .getSpace(input.spaceId)
    .catch(() => undefined);
  await input.store.saveSpace({
    spaceId: input.spaceId,
    accountId,
    kind: ledgerSpaceKind(space?.type),
    ...(space?.displayName ? { displayName: space.displayName } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  });
  const confirmedSpace = await input.store.findSpace(input.spaceId);
  return confirmedSpace?.accountId === accountId ? accountId : undefined;
}

async function projectionSourceFromPlanRun(input: {
  readonly operations: ControlPlaneOperations;
  readonly planRun: PublicPlanRun;
  readonly fallbackRun?: Run;
}): Promise<DeployControlProjectionSource | undefined> {
  const snapshotId =
    input.planRun.sourceSnapshotId ?? input.fallbackRun?.sourceSnapshotId;
  const snapshot = snapshotId
    ? await input.operations
        .getSourceSnapshot(snapshotId)
        .catch(() => undefined)
    : undefined;
  if (snapshot) {
    return {
      sourceGitUrl: snapshot.url,
      sourceRef: snapshot.ref,
      sourceCommit: snapshot.resolvedCommit || snapshot.archiveDigest,
      planDigest:
        input.planRun.planDigest ??
        input.fallbackRun?.planDigest ??
        snapshot.archiveDigest,
      ...(input.planRun.planArtifact?.digest
        ? { artifactDigest: input.planRun.planArtifact.digest }
        : {}),
    };
  }
  const source = (input.planRun as { readonly source?: OpenTofuModuleSource })
    .source;
  if (!source) return undefined;
  const planDigest =
    input.planRun.planDigest ??
    input.fallbackRun?.planDigest ??
    input.planRun.sourceDigest;
  const artifactDigest = input.planRun.planArtifact?.digest;
  if (source.kind === "git") {
    return {
      sourceGitUrl: source.url,
      sourceRef: source.ref ?? "HEAD",
      sourceCommit:
        input.planRun.sourceCommit ??
        source.commit ??
        input.planRun.sourceDigest,
      planDigest,
      ...(artifactDigest ? { artifactDigest } : {}),
    };
  }
  if (source.kind === "prepared") {
    return {
      sourceGitUrl: source.url,
      sourceRef: "prepared",
      sourceCommit: input.planRun.sourceCommit ?? source.digest,
      planDigest,
      ...(artifactDigest ? { artifactDigest } : {}),
    };
  }
  return {
    sourceGitUrl: `local:${source.path}`,
    sourceRef: source.modulePath ?? "local",
    sourceCommit: input.planRun.sourceCommit ?? input.planRun.sourceDigest,
    planDigest,
    ...(artifactDigest ? { artifactDigest } : {}),
  };
}

function projectionStatusFromDeploy(
  deployResponse: DeployResponse,
): AppInstallationStatus {
  if (
    deployResponse.status === "failed" ||
    deployResponse.run.status === "failed" ||
    deployResponse.planRun?.status === "failed" ||
    deployResponse.applyRun?.status === "failed"
  ) {
    return "failed";
  }
  if (
    deployResponse.status === "applied" ||
    deployResponse.applyRun?.status === "succeeded" ||
    (deployResponse.installation.status === "active" &&
      deployResponse.installation.currentStateGeneration > 0)
  ) {
    return "ready";
  }
  return "installing";
}

function projectionStatusFromRunStatus(
  status: Run["status"],
): AppInstallationStatus {
  if (status === "succeeded") return "ready";
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "failed";
  }
  return "installing";
}

function nextProjectionStatus(
  existing: AppInstallationStatus | undefined,
  requested: AppInstallationStatus,
): AppInstallationStatus {
  if (!existing) return requested;
  if (existing === requested) return existing;
  if (existing === "ready" && requested === "failed") return existing;
  if (canTransitionAppInstallationStatus(existing, requested)) return requested;
  return existing;
}

async function projectionAccountIdForSubject(
  subject: TakosumiSubject,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`takosumi.accounts.projection-account:${subject}`),
  );
  return `acct_${base64UrlEncodeBytes(new Uint8Array(digest)).slice(0, 32)}`;
}

function ledgerSpaceKind(type: SpaceType | undefined): SpaceKind {
  return type === "organization" ? "org" : "personal";
}

function logDeployUploadFailure(
  error: unknown,
  context: {
    readonly method: string;
    readonly path: string;
    readonly spaceId: string;
    readonly name: string;
    readonly snapshotId: string;
    readonly environment: string;
    readonly hasVars: boolean;
    readonly providerConnectionCount: number;
  },
): void {
  console.error("Takosumi control deploy upload failed", {
    ...context,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
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
  return json({ run: await publicRun(operations, run) });
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
  const response = await operations.createApplyRun(applyRequest);
  await syncDeployControlProjectionFromApply({
    operations,
    store,
    sessionSubject: sessionSubject as TakosumiSubject,
    planRun,
    response,
  });
  return jsonStatus(await publicApplyActionResponse(operations, response), 201);
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
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
        }
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
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}

async function approveRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.approveRunGroup(runGroupId);
  if (!result) return errorJson("not_found", "not found", 404);
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
    return errorJson(
      "invalid_request",
      "spaceId query parameter is required",
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
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  return json(await operations.listConnections(spaceId, page.params));
}

/**
 * Registers a Space-owned provider/source helper Connection from the dashboard
 * session. This is the credential-helper write path
 * the §31 connections screen calls same-origin: the guided-token paste and the
 * raw-token "詳細設定" fallback both POST here.
 *
 * Invariants enforced here (independent of any client coercion):
 *   - the session subject must own the target Space (space-permission gate);
 *   - the created Connection is ALWAYS `scope: "space"`; Gateway/global
 *     internal resolver records stay on the bearer-gated §30 surface, so we force
 *     `scope` server-side;
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
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const spaceId = stringValue(body.spaceId) ?? stringValue(body.space_id);
  if (!spaceId) {
    return errorJson("invalid_request", "spaceId is required", 400);
  }
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const requestedKind = stringValue(body.kind);
  const sourceGitKind =
    requestedKind === "source_git_https_token" ? requestedKind : undefined;
  const requestedCredentialDriver = stringValue(body.credentialDriver);
  const requestedGenericEnv =
    requestedKind === "generic_env_provider" ||
    requestedCredentialDriver === "generic_env";
  const provider = sourceGitKind
    ? sourceGitKind
    : (stringValue(body.provider) ?? "cloudflare");
  const normalizedProvider = isGoogleCloudProvider(provider)
    ? "google"
    : provider;
  const values = stringRecord(body.values);
  if (!values || Object.keys(values).length === 0) {
    return errorJson("invalid_request", "values is required", 400);
  }
  if (sourceGitKind && !stringValue(values.GIT_HTTPS_TOKEN)) {
    return errorJson(
      "invalid_request",
      "values.GIT_HTTPS_TOKEN is required",
      400,
    );
  }
  const scopeHints = connectionScopeHintsFromValues(
    normalizedProvider,
    values,
    body.scopeHints,
  );
  const createRequest: CreateConnectionRequest = {
    spaceId,
    provider: normalizedProvider,
    credentialDriver: sourceGitKind
      ? "static_secret"
      : requestedGenericEnv
        ? "generic_env"
        : normalizedProvider === "cloudflare"
          ? "cloudflare_api_token"
          : normalizedProvider === "google"
            ? "gcp_service_account_json"
            : "generic_env",
    // Cloudflare gets the dedicated api-token kind; source Git gets the source
    // credential kind; anything else is the generic-env provider kind.
    kind: sourceGitKind
      ? sourceGitKind
      : requestedGenericEnv
        ? "generic_env_provider"
        : normalizedProvider === "cloudflare"
          ? "cloudflare_api_token"
          : normalizedProvider === "google"
            ? "gcp_service_account_json"
            : "generic_env_provider",
    authMethod: "static_secret",
    // Force Space scope: the dashboard session surface never mints an operator
    // default. Any caller-supplied `scope` is ignored.
    scope: "space",
    ...(stringValue(body.displayName)
      ? { displayName: stringValue(body.displayName) }
      : {}),
    ...(scopeHints ? { scopeHints } : {}),
    values,
  };
  const response = await operations.createConnection(createRequest);
  // `response.connection` is the public projection (no secret values).
  return jsonStatus(response, 201);
}

/**
 * Connection item op (test / revoke) from the dashboard session
 * (`POST /api/v1/connections/:id/{test,revoke}`). This is the consolidated
 * surface that replaced the former account-plane `/v1/connections/:id` edge.
 *
 * The request only names the connection id, so space ownership is enforced by
 * first reading the Connection (a non-secret projection — the public Connection
 * type carries no values) to learn its `spaceId`, then checking the session
 * subject owns that Space. To prevent cross-tenant probing of connection ids, a
 * missing connection, an absent `spaceId`, and a space-ownership failure all
 * answer a non-disclosing `connection_not_found` (404).
 */
async function connectionItemOp(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  connectionId: string,
  op: "test" | "revoke",
): Promise<Response> {
  if (!connectionId) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  // Resolve the Connection's owning Space for the ownership gate. A missing
  // connection (typed `not_found`) is mapped to the same non-disclosing 404.
  let connection: Connection;
  try {
    connection = await operations.getConnection(connectionId);
  } catch (error) {
    if (controllerErrorCode(error) === "not_found") {
      return errorJson("connection_not_found", "connection not found", 404);
    }
    throw error;
  }
  const spaceId = connection.spaceId;
  if (!spaceId) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  // Both test (re-verify) and revoke (delete the sealed blob) are write-scoped
  // mutations; the ownership failure must not disclose the connection's
  // existence, so a 403 from the gate is surfaced as a 404 here.
  const auth = await requireSpaceAccess({
    operations,
    store,
    spaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) {
    return errorJson("connection_not_found", "connection not found", 404);
  }
  if (op === "test") {
    return json(await operations.testConnection(connectionId));
  }
  await operations.revokeConnection(connectionId);
  return new Response(null, { status: 204 });
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
    return errorJson("invalid_request", "spaceId is required", 400);
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
 * the code, registers the resulting Space-owned `generic_env_provider` Connection,
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
  let created: ConnectionResponse;
  try {
    // Force Space scope regardless of what the helper produced.
    created = await operations.createConnection({
      ...createRequest,
      scope: "space",
    });
  } catch {
    return redirectToConnections(url, { error: "oauth_failed" });
  }
  let connectionStatus: TestConnectionResponse["status"] | undefined;
  try {
    const result = await operations.testConnection(created.connection.id);
    connectionStatus = result.status;
  } catch {
    connectionStatus = "pending";
  }
  return redirectToConnections(url, {
    connected: spaceId,
    connectionId: created.connection.id,
    connectionStatus,
  });
}

function connectionOAuthUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "Cloudflare OAuth is not configured on this deployment.",
    501,
  );
}

/**
 * Same-origin redirect back to the dashboard connections screen. Only opaque
 * status keys (`connected` / `connection_error`) and the public Connection id /
 * verification status ride the query — never the token or any error detail.
 */
function redirectToConnections(
  url: URL,
  result: {
    readonly connected?: string;
    readonly error?: string;
    readonly connectionId?: string;
    readonly connectionStatus?: TestConnectionResponse["status"];
  },
): Response {
  const target = new URL("/connections", url.origin);
  if (result.connected) target.searchParams.set("connected", "1");
  if (result.connectionId)
    target.searchParams.set("connection_id", result.connectionId);
  if (result.connectionStatus)
    target.searchParams.set("connection_status", result.connectionStatus);
  if (result.error) target.searchParams.set("connection_error", result.error);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString() },
  });
}

async function listProviderConnections(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  const spaceId =
    stringValue(url.searchParams.get("spaceId") ?? undefined) ??
    stringValue(url.searchParams.get("space_id") ?? undefined);
  if (!spaceId) {
    return errorJson(
      "invalid_request",
      "spaceId query parameter is required",
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
  const providerConnections = await Promise.all(
    (await operations.connections.listProviderEnvs(spaceId))
      .filter((providerEnv) => providerEnv.spaceId !== undefined)
      .map((providerEnv) => publicProviderConnection(operations, providerEnv)),
  );
  return json({ providerConnections });
}

function publicProviderEnv(providerEnv: ProviderEnv): PublicProviderEnv {
  const { secretRef: _secretRef, ...publicEnv } = providerEnv;
  void _secretRef;
  return publicEnv;
}

async function publicProviderConnection(
  operations: ControlPlaneOperations,
  providerEnv: ProviderEnv,
): Promise<ProviderConnection> {
  const publicEnv = publicProviderEnv(providerEnv);
  return {
    id: await publicProviderConnectionId(publicEnv.id),
    ...(publicEnv.spaceId ? { spaceId: publicEnv.spaceId } : {}),
    providerSource: publicEnv.providerSource,
    displayName: publicEnv.displayName,
    ownership: await providerConnectionOwnership(operations, providerEnv),
    status: publicEnv.status,
    requiredEnvNames: publicEnv.requiredEnvNames,
    ...(publicEnv.expiresAt ? { expiresAt: publicEnv.expiresAt } : {}),
    createdAt: publicEnv.createdAt,
    updatedAt: publicEnv.updatedAt,
  };
}

async function resolveProviderConnectionBindings(
  operations: ControlPlaneOperations,
  spaceId: string,
  bindings: InstallationProviderConnectionBindings,
): Promise<
  | { readonly ok: true; readonly bindings: InstallationProviderEnvBindings }
  | { readonly ok: false; readonly message: string }
> {
  const visibleProviderEnvs = (
    await operations.connections.listProviderEnvs(spaceId)
  ).filter((providerEnv) => providerEnv.spaceId !== undefined);
  const envByPublicId = new Map<string, ProviderEnv>();
  for (const providerEnv of visibleProviderEnvs) {
    envByPublicId.set(
      await publicProviderConnectionId(providerEnv.id),
      providerEnv,
    );
  }
  const resolved: InstallationProviderEnvBinding[] = [];
  for (const [index, binding] of bindings.entries()) {
    const providerEnv = envByPublicId.get(binding.connectionId);
    if (!providerEnv) {
      return {
        ok: false,
        message: `connections[${index}]: unknown provider connection`,
      };
    }
    resolved.push({
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      envId: providerEnv.id,
      ...(binding.region ? { region: binding.region } : {}),
    });
  }
  return { ok: true, bindings: resolved };
}

async function publicProviderConnectionId(
  providerEnvId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `takosumi-provider-connection:v1:${providerEnvId}`,
    ),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `pcn_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 32)}`;
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
    return errorJson(
      "invalid_request",
      "spaceId query parameter is required",
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
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const { items, nextCursor } = await operations.outputShares.listForSpacePage(
    spaceId,
    page.params,
  );
  return json({
    shares: items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function createOutputShare(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const fromSpaceId = stringValue(body.fromSpaceId);
  const toSpaceId = stringValue(body.toSpaceId);
  const producerInstallationId = stringValue(body.producerInstallationId);
  const outputs = outputShareEntries(body.outputs);
  const sensitivePolicy = outputShareSensitivePolicy(body.sensitivePolicy);
  if (!fromSpaceId || !toSpaceId || !producerInstallationId || !outputs) {
    return errorJson(
      "invalid_request",
      "fromSpaceId, toSpaceId, producerInstallationId, and outputs are required",
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
    return errorJson(
      "invalid_request",
      "producerInstallationId must belong to the source Space.",
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
  if (!existing) return errorJson("not_found", "not found", 404);
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
  if (!existing) return errorJson("not_found", "not found", 404);
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
    response: errorJson(
      "forbidden",
      "The authenticated session cannot access this Space.",
      403,
    ),
  };
}

export async function canAccessSpace(input: {
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringRecordValue(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

function jsonRecordValue(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return undefined;
    if (!isJsonValue(item)) return undefined;
    out[key] = item;
  }
  return out;
}

function outputAllowlistValue(
  value: unknown,
): Readonly<Record<string, OutputAllowlistEntry>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, OutputAllowlistEntry> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const from = stringValue(record.from);
    const type = stringValue(record.type);
    if (!from || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(from)) return undefined;
    if (
      type !== "string" &&
      type !== "url" &&
      type !== "hostname" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "json"
    ) {
      return undefined;
    }
    const required = booleanValue(record.required);
    out[name] = {
      from,
      type,
      ...(required !== undefined ? { required } : {}),
    };
  }
  return out;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function parseInstallationProviderConnectionBindings(value: unknown):
  | {
      readonly ok: true;
      readonly bindings: InstallationProviderConnectionBindings;
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "connections must be an array" };
  }
  const connections: InstallationProviderConnectionBinding[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseInstallationProviderConnectionBinding(item);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `connections[${index}]: ${parsed.message}`,
      };
    }
    connections.push(parsed.binding);
  }
  return { ok: true, bindings: connections };
}

function parseInstallationProviderConnectionBinding(value: unknown):
  | {
      readonly ok: true;
      readonly binding: InstallationProviderConnectionBinding;
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "connection must be an object" };
  }
  const input = value as Record<string, unknown>;
  const provider = stringValue(input.provider);
  if (!provider) return { ok: false, message: "provider is required" };
  const connectionId = stringValue(input.connectionId);
  if (!connectionId) {
    return { ok: false, message: "connectionId is required" };
  }
  const binding: {
    provider: string;
    alias?: string;
    connectionId: string;
    region?: string;
  } = { provider, connectionId };
  const alias = stringValue(input.alias);
  if (alias) binding.alias = alias;
  const region = stringValue(input.region);
  if (region) binding.region = region;
  return { ok: true, binding };
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
 * Extracts the non-secret connection scope hints the UI may pass. Only the
 * well-known string fields are forwarded.
 */
function connectionScopeHints(
  value: unknown,
): ConnectionScopeHints | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const hints: Record<string, string> = {};
  for (const key of [
    "accountId",
    "zoneId",
    "repoUrl",
    "username",
    "knownHostsEntry",
    "awsRegion",
    "gcpProjectId",
    "gcpServiceAccountEmail",
    "templateId",
  ] as const) {
    const v = stringValue(value[key]);
    if (v) hints[key] = v;
  }
  return Object.keys(hints).length > 0
    ? (hints as ConnectionScopeHints)
    : undefined;
}

function connectionScopeHintsFromValues(
  provider: string,
  values: Readonly<Record<string, string>>,
  explicit: unknown,
): ConnectionScopeHints | undefined {
  const derived: Record<string, string> = {};
  if (provider === "cloudflare") {
    const accountId = stringValue(values.CLOUDFLARE_ACCOUNT_ID);
    if (accountId) derived.accountId = accountId;
  }
  if (isGoogleCloudProvider(provider)) {
    const projectId =
      stringValue(values.GOOGLE_CLOUD_PROJECT) ??
      stringValue(values.GOOGLE_PROJECT);
    if (projectId) derived.gcpProjectId = projectId;
  }
  const hints = {
    ...derived,
    ...(connectionScopeHints(explicit) ?? {}),
  };
  return Object.keys(hints).length > 0
    ? (hints as ConnectionScopeHints)
    : undefined;
}

function isGoogleCloudProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "gcp" || normalized === "google";
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
