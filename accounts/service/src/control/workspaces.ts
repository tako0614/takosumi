/**
 * Session-authed Workspace (`/api/v1/workspaces`)
 * control routes: workspace CRUD, members, capsule create/list, graph,
 * runs/activity, backups, billing reads, plan-update / drift-check. Extracted
 * from `control-routes.ts` (P3 god-file split).
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
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  InstallConfig,
  InstallConfigVariableDefault,
  InstallConfigVariablePresentation,
  ManagedPublicHostnameAllocation,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import {
  capsuleInterfaceBlueprintsNeedInstallingPrincipal,
  resolveCapsuleInterfaceBlueprintInstallingPrincipal,
} from "takosumi-contract/interfaces";
import { parseScopeBoundaryPolicy } from "takosumi-contract";
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
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
import type {
  PublicStateVersion,
  StateVersion,
} from "takosumi-contract/state-versions";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { AccountsStore } from "../store.ts";
import type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlWorkspaceRole,
  ControlMembershipStatus,
  PublicWorkspaceMember,
  MembershipActor,
} from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  canAccessWorkspace,
  controlPlaneUnavailable,
  controllerErrorCode,
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicStateVersion,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
  resolveProviderBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  dependencyModeValue,
  dependencyVisibilityValue,
  installConfigStoreValue,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseProviderBinding,
  parseProviderBindings,
  parseLimit,
  workspaceTypeValue,
  sourceBuildValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import { parseInterfaceBlueprintsValue } from "./interface-blueprints.ts";
import { normalizeVariablePathRecord } from "../../../../core/domains/deploy-control/validation.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { maybeEnsurePersonalWorkspaceForSession } from "../control-personal-workspace.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { ensureTakosumiAccountsOidcForCapsule } from "./capsule-oidc.ts";
import {
  hydrateRepoOwnedStoreConfig,
  latestSourceSnapshotForSource,
} from "./repo-owned-install-config.ts";
import { handleWorkspaceProjects } from "./projects.ts";

function sourceWorkspaceId(
  source: Readonly<{ workspaceId?: string }>,
): string | undefined {
  return stringValue(source.workspaceId);
}

export async function handleWorkspaces(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // GET/POST /api/v1/workspaces.
  if (segments.length === 1 && segments[0] === "workspaces") {
    if (method === "GET") {
      await maybeEnsurePersonalWorkspaceForSession({
        request: request.clone(),
        store,
        operations,
      });
      return await listWorkspaces(operations, store, ctx.session.subject, url);
    }
    if (method === "POST") {
      return await createWorkspace(request, operations, ctx.session.subject);
    }
    return methodNotAllowed("GET, POST");
  }
  // /api/v1/workspaces/:workspaceId ; /api/v1/workspaces/:workspaceId/...
  if (segments[0] === "workspaces" && segments.length >= 2) {
    const workspaceId = decodeURIComponent(segments[1] ?? "");
    const leaf = segments[2];
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method === "GET")
        return json({
          workspace: await operations.workspaces.getWorkspace(workspaceId),
        });
      if (method === "PATCH")
        return await updateWorkspace(
          request,
          operations,
          store,
          ctx.session.subject,
          workspaceId,
        );
      return methodNotAllowed("GET, PATCH");
    }
    if (leaf === "members") {
      // /api/v1/workspaces/:workspaceId/members[/:subject]. The Workspace is already
      // resolved server-side and namespace-gated above; the member handlers add
      // the membership-ROLE gate (list = any member; mutate = owner/admin;
      // role-change + remove = owner-only with a last-owner guard).
      if (segments.length === 3) {
        if (method === "GET") {
          return await listWorkspaceMembers(
            operations,
            workspaceId,
            ctx.session.subject,
          );
        }
        if (method === "POST") {
          return await addWorkspaceMember(
            request,
            store,
            operations,
            workspaceId,
            ctx.session.subject,
          );
        }
        return methodNotAllowed("GET, POST");
      }
      if (segments.length === 4) {
        const targetSubject = decodeURIComponent(segments[3] ?? "");
        if (method === "PATCH") {
          return await changeWorkspaceMemberRole(
            request,
            operations,
            workspaceId,
            ctx.session.subject,
            targetSubject,
          );
        }
        if (method === "DELETE") {
          return await removeWorkspaceMember(
            operations,
            workspaceId,
            ctx.session.subject,
            targetSubject,
          );
        }
        return methodNotAllowed("PATCH, DELETE");
      }
    }
    if (leaf === "projects" && segments.length === 3) {
      return await handleWorkspaceProjects(ctx, workspaceId, method);
    }
    if (
      leaf === "source-ref-resolutions" &&
      segments.length === 4 &&
      segments[3] === "stable-semver"
    ) {
      if (method !== "POST") return methodNotAllowed("POST");
      const body = await readJsonObject(request);
      const url = body ? stringValue(body.url) : undefined;
      if (!url || Object.keys(body!).some((key) => key !== "url")) {
        return errorJson(
          "invalid_request",
          "body must contain only a non-empty url",
          400,
        );
      }
      return json(await operations.resolveStableSourceTag(url));
    }
    if (leaf === "capsules" && segments.length === 3) {
      if (method === "GET")
        return await listWorkspaceCapsules(operations, workspaceId, url);
      if (method === "POST") {
        return await createCapsule(
          request,
          operations,
          store,
          ctx.issuer,
          ctx.session.subject,
          workspaceId,
          ctx.managedPublicBaseDomain,
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (leaf === "current-state-versions" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await listWorkspaceCurrentStateVersions(
        operations,
        workspaceId,
        url,
      );
    }
    if (leaf === "graph" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await workspaceGraph(operations, workspaceId);
    }
    if (leaf === "runs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await workspaceRuns(operations, workspaceId, url);
    }
    if (leaf === "activity" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await workspaceActivity(operations, workspaceId, url);
    }
    if (leaf === "backups" && segments.length === 3) {
      if (method === "GET") {
        const page = parseControlPageParams(url);
        if (!page.ok) return page.response;
        return json(
          (await operations.backups.listBackups(
            workspaceId,
            page.params,
          )) satisfies ListBackupsResponse,
        );
      }
      if (method === "POST") {
        const backup = await operations.backups.createBackup({ workspaceId });
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
        workspaceId,
        backupId,
        ctx.session.subject,
      );
    }
    if (leaf === "billing" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getWorkspaceBilling(workspaceId));
    }
    if (leaf === "usage" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      const page = parseControlPageParams(url);
      if (!page.ok) return page.response;
      return json(
        await operations.listWorkspaceUsage(workspaceId, page.params),
      );
    }
    if (leaf === "plan-update" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await workspacePlanUpdate(operations, workspaceId);
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
        await operations.runGroups.createWorkspaceDriftCheck(
          workspaceId,
          limit !== undefined ? { limit } : {},
        ),
        201,
      );
    }
  }
  return undefined;
}

// --- Workspaces ----------------------------------------------------------------

async function listWorkspaces(
  operations: ControlPlaneOperations,
  _store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  // Preserve the public all-matching response and createdAt/id order while the
  // durable store performs membership/status/archive filtering in bounded
  // keyset pages. The route never materializes archived rows unless explicitly
  // requested with includeArchived=true.
  const includeArchived = parseBooleanQuery(url, "includeArchived") === true;
  const visible = await listWorkspacesForSession(
    operations,
    sessionSubject,
    includeArchived,
  );
  return json({ workspaces: visible });
}

async function listWorkspacesForSession(
  operations: ControlPlaneOperations,
  sessionSubject: string,
  includeArchived: boolean,
): Promise<readonly Workspace[]> {
  const workspaces: Workspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await operations.workspaces.listWorkspacesForAccountPage(
      sessionSubject,
      {
        includeArchived,
        order: "created_asc",
        ...(cursor ? { cursor } : {}),
      },
    );
    workspaces.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return workspaces;
}

function isArchivedWorkspace(workspace: Workspace): boolean {
  return (
    typeof workspace.archivedAt === "string" && workspace.archivedAt.length > 0
  );
}

function parseBooleanQuery(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

async function createWorkspace(
  request: Request,
  operations: ControlPlaneOperations,
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const handle = stringValue(body.handle);
  const displayName = stringValue(body.displayName) ?? handle;
  const type = workspaceTypeValue(body.type) ?? "personal";
  if (!handle) {
    return errorJson("invalid_request", "handle is required", 400);
  }
  // ownerUserId is the authenticated account id; canonical Workspace creation
  // persists the corresponding owner membership in the same authority.
  const workspace = await operations.workspaces.createWorkspace({
    handle,
    displayName: displayName ?? handle,
    type,
    ownerUserId: sessionSubject,
  });
  return jsonStatus({ workspace }, 201);
}

async function updateWorkspace(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  workspaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const patch: {
    displayName?: string;
    policy?: PolicyConfig;
    archived?: boolean;
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
    if (body.policy.scopeBoundary !== undefined) {
      try {
        parseScopeBoundaryPolicy(body.policy.scopeBoundary);
      } catch (error) {
        return errorJson(
          "invalid_argument",
          error instanceof Error ? error.message : "scopeBoundary is invalid",
          400,
        );
      }
    }
    patch.policy = body.policy as PolicyConfig;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return errorJson("invalid_argument", "archived must be boolean", 400);
    }
    patch.archived = body.archived;
  }
  if (
    patch.displayName === undefined &&
    patch.policy === undefined &&
    patch.archived === undefined
  ) {
    return errorJson(
      "invalid_argument",
      "displayName, policy, or archived is required",
      400,
    );
  }
  if (patch.archived === true) {
    const [target, activePage] = await Promise.all([
      operations.workspaces.getWorkspace(workspaceId),
      operations.workspaces.listWorkspacesForAccountPage(sessionSubject, {
        includeArchived: false,
        order: "created_asc",
        limit: 1,
      }),
    ]);
    if (!isArchivedWorkspace(target) && activePage.total <= 1) {
      return errorJson(
        "failed_precondition",
        "cannot archive the last active workspace",
        409,
      );
    }
  }
  const workspace = await operations.workspaces.updateWorkspace(
    workspaceId,
    patch,
  );
  await operations.activity.record?.({
    workspaceId,
    actorId: sessionSubject,
    action: "workspace.updated",
    targetType: "workspace",
    targetId: workspaceId,
    metadata: {
      fields: Object.keys(patch).sort(),
      ...(patch.policy !== undefined
        ? { policyDigest: await stableJsonDigest(patch.policy) }
        : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    },
  });
  return json({ workspace });
}

// --- Members (Workspace membership / roles) ------------------------------------
//
// The Workspace is resolved server-side and namespace-gated by `requireWorkspaceAccess`
// in dispatch BEFORE these run. On top of that namespace gate, every member
// handler enforces the membership-ROLE gate from the membership ledger itself:
//
//   - list:        any active member of the Workspace (member 可),
//   - add/invite:  owner or admin only; a POST that overwrites an EXISTING
//                  active owner is owner-only and last-owner-guarded (same as
//                  the PATCH path) so POST cannot escalate or orphan,
//   - role change: owner only,
//   - remove:      owner only, and the LAST remaining owner can never be removed
//                  or demoted (last-owner guard) so a Workspace is never left
//                  unmanaged.
//
// The Workspaces domain seeds no membership row when a Workspace is created, so the
// roster starts empty. To keep the mutation gate aligned with the namespace
// gate (which already trusts `Workspace.ownerUserId`) and to let the namespace owner
// bootstrap the first membership, every handler reads the roster via
// `effectiveMembers`, which adds an IMPLICIT active owner row for the namespace
// owner whenever the ledger has no active row for them. The first real
// `upsertMember` the owner performs persists a concrete row.
//
// `targetSubject` / the session subject are matched against the membership
// ledger's `accountId`; the workspaceId is never taken from the client body.

const MEMBER_ROLES: readonly ControlWorkspaceRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

function controlRoleValue(value: unknown): ControlWorkspaceRole | undefined {
  return typeof value === "string" &&
    (MEMBER_ROLES as readonly string[]).includes(value)
    ? (value as ControlWorkspaceRole)
    : undefined;
}

function memberForbidden(description: string): Response {
  return errorJson("forbidden", description, 403);
}

/** True when the membership has an active owner role. */
function isActiveOwner(member: PublicWorkspaceMember): boolean {
  return member.status === "active" && member.roles.includes("owner");
}

