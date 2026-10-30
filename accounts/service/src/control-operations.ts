/**
 * The structural `ControlPlaneOperations` facade the session-authed control
 * surface (`accounts/service/src/control/*`) calls, plus the membership
 * projection co-types. Extracted from `control-routes.ts` (P3 god-file split);
 * `control-routes.ts` re-exports `ControlPlaneOperations` / `RunGroupWithRunsLike`
 * so the ~4 in-tree importers are unchanged.
 */
import type {
  RebindCapsuleInstallConfigRequest,
  RebindCapsuleInstallConfigResponse,
} from "../../../core/domains/capsules/mod.ts";
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
  CreateSourceSyncRequest,
  CreateSourceSyncResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  RotateSourceHookSecretResponse,
  SourceResponse,
  SourceSnapshot,
  SourceSyncRun,
  StableSourceTagResolutionResponse,
} from "takosumi-contract/sources";
import type {
  CapsuleAdoptedSourceRevision,
  CapsuleCompatibilityReport,
  CapsuleCompatibilityReportResponse,
  CapsuleUninstallRequester,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import type {
  AccountWorkspaceListParams,
  AccountWorkspacePage,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
  WorkspaceType,
} from "takosumi-contract/workspaces";
import type { AppAccessResolver } from "takosumi-contract/app-access";
import type { AppOwnershipStore } from "../../../core/domains/app-ownership/store.ts";
import type { AppViewerLists } from "../../../core/domains/app-ownership/list-visibility.ts";
import type { Project } from "takosumi-contract/projects";
import type { WorkspaceBillingBindingsService } from "../../../core/domains/workspace-billing-bindings/mod.ts";
import type {
  InstallConfig,
  InstallConfigCommittedPostApplyRecoveryProof,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  CapsulePlanCreationFence,
  WorkspaceManagementAuthority,
} from "../../../core/domains/deploy-control/store.ts";
import type { CompatibilityCheckManagementContext, EnsureOwnedSourceRequest } from "../../../core/domains/sources/mod.ts";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  Output,
} from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type {
  CapsuleCurrentResourceInventoryResponse,
} from "takosumi-contract/current-resource-inventory";
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
  RunPlanOrigin,
  RunType,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { InterfaceOAuthActivityEvidence } from "./access-token-activity.ts";
