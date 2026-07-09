/**
 * Session-authed Workspace (`/api/v1/workspaces`)
 * control routes: workspace CRUD, members, capsule create/list, graph,
 * runs/activity, backups, billing reads, plan-update / drift-check. Public
 * upload/prepared-source ingest is retired; upload compatibility remains
 * internal/operator-only. Extracted from `control-routes.ts` (P3 god-file split).
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
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  CapsuleProviderEnvBindingSet,
  InstallConfig,
  InstallConfigStoreInput,
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
  CapsuleProviderConnectionBinding,
  CapsuleProviderConnectionBindings,
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
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
import type {
  AppCapsuleMode,
  AppCapsuleStatus,
  CapsuleRecord,
  WorkspaceKind,
} from "../ledger.ts";
import type { SharedCellRuntimeAllocator } from "../runtime.ts";
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
  publicDeployResponse,
  publicDeployment,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
  resolveProviderConnectionBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  connectionScopeHintsFromValues,
  dependencyModeValue,
  dependencyVisibilityValue,
  installConfigStoreValue,
  isGoogleCloudProvider,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseCapsuleProviderConnectionBinding,
  parseCapsuleProviderConnectionBindings,
  parseLimit,
  spaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import { normalizeVariablePathRecord } from "../../../../core/domains/deploy-control/validation.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/install_config_bootstrap.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { maybeEnsurePersonalWorkspaceForSession } from "../control-personal-space.ts";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";
import { ensureTakosumiAccountsOidcForCapsule } from "./capsule-oidc.ts";

function sourceWorkspaceId(
  source: Readonly<{ workspaceId?: string; spaceId?: string }>,
): string | undefined {
  return stringValue(source.workspaceId) ?? stringValue(source.spaceId);
}

export async function handleWorkspaces(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // GET/POST /api/v1/workspaces, normalized to the historical handler key.
  if (segments.length === 1 && segments[0] === "spaces") {
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
  if (segments[0] === "spaces" && segments.length >= 2) {
    const workspaceId = decodeURIComponent(segments[1] ?? "");
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
          space: await operations.spaces.getWorkspace(workspaceId),
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
    const leaf = segments[2];
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
    if (leaf === "uploads" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return errorJson(
        "gone",
        "Public upload ingest is retired. Register a Git URL Source and create a Capsule instead.",
        410,
        request,
      );
    }
    if (leaf === "artifact-snapshots" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return errorJson(
        "gone",
        "Public prepared-source archive ingest is retired. Register a Git URL Source and create a Capsule instead.",
        410,
        request,
      );
    }
    if (leaf === "installations" && segments.length === 3) {
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
      return await spaceGraph(operations, workspaceId);
    }
    if (leaf === "runs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await spaceRuns(operations, workspaceId, url);
    }
    if (leaf === "activity" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return await spaceActivity(operations, workspaceId, url);
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
    if (leaf === "credit-reservations" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(
        await operations.listWorkspaceCreditReservations(workspaceId),
      );
    }
    // NOTE: `credits/top-up` and `subscription/change` are intentionally NOT
    // on this session surface. Billing mode is operator-selected and credits
    // enter through paid Stripe checkout (spec §32); the operator mutations
    // live on the bearer-gated `/internal/v1` surface
    // (core/api/deploy_control_billing_routes.ts).
    if (leaf === "plan-update" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await spacePlanUpdate(operations, workspaceId);
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

/** 64 MiB cap on a single local Capsule upload archive. */
const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

// --- Workspaces ----------------------------------------------------------------

async function listWorkspaces(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  url: URL,
): Promise<Response> {
  // Scope the read to the caller's own spaces instead of loading every tenant's
  // Workspace and filtering per row. This reproduces `canAccessWorkspace`'s accept set
  // as a UNION of two scoped queries:
  //   (A) deploy-control Workspaces the subject directly owns (ownerUserId), and
  //   (B) Workspaces whose account is legally owned by the subject (the accounts
  //       ledger's `legalOwnerSubject`), fetched individually so we never read
  //       another tenant's Workspace.
  const includeArchived = parseBooleanQuery(url, "includeArchived") === true;
  const visible = (
    await listWorkspacesForSession(operations, store, sessionSubject)
  )
    .filter((space) => includeArchived || !isArchivedWorkspace(space))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  return json({ spaces: visible });
}

