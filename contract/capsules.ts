/**
 * Capsule ledger record + OpenTofu Capsule compatibility contract
 * (`capsules` / compatibility reports).
 *
 * A Capsule is the OpenTofu execution unit directly under a Workspace / Project
 * (`@workspace/name`): one Capsule = one OpenTofu root execution + one tfstate +
 * outputs. The App/Environment/InstallProfile lanes model is retired;
 * `environment` is a column on the Capsule (UNIQUE(project_id, name,
 * environment)).
 *
 * The compatibility report is not a Takosumi-specific source manifest; it is a
 * read-only analysis of a plain Git-hosted OpenTofu configuration. The original
 * SourceSnapshot remains the execution source and is never rewritten by this
 * check. InstallConfig (see
 * `./install-configs.ts`) is the service-side DB record describing Capsule
 * execution policy. User repos carry NO Takosumi manifest.
 */

import type { PublicRun, Run, RunStatus, RunType } from "./runs.ts";
import type { InstallConfigStoreText } from "./install-configs.ts";
import type { InterfaceDisplayIcon } from "./interface-display.ts";
import type { InterfaceClients } from "./interface-clients.ts";
import type {
  ProviderRequirement,
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";

export type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
} from "./connections.ts";

// ---------------------------------------------------------------------------
// Capsule ledger record
// ---------------------------------------------------------------------------

/**
 * `error` can retain the latest provider-applied StateVersion/Output while a
 * required post-apply lifecycle action has failed or stayed non-terminal. It
 * is never runtime Ready; a later successful reviewed plan/apply is the generic
 * recovery path back to `active`.
 *
 * `uninstalled` is the grace state of a two-stage uninstall. The provider
 * resources and their data still exist (and still meter) until
 * {@link CapsuleUninstall.scheduledDestroyAt}; nothing new is planned or applied
 * for the Capsule except its teardown. The only exits are cancelling the
 * uninstall (back to {@link CapsuleUninstall.previousStatus}) or a committed
 * destroy (`destroyed`). The Capsule keeps its name while uninstalled.
 */
export type CapsuleStatus =
  | "pending"
  | "active"
  | "stale"
  | "error"
  | "disabled"
  | "uninstalled"
  | "destroyed";

/** Statuses a scheduled uninstall can start from and return to on cancel. */
export type CapsuleUninstallRestorableStatus = "active" | "stale" | "error";

/**
 * Evidence of the one data export attempted before a scheduled destroy. A
 * failed or skipped export is recorded and the destroy still proceeds; the
 * record is what tells the owner afterwards whether a copy exists.
 */
export interface CapsulePreDestroyExport {
  readonly status: "exported" | "failed" | "skipped";
  /** Backup record id when `exported`. */
  readonly backupId?: string;
  /**
   * Whether the export carried service data (app data pointers) in addition
   * to the control ledger and state. `false` means the install declared no
   * service-data backup, so only ledger and state were saved.
   */
  readonly includesServiceData?: boolean;
  /** Public-safe reason token when `failed` or `skipped`. */
  readonly reason?: string;
  readonly at: string;
}

/**
 * One two-stage uninstall request and its progress. The Capsule row is the
 * authority: every step is a compare-and-set on `revision`, so a cancel and the
 * scheduled finalizer cannot both win.
 *
 * - `scheduled`: in grace, or due and not yet past the point of no return.
 *   Cancelling is allowed.
 * - `destroying`: the finalizer verified the teardown Plan it created and is
 *   approving and applying it. Cancelling is refused unless the finalizer
 *   blocked before any teardown was dispatched.
 * - `cancelled`: retained as evidence until the next uninstall replaces it.
 */
/** Internal scheduling provenance. Never expose grant references in public reads. */
export interface CapsuleUninstallRequester {
  readonly subject: string;
  readonly grant?:
    | { readonly kind: "personal-access-token"; readonly tokenId: string }
    | { readonly kind: "oauth-access-token"; readonly tokenHash: string };
}

