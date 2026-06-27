/**
 * The structural `ControlPlaneOperations` facade the session-authed control
 * surface (`accounts/service/src/control/*`) calls, plus the membership
 * projection co-types. Extracted from `control-routes.ts` (P3 god-file split);
 * `control-routes.ts` re-exports `ControlPlaneOperations` / `RunGroupWithRunsLike`
 * so the ~4 in-tree importers are unchanged.
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  InternalDeployRequest,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ArtifactSnapshotRequest,
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
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProvidersResponse } from "takosumi-contract/providers";
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
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  InstallationProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
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
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

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
export interface MembershipActor {
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
        readonly archived?: boolean;
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
    record?(
      event: Omit<ActivityEvent, "id" | "createdAt">,
    ): Promise<ActivityEvent | undefined>;
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
  recordArtifactSnapshot(input: {
    readonly spaceId: string;
    readonly url: string;
    readonly digest: string;
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
    input: { readonly usdMicros?: number; readonly credits?: number },
  ): Promise<{ readonly balance: CreditBalance }>;
  changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
  // --- Connections (§9) ---
  readonly connections: {
    listProviderConnections(
      spaceId?: string,
    ): Promise<readonly ProviderConnection[]>;
    getProviderConnection?(id: string): Promise<ProviderConnection>;
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
  listRuns(
    spaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly Run[]>;
  createInstallationPlan(
    installationId: string,
    options?: {
      readonly compatibilityReportId?: string;
      readonly runnerProfileId?: string;
    },
  ): Promise<PlanRunResponse>;
  createInstallationDestroyPlan(
    installationId: string,
    options?: {
      readonly runnerProfileId?: string;
    },
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
  listProviderCatalogEntries(): Promise<ListProvidersResponse>;
  // --- Runner profiles (read; used by Provider Connection / Gateway views) ---
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
}

/** Loose RunGroup-with-runs projection (avoids importing the service type). */
export interface RunGroupWithRunsLike {
  readonly runGroup: { readonly id: string; readonly spaceId: string };
  readonly runs: readonly Run[];
}