import type {
  CapsuleRequiredInterface,
  Interface,
} from "takosumi-contract/interfaces";
import type { GitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";
import type {
  CapsuleInterfaceMaterializationFailure,
  CapsuleInterfaceMaterializationRetryReceipt,
  RetryCapsuleInterfaceMaterializationFailureInput,
} from "../../../core/domains/interfaces/materialization_intent_failures.ts";

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
  readonly appOwnership?: AppOwnershipStore;
  /**
   * Workspace compatibility lists filtered for the caller in the store query.
   * Required whenever `appOwnership` is wired: list routes refuse (503)
   * instead of serving an unfiltered list without it.
   */
  readonly viewerLists?: AppViewerLists;
  readonly appAccess?: AppAccessResolver;
  readonly appAuthorization?: import("./control/app-ownership.ts").AppOwnershipOperations;
  readonly accountResources?: import("../../../core/domains/account-resources/read.ts").AccountResourceReader;
  /** Optional private owner-to-owner identity custody; no public caller admission. */
  readonly identityReconciliation?:import("../../../contract/identity-reconciliation.ts").ControlIdentityReconciliationPort;
  /** Durable, actor-scoped Git install/revision coordinator ledger. */
  readonly gitInstallPlans: GitInstallPlanStore;
  /**
   * Optional narrow Core seam for Interface OAuth active checks and the
   * session-authenticated dashboard launcher projection. Core remains the
   * binding/lifecycle authority; the account plane never reimplements it.
   */
  readonly interfaces?: {
    get?(id: string): Promise<Interface>;
    listCapsuleInterfaceLinks?(capsuleId: string): Promise<readonly import("takosumi-contract/interfaces").InterfaceLink[]>;
    listProviderCapsuleInterfaceLinks?(capsuleId: string): Promise<readonly import("takosumi-contract/interfaces").InterfaceLink[]>;
    getLatestCapsuleInterfaceLink?(capsuleId: string, key: string): Promise<import("takosumi-contract/interfaces").InterfaceLink | undefined>;
    getInterfaceLinkRequirement?(capsuleId: string, key: string): Promise<{ readonly capsule: Capsule; readonly requirement: CapsuleRequiredInterface }>;
    listInterfaceLinkCandidateView?(input: { readonly workspaceId: string; readonly capsuleId: string; readonly requirement: CapsuleRequiredInterface }): Promise<{ readonly candidates: readonly { readonly interfaceId: string; readonly providerCapsuleId: string; readonly providerCapsuleName: string; readonly interfaceName: string }[]; readonly generation: number; readonly requirementFingerprint: string }>;
    listInterfaceLinkCandidates?(input: { readonly workspaceId: string; readonly capsuleId: string; readonly requirement: CapsuleRequiredInterface }): Promise<readonly Interface[]>;
    interfaceLinksAvailable?(): Promise<boolean>;
    ensureCapsuleInterfaceLinks?(input: { readonly workspaceId: string; readonly capsuleId: string; readonly requirements: readonly CapsuleRequiredInterface[]; readonly selections: readonly { readonly requirementKey: string; readonly interfaceId: string; readonly selection: "explicit" | "auto_single" }[] }, actor?: import("takosumi-contract").ActorContext, writeFence?: import("../../../core/domains/interfaces/service.ts").InterfaceLinkWriteFence): Promise<readonly import("takosumi-contract/interfaces").InterfaceLink[]>;
    putCapsuleInterfaceLink?(input: { readonly capsuleId: string; readonly requirementKey: string; readonly interfaceId: string; readonly expectedGeneration: number; readonly expectedRequirementFingerprint?: string }, actor?: import("takosumi-contract").ActorContext, writeFence?: import("../../../core/domains/interfaces/service.ts").InterfaceLinkWriteFence): Promise<import("takosumi-contract/interfaces").InterfaceLink>;
    revokeCapsuleInterfaceLink?(capsuleId: string, key: string, expectedGeneration: number, actor?: import("takosumi-contract").ActorContext, writeFence?: import("../../../core/domains/interfaces/service.ts").InterfaceLinkWriteFence, authorizedProvider?: { readonly linkId: string; readonly providerInterfaceId: string; readonly providerCapsuleId: string }): Promise<import("takosumi-contract/interfaces").InterfaceLink>;
    revokeCapsuleInterfaceLinks?(workspaceId: string, capsuleId: string, reason?: "consumer_destroyed" | "install_discarded"): Promise<void>;
    listProviderInterfaceLinkRequests?(providerCapsuleId: string): Promise<readonly import("takosumi-contract/interfaces").InterfaceLink[]>;
    approveInterfaceLink?(input: { readonly providerCapsuleId: string; readonly linkId: string; readonly expectedGeneration: number; readonly approvedPermissions?: readonly string[] }, actor?: import("takosumi-contract").ActorContext, writeFence?: import("../../../core/domains/interfaces/service.ts").InterfaceLinkWriteFence): Promise<import("takosumi-contract/interfaces").InterfaceLink>;
    declineInterfaceLink?(input: { readonly providerCapsuleId: string; readonly linkId: string; readonly expectedGeneration: number }, actor?: import("takosumi-contract").ActorContext, writeFence?: import("../../../core/domains/interfaces/service.ts").InterfaceLinkWriteFence): Promise<import("takosumi-contract/interfaces").InterfaceLink>;
    ensureCapsuleRequiredInterfaces?(input: {
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly principalId: string;
      readonly requirements: readonly CapsuleRequiredInterface[];
    }): Promise<void>;
    validatePrincipalOAuth2TokenEvidence(
      evidence: InterfaceOAuthActivityEvidence,
    ): Promise<boolean>;
    listAuthorizedForPrincipal(
      filter: {
        readonly workspaceId: string;
        readonly type?: string;
        readonly phase: "Resolved";
        readonly ownerKind: "Capsule";
        readonly ownerId?: string;
      },
      subjectId: string,
      permission: "ui.open",
    ): Promise<readonly Interface[]>;
    listAuthorizedUiSurfaceCandidatesForPrincipalPage(
      filter: {
        readonly workspaceId: string;
        readonly phase: "Resolved";
      },
      subjectId: string,
      permission: "ui.open",
      params: PageParams,
      capsuleId?: string,
    ): Promise<Page<Interface>>;
  };
  // --- Workspaces (§4) ---
  readonly workspaces: {
    /** Generic retained binding owner facade over the same Control store. */
    readonly billingBindings?: Pick<WorkspaceBillingBindingsService, "get" | "prepare" | "claim">;
    /**
     * Idempotently creates or returns the subject's personal Workspace. Hosts
     * expose the Workspace domain's canonical ensure operation here so the
     * account plane never emulates it with repeated create attempts.
     */
    ensurePersonalWorkspace?(
      ownerUserId: string,
      handle: string,
    ): Promise<Workspace>;
    /** Shared hosted sign-in never repairs existing owner membership. */
    ensurePersonalWorkspaceForSharedAccount?(
      ownerUserId: string,
      handle: string,
    ): Promise<Workspace>;
    listWorkspaces(): Promise<readonly Workspace[]>;
    listWorkspacesByOwner(ownerUserId: string): Promise<readonly Workspace[]>;
    listWorkspacesForAccount(accountId: string): Promise<readonly Workspace[]>;
    listWorkspacesForAccountPage(
      accountId: string,
      params: AccountWorkspaceListParams,
    ): Promise<AccountWorkspacePage>;
    getWorkspaceForAccount(
      accountId: string,
      workspaceId: string,
    ): Promise<Workspace | undefined>;
    listWorkspacesByIds?(ids: readonly string[]): Promise<readonly Workspace[]>;
    getWorkspace(id: string): Promise<Workspace>;
    /**
     * Captures the exact active private Workspace-management authority for a
     * one-shot admission. The caller must retain this snapshot across async
     * preparation and pass it to the durable write; it must never be refreshed
     * after preparation starts.
     */
    captureManagementAuthority(
      workspaceId: string,
    ): Promise<WorkspaceManagementAuthority>;
    createWorkspace(request: {
      readonly handle: string;
      readonly displayName: string;
      readonly type: WorkspaceType;
      readonly ownerUserId: string;
    }): Promise<Workspace>;
    /** Organization-only creation; personal uses the shared singleton ensure.
     * Existing Workspace authority is never repaired by this operation. */
    createWorkspaceForSharedAccount?(request: {
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
    updateWorkspaceForAccount(
      id: string,
      patch: {
        readonly displayName?: string;
        readonly policy?: PolicyConfig;
        readonly archived?: boolean;
      },
      actorAccountId: string,
      expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority,
      options?: { readonly requireCurrentMembership?: boolean },
    ): Promise<Workspace>;
    /**
     * Deletes an empty Workspace as its owner. Refuses with
     * `permission_denied` for non-owners and `failed_precondition`
     * (`reason: "workspace_not_empty"`) while Capsules, Sources,
     * in-flight Runs, or usage evidence remain; observes `not_found`
     * once deleted. Never destroys cloud resources.
     */
    deleteWorkspaceForAccount(
      id: string,
      actorAccountId: string,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
      options?: { readonly requireCurrentMembership?: boolean },
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
    /** Exact pair lookup used by ordinary authorization reads. */
    getMember?(
      workspaceId: string,
      accountId: string,
    ): Promise<PublicWorkspaceMember | undefined>;
    /** Lists a Workspace's memberships (membership domain `listWorkspaceMemberships`). */
    listMembers(workspaceId: string): Promise<readonly PublicWorkspaceMember[]>;
    /**
     * Adds or updates one Workspace membership (membership domain
     * `upsertWorkspaceMembership`). Used for invite/add and for role changes; a
     * `status: "suspended"` upsert is the soft-remove path. Returns the upserted
     * membership projection.
     */
    upsertMember(input: {
      readonly expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority;
      /** Internal owner-only command policy, never current role authority. */
      readonly requiredActorRole?: "owner";
      readonly requireCurrentMembership?: boolean;
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
    getCapsulesByIds(ids: readonly string[]): Promise<readonly Capsule[]>;
    listCapsules(workspaceId: string): Promise<readonly Capsule[]>;
    listCapsulesPage(
      workspaceId: string,
      params: CapsuleListPageParams,
    ): Promise<Page<Capsule>>;
    /** Server-only create of the complete initial deployment authority. */
    createCapsuleInitialAuthority(request: {
      readonly capsuleId: string;
      readonly workspaceId: string;
      readonly projectId?: string;
      /** Private management authority retained across initial preparation. */
      readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
      readonly name: string;
      readonly environment: string;
      readonly sourceId: string;
      readonly installingPrincipalId: string;
      readonly autoUpdate?: boolean;
      readonly installConfig: InstallConfig;
      readonly providerBindingSetId: string;
      readonly providerBindings: ProviderBindingSet["bindings"];
    }): Promise<{ readonly capsule: Capsule; readonly replayed: boolean }>;
    putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
    createInstallConfigIfAbsent(
      config: InstallConfig,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ): Promise<boolean>;
    getInstallConfig(id: string): Promise<InstallConfig>;
    /** Private continuation authority; absent legacy metadata cannot resume work. */
    requireInstallConfigManagementAuthority(
      id: string,
      expected?: WorkspaceManagementAuthority,
    ): Promise<WorkspaceManagementAuthority>;
    getInstallConfigsByIds?(
      ids: readonly string[],
    ): Promise<readonly InstallConfig[]>;
    listInstallConfigs(
      workspaceId?: string,
      options?: { readonly includeInternal?: boolean },
    ): Promise<readonly InstallConfig[]>;
    listSharedInstallConfigs(options?: {
      readonly includeInternal?: boolean;
    }): Promise<readonly InstallConfig[]>;
    listInstallConfigsPage?(
      workspaceId: string,
      params: PageParams,
      options?: { readonly includeInternal?: boolean },
    ): Promise<Page<InstallConfig>>;
    listSharedInstallConfigsPage?(
      params: PageParams,
      options?: { readonly includeInternal?: boolean },
    ): Promise<Page<InstallConfig>>;
    listInstallConfigUnionPage?(
      workspaceId: string | undefined,
      params: PageParams,
      options?: {
        readonly view?: "all" | "store";
        readonly includeInternal?: boolean;
      },
    ): Promise<Page<InstallConfig>>;
    patchCapsuleStatus(
      id: string,
      status: Capsule["status"],
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ): Promise<Capsule>;
    setCapsuleAutoUpdate(
      id: string,
      enabled: boolean,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ): Promise<Capsule>;
    abandonUnappliedCapsule(
      id: string,
      reason: string,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ): Promise<Capsule>;
    /** Stage one of a two-stage uninstall; absent on hosts without it. */
    scheduleCapsuleUninstall?(
      id: string,
      options?: {
        readonly actor?: string;
        readonly requester?: CapsuleUninstallRequester;
        readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
      },
    ): Promise<Capsule>;
    cancelCapsuleUninstall?(
      id: string,
      options?: {
        readonly actor?: string;
        readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
      },
    ): Promise<Capsule>;
    /** Whole days the scheduled uninstall waits before it destroys. */
    readonly uninstallGraceDays?: number;
    /** Read-only schedule/cancel state admission, matching the commands. */
    uninstallAdmission?(
      capsule: Capsule,
    ): Promise<{ readonly schedule: boolean; readonly cancel: boolean }>;
    getCapsuleExecutionAuthorityEpoch(capsuleId: string): Promise<number>;
    getInstallConfigReAdoptionRecoveryProof?(
      capsuleId: string,
    ): Promise<InstallConfigCommittedPostApplyRecoveryProof | undefined>;
    rebindInstallConfig(
      request: RebindCapsuleInstallConfigRequest,
    ): Promise<RebindCapsuleInstallConfigResponse>;
    getProviderBindingSetByCapsule(
      capsuleId: string,
      environment: string,
    ): Promise<ProviderBindingSet | undefined>;
  };
  // --- RunGroups (§19 / §24) ---
  readonly runGroups: {
    createWorkspaceUpdate(workspaceId: string, actorAccountId?: string): Promise<RunGroupWithRunsLike>;
    createWorkspaceDriftCheck(
      workspaceId: string,
      options?: { readonly limit?: number; readonly actorAccountId?: string },
    ): Promise<RunGroupWithRunsLike>;
    getRunGroup(id: string): Promise<RunGroupWithRunsLike | undefined>;
    approveRunGroup(id: string, actorAccountId?: string): Promise<RunGroupWithRunsLike | undefined>;
  };
  listInterfaceMaterializationFailures(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly CapsuleInterfaceMaterializationFailure[]>;
  retryInterfaceMaterializationFailure(
    workspaceId: string,
    intentId: string,
    input: RetryCapsuleInterfaceMaterializationFailureInput,
  ): Promise<CapsuleInterfaceMaterializationRetryReceipt>;
  /** One app's dead-lettered Interface materializations; absent on older hosts. */
  listCapsuleInterfaceMaterializationFailures?(
    capsuleId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly CapsuleInterfaceMaterializationFailure[]>;
  /** Retries one failure of `capsuleId`; absent on older hosts. */
  retryCapsuleInterfaceMaterializationFailure?(
    capsuleId: string,
    intentId: string,
    input: RetryCapsuleInterfaceMaterializationFailureInput,
  ): Promise<CapsuleInterfaceMaterializationRetryReceipt>;
  // --- Activity (§27 / §34) ---
  readonly activity: {
    record?(
      event: Omit<ActivityEvent, "id" | "createdAt">,
    ): Promise<ActivityEvent | undefined>;
    list(
      workspaceId: string,
      limit?: number,
    ): Promise<readonly ActivityEvent[]>;
    listAcrossWorkspaces(
      workspaceIds: readonly string[],
      limit?: number,
    ): Promise<readonly ActivityEvent[]>;
    /** Keyset page across internal partitions; absent on older hosts. */
    listAcrossWorkspacesPage?(
      workspaceIds: readonly string[],
      params: PageParams,
    ): Promise<Page<ActivityEvent>>;
  };
  // --- Backups (§29) ---
  readonly backups: {
    createBackup(input: {
      readonly workspaceId: string;
      readonly createdByRunId?: string;
      readonly capsuleId?: string;
      readonly environment?: string;
      readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
    }): Promise<BackupRecord>;
    listBackups(
      workspaceId: string,
      params?: PageParams,
    ): Promise<ListBackupsResponse>;
    /** Backups taken of one app; absent on older hosts. */
    listCapsuleBackups?(
      capsuleId: string,
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
  resolveStableSourceTag(
    url: string,
  ): Promise<StableSourceTagResolutionResponse>;
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
    listReleaseOwnedProviderConnections(
      workspaceId?: string,
    ): Promise<readonly ProviderConnection[]>;
    /** Release-owned bindable connections without a Workspace; absent on older hosts. */
    listReleaseOwnedBindableProviderConnections?(): Promise<readonly ProviderConnection[]>;
    getProviderConnection?(id: string): Promise<ProviderConnection>;
    /** The account's own non-operator Connections, where the store lists by owner. */
    listOwnedConnections?(ownerAccountId: string): Promise<readonly ProviderConnection[] | undefined>;
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
    expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority | undefined,
    actorAccountId: string | null,
  ): Promise<ConnectionResponse>;
  /**
   * Re-verifies a Provider Connection's stored credential with the provider (§30
   * `POST /internal/v1/connections/:id/test`). The control surface resolves the
   * Provider Connection's owning Workspace (via {@link getConnection}) and Workspace-permission
   * gates BEFORE calling this; the response carries no secret values. The
   * private authority tuple is captured before that authorization work and
   * retained through the Vault write.
   */
  testConnection(
    connectionId: string,
    expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority | undefined,
    actorAccountId: string | null,
  ): Promise<TestConnectionResponse>;
  /**
   * Revokes a Provider Connection and deletes its sealed secret blob (§30
   * `POST /internal/v1/connections/:id/revoke`). The control surface resolves the
   * Provider Connection's owning Workspace (via {@link getConnection}) and Workspace-permission
   * gates BEFORE calling this. The wiring records the §27 / §34
   * `connection.revoked` Workspace activity, mirroring the deploy-control route.
   * The private authority tuple is captured before authorization and retained
   * through deletion.
   */
  revokeConnection(
    connectionId: string,
    expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority | undefined,
    actorAccountId: string | null,
  ): Promise<void>;
  /** Provider-owned OAuth helpers keyed by opaque composition-time helper id. */
  readonly connectionOAuth?: Readonly<
    Record<
      string,
      {
        readonly providerSource?: string;
        readonly browserBindingRequired?: boolean;
        readonly credentialRecipe?: { readonly id: string; readonly authMode: string };
        readonly setupFields?: readonly { readonly key: string; readonly envName: string }[];
        /**
         * `subject` is the authenticated account subject of the cookie-gated
         * caller. The helper signs it INTO the OAuth state so the cross-site
         * callback (which carries no session cookie) can authorize from the
         * signed state alone. See {@link handleControlRoute}.
         */
        start(input: {
          readonly subject: string;
          readonly workspaceId?: string;
          readonly scope?: "personal" | "workspace";
          readonly ownerAccountId?: string;
          readonly displayName?: string;
          readonly successRedirectUri?: string;
          readonly scopeHints?: ConnectionScopeHints;
          /** Private Workspace admission tuple captured before OAuth awaits. */
          readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
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
          /** Private tuple captured at OAuth start; never public request data. */
          readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
        }>;
      }
    >
  >;
  // --- Runs (§6.8 / §19 / §23) ---
  listRuns(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly Run[]>;
  /** Optional additive keyset seam for deployments that expose Run paging. */
  listRunsPage?(
    workspaceId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<{ readonly runs: readonly Run[]; readonly nextCursor?: string }>;
  /** Keyset page of one Capsule's Runs; absent on hosts without the seam. */
  listCapsuleRunsPage?(
    capsuleId: string,
    options: {
      readonly workspaceId: string;
      readonly limit?: number;
      readonly cursor?: string;
      readonly types?: readonly RunType[];
    },
  ): Promise<{ readonly runs: readonly Run[]; readonly nextCursor?: string }>;
  createCapsulePlan(
    capsuleId: string,
    options?: {
      readonly compatibilityReportId?: string;
      readonly runnerProfileId?: string;
      /** Server-only exact SourceSnapshot pin used by the install coordinator. */
      readonly sourceSnapshotId?: string;
      /** Server-only deterministic Run identity used for lost-ack recovery. */
      readonly planRunId?: string;
      /** Exact Capsule authority fence for configuration-plan persistence. */
      readonly expectedCapsulePlanAuthority?: CapsulePlanCreationFence;
      /** Private management authority retained across configuration preparation. */
      readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
      /** Server-owned audit marker; never parsed from an HTTP request body. */
      readonly actor?: string;
      /** The server flow creating this plan; never parsed from a request body. */
      readonly origin?: RunPlanOrigin;
    },
  ): Promise<PlanRunResponse>;
  /**
   * Read-only Core preflight for the complete value-free ProviderBinding set
   * proposed by a Configuration Plan. It must succeed before any successor CAS.
   */
  validateCapsuleConfigurationProviderBindings(input: {
    readonly capsule: Capsule;
    readonly installConfig: InstallConfig;
    readonly compatibilityReport: CapsuleCompatibilityReport;
    readonly providerBindings: ProviderBindings;
  }): Promise<void>;
  createCapsuleDestroyPlan(
    capsuleId: string,
    options?: {
      readonly runnerProfileId?: string;
      /** Server-owned authenticated caller; never accepted from request JSON. */
      readonly actor?: string;
    },
  ): Promise<PlanRunResponse>;
  createCapsuleDriftCheck(capsuleId: string, options?: { readonly actor?: string }): Promise<PlanRunResponse>;
  /** Derived from current StateVersion provenance; never Source.defaultRef. */
  getCapsuleAdoptedSourceRevision(
    capsuleId: string,
  ): Promise<CapsuleAdoptedSourceRevision | undefined>;
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
  getCurrentResourceInventory(
    capsuleId: string,
  ): Promise<CapsuleCurrentResourceInventoryResponse>;
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
    options?: { readonly actor?: string },
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
  createSource(
    request: CreateSourceRequest,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<CreateSourceResponse>;
  ensureOwnedSource(
    request: EnsureOwnedSourceRequest,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<SourceResponse>;
  retireOwnedSource(sourceId: string, reason: string): Promise<"retired" | "already_retired" | "deferred">;
  listSources(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  rotateSourceHookSecret(id: string, actorId?: string): Promise<RotateSourceHookSecretResponse>;
  /**
   * Deletes an unreferenced Source. Refuses with `failed_precondition`
   * (machine-readable `reason`) while a non-destroyed Capsule tracks it or
   * a Run is in flight; observes `not_found` once deleted.
   */
  deleteSource(id: string, actorId?: string, expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: CreateSourceSyncRequest & { readonly dedupe?: boolean },
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    actorAccountId?: string,
  ): Promise<CreateSourceSyncResponse>;
  convergeOwnedSourceLane(sourceId: string): Promise<SourceResponse>;
  createSourceReconciliationSyncs(
    sourceId: string,
    options?: { readonly scheduled?: boolean },
  ): Promise<readonly CreateSourceSyncResponse[]>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun>;
  listSourceSnapshots(
    sourceId: string,
    params?: PageParams,
  ): Promise<ListSourceSnapshotsResponse>;
  createSourceCompatibilityCheck(
    sourceId: string,
    request?: CreateSourceCompatibilityCheckRequest,
    context?: CompatibilityCheckManagementContext,
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