export interface CapsuleUninstall {
  readonly id: string;
  readonly revision: number;
  readonly phase: "scheduled" | "destroying" | "cancelled";
  readonly requestedAt: string;
  /** Authenticated account subject and optional delegated grant; absent on legacy requests. */
  readonly requester?: CapsuleUninstallRequester;
  readonly scheduledDestroyAt: string;
  /** Last due finalizer attempt, used to rotate waiting requests fairly. */
  readonly lastFinalizeAttemptAt?: string;
  readonly previousStatus: CapsuleUninstallRestorableStatus;
  readonly cancelledAt?: string;
  readonly preDestroyExport?: CapsulePreDestroyExport;
  /** Export claim recorded before attempting the one pre-destroy export. */
  readonly preDestroyExportStartedAt?: string;
  /** Teardown Plan created by the finalizer for the current attempt. */
  readonly destroyPlanRunId?: string;
  readonly destroyAttempts?: number;
  /** When the current attempt's Plan id was recorded, before it was created. */
  readonly destroyPlanRequestedAt?: string;
  /** Unexpected finalizer errors so far; enough of them block the request. */
  readonly finalizeFailures?: number;
  readonly destroyStartedAt?: string;
  /**
   * Set when the finalizer stopped continuing unattended (for example the
   * teardown Plan was not delete-only). The Capsule stays `uninstalled`; the
   * owner can cancel or delete it now.
   */
  readonly blockedReason?: string;
  /** Deadline authorization refusal time, retained even if Activity recording fails. */
  readonly authorizationRejectedAt?: string;
}

/**
 * Capsule ledger record.
 * 1 Capsule = generated root + tfstate + outputs; `currentStateGeneration` is
 * the generation guard cursor. The latest `currentOutputId` is an internal
 * ledger pointer to the encrypted raw output envelope and is projected out of
 * public Capsule reads; dashboard output reads go through safe Output projections.
 */