/** The caller's membership in the Workspace, matched by session subject. */
function findCaller(
  members: readonly PublicWorkspaceMember[],
  subject: string,
): PublicWorkspaceMember | undefined {
  return members.find((member) => member.accountId === subject);
}

/** Returns the canonical membership roster for this Workspace. */
async function effectiveMembers(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<readonly PublicWorkspaceMember[]> {
  return await operations.members.listMembers(workspaceId);
}

async function listWorkspaceMembers(
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: string,
): Promise<Response> {
  const members = await effectiveMembers(operations, workspaceId);
  // List is member-visible: the caller must be an active member of THIS Workspace.
  // The namespace gate (requireWorkspaceAccess) already passed, but membership is a
  // separate ledger — a namespace owner who is not a recorded member still sees
  // the roster (they own the Workspace via the implicit owner row), otherwise an
  // active member must be present.
  const caller = findCaller(members, subject);
  if (caller && caller.status !== "active") {
    return memberForbidden("Your membership in this Workspace is not active.");
  }
  return json({ members });
}

async function addWorkspaceMember(
  request: Request,
  store: AccountsStore,
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: string,
): Promise<Response> {
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
  // Mutation gate: only an active owner/admin of this Workspace may add members. The
  // roster includes the implicit namespace-owner row so the Workspace owner can
  // always bootstrap the first membership.
  const members = await effectiveMembers(operations, workspaceId);
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
  // The membership store is keyed by `workspaceId:accountId` and `upsertMember`
  // OVERWRITES, so a POST against an EXISTING member is a role change in
  // disguise. Route an existing-active-owner upsert through the SAME gates the
  // dedicated PATCH path (`changeWorkspaceMemberRole`) enforces, otherwise an admin
  // could demote a sitting owner and either role could strip the last owner —
  // privilege escalation / Workspace orphaning straight through POST. This also
  // covers the implicit namespace-owner row (active owner), so a POST can never
  // silently strip the namespace owner who has no ledger row yet.
  const target = findCaller(members, accountId);
  if (target && isActiveOwner(target)) {
    // Changing an existing active OWNER's role is owner-only (admins cannot
    // touch an owner), matching `changeWorkspaceMemberRole`.
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
    workspaceId,
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

async function changeWorkspaceMemberRole(
  request: Request,
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: string,
  targetSubject: string,
): Promise<Response> {
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
  const members = await effectiveMembers(operations, workspaceId);
  const caller = findCaller(members, subject);
  // Role change is owner-only.
  if (!caller || !isActiveOwner(caller)) {
    return memberForbidden("Only an owner can change member roles.");
  }
  const target = findCaller(members, targetSubject);
  if (!target) {
    return errorJson("not_found", "member not found", 404);
  }
  // Last-owner guard: demoting the sole remaining owner would leave the Workspace
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
    workspaceId,
    accountId: targetSubject,
    roles,
    status: "active",
    actor: actorFor(caller),
  });
  return json({ member });
}

async function removeWorkspaceMember(
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: string,
  targetSubject: string,
): Promise<Response> {
  const members = await effectiveMembers(operations, workspaceId);
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
    workspaceId,
    accountId: targetSubject,
    roles: target.roles,
    status: "suspended",
    actor: actorFor(caller),
  });
  return json({ member });
}

