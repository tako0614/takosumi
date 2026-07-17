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
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  ListConnectionsResponse,
  ListStateVersionsResponse,
  GetStateVersionResponse,
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
  SourceSyncIntent,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
  WorkspaceType,
} from "takosumi-contract/workspaces";
import type { Project } from "takosumi-contract/projects";
import type {
  InstallConfig,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  Output,
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CapsuleUsageSummary,
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
import type { InterfaceOAuthActivityEvidence } from "./access-token-activity.ts";

interface CapsuleListPageParams extends PageParams {
  readonly includeDestroyed?: boolean;
}

// The Accounts facade uses the canonical WorkspaceMember ledger shape directly.
// These aliases preserve the local handler vocabulary without maintaining a
// second membership model.
export type ControlWorkspaceRole = WorkspaceRole;
export type ControlMembershipStatus = WorkspaceMemberStatus;
export type PublicWorkspaceMember = WorkspaceMember;

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
  /** Optional narrow Core seam used only for Interface OAuth active checks. */
  readonly interfaces?: {
    validatePrincipalOAuth2TokenEvidence(
      evidence: InterfaceOAuthActivityEvidence,
    ): Promise<boolean>;
  };
  // --- Workspaces (§4) ---
  readonly workspaces: {
    listWorkspaces(): Promise<readonly Workspace[]>;
    listWorkspacesByOwner(ownerUserId: string): Promise<readonly Workspace[]>;
    listWorkspacesForAccount(accountId: string): Promise<readonly Workspace[]>;
    listWorkspacesByIds?(ids: readonly string[]): Promise<readonly Workspace[]>;
    getWorkspace(id: string): Promise<Workspace>;
    createWorkspace(request: {
      readonly handle: string;
      readonly displayName: string;
      readonly type: WorkspaceType;
      readonly ownerUserId: string;
    }): Promise<Workspace>;
    updateWorkspace(
      id: string,
      patch: {
        readonly displayName?: string;
        readonly policy?: PolicyConfig;
        readonly archived?: boolean;
      },
    ): Promise<Workspace>;
  };
  // --- Projects (canonical Workspace-owned grouping) ---
  readonly projects: {
    createProject(request: {
      readonly workspaceId: string;
      readonly name: string;
      readonly slug: string;
      readonly projectJson?: Readonly<Record<string, unknown>>;
    }): Promise<Project>;
    listProjects(workspaceId: string): Promise<readonly Project[]>;
    getProject(id: string): Promise<Project>;
  };
  // --- Members (membership domain: Workspace members + roles) ---
  //
  // Backed in-process by the membership domain's
  // `MembershipRoleEntitlementService` (`listWorkspaceMemberships` /
  // `upsertWorkspaceMembership`). The control surface resolves the Workspace server-side
  // and enforces the role gate BEFORE calling these; the service's own
  // owner/admin gate is a defense-in-depth backstop. The membership domain has
  // no hard-delete and no invitation/notification machinery, so:
  //   - `addMember` upserts (handle/subject is added directly as an active or
  //     invited member; there is no email invite or notification side-channel),
  //   - `removeMember` is a SOFT remove (`status: "suspended"`), since the
  //     membership store exposes no delete.
  readonly members: {
    /** Lists a Workspace's memberships (membership domain `listWorkspaceMemberships`). */
    listMembers(workspaceId: string): Promise<readonly PublicWorkspaceMember[]>;
    /**
     * Adds or updates one Workspace membership (membership domain
     * `upsertWorkspaceMembership`). Used for invite/add and for role changes; a
     * `status: "suspended"` upsert is the soft-remove path. Returns the upserted
     * membership projection.
     */
    upsertMember(input: {
      readonly workspaceId: string;
      readonly accountId: string;
      readonly roles?: readonly ControlWorkspaceRole[];
      readonly status?: ControlMembershipStatus;
      readonly actor: MembershipActor;
    }): Promise<PublicWorkspaceMember>;
  };
  // --- Capsules + InstallConfigs (§5 / §11) ---
  readonly capsules: {
    getCapsule(id: string): Promise<Capsule>;
    listCapsules(workspaceId: string): Promise<readonly Capsule[]>;
    listCapsulesPage(
      workspaceId: string,
      params: CapsuleListPageParams,
    ): Promise<Page<Capsule>>;
    createCapsule(request: {
      readonly workspaceId: string;
      readonly projectId?: string;
      readonly name: string;
      readonly environment: string;
      readonly sourceId: string;
      readonly installConfigId: string;
      readonly autoUpdate?: boolean;
    }): Promise<Capsule>;
    putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
    getInstallConfig(id: string): Promise<InstallConfig>;
    listInstallConfigs(workspaceId?: string): Promise<readonly InstallConfig[]>;
    patchCapsuleStatus(id: string, status: Capsule["status"]): Promise<Capsule>;
    setCapsuleAutoUpdate(id: string, enabled: boolean): Promise<Capsule>;
    abandonUnappliedCapsule?(id: string, reason: string): Promise<Capsule>;
    putProviderBindingSet(
      profile: ProviderBindingSet,
    ): Promise<ProviderBindingSet>;
    getProviderBindingSetByCapsule(
      capsuleId: string,
      environment: string,
    ): Promise<ProviderBindingSet | undefined>;
  };
  // --- Dependencies (§14 / §15) ---
  readonly dependencies: {
    createDependency(request: {
      readonly workspaceId: string;
      readonly producerCapsuleId: string;
      readonly consumerCapsuleId: string;
      readonly mode: DependencyMode;
      readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
      readonly visibility: DependencyVisibility;
    }): Promise<Dependency>;
    getDependency(id: string): Promise<Dependency | undefined>;
    listForCapsule(capsuleId: string): Promise<{
      readonly asProducer: readonly Dependency[];
      readonly asConsumer: readonly Dependency[];
    }>;
    deleteDependency(id: string): Promise<boolean>;
  };
  /**
   * Workspace-wide dependency edge listing for the graph projection. Added to the
   * facade in M10 (mirrors the store's `listDependenciesByWorkspace`).
   */
  listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]>;
  // --- RunGroups (§19 / §24) ---
  readonly runGroups: {
    createWorkspaceUpdate(workspaceId: string): Promise<RunGroupWithRunsLike>;
    createWorkspaceDriftCheck(
      workspaceId: string,
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
    list(
      workspaceId: string,
      limit?: number,
    ): Promise<readonly ActivityEvent[]>;
  };
  // --- Backups (§29) ---
  readonly backups: {
    createBackup(input: {
      readonly workspaceId: string;
      readonly createdByRunId?: string;
      readonly capsuleId?: string;
      readonly environment?: string;
    }): Promise<BackupRecord>;
    listBackups(
      workspaceId: string,
      params?: PageParams,
    ): Promise<ListBackupsResponse>;
  };
  createRestoreRun(
    workspaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context?: { readonly actor?: string },
  ): Promise<Run>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot>;
  readSourceSnapshotFiles(
    id: string,
    options?: { readonly modulePath?: string },
  ): Promise<readonly { readonly path: string; readonly text: string }[]>;
  // --- Billing (§28) ---
  getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
    };
  }>;
  getCapsuleUsageSummary(capsuleId: string): Promise<CapsuleUsageSummary>;
  listWorkspaceUsage(
    workspaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }>;
  // --- Connections (§9) ---
  readonly connections: {
    listProviderConnections(
      workspaceId?: string,
    ): Promise<readonly ProviderConnection[]>;
    getProviderConnection?(id: string): Promise<ProviderConnection>;
  };
  // --- OutputShares (§18) ---
  readonly outputShares: {
    createShare(request: {
      readonly fromWorkspaceId: string;
      readonly toWorkspaceId: string;
      readonly producerCapsuleId: string;
      readonly outputs: readonly {
        readonly name: string;
        readonly alias?: string;
        readonly sensitive?: boolean;
      }[];
    }): Promise<OutputShare>;
    listForWorkspace(workspaceId: string): Promise<readonly OutputShare[]>;
    listForWorkspacePage(
      workspaceId: string,
      params: PageParams,
    ): Promise<Page<OutputShare>>;
    getShare(id: string): Promise<OutputShare | undefined>;
    approveShare(id: string): Promise<OutputShare>;
    revokeShare(id: string): Promise<OutputShare>;
  };
  listConnections(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse>;
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  getConnection(connectionId: string): Promise<ProviderConnection>;
  /**
   * Registers a Workspace-owned Provider Connection (§9). The control
   * surface only ever builds Workspace-scoped requests here (guided-token / OAuth /
   * generic-env helper paths); the response is the public {@link ProviderConnection}
   * projection, which carries NO secret `values`.
   */
  createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse>;
  /**
   * Re-verifies a Provider Connection's stored credential with the provider (§30
   * `POST /internal/v1/connections/:id/test`). The control surface resolves the
   * Provider Connection's owning Workspace (via {@link getConnection}) and Workspace-permission
   * gates BEFORE calling this; the response carries no secret values.
   */
  testConnection(connectionId: string): Promise<TestConnectionResponse>;
  /**
   * Revokes a Provider Connection and deletes its sealed secret blob (§30
   * `POST /internal/v1/connections/:id/revoke`). The control surface resolves the
   * Provider Connection's owning Workspace (via {@link getConnection}) and Workspace-permission
   * gates BEFORE calling this. The wiring records the §27 / §34
   * `connection.revoked` Workspace activity, mirroring the deploy-control route.
   */
  revokeConnection(connectionId: string): Promise<void>;
  /** Provider-owned OAuth helpers keyed by opaque composition-time helper id. */
  readonly connectionOAuth?: Readonly<
    Record<
      string,
      {
        /**
         * `subject` is the authenticated account subject of the cookie-gated
         * caller. The helper signs it INTO the OAuth state so the cross-site
         * callback (which carries no session cookie) can authorize from the
         * signed state alone. See {@link handleControlRoute}.
         */
        start(input: {
          readonly subject: string;
          readonly workspaceId: string;
          readonly displayName?: string;
          readonly successRedirectUri?: string;
        }): Promise<ConnectionOAuthStartResponse>;
        /**
         * Verifies the signed state and returns BOTH the connection-create
         * request and the `subject` that was signed in at `start` time. The
         * callback authorizes the Workspace against that `subject`; `subject` is
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
      }
    >
  >;
  // --- Runs (§6.8 / §19 / §23) ---
  listRuns(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly Run[]>;
  createCapsulePlan(
    capsuleId: string,
    options?: {
      readonly compatibilityReportId?: string;
      readonly runnerProfileId?: string;
    },
  ): Promise<PlanRunResponse>;
  createCapsuleDestroyPlan(
    capsuleId: string,
    options?: {
      readonly runnerProfileId?: string;
    },
  ): Promise<PlanRunResponse>;
  createCapsuleDriftCheck(capsuleId: string): Promise<PlanRunResponse>;
  /**
   * Reads the internal PlanRun projection by id. The control surface uses it to
   * resolve a plan run's owning Workspace (for the apply Workspace-permission gate) and
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
  // --- StateVersions (§21 / §30) ---
  /** Lists a Capsule's persisted OpenTofu state generations. */
  listStateVersions(
    capsuleId: string,
    params?: PageParams,
  ): Promise<ListStateVersionsResponse>;
  /**
   * Optional in-process fast path for dashboard Workspace list projections.
   * Hosts that wire the canonical control store can answer current StateVersion rows
   * by id in one read; tests and older hosts can omit it and the route falls
   * back to Workspace-scoped or single-record reads.
   */
  listStateVersionsByIds?(
    stateVersionIds: readonly string[],
  ): Promise<readonly StateVersion[]>;
  listStateVersionsByWorkspace?(
    workspaceId: string,
  ): Promise<readonly StateVersion[]>;
  /**
   * Reads one StateVersion by id. A missing id is a typed `not_found`.
   */
  getStateVersion(id: string): Promise<GetStateVersionResponse>;
  /**
   * Reads an Output ledger row by its internal id. Session handlers may call
   * this only after resolving and authorizing the owning Capsule, and must
   * project out rawArtifactRef before returning a response.
   */
  getOutput(id: string): Promise<Output | undefined>;
  /**
   * Creates a rollback PLAN run from a StateVersion's creating Run provenance.
   */
  createStateVersionRollbackPlan(
    stateVersionId: string,
  ): Promise<PlanRunResponse>;
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
   * Workspace first and Workspace-permission gates before calling this. The returned
   * {@link RunCostInfo} carries only the values the controller already
   * computed at plan time (estimated USD, showback or host-extension decision,
   * and policy reasons) — no cost is computed here and no secret material is
   * returned.
   */
  getRunCost(id: string): Promise<RunCostInfo>;
  // --- Sources (§6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: {
      readonly dedupe?: boolean;
      readonly intent?: SourceSyncIntent;
    },
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
  listCredentialRecipes(): Promise<ListCredentialRecipesResponse>;
  // --- Runner profiles (read; used by Provider Connection views) ---
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
}

/** Loose RunGroup-with-runs projection (avoids importing the service type). */
export interface RunGroupWithRunsLike {
  readonly runGroup: { readonly id: string; readonly workspaceId?: string };
  readonly runs: readonly Run[];
}