export interface Capsule {
  readonly id: string;
  /** @deprecated Legacy input only. AppOwnershipStore is the owner authority; never persist or read this from Capsule JSON. */
  readonly ownerAccountId?: string;
  /** @deprecated Legacy input only; use AppOwnershipStore. */
  readonly ownershipEpoch?: number;
  /** @deprecated Legacy input only; use AppOwnershipStore. */
  readonly managementState?: "active" | "draining" | "frozen";
  /** @deprecated Legacy input only; use AppOwnershipStore. */
  readonly managementEpoch?: number;
  /** @deprecated Legacy input only; use getCapsuleStorageRoot or AppOwnershipStore. */
  readonly storageRoot?: string;
  readonly workspaceId: string;
  /**
   * Frozen per-app derivation scope (TASK-0118 Phase 9).
   *
   * Every durable value derived for this Capsule reads this opaque value where
   * it used to read the Workspace id: generated-secret HMAC preimages, sealing
   * AADs and nonces, the public OIDC client id and activation digest, the
   * public-origin reservation key and label, the install-context
   * `workspace_id` module variable and the Workspace-scoped name suffix. It is
   * written once when the Capsule is created and never changes, so removing
   * Workspace can never move a derived key, name or storage path.
   *
   * It grants nothing: no membership, listing or authorization decision reads
   * it. Capsules created before stage 9.0 lack it until the operator backfill
   * copies their Workspace id; read it only through {@link capsuleScopeRef}.
   */
  readonly scopeRef?: string;
  /**
   * The operator-designated delegate app (Takos) whose own token installed this
   * app for its owner (TASK-0118 P9.1-b). Written once at creation; private.
   * A delegate token reaches an app beyond its own Workspace limits only when
   * this names that token's app.
   */
  readonly delegateCapsuleId?: string;
  /**
   * Owning Project. Capsules live under a Project; a default Project
   * (`prj_default_<workspaceId>`) is backfilled per Workspace for pre-Project
   * rows.
   */
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  /**
   * Registered Git {@link Source} this Capsule tracks. Capsule authoring is
   * Git-only; immutable archives are runner transport, not another Source kind.
   */
  readonly sourceId: string;
  readonly installConfigId: string;
  /**
   * Exact Principal that installed this Capsule. Internal authorization
   * provenance: public Capsule projections must never expose it, and later
   * Runs must not reinterpret "installer" as their current caller.
   */
  readonly installingPrincipalId?: string;
  readonly environment: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
  readonly currentOutputId?: string;
  readonly compatibilityReportId?: string;
  readonly compatibilityStatus?: CapsuleCompatibilityLevel;
  readonly status: CapsuleStatus;
  /**
   * Auto-update opt-in. When the tracked Source resolves a new snapshot and
   * marks this Capsule `stale`, the control plane creates the update plan run
   * itself and auto-applies it only when the plan is CLEAN (succeeded — an
   * approval-parked, destructive, or policy-blocked plan never is). Destructive
   * updates always stop as 更新があります and wait for the user.
   */
  readonly autoUpdate?: boolean;
  /**
   * Auto-update backoff marker: the SourceSnapshot id of the last automatic
   * attempt. One automatic attempt per snapshot — a failed auto-update retries
   * only on the next new snapshot (or a manual update). Internal; projected out
   * of public reads.
   */
  readonly autoUpdateAttemptSourceSnapshotId?: string;
  /**
   * Host-reserved public origin for this Capsule's Worker.
   *
   * A Capsule whose manifest delivers `identity.oidc` by bindings declares no
   * repository endpoint: the origin is assigned by whichever host publishes the
   * Worker, and Takosumi only ever RECEIVES it (see
   * `deploy/platform/runtime_input_oidc_client_source.ts`). Plan asks the host
   * to fix one origin before the reviewed plan exists; Apply must read back the
   * SAME one rather than ask for another, so the opaque host reference has to
   * outlive the Run that first obtained it.
   *
   * This is private host bookkeeping — never repository configuration, never a
   * provider resource identity, and never part of a public Capsule projection.
   * `reservationRef` is opaque to Takosumi: it carries no hostname scheme,
   * tenant, space, or provider-native name.
   */
  readonly publicOriginReservation?: CapsulePublicOriginReservation;
  /** Latest two-stage uninstall request, if one was ever made. */
  readonly uninstall?: CapsuleUninstall;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One host-owned public-origin reservation held for a Capsule.
 *
 * `origin` is pinned so a later Apply can detect that the host handed the
 * origin to someone else (a lapsed reservation) and fail the pinned descriptor
 * instead of quietly registering a redirect URI for an origin nobody serves.
 */
export interface CapsulePublicOriginReservation {
  /** Opaque host reference. Takosumi re-sends it and never parses it. */
  readonly reservationRef: string;
  /** Exact HTTPS origin the host fixed for this Capsule. */
  readonly origin: string;
  /** Label Takosumi asked the host to reserve, for operator diagnosis. */
  readonly requestedLabel: string;
  readonly reservedAt: string;
  /**
   * Set once the host confirmed it stopped holding this origin. The record is
   * retired rather than erased: a released reservation is the evidence that the
   * teardown finished, and an absent field would be indistinguishable from a
   * teardown that never ran.
   */
  readonly releasedAt?: string;
}

/**
 * Non-secret Git address adopted by the Capsule's current successful Apply.
 * This is derived from current StateVersion provenance and is deliberately not
 * the shared Source's `defaultRef` / `defaultPath`.
 */
export interface CapsuleAdoptedSourceRevision {
  readonly sourceSnapshotId: string;
  readonly ref: string;
  readonly path: string;
  readonly resolvedCommit: string;
}

/**
 * The Capsule's frozen derivation scope. A Capsule created before stage 9.0
 * has no stored value yet and derives from its Workspace id, which is exactly
 * the value the backfill stores, so the result never changes.
 */
export function capsuleScopeRef(
  capsule: Pick<Capsule, "scopeRef" | "workspaceId">,
): string {
  const scopeRef: unknown = capsule.scopeRef;
  if (scopeRef === undefined) return capsule.workspaceId;
  if (typeof scopeRef !== "string" || scopeRef.length === 0) {
    throw new TypeError("Capsule scopeRef is invalid");
  }
  return scopeRef;
}

/**
 * The record as stage 9.0 and later write it. A Capsule stored before stage
 * 9.0 gains its frozen `scopeRef` (its Workspace id, the value it always
 * derived from), so an exact-record comparison treats the two spellings of the
 * same Capsule as equal. Only for comparisons; never persist the result.
 */
export function capsuleWithScopeRef<T extends Pick<Capsule, "scopeRef" | "workspaceId">>(
  capsule: T,
): T {
  return capsule.scopeRef === undefined
    ? { ...capsule, scopeRef: capsule.workspaceId }
    : capsule;
}

/** Public Capsule projection returned by `/api` and dashboard session routes. */
export type PublicCapsule = Omit<
  Capsule,
  | "scopeRef"
  | "delegateCapsuleId"
  | "ownerAccountId"
  | "ownershipEpoch"
  | "managementState"
  | "managementEpoch"
  | "storageRoot"
  | "currentOutputId"
  | "autoUpdateAttemptSourceSnapshotId"
  | "installingPrincipalId"
  | "publicOriginReservation"
  | "uninstall"
> & {
  readonly uninstall?: Omit<CapsuleUninstall, "requester">;
  /** Absent before the first successful Apply. Derived; never stored on Capsule. */
  readonly adoptedSourceRevision?: CapsuleAdoptedSourceRevision;
};

// ---------------------------------------------------------------------------
// Capsule compatibility report
// ---------------------------------------------------------------------------

export type CapsuleCompatibilityLevel = "ready" | "needs_patch" | "unsupported";

export type CapsuleCompatibility = CapsuleCompatibilityLevel;

export type CapsuleFindingSeverity = "info" | "warning" | "error";

export type CapsuleFindingCompatibilityImpact =
  "none" | "needs_patch" | "unsupported";

export interface CapsuleGateFinding {
  readonly severity: CapsuleFindingSeverity;
  /** Structured aggregate effect; consumers must not infer it from `code`. */
  readonly compatibilityImpact: CapsuleFindingCompatibilityImpact;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
  /** Structured presentation context; consumers must not parse `message`. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface CapsuleProviderRequirement {
  /** Canonical provider source address, including registry host. */
  readonly source: string;
  /** Exact local name declared by the child module in `required_providers`. */
  readonly moduleLocalName: string;
  /** Exact child-module configuration alias; absence means the default. */
  readonly childAlias?: string;
  /** Exact literal version only when static analysis proved one. */
  readonly version?: string;
  readonly allowed: boolean;
  /**
   * Explicit service-side decision that this provider needs a
   * ProviderConnection for this run context. HCL source names alone never imply
   * credentials; absent/false means the compatibility analyzer made no such
   * requirement.
   */
  readonly credentialRequired?: boolean;
}

/** Reachable provider package used only for policy and supply-chain checks. */
export interface CapsuleProviderPackage {
  /** Canonical provider source address, including registry host. */
  readonly source: string;
  /** Exact literal version only when graph analysis proved one. */
  readonly version?: string;
  readonly allowed: boolean;
}

/** Exact provider identity declared or implicitly used by the selected root. */
export interface CapsuleRootProviderRequirement {
  readonly source: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
  readonly version?: string;
  /** Root binding needs run-scoped credential material when true. */
  readonly credentialRequired?: boolean;
}

export interface CapsuleResourceSummary {
  readonly type: string;
  readonly count?: number;
  readonly allowed: boolean;
}

export interface CapsuleDataSourceSummary {
  readonly type: string;
  readonly allowed: boolean;
}

export interface CapsuleProvisionerSummary {
  readonly type: string;
  readonly allowed: boolean;
}

/**
 * OpenTofu metadata for one root-module Output discovered by compatibility
 * analysis. The generated-root path must preserve `sensitive`; an `ephemeral`
 * Output cannot be re-exported from a root module and therefore makes the
 * Capsule incompatible with Takosumi's persisted Output ledger.
 */
export interface CapsuleRootModuleOutputDeclaration {
  readonly name: string;
  /** `null` means static analysis could not prove the constant boolean. */
  readonly sensitive: boolean | null;
  /** `null` means static analysis could not prove the constant boolean. */
  readonly ephemeral: boolean | null;
}

/**
 * Bounded, non-secret metadata for one root-module variable discovered by
 * compatibility analysis. `unknown` means static analysis could not prove a
 * basic type; consumers may still validate the variable name/default but must
 * not infer a type from comments or descriptions.
 */
export interface CapsuleRootModuleVariableDeclaration {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "json" | "unknown";
  readonly hasDefault: boolean;
}

export interface CapsuleCompatibilityReport {
  readonly id: string;
  readonly sourceId: string;
  readonly capsuleId?: string;
  readonly sourceSnapshotId: string;
  /**
   * Normalized module path the Capsule Gate actually analyzed inside the
   * SourceSnapshot archive; `"."` marks the archive root. A plan executes
   * `InstallConfig.modulePath`, so a report is only evidence about the module
   * it was produced for: without this field a report for a benign module could
   * be reused (or supplied as a `compatibilityReportId` hint) to gate an
   * unreviewed sibling module in the same snapshot. Absent means a report
   * written before the path was recorded, which can no longer gate any plan.
   */
  readonly modulePath?: string;
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providerPackages: readonly CapsuleProviderPackage[];
  readonly rootProviderRequirements: readonly CapsuleRootProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
  /**
   * Non-secret root module interface discovered during compatibility analysis.
   * Plan creation can reuse this metadata when a preflight report is supplied,
   * avoiding another source archive expansion just to decide which ordinary
   * OpenTofu variables/outputs the generated root may project.
   */
  readonly rootModuleVariables?: readonly string[];
  /**
   * Exact basic type/default metadata for repository-owned install UX
   * validation. Older reports may omit it and cannot authorize enhanced UX
   * adoption; `rootModuleVariables` remains for wire compatibility.
   */
  readonly rootModuleVariableDeclarations?: readonly CapsuleRootModuleVariableDeclaration[];
  readonly rootModuleOutputs?: readonly CapsuleRootModuleOutputDeclaration[];
  readonly providerRequirements?: readonly ProviderRequirement[];
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly createdAt: string;
}

/**
 * Canonical spelling of the module path a compatibility report was analyzed
 * for, so the report can be compared against the path a plan will actually
 * execute. `"."` is the archive root; any other value is a normalized relative
 * path. Callers must treat a missing `CapsuleCompatibilityReport.modulePath` as
 * unknown rather than as the root, so a pre-guard report cannot pass itself off
 * as evidence for a module it never analyzed.
 */
export function normalizeCompatibilityReportModulePath(
  modulePath: string | undefined,
): string {
  const value = modulePath?.trim();
  if (!value) return ".";
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/g, "");
  return normalized && normalized !== "." ? normalized : ".";
}