async function listWorkspacesForSession(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
): Promise<readonly Workspace[]> {
  const byId = new Map<string, Workspace>();
  for (const space of await operations.spaces.listWorkspacesByOwner(
    sessionSubject,
  )) {
    byId.set(space.id, space);
  }
  const ledgerWorkspaces = await store.listWorkspacesForOwner(
    sessionSubject as TakosumiSubject,
  );
  const missingIds = uniqueMissingWorkspaceIds(
    ledgerWorkspaces.map((workspace) => workspace.workspaceId),
    byId,
  );
  if (missingIds.length > 0 && operations.spaces.listWorkspacesByIds) {
    for (const space of await operations.spaces.listWorkspacesByIds(
      missingIds,
    )) {
      byId.set(space.id, space);
    }
  }
  for (const workspaceId of missingIds) {
    if (byId.has(workspaceId)) continue;
    try {
      byId.set(workspaceId, await operations.spaces.getWorkspace(workspaceId));
    } catch {
      // The deploy-control Workspace may not exist (or is mid-creation); skip it.
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function uniqueMissingWorkspaceIds(
  ids: readonly string[],
  existing: ReadonlyMap<string, Workspace>,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (seen.has(id) || existing.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isArchivedWorkspace(space: Workspace): boolean {
  return typeof space.archivedAt === "string" && space.archivedAt.length > 0;
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
  const type = spaceTypeValue(body.type) ?? "personal";
  if (!handle) {
    return errorJson("invalid_request", "handle is required", 400);
  }
  // ownerUserId is the session account id (the authenticated subject); the
  // dashboard never supplies it. The membership ledger seeds no row here; the
  // member handlers grant the namespace owner an implicit active-owner row (see
  // `effectiveMembers`) so they can bootstrap the first membership.
  const space = await operations.spaces.createWorkspace({
    handle,
    displayName: displayName ?? handle,
    type,
    ownerUserId: sessionSubject,
  });
  return jsonStatus({ space }, 201);
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
    const [target, spaces] = await Promise.all([
      operations.spaces.getWorkspace(workspaceId),
      listWorkspacesForSession(operations, store, sessionSubject),
    ]);
    const activeWorkspaces = spaces.filter(
      (space) => !isArchivedWorkspace(space),
    );
    if (!isArchivedWorkspace(target) && activeWorkspaces.length <= 1) {
      return errorJson(
        "failed_precondition",
        "cannot archive the last active workspace",
        409,
      );
    }
  }
  const space = await operations.spaces.updateWorkspace(workspaceId, patch);
  await operations.activity.record?.({
    workspaceId,
    spaceId: workspaceId,
    actorId: sessionSubject,
    action: "space.updated",
    targetType: "space",
    targetId: workspaceId,
    metadata: {
      fields: Object.keys(patch).sort(),
      ...(patch.policy !== undefined
        ? { policyDigest: await stableJsonDigest(patch.policy) }
        : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    },
  });
  return json({ space });
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
// The spaces domain seeds NO membership row when a Workspace is created, so the
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

function membersUnavailable(): Response {
  return errorJson(
    "feature_unavailable",
    "Workspace membership management is not available.",
    503,
  );
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

/**
 * The membership ledger does not seed a row when a Workspace is created (the spaces
 * domain records only `Workspace.ownerUserId`), so a brand-new Workspace starts with an
 * EMPTY roster. To let the namespace owner bootstrap the first membership and to
 * keep the mutation gate aligned with the namespace gate (`canAccessWorkspace`,
 * which already trusts `Workspace.ownerUserId`), synthesize an implicit ACTIVE owner
 * row for the namespace owner whenever the ledger has no active row for them.
 *
 * This is read-only: it does not write to the ledger. The first real
 * `upsertMember` the owner performs persists a concrete row; once any active
 * owner row exists for the namespace owner, the synthetic row is not added.
 */
function withImplicitNamespaceOwner(
  members: readonly PublicWorkspaceMember[],
  workspaceId: string,
  ownerUserId: string,
): readonly PublicWorkspaceMember[] {
  const existing = members.find((member) => member.accountId === ownerUserId);
  // Only synthesize when the namespace owner has NO active row. A suspended /
  // invited row for the owner is left as-is (the owner explicitly changed it),
  // and an existing active row already grants them management.
  if (existing && existing.status === "active") return members;
  if (existing) {
    // Replace a non-active owner row with the implicit active-owner view so the
    // namespace owner is never locked out of their own Workspace.
    return members.map((member) =>
      member.accountId === ownerUserId
        ? implicitOwner(workspaceId, ownerUserId)
        : member,
    );
  }
  return [implicitOwner(workspaceId, ownerUserId), ...members];
}

/** The synthetic active-owner projection for a namespace owner with no row. */
function implicitOwner(
  workspaceId: string,
  ownerUserId: string,
): PublicWorkspaceMember {
  const now = new Date(0).toISOString();
  return {
    id: `implicit-owner:${ownerUserId}`,
    workspaceId,
    accountId: ownerUserId,
    roles: ["owner"],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolves the Workspace's namespace owner (`Workspace.ownerUserId`) server-side and
 * returns the effective member roster (ledger rows + the implicit namespace
 * owner). The Workspace is already namespace-gated by `requireWorkspaceAccess` in
 * dispatch; we re-read it here only to learn the owner subject, never from the
 * client body.
 */
async function effectiveMembers(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<readonly PublicWorkspaceMember[]> {
  const members = await operations.members!.listMembers(workspaceId);
  const space = await operations.spaces.getWorkspace(workspaceId);
  return withImplicitNamespaceOwner(members, workspaceId, space.ownerUserId);
}

async function listWorkspaceMembers(
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: string,
): Promise<Response> {
  if (!operations.members) return membersUnavailable();
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
  if (!operations.members) return membersUnavailable();
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
  const { items, nextCursor } = await operations.installations.listCapsulesPage(
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
  const { items, nextCursor } = await operations.installations.listCapsulesPage(
    workspaceId,
    {
      ...page.params,
      includeDestroyed: includeDestroyed.includeDestroyed,
    },
  );
  const deployments = operations.listDeploymentsByIds
    ? await listCurrentStateVersionsFromIdsRead(operations, workspaceId, items)
    : operations.listDeploymentsBySpace
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
    deployments,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
}

async function listCurrentStateVersionsFromWorkspaceRead(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicDeployment[]> {
  const currentIds = new Set(currentStateVersionIds(capsules));
  if (currentIds.size === 0) return [];
  const byId = publicDeploymentMap(
    (await operations.listDeploymentsBySpace!(workspaceId)).filter(
      (deployment) => currentIds.has(deployment.id),
    ),
    workspaceId,
  );
  return currentDeploymentsInCapsuleOrder(capsules, byId);
}

async function listCurrentStateVersionsFromIdsRead(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicDeployment[]> {
  const currentIds = currentStateVersionIds(capsules);
  if (currentIds.length === 0) return [];
  const byId = publicDeploymentMap(
    await operations.listDeploymentsByIds!(currentIds),
    workspaceId,
  );
  return currentDeploymentsInCapsuleOrder(capsules, byId);
}

function currentStateVersionIds(
  capsules: readonly Capsule[],
): readonly string[] {
  return capsules
    .map(capsuleCurrentStateVersionId)
    .filter((id): id is string => id !== undefined && id.length > 0);
}

function capsuleCurrentStateVersionId(capsule: Capsule): string | undefined {
  return capsule.currentStateVersionId ?? capsule.currentDeploymentId;
}

function publicDeploymentMap(
  deployments: readonly Deployment[],
  workspaceId: string,
): ReadonlyMap<string, PublicDeployment> {
  return new Map(
    deployments
      .filter((deployment) => deploymentWorkspaceId(deployment) === workspaceId)
      .map((deployment) => [deployment.id, publicDeployment(deployment)]),
  );
}

function currentDeploymentsInCapsuleOrder(
  capsules: readonly Capsule[],
  deploymentsById: ReadonlyMap<string, PublicDeployment>,
): readonly PublicDeployment[] {
  return capsules
    .map((capsule) => {
      const id = capsuleCurrentStateVersionId(capsule);
      return id ? deploymentsById.get(id) : undefined;
    })
    .filter((row): row is PublicDeployment => row !== undefined);
}

async function listCurrentStateVersionsFromSingleReads(
  operations: ControlPlaneOperations,
  workspaceId: string,
  capsules: readonly Capsule[],
): Promise<readonly PublicDeployment[]> {
  const deployments = await Promise.all(
    capsules.map(async (capsule) => {
      const currentId = capsuleCurrentStateVersionId(capsule);
      if (!currentId) return undefined;
      try {
        const deployment = await operations.getDeployment(currentId);
        if (deploymentWorkspaceId(deployment) !== workspaceId) return undefined;
        return publicDeployment(deployment);
      } catch {
        return undefined;
      }
    }),
  );
  return deployments.filter(
    (row): row is PublicDeployment => row !== undefined,
  );
}

function deploymentWorkspaceId(deployment: Deployment): string | undefined {
  return (
    deployment.spaceId ??
    (deployment as { readonly workspaceId?: string }).workspaceId
  );
}

async function createCapsule(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  issuer: string | undefined,
  sessionSubject: string,
  workspaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const name = stringValue(body.name);
  const environment = stringValue(body.environment);
  const sourceId = stringValue(body.sourceId);
  const installConfigId = stringValue(body.installConfigId);
  const runnerProfileId =
    stringValue(body.runnerId) ?? stringValue(body.runnerProfileId);
  const outputAllowlist = outputAllowlistValue(body.outputAllowlist);
  const storeMetadata = installConfigStoreValue(body.store);
  const modulePath = modulePathValue(body.modulePath);
  if (body.modulePath !== undefined && modulePath === undefined) {
    return errorJson(
      "invalid_request",
      "modulePath must be a safe relative OpenTofu module path.",
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
  if (body.store !== undefined && storeMetadata === undefined) {
    return errorJson(
      "invalid_request",
      "store metadata must be omitted or copied from a valid TCS Store listing",
      400,
    );
  }
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
    await operations.installations.getInstallConfig(installConfigId);
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
  const hydratedRepoConfig = await hydrateRepoOwnedStoreConfig({
    source,
    storeMetadata,
    outputAllowlist,
    modulePath,
  });
  const resolvedStoreMetadata = hydratedRepoConfig.storeMetadata;
  const resolvedOutputAllowlist = hydratedRepoConfig.outputAllowlist;
  const resolvedModulePath = hydratedRepoConfig.modulePath;
  const storeDefaultVars = storeDefaultVariableMapping(
    resolvedStoreMetadata ?? baseConfig.store,
    {
      capsuleName: name,
      workspaceId,
    },
  );
  const hasStoreDefaultVars = Object.keys(storeDefaultVars).length > 0;
  const hasVars = vars !== undefined && Object.keys(vars).length > 0;
  if (
    hasVars ||
    hasStoreDefaultVars ||
    runnerProfileId ||
    resolvedOutputAllowlist !== undefined ||
    resolvedStoreMetadata !== undefined ||
    resolvedModulePath !== undefined
  ) {
    const now = new Date().toISOString();
    const { modulePath: _baseModulePath, ...baseConfigWithoutModulePath } =
      baseConfig;
    const configBase =
      resolvedModulePath === "" ? baseConfigWithoutModulePath : baseConfig;
    const config = await operations.installations.putInstallConfig({
      ...configBase,
      id: `icfg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId,
      name: `${name}-config`,
      internal: { reason: "per_install_overrides" },
      variableMapping: mergeVariableMappings(
        baseConfig.variableMapping,
        storeDefaultVars,
        vars ?? {},
      ),
      ...(resolvedStoreMetadata ? { store: resolvedStoreMetadata } : {}),
      ...(runnerProfileId ? { runnerId: runnerProfileId } : {}),
      ...(resolvedModulePath ? { modulePath: resolvedModulePath } : {}),
      outputAllowlist:
        resolvedOutputAllowlist ?? scopedCloneOutputAllowlist(baseConfig),
      createdAt: now,
      updatedAt: now,
    });
    resolvedInstallConfigId = config.id;
    resolvedInstallConfig = config;
  }
  const installation = await operations.installations.createCapsule({
    workspaceId,
    name,
    environment,
    sourceId,
    installConfigId: resolvedInstallConfigId,
  });
  if (resolvedInstallConfig && issuer) {
    await ensureTakosumiAccountsOidcForCapsule({
      operations,
      store,
      issuer,
      capsule: installation,
      installConfig: resolvedInstallConfig,
      sourceGitUrl: source.url,
    });
  }
  return jsonStatus({ capsule: publicCapsule(installation) }, 201);
}

interface RepoOwnedStoreHydrationInput {
  readonly source: Source;
  readonly storeMetadata: InstallConfig["store"] | undefined;
  readonly outputAllowlist: InstallConfig["outputAllowlist"] | undefined;
  readonly modulePath: string | undefined;
}

interface RepoOwnedStoreHydrationResult {
  readonly storeMetadata: InstallConfig["store"] | undefined;
  readonly outputAllowlist: InstallConfig["outputAllowlist"] | undefined;
  readonly modulePath: string | undefined;
}

async function hydrateRepoOwnedStoreConfig(
  input: RepoOwnedStoreHydrationInput,
): Promise<RepoOwnedStoreHydrationResult> {
  if (!input.storeMetadata?.source) return input;
  if (
    input.storeMetadata.inputs.length > 0 &&
    input.storeMetadata.installExperience &&
    input.outputAllowlist !== undefined
  ) {
    return input;
  }
  const metadata = await fetchRepoOwnedTcsMetadata({
    git: input.storeMetadata.source.git || input.source.url,
    ref: sourceDefaultRef(input.source),
  });
  if (!metadata) return input;

  const modulePath =
    input.modulePath ?? modulePathValue(metadata.modulePath) ?? undefined;
  const storePatch: Record<string, unknown> = {};
  if (input.storeMetadata.inputs.length === 0 && metadata.inputs !== undefined) {
    storePatch.inputs = metadata.inputs;
  }
  if (
    input.storeMetadata.installExperience === undefined &&
    metadata.installExperience !== undefined
  ) {
    storePatch.installExperience = metadata.installExperience;
  }
  if (modulePath !== undefined) {
    storePatch.source = {
      ...input.storeMetadata.source,
      path: modulePath === "" ? "." : modulePath,
    };
  }
  const mergedStore = installConfigStoreValue({
    ...input.storeMetadata,
    ...storePatch,
  });
  return {
    storeMetadata: mergedStore ?? input.storeMetadata,
    outputAllowlist:
      input.outputAllowlist ??
      repoOutputAllowlistValue(metadata.outputAllowlist),
    modulePath,
  };
}

function sourceDefaultRef(source: Source): string {
  return source.defaultRef?.trim() || "main";
}

async function fetchRepoOwnedTcsMetadata(input: {
  readonly git: string;
  readonly ref: string;
}): Promise<Record<string, unknown> | undefined> {
  const repo = githubRepoParts(input.git);
  if (!repo) return undefined;
  const ref = input.ref.trim() || "main";
  try {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${encodeURIComponent(ref)}/.well-known/tcs.json`,
      { headers: { accept: "application/json" } },
    );
    if (raw.status === 404) return undefined;
    if (raw.ok) return repoMetadataRecord(await raw.json());

    const api = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/.well-known%2Ftcs.json?ref=${encodeURIComponent(ref)}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (api.status === 404 || !api.ok) return undefined;
    const body = await api.json();
    if (!isPlainJsonObject(body) || typeof body.content !== "string") {
      return undefined;
    }
    const binary = atob(body.content.replace(/\s+/gu, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return repoMetadataRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

function githubRepoParts(
  git: string,
): { readonly owner: string; readonly repo: string } | undefined {
  try {
    const url = new URL(git);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const parts = url.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "")
      .split("/")
      .filter(Boolean);
    return parts.length >= 2 ? { owner: parts[0], repo: parts[1] } : undefined;
  } catch {
    return undefined;
  }
}

function repoMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const schemaVersion =
    typeof value.schemaVersion === "string" ? value.schemaVersion.trim() : "";
  if (schemaVersion && schemaVersion !== "tcs.repo/v1") return undefined;
  return value;
}

function repoOutputAllowlistValue(
  value: unknown,
): InstallConfig["outputAllowlist"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const item of value) {
    if (!isPlainJsonObject(item)) return undefined;
    const key = stringValue(item.key);
    if (!key) return undefined;
    record[key] = {
      from: item.from,
      type: item.type,
      ...(item.required !== undefined ? { required: item.required } : {}),
    };
  }
  return outputAllowlistValue(record);
}

function storeDefaultVariableMapping(
  store: InstallConfig["store"] | undefined,
  options: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): Readonly<Record<string, JsonValue>> {
  if (!store) return {};
  let out: Record<string, JsonValue> = {};
  for (const input of store.inputs) {
    if (input.secret === true) continue;
    const raw = input.defaultValue?.trim();
    if (!raw) continue;
    const value = storeDefaultInputValue(input, raw, store, options);
    if (value === undefined) continue;
    try {
      out = mergeVariableMappings(
        out,
        normalizeVariablePathRecord({ [input.name]: value }, "store.inputs"),
      ) as Record<string, JsonValue>;
    } catch {
      continue;
    }
  }
  return out;
}

function storeDefaultInputValue(
  input: InstallConfigStoreInput,
  raw: string,
  store: NonNullable<InstallConfig["store"]>,
  options: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): JsonValue | undefined {
  const value = symbolicStoreDefaultValue(raw, store, options);
  if (input.type === "boolean") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    return undefined;
  }
  if (input.type === "number") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (input.type === "json") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isJsonValue(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function symbolicStoreDefaultValue(
  value: string,
  store: NonNullable<InstallConfig["store"]>,
  options: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): string {
  if (value === "service-name") {
    return storeSlug(options.capsuleName || store.suggestedName);
  }
  if (value === "service-name-with-space") {
    const base = storeSlug(options.capsuleName || store.suggestedName);
    const suffix = workspaceSlugSuffix(options.workspaceId);
    return suffix ? `${base}-${suffix}` : base;
  }
  return value;
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
    .replace(/^(workspace|space)_/u, "")
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
  return baseConfig.sourceKind === "generic_capsule"
    ? defaultCapsuleOutputAllowlist()
    : baseConfig.outputAllowlist;
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

async function spaceGraph(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<Response> {
  const [installations, edges] = await Promise.all([
    operations.installations.listCapsules(workspaceId),
    operations.listDependenciesByWorkspace(workspaceId),
  ]);
  const nodes = installations.map((installation) => ({
    capsuleId: installation.id,
    name: installation.name,
    environment: installation.environment,
    status: installation.status,
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

async function spaceRuns(
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

async function spaceActivity(
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

async function uploadWorkspaceArchive(
  request: Request,
  url: URL,
  operations: ControlPlaneOperations,
  workspaceId: string,
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
    workspaceId,
    bytes,
    ...(path ? { path } : {}),
  });
  return jsonStatus({ snapshot }, 201);
}

async function createWorkspacePreparedSourceSnapshot(
  request: Request,
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorJson("invalid_argument", "invalid request", 400, request);
  }
  const sourceArchiveUrl = stringValue(body.url);
  const digest = stringValue(body.digest);
  const format = stringValue(body.format);
  if (!sourceArchiveUrl || !digest) {
    return errorJson(
      "invalid_argument",
      "url and digest are required",
      400,
      request,
    );
  }
  if (format !== undefined && format !== "tar.zst") {
    return errorJson(
      "invalid_argument",
      "format must be tar.zst",
      400,
      request,
    );
  }
  const path = stringValue(body.path);
  const sourceArchiveRequest: ArtifactSnapshotRequest = {
    url: sourceArchiveUrl,
    digest,
    ...(format ? { format } : {}),
    ...(path ? { path } : {}),
  };
  const snapshot = await operations.recordArtifactSnapshot({
    workspaceId,
    url: sourceArchiveRequest.url,
    digest: sourceArchiveRequest.digest,
    ...(sourceArchiveRequest.path ? { path: sourceArchiveRequest.path } : {}),
  });
  return jsonStatus({ snapshot }, 201);
}

async function spacePlanUpdate(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<Response> {
  return jsonStatus(
    await operations.runGroups.createWorkspaceUpdate(workspaceId),
    201,
  );
}