/** Active owners in the Workspace (used by the last-owner guard). */
function activeOwnerCount(members: readonly PublicWorkspaceMember[]): number {
  return members.filter(isActiveOwner).length;
}

/**
 * Parses a `roles` field that may be a single role string or an array. Returns
 * a de-duplicated, non-empty role list, or `undefined` when any entry is not a
 * known role.
 */
function parseRolesField(
  value: unknown,
): readonly ControlWorkspaceRole[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (raw.length === 0) return undefined;
  const roles: ControlWorkspaceRole[] = [];
  for (const entry of raw) {
    const role = controlRoleValue(entry);
    if (!role) return undefined;
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

/** Builds the membership-service actor from the caller's membership. */
function actorFor(caller: PublicWorkspaceMember): MembershipActor {
  return {
    actorAccountId: caller.accountId,
    roles: [...caller.roles],
    requestId: `ctrl-${caller.accountId}-${Date.now()}`,
  };
}

// --- Capsules ---------------------------------------------------------

function parseIncludeDestroyed(
  url: URL,
):
  | { readonly ok: true; readonly includeDestroyed: boolean }
  | { readonly ok: false; readonly response: Response } {
  const raw = url.searchParams.get("includeDestroyed");
  if (raw === null || raw === "" || raw === "true") {
    return { ok: true, includeDestroyed: true };
  }
  if (raw === "false") {
    return { ok: true, includeDestroyed: false };
  }
  return {
    ok: false,
    response: errorJson(
      "invalid_request",
      "includeDestroyed must be true or false",
      400,
    ),
  };
}

async function listWorkspaceCapsules(
  operations: ControlPlaneOperations,
  workspaceId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const includeDestroyed = parseIncludeDestroyed(url);
  if (!includeDestroyed.ok) return includeDestroyed.response;
  const { items, nextCursor } = await operations.capsules.listCapsulesPage(
    workspaceId,
    {
      ...page.params,
      includeDestroyed: includeDestroyed.includeDestroyed,
    },
  );
  return json({
    capsules: items.map(publicCapsule),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function listWorkspaceCurrentStateVersions(
  operations: ControlPlaneOperations,
  workspaceId: string,
  url: URL,
): Promise<Response> {
  const page = parseControlPageParams(url);
  if (!page.ok) return page.response;
  const includeDestroyed = parseIncludeDestroyed(url);
  if (!includeDestroyed.ok) return includeDestroyed.response;
  const { items, nextCursor } = await operations.capsules.listCapsulesPage(
    workspaceId,
    {
      ...page.params,
      includeDestroyed: includeDestroyed.includeDestroyed,
    },
  );
  const stateVersions = operations.listStateVersionsByIds
    ? await listCurrentStateVersionsFromIdsRead(operations, workspaceId, items)
    : operations.listStateVersionsByWorkspace
      ? await listCurrentStateVersionsFromWorkspaceRead(
          operations,
          workspaceId,
          items,
        )
      : await listCurrentStateVersionsFromSingleReads(
          operations,
          workspaceId,
          items,
        );
  return json({
    stateVersions,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function listCurrentStateVersionsFromWorkspaceRead(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicStateVersion[]> {
  const currentIds = new Set(currentStateVersionIds(capsules));
  if (currentIds.size === 0) return [];
  const byId = publicStateVersionMap(
    (await operations.listStateVersionsByWorkspace!(workspaceId)).filter(
      (stateVersion) => currentIds.has(stateVersion.id),
    ),
    workspaceId,
  );
  return currentStateVersionsInCapsuleOrder(capsules, byId);
}

async function listCurrentStateVersionsFromIdsRead(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicStateVersion[]> {
  const currentIds = currentStateVersionIds(capsules);
  if (currentIds.length === 0) return [];
  const byId = publicStateVersionMap(
    await operations.listStateVersionsByIds!(currentIds),
    workspaceId,
  );
  return currentStateVersionsInCapsuleOrder(capsules, byId);
}

function currentStateVersionIds(
  capsules: readonly Capsule[],
): readonly string[] {
  return capsules
    .map(capsuleCurrentStateVersionId)
    .filter((id): id is string => id !== undefined && id.length > 0);
}

function capsuleCurrentStateVersionId(capsule: Capsule): string | undefined {
  return capsule.currentStateVersionId ?? capsule.currentStateVersionId;
}

function publicStateVersionMap(
  stateVersions: readonly StateVersion[],
  workspaceId: string,
): ReadonlyMap<string, PublicStateVersion> {
  return new Map(
    stateVersions
      .filter((stateVersion) => stateVersion.workspaceId === workspaceId)
      .map((stateVersion) => [
        stateVersion.id,
        publicStateVersion(stateVersion),
      ]),
  );
}

function currentStateVersionsInCapsuleOrder(
  capsules: readonly Capsule[],
  stateVersionsById: ReadonlyMap<string, PublicStateVersion>,
): readonly PublicStateVersion[] {
  return capsules
    .map((capsule) => {
      const id = capsuleCurrentStateVersionId(capsule);
      return id ? stateVersionsById.get(id) : undefined;
    })
    .filter((row): row is PublicStateVersion => row !== undefined);
}

async function listCurrentStateVersionsFromSingleReads(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicStateVersion[]> {
  const stateVersions = await Promise.all(
    capsules.map(async (capsule) => {
      const currentId = capsuleCurrentStateVersionId(capsule);
      if (!currentId) return undefined;
      try {
        const { stateVersion } = await operations.getStateVersion(currentId);
        if (stateVersion.workspaceId !== workspaceId) return undefined;
        return publicStateVersion(stateVersion);
      } catch {
        return undefined;
      }
    }),
  );
  return stateVersions.filter(
    (row): row is PublicStateVersion => row !== undefined,
  );
}

async function createCapsule(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  issuer: string | undefined,
  sessionSubject: string,
  workspaceId: string,
  managedPublicBaseDomain?: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const name = stringValue(body.name);
  const projectId = stringValue(body.projectId);
  const environment = stringValue(body.environment);
  const sourceId = stringValue(body.sourceId);
  const installConfigId = stringValue(body.installConfigId);
  const runnerProfileId =
    stringValue(body.runnerId) ?? stringValue(body.runnerProfileId);
  const outputAllowlist = outputAllowlistValue(body.outputAllowlist);
  const interfaceBlueprintsResult =
    body.interfaceBlueprints === undefined
      ? undefined
      : parseInterfaceBlueprintsValue(body.interfaceBlueprints);
  const interfaceBlueprints =
    interfaceBlueprintsResult?.ok === true
      ? interfaceBlueprintsResult.value
      : undefined;
  const storeMetadata = installConfigStoreValue(body.store);
  const modulePath = modulePathValue(body.modulePath);
  const sourceBuild = sourceBuildValue(body.sourceBuild);
  const managedPublicHostname = managedPublicHostnameValue(
    body.managedPublicHostname,
  );
  if (body.modulePath !== undefined && modulePath === undefined) {
    return errorJson(
      "invalid_request",
      "modulePath must be a safe relative OpenTofu module path.",
      400,
    );
  }
  if (body.sourceBuild !== undefined && sourceBuild === undefined) {
    return errorJson(
      "invalid_request",
      "sourceBuild must contain argv commands and relative output paths.",
      400,
    );
  }
  if (body.outputAllowlist !== undefined && outputAllowlist === undefined) {
    return errorJson(
      "invalid_request",
      "outputAllowlist must be an object of { from, type, required? } entries",
      400,
    );
  }
  if (
    interfaceBlueprintsResult !== undefined &&
    !interfaceBlueprintsResult.ok
  ) {
    return errorJson("invalid_request", interfaceBlueprintsResult.message, 400);
  }
  if (
    body.managedPublicHostname !== undefined &&
    managedPublicHostname === undefined
  ) {
    return errorJson(
      "invalid_request",
      "managedPublicHostname must be { mode: 'scoped' | 'vanity' }",
      400,
    );
  }
  if (body.store !== undefined && storeMetadata === undefined) {
    return errorJson(
      "invalid_request",
      "store metadata must be omitted or copied from a valid TCS Store listing",
      400,
    );
  }
  const autoUpdate = body.autoUpdate === true;
  const vars = normalizedVarsValue(body.vars);
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
  const sourceOwnerWorkspaceId = sourceWorkspaceId(source);
  if (!sourceOwnerWorkspaceId) {
    return errorJson(
      "internal_error",
      "source is missing Workspace identity",
      500,
    );
  }
  if (sourceOwnerWorkspaceId !== workspaceId) {
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: sourceOwnerWorkspaceId,
      subject: sessionSubject,
    });
    if (!auth.ok) return auth.response;
    return errorJson(
      "invalid_request",
      "sourceId must belong to the target Workspace.",
      400,
    );
  }
  let resolvedInstallConfigId = installConfigId;
  let resolvedInstallConfig: InstallConfig | undefined;
  const baseConfig =
    await operations.capsules.getInstallConfig(installConfigId);
  if (
    baseConfig.workspaceId !== undefined &&
    baseConfig.workspaceId !== workspaceId
  ) {
    return errorJson(
      "invalid_request",
      "installConfigId is not available to the target Workspace.",
      400,
    );
  }
  const repoMetadataSnapshot = await latestSourceSnapshotForSource(
    operations,
    source,
  );
  const hydratedRepoConfig = await hydrateRepoOwnedStoreConfig({
    operations,
    source,
    sourceSnapshot: repoMetadataSnapshot,
    storeMetadata,
    modulePath,
  });
  const resolvedStoreMetadata = hydratedRepoConfig.storeMetadata;
  const resolvedModulePath = hydratedRepoConfig.modulePath;
  const presentationDefaultVars = variablePresentationDefaultMapping(
    baseConfig.variablePresentation,
    { capsuleName: name, workspaceId },
  );
  const hasPresentationDefaultVars =
    Object.keys(presentationDefaultVars).length > 0;
  const hasVars = vars !== undefined && Object.keys(vars).length > 0;
  const selectedInterfaceBlueprints =
    interfaceBlueprints ?? baseConfig.interfaceBlueprints;
  const needsInstallingPrincipalScope =
    capsuleInterfaceBlueprintsNeedInstallingPrincipal(
      selectedInterfaceBlueprints,
    );
  const resolvedInterfaceBlueprints =
    resolveCapsuleInterfaceBlueprintInstallingPrincipal(
      selectedInterfaceBlueprints,
      sessionSubject,
    );
  if (
    hasVars ||
    hasPresentationDefaultVars ||
    runnerProfileId ||
    outputAllowlist !== undefined ||
    resolvedStoreMetadata !== undefined ||
    resolvedModulePath !== undefined ||
    sourceBuild !== undefined ||
    managedPublicHostname !== undefined ||
    interfaceBlueprints !== undefined ||
    needsInstallingPrincipalScope
  ) {
    const now = new Date().toISOString();
    const { modulePath: _baseModulePath, ...baseConfigWithoutModulePath } =
      baseConfig;
    const configBase =
      resolvedModulePath === "" ? baseConfigWithoutModulePath : baseConfig;
    const config = await operations.capsules.putInstallConfig({
      ...configBase,
      id: `icfg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId,
      name: `${name}-config`,
      internal: { reason: "per_install_overrides" },
      variableMapping: mergeVariableMappings(
        baseConfig.variableMapping,
        presentationDefaultVars,
        vars ?? {},
      ),
      ...(resolvedStoreMetadata ? { store: resolvedStoreMetadata } : {}),
      ...(runnerProfileId ? { runnerId: runnerProfileId } : {}),
      ...(resolvedModulePath ? { modulePath: resolvedModulePath } : {}),
      ...(sourceBuild ? { sourceBuild } : {}),
      ...(managedPublicHostname ? { managedPublicHostname } : {}),
      ...(resolvedInterfaceBlueprints
        ? { interfaceBlueprints: resolvedInterfaceBlueprints }
        : {}),
      outputAllowlist:
        outputAllowlist ?? scopedCloneOutputAllowlist(baseConfig),
      createdAt: now,
      updatedAt: now,
    });
    resolvedInstallConfigId = config.id;
    resolvedInstallConfig = config;
  }
  const capsule = await operations.capsules.createCapsule({
    workspaceId,
    ...(projectId ? { projectId } : {}),
    name,
    environment,
    sourceId,
    installConfigId: resolvedInstallConfigId,
    ...(autoUpdate ? { autoUpdate: true } : {}),
  });
  if (resolvedInstallConfig && issuer) {
    try {
      await ensureTakosumiAccountsOidcForCapsule({
        operations,
        store,
        issuer,
        capsule,
        installConfig: resolvedInstallConfig,
        ...(managedPublicBaseDomain ? { managedPublicBaseDomain } : {}),
      });
    } catch (error) {
      // Compensate: never leave a half-created capsule behind when the OIDC
      // client provisioning fails — the caller sees the error, and without
      // this the workspace keeps a ghost capsule that was never installable.
      try {
        await operations.capsules.abandonUnappliedCapsule?.(
          capsule.id,
          "takosumi accounts oidc provisioning failed during create",
        );
      } catch {
        // Best-effort; surface the original failure.
      }
      throw error;
    }
  }
  return jsonStatus({ capsule: publicCapsule(capsule) }, 201);
}

function managedPublicHostnameValue(
  value: unknown,
): ManagedPublicHostnameAllocation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  return value.mode === "scoped" || value.mode === "vanity"
    ? { mode: value.mode }
    : undefined;
}

function variablePresentationDefaultMapping(
  presentation: InstallConfig["variablePresentation"] | undefined,
  options: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): Readonly<Record<string, JsonValue>> {
  if (!presentation) return {};
  let out: Record<string, JsonValue> = {};
  for (const input of presentation) {
    if (input.secret === true) continue;
    if (!input.defaultValue) continue;
    const value = variablePresentationDefaultValue(
      input,
      input.defaultValue,
      options,
    );
    if (value === undefined) continue;
    try {
      out = mergeVariableMappings(
        out,
        normalizeVariablePathRecord(
          { [input.name]: value },
          "variablePresentation",
        ),
      ) as Record<string, JsonValue>;
    } catch {
      continue;
    }
  }
  return out;
}

function variablePresentationDefaultValue(
  input: InstallConfigVariablePresentation,
  defaultValue: InstallConfigVariableDefault,
  options: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): JsonValue | undefined {
  let value: JsonValue;
  switch (defaultValue.source) {
    case "literal":
      value = defaultValue.value;
      break;
    case "capsule_name":
      value = storeSlug(options.capsuleName);
      break;
    case "workspace_scoped_capsule_name": {
      const base = storeSlug(options.capsuleName);
      const suffix = workspaceSlugSuffix(options.workspaceId);
      value = suffix ? `${base}-${suffix}` : base;
      break;
    }
  }
  switch (input.type ?? "string") {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "json":
      return value;
  }
}

function storeSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "capsule"
  );
}

function workspaceSlugSuffix(value: string): string {
  return value
    .replace(/^workspace_/u, "")
    .replace(/[^a-z0-9-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 6)
    .toLowerCase();
}

function mergeVariableMappings(
  ...records: readonly Readonly<Record<string, unknown>>[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      out[key] = mergeVariableMappingValue(out[key], value);
    }
  }
  return out;
}

function mergeVariableMappingValue(
  existing: unknown,
  incoming: unknown,
): unknown {
  if (isPlainJsonObject(existing) && isPlainJsonObject(incoming)) {
    return mergeVariableMappings(existing, incoming);
  }
  return incoming;
}

function scopedCloneOutputAllowlist(
  baseConfig: InstallConfig,
): InstallConfig["outputAllowlist"] {
  if (Object.keys(baseConfig.outputAllowlist).length > 0) {
    return baseConfig.outputAllowlist;
  }
  return defaultCapsuleOutputAllowlist();
}

function normalizedVarsValue(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) return undefined;
  try {
    return normalizeVariablePathRecord(value, "vars");
  } catch {
    return undefined;
  }
}

async function createRestoreRun(
  request: Request,
  operations: ControlPlaneOperations,
  workspaceId: string,
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
  const capsuleId = stringValue(body.capsuleId);
  const environment = stringValue(body.environment);
  const expectedBackupDigest = stringValue(body.expectedBackupDigest);
  const restoreRequest: CreateRestoreRequest = {
    stateGeneration: Number(stateGeneration),
    ...(capsuleId ? { capsuleId } : {}),
    ...(environment ? { environment } : {}),
    ...(expectedBackupDigest ? { expectedBackupDigest } : {}),
    ...(body.restoreServiceData === true ? { restoreServiceData: true } : {}),
  };
  const run = await operations.createRestoreRun(
    workspaceId,
    backupId,
    restoreRequest,
    {
      actor,
    },
  );
  return jsonStatus({ run: await publicRun(operations, run) }, 201);
}

// --- Graph -----------------------------------------------------------------

async function workspaceGraph(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<Response> {
  const [capsules, edges] = await Promise.all([
    operations.capsules.listCapsules(workspaceId),
    operations.listDependenciesByWorkspace(workspaceId),
  ]);
  const nodes = capsules.map((capsule) => ({
    capsuleId: capsule.id,
    name: capsule.name,
    environment: capsule.environment,
    status: capsule.status,
  }));
  const graphEdges = edges.map((edge) => ({
    id: edge.id,
    producerCapsuleId: edge.producerCapsuleId,
    consumerCapsuleId: edge.consumerCapsuleId,
    outputs: edge.outputs,
  }));
  return json({ nodes, edges: graphEdges });
}

// --- Activity --------------------------------------------------------------

async function workspaceRuns(
  operations: ControlPlaneOperations,
  workspaceId: string,
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
  const runs = await operations.listRuns(workspaceId, limit ? { limit } : {});
  return json({
    runs: await Promise.all(runs.map((run) => publicRun(operations, run))),
  } satisfies ListRunsResponse);
}

async function workspaceActivity(
  operations: ControlPlaneOperations,
  workspaceId: string,
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
  const events = await operations.activity.list(workspaceId, limit);
  return json({ events });
}

async function workspacePlanUpdate(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<Response> {
  return jsonStatus(
    await operations.runGroups.createWorkspaceUpdate(workspaceId),
    201,
  );
}