export interface CapsuleGateResult {
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providerPackages: readonly CapsuleProviderPackage[];
  readonly rootProviderRequirements: readonly CapsuleRootProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
}

export interface CreateSourceCompatibilityCheckRequest {
  readonly sourceSnapshotId?: string;
  /** Safe relative OpenTofu module path inside the SourceSnapshot archive. */
  readonly modulePath?: string;
  readonly capsuleId?: string;
  /**
   * Curated InstallConfig to gate the pre-install compatibility check against,
   * used when no Capsule exists yet (e.g. the dashboard's "選んで入れる"
   * Store deep-link). Its bounded policy (`allowedResourceTypes` …) is merged
   * with Workspace policy as a ceiling and applied to the Capsule Gate without
   * widening the instance-wide default allowlist. Ignored when `capsuleId` is
   * also present (the Capsule's own InstallConfig wins).
   */
  readonly installConfigId?: string;
  /**
   * Accounts/dashboard preflight hint. Core compatibility analysis ignores
   * these fields; the authenticated Accounts route compiles and persists the
   * validated result after the exact report succeeds.
   */
  readonly compileInstallUx?: boolean;
  readonly capsuleName?: string;
}

export interface CapsuleCompatibilityReportResponse {
  readonly report: CapsuleCompatibilityReport;
  readonly run?: Run;
  /** Present only when Accounts install preflight requested compilation. */
  readonly repositoryInstallUx?: RepositoryInstallUxCompatibilityResult;
}

export type RepositoryInstallUxCompatibilityResult =
  | { readonly status: "absent" }
  | {
      readonly status: "accepted";
      readonly installConfigId: string;
    }
  | {
      readonly status: "invalid";
      readonly diagnosticCode: string;
      readonly message: string;
    };

export type PublicCapsuleCompatibilityReport = Omit<
  CapsuleCompatibilityReport,
  "providerResolutions"
> & {
  readonly providerResolutions?: readonly PublicProviderResolution[];
};

export interface PublicCapsuleCompatibilityReportResponse {
  readonly report: PublicCapsuleCompatibilityReport;
  readonly run?: PublicRun;
  readonly repositoryInstallUx?: RepositoryInstallUxCompatibilityResult;
}

// ---------------------------------------------------------------------------
// Installed-app view (`GET /api/v1/capsules/:capsuleId/app`)
// ---------------------------------------------------------------------------

export const CAPSULE_APP_VIEW_KIND = "takosumi.capsule-app@v1" as const;

/**
 * One state per installed app, computed by the control plane from the Capsule
 * row, its newest lifecycle Run, its install or revision coordinator, its
 * ProviderConnections and its screen materialization ledger.
 *
 * - `installing`: never applied; the first install is preparing, running, or
 *   waiting for the person's review.
 * - `installed`: applied, with no change in progress and nothing needing the
 *   person.
 * - `updating`: applied, and a change (revision preparation, plan or apply)
 *   is in progress.
 * - `needs_attention`: at least one error-severity problem and nothing in
 *   progress that could resolve it.
 * - `stopped`: the operator disabled the app.
 * - `uninstall_scheduled`: inside the uninstall grace period.
 * - `uninstalling`: the teardown is running or starting, or a teardown plan
 *   the person requested waits for their review.
 * - `uninstalled`: destroyed.
 *
 * An uninstall record counts only while the Capsule is `uninstalled`, or
 * while it is `error` after a teardown failure and its newest lifecycle Run is
 * still a removal; older records are kept only as evidence.
 */
export const CAPSULE_APP_STATES = [
  "installing",
  "installed",
  "updating",
  "needs_attention",
  "stopped",
  "uninstall_scheduled",
  "uninstalling",
  "uninstalled",
] as const;
export type CapsuleAppState = (typeof CAPSULE_APP_STATES)[number];

/**
 * The one main action for the current state.
 *
 * - `open`: open the app's first screen (`screens[0]`).
 * - `view_resources`: an installed app without screens; show what it created.
 * - `review`: review the plan in `progress.review`, or the policy reasons of
 *   the blocked Run named by the first problem.
 * - `retry`: plan again — the failed Run named by the first problem, or the
 *   app's current configuration when no Run is named.
 * - `retry_screen`: retry the screen materialization failure named by the
 *   first problem.
 * - `fix_connection`: repair the ProviderConnection named by the first problem.
 * - `fix_interface_link`: select a working provider for the Interface requirement
 *   named by the first problem.
 * - `review_interface_link`: a problem's own action only (never the primary
 *   action): approve or decline the link another app asks this app for.
 * - `continue_install`: resume an install that stopped before a plan.
 * - `cancel_uninstall`: cancel the scheduled uninstall (the cancel command
 *   would admit it now).
 * - `uninstall_now`: the stalled scheduled uninstall can no longer be
 *   cancelled; create the immediate teardown plan
 *   (`DELETE /api/v1/capsules/:id?immediate=true`) and review it.
 * - `reinstall`: install the app again.
 * - `none`: nothing for the person to do now (work is in progress).
 */
export const CAPSULE_APP_ACTIONS = [
  "open",
  "view_resources",
  "review",
  "retry",
  "retry_screen",
  "fix_connection",
  "fix_interface_link",
  "review_interface_link",
  "continue_install",
  "cancel_uninstall",
  "uninstall_now",
  "reinstall",
  "none",
] as const;
export type CapsuleAppAction = (typeof CAPSULE_APP_ACTIONS)[number];

/**
 * Stable problem codes, listed in the priority order the primary action
 * follows.
 *
 * - `connection_unavailable`: a ProviderBinding points at a connection that is
 *   missing, revoked, expired or in error.
 * - `interface_link_unavailable`: an active app link's provider was removed
 *   (error) or its Interface is temporarily not ready (warning).
 * - `interface_link_degraded`: an active link's provider is scheduled for removal.
 * - `interface_link_unset`: a requirement has no active, approved app link.
 * - `interface_link_approval_pending`: info only, on the provider app; another
 *   app's link to this app's Interface waits for the caller's approval
 *   (`review_interface_link`). Never decides the primary action.
 * - `uninstall_failed`: a teardown that reached the provider failed; the
 *   problem names the failed removal Run.
 * - `uninstall_blocked`: the scheduled uninstall stopped (in either phase) and
 *   waits for the person while the resources keep running; `reason` is the
 *   finalizer's stable `blockedReason` token.
 * - `policy_blocked`: the newest plan was denied by policy; see the Run's
 *   `policyReasons`.
 * - `run_failed`: the newest lifecycle Run failed.
 * - `capsule_error`: the Capsule is in error without a failed newest Run.
 * - `install_incomplete`: a never-applied app with no Run in progress, nothing
 *   to review, and no recent progress.
 * - `screen_unavailable`: the current version's screens could not be made
 *   openable (a dead-lettered materialization).
 * - `uninstall_scheduled`: warning only; the app will be destroyed at
 *   `uninstall.scheduled.deleteAfter` unless cancelled.
 */
export const CAPSULE_APP_PROBLEM_CODES = [
  "connection_unavailable",
  "uninstall_failed",
  "uninstall_blocked",
  "policy_blocked",
  "run_failed",
  "capsule_error",
  "install_incomplete",
  "interface_link_unavailable",
  "screen_unavailable",
  "interface_link_degraded",
  "interface_link_unset",
  "interface_link_approval_pending",
  "uninstall_scheduled",
] as const;
export type CapsuleAppProblemCode = (typeof CAPSULE_APP_PROBLEM_CODES)[number];

export type CapsuleAppConnectionStatus =
  | "missing"
  | "revoked"
  | "expired"
  | "error";

/** Value-free identity of one dead-lettered screen materialization. */
export interface CapsuleAppScreenFailure {
  readonly id: string;
  readonly failureDigest: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly errorCode: string;
}

export interface CapsuleAppProblem {
  readonly code: CapsuleAppProblemCode;
  readonly severity: "error" | "warning" | "info";
  /** The Run behind the problem, when one is. */
  readonly runId?: string;
  readonly runType?: RunType;
  readonly errorCode?: string;
  /** `uninstall_blocked`: the finalizer's stable `blockedReason` token. */
  readonly reason?: string;
  /** `connection_unavailable`: the provider source the binding serves. */
  readonly provider?: string;
  readonly connectionId?: string;
  readonly connectionStatus?: CapsuleAppConnectionStatus;
  /** `screen_unavailable`: the exact failure the retry route expects. */
  readonly screenFailure?: CapsuleAppScreenFailure;
  /** `interface_link_*`: stable requirement identity for the repair action. */
  readonly requirementKey?: string;
  readonly interfaceLinkId?: string;
  readonly providerCapsuleId?: string;
  /** `interface_link_approval_pending`: the app that asks for the link. */
  readonly consumerCapsuleId?: string;
}

/** Value-free identity and display metadata of the app at the other end. */
export interface CapsuleAppLinkedApp {
  readonly capsuleId: string;
  readonly name: string;
  readonly displayName?: InstallConfigStoreText;
  readonly iconUrl?: string;
}

export type CapsuleAppLinkHealth =
  | "ok"
  | "reapproval_required"
  | "provider_not_ready"
  | "provider_uninstall_scheduled"
  | "provider_removed";

/**
 * One declared requirement (`uses`) or current incoming link (`usedBy`).
 * Health is computed from the provider at read time; it never changes the
 * persisted approval state. No Interface input, output or delivery is exposed.
 */
export interface CapsuleAppLink {
  readonly linkId?: string;
  readonly requirementKey: string;
  readonly consumerCapsuleId: string;
  readonly providerCapsuleId?: string;
  readonly providerInterfaceId?: string;
  readonly interfaceType: string;
  readonly interfaceVersion: string;
  readonly permissions: readonly string[];
  readonly state: "unset" | "pending_approval" | "active" | "declined" | "revoked";
  /** Current link generation for a guarded mutation; zero before a link exists. */
  readonly generation: number;
  readonly health: CapsuleAppLinkHealth;
  readonly otherApp?: CapsuleAppLinkedApp;
  /** The caller may manage at least one end of this link. */
  readonly canManage: boolean;
  /**
   * `usedBy` rows waiting for this app's consent: whether the caller may
   * approve or decline (an owner or member of this provider app, never an
   * installed app's own token, and only while the app accepts links).
   */
  readonly canApprove?: boolean;
}

export interface CapsuleAppLinks {
  readonly uses: readonly CapsuleAppLink[];
  readonly usedBy: readonly CapsuleAppLink[];
}

/**
 * One link waiting for a provider app's consent
 * (`GET /api/v1/capsules/:id/interface-links/requests`). Value-free: names,
 * permission names and timestamps only, never Interface inputs or outputs.
 */
export interface CapsuleInterfaceLinkRequest {
  readonly linkId: string;
  /** The link generation `approve` / `decline` expect. */
  readonly generation: number;
  readonly consumerApp: CapsuleAppLinkedApp;
  readonly requirementKey: string;
  readonly providerInterfaceId: string;
  readonly interfaceType: string;
  readonly interfaceVersion: string;
  readonly requestedPermissions: readonly string[];
  /** The requesting account's display name, when the account still exists. */
  readonly requestedByDisplayName?: string;
  readonly createdAt: string;
}

/**
 * One launchable, authorized screen (a Resolved `ui-surface` Interface the
 * caller may open). Only display metadata, the checked launch URL and the
 * screen's validated native clients are projected; no other Interface input
 * or Output value is.
 */
export interface CapsuleAppScreen {
  readonly interfaceId: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly icon?: InterfaceDisplayIcon;
  readonly category?: string;
  readonly sortOrder?: number;
  readonly url: string;
  /**
   * The native phone apps the screen declares (`document.clients`), parsed by
   * `parseInterfaceClients` against `url`: links are filled in with this
   * screen's origin or URL and nothing else. Absent when none is usable.
   */
  readonly clients?: InterfaceClients;
}

export interface CapsuleAppRunSummary {
  readonly id: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly requiresApproval?: boolean;
}

export interface CapsuleAppVersion {
  /** Terminal apps have no installed version, even after Source archives retire. */
  readonly uninstalled?: boolean;
  /** The Git repository (credential-free URL) and the Source's default ref. */
  readonly repository?: {
    readonly url: string;
    readonly defaultRef: string;
  };
  /** The version the current successful apply adopted. */
  readonly current?: {
    readonly sourceSnapshotId: string;
    readonly ref: string;
    readonly path: string;
    readonly commit: string;
  };
  /** The newest snapshot fetched for the current ref (may equal `current`). */
  readonly latest?: {
    readonly sourceSnapshotId: string;
    readonly ref: string;
    readonly commit: string;
    readonly fetchedAt: string;
  };
  /** True when `latest` names a different commit than `current`. */
  readonly updateAvailable: boolean;
  /**
   * The control plane marked the app stale: its last apply no longer matches
   * its inputs (a newer source snapshot or a changed dependency Output).
   */
  readonly stale: boolean;
  readonly autoUpdate: boolean;
}

export interface CapsuleAppProgress {
  /**
   * An install or revision coordinator is still preparing this app's next
   * Plan (it has not created the Plan Run yet; an install attempt counts only
   * for a never-applied app and only until it stalls). Once the Plan Run
   * exists, `run`/`review` and `latestRun` describe the work. The name
   * predates install coordinators and is kept for compatibility.
   */
  readonly revisionPreparing: boolean;
  /**
   * An install attempt bound to this never-applied app that has not created
   * its Plan yet. `continue_install` advances it through
   * `POST /api/v1/install-plans/:id/reconcile` instead of planning directly.
   * Any Workspace member may reconcile it; the Plan Run it creates records
   * the coordinator (`git-install-plan:<id>`) as its actor, not the member
   * who advanced it. Attempts written before management-authority
   * persistence can never advance and are not named here.
   */
  readonly installPlanId?: string;
  /**
   * The install attempt waits for its creator's answer before it can plan:
   * `viewer` when the caller started it (they continue it on the install
   * page), `other` when someone else did. Reconciling does not advance it.
   */
  readonly installPlanAwaitingInput?: "viewer" | "other";
  /**
   * A revision coordinator for this app that has not created its Plan and
   * stopped moving (its client went away). It no longer holds the app as
   * updating; `POST /api/v1/revision-plans/:id/reconcile` continues it, and
   * its Plan Run records the coordinator (`git-revision-plan:<id>`) as actor.
   * A coordinator pinned to an older state generation or InstallConfig
   * (another change was applied, or settings rebound the app, since) can only
   * fail and is not named.
   */
  readonly revisionPlanId?: string;
  /** The newest lifecycle Run, while it is queued or running. */
  readonly run?: CapsuleAppRunSummary;
  /** The newest lifecycle Run, while it is a plan waiting for review. */
  readonly review?: {
    readonly runId: string;
    readonly runType: RunType;
  };
}

export interface CapsuleAppUninstall {
  /** Current consumers affected if this provider is removed. */
  readonly impact: { readonly usedBy: readonly CapsuleAppLink[] };
  /**
   * What a new uninstall request does now: `scheduled` keeps resources and
   * data for `graceDays` first, `discard` drops a never-applied app at once,
   * and `none` means no default uninstall is available (already destroyed, or
   * the host has no scheduled uninstall; an explicit immediate destroy plan
   * remains possible).
   */
  readonly mode: "scheduled" | "discard" | "none";
  /** Whole days a scheduled uninstall waits; present when `mode` is `scheduled`. */
  readonly graceDays?: number;
  /** The current scheduled uninstall, when one is pending or running. */
  readonly scheduled?: {
    readonly phase: "scheduled" | "destroying";
    readonly requestedAt: string;
    readonly deleteAfter: string;
    readonly cancellable: boolean;
    readonly blocked: boolean;
    readonly preDestroyExport?: {
      readonly status: CapsulePreDestroyExport["status"];
      readonly includesServiceData?: boolean;
    };
  };
}

/** Parts of the view the control plane could not read for this response. */
export type CapsuleAppIncompleteSection =
  | "display"
  | "screens"
  | "version"
  | "links"
  | "screen_problems";

/** Body of `GET /api/v1/capsules/:capsuleId/app`. Value-free; no secrets. */
export interface CapsuleAppView {
  readonly kind: typeof CAPSULE_APP_VIEW_KIND;
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly environment: string;
  /** Store-provided display name, when the InstallConfig carries one. */
  readonly displayName?: InstallConfigStoreText;
  readonly iconUrl?: string;
  readonly status: CapsuleStatus;
  readonly applied: boolean;
  readonly state: CapsuleAppState;
  readonly primaryAction: CapsuleAppAction;
  /** Ordered by {@link CAPSULE_APP_PROBLEM_CODES} priority. */
  readonly problems: readonly CapsuleAppProblem[];
  /** Every launchable screen, in display order. */
  readonly screens: readonly CapsuleAppScreen[];
  readonly links: CapsuleAppLinks;
  readonly version: CapsuleAppVersion;
  readonly progress: CapsuleAppProgress;
  /** The newest lifecycle Run (plan, apply, destroy plan or destroy apply). */
  readonly latestRun?: CapsuleAppRunSummary;
  readonly uninstall: CapsuleAppUninstall;
  /** Present when a supporting read failed; the named parts may be missing. */
  readonly incomplete?: readonly CapsuleAppIncompleteSection[];
  readonly observedAt: string;
}

export interface CapsuleAppResponse {
  readonly app: CapsuleAppView;
}
