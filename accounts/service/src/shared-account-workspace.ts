/**
 * Shared hosted account -> canonical Workspace directory. This is a projection
 * of the existing Control authority, not another directory or billing ledger.
 * HTTP callers present an Accounts session; ID-token role/Org claims confer
 * no Workspace authority. Product compositions supply the billing owner's
 * immutable, idempotent Workspace-to-Organization resolver explicitly.
 */
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { Workspace, WorkspaceMember, WorkspaceRole, WorkspaceType } from "takosumi-contract/workspaces";
import { WORKSPACE_HANDLE_PATTERN } from "takosumi-contract/workspaces";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";
import { requireAccountSession } from "./account-session.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import { ensurePersonalWorkspaceForAccount } from "./control-personal-workspace.ts";
import { errorJson, json, methodNotAllowed, readJsonObject, RequestBodyReadError, withPrivateNoStoreHeaders } from "./http-helpers.ts";
import type { AccountsStore, TakosumiAccountRecord } from "./store.ts";

export const SHARED_ACCOUNT_WORKSPACES_PATH = "/api/v1/account/shared-workspaces";

export interface SharedAccountsSessionContext {
  readonly subject: TakosumiSubject;
  readonly sessionId?: string;
}

/**
 * Constructed only by the trusted RP gateway after its local session and
 * issuer grant verification. The callback checks the same authenticated grant
 * again after awaited owner handshakes. No public route deserializes this
 * context, accepts a subject header, or forwards an issuer browser cookie.
 */
export interface SharedHostedSessionContext {
  readonly kind: "shared-hosted-session";
  readonly canonicalAccountId: TakosumiSubject;
  readonly activeWorkspaceId?: string;
  readonly assertCurrentGrant: () => Promise<boolean>;
}

export type SharedAccountWorkspaceSession = SharedAccountsSessionContext | SharedHostedSessionContext;

/**
 * Optional protocol-owned transport authentication. A composition may expose
 * the directory to a registered RP's dedicated account-directory token, after
 * verifying its client/profile/current grant. This hook is never populated
 * from request fields, and its context remains local to the Accounts handler.
 */
export type SharedAccountWorkspaceAuthenticator = (request: Request) => Promise<
  | { readonly ok: true; readonly session: SharedAccountWorkspaceSession }
  | { readonly ok: false; readonly response: Response }
>;

export interface SharedAccountWorkspaceChoice {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  /** Current common membership, never a cached token role. */
  readonly roles: readonly WorkspaceRole[];
  readonly owner: boolean;
}

export interface SharedAccountWorkspaceMenu {
  readonly accountId: TakosumiSubject;
  /** Present when an accessible owned personal Workspace is in this page. */
  readonly personalWorkspaceId?: string;
  readonly activeWorkspace?: SharedAccountWorkspaceChoice;
  readonly choices: readonly SharedAccountWorkspaceChoice[];
  readonly nextCursor?: string;
}

export interface SharedWorkspaceBillingOrganization {
  readonly workspaceId: string;
  /** Existing immutable owner reference; unrelated to issuer/subject naming. */
  readonly workspaceRef: string;
  readonly organizationId: string;
  // This binding identifies retained money/resource references. It does not
  // grant wallet reads, subscription changes, top-ups, or payment consent.
}

/**
 * Trusted composition port. The owner creates or returns a binding once for
 * the exact Workspace UID and refuses reassignments. A pending/unreviewed
 * binding returns null. This port never accepts a caller-selected Org/ref.
 */
export type SharedWorkspaceBillingResolver = (input: {
  readonly workspaceId: string;
  /** Server-derived current canonical account, never a caller-selected field. */
  readonly canonicalAccountId: TakosumiSubject;
  /** Local callback only; never serialized into billing-owner requests. */
  readonly assertCurrentGrant: () => Promise<boolean>;
}) => Promise<SharedWorkspaceBillingOrganization | null>;

export interface SharedAccountWorkspaceDirectory {
  bootstrap(session: SharedAccountWorkspaceSession): Promise<Workspace>;
  menu(session: SharedAccountWorkspaceSession, input?: {
    readonly selectedWorkspaceId?: string;
    readonly after?: string;
    readonly limit?: number;
  }): Promise<SharedAccountWorkspaceMenu>;
  choose(session: SharedAccountWorkspaceSession, workspaceId: string): Promise<SharedAccountWorkspaceChoice>;
  create(session: SharedAccountWorkspaceSession, input: {
    readonly handle: string;
    readonly displayName: string;
    readonly type: "organization";
  }): Promise<SharedAccountWorkspaceChoice>;
  billingOrganization(session: SharedAccountWorkspaceSession, workspaceId: string): Promise<SharedWorkspaceBillingOrganization>;
}

export interface SharedAccountWorkspaceDependencies {
  readonly store: AccountsStore;
  readonly operations: Pick<ControlPlaneOperations, "workspaces" | "members">;
  readonly resolveWorkspaceBilling?: SharedWorkspaceBillingResolver;
}

export class SharedAccountWorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

export function createSharedAccountWorkspaceDirectory(deps: SharedAccountWorkspaceDependencies): SharedAccountWorkspaceDirectory {
  const rejectSession = (): never => {
    throw new SharedAccountWorkspaceError("invalid_session", "A current canonical account session is required.", 401);
  };
  const canonicalAccount = async (session: SharedAccountWorkspaceSession): Promise<TakosumiAccountRecord> => {
    if (!deps.store.findCanonicalAccount || !deps.store.isAccountAuthenticationFenced) {
      throw new SharedAccountWorkspaceError("capability_unavailable", "Shared account authority is unavailable.", 503);
    }
    const hosted = "canonicalAccountId" in session;
    const subject = hosted ? session.canonicalAccountId : session.subject;
    if (hosted && !(await session.assertCurrentGrant())) rejectSession();
    if (!hosted && session.sessionId) {
      const record = await deps.store.findAccountSession(session.sessionId);
      if (!record || record.subject !== subject || record.expiresAt <= Date.now() ||
        (record.policy === "hosted" && (!record.absoluteExpiresAt || record.absoluteExpiresAt <= Date.now()))) rejectSession();
    }
    const account = await deps.store.findCanonicalAccount(subject);
    // Old alias sessions must reauthenticate after a merge; redirecting their
    // subject here would silently create new authority under a stale session.
    if (!account || account.subject !== subject) {
      throw new SharedAccountWorkspaceError("invalid_session", "A current canonical account session is required.", 401);
    }
    if (await deps.store.isAccountAuthenticationFenced(subject)) rejectSession();
    return account;
  };
  const liveMember = async (accountId: string, workspaceId: string): Promise<WorkspaceMember | undefined> => {
    const member = deps.operations.members.getMember
      ? await deps.operations.members.getMember(workspaceId, accountId)
      : (await deps.operations.members.listMembers(workspaceId)).find((row) => row.accountId === accountId);
    return member?.workspaceId === workspaceId && member.accountId === accountId &&
      member.status === "active" && member.roles.some(validRole) ? member : undefined;
  };
  const choice = (workspace: Workspace, member: WorkspaceMember): SharedAccountWorkspaceChoice => ({
    id: workspace.id, handle: workspace.handle, displayName: workspace.displayName,
    type: workspace.type, roles: member.roles.filter(validRole), owner: member.roles.includes("owner"),
  });
  const authorized = async (accountId: string, workspaceId: string): Promise<SharedAccountWorkspaceChoice> => {
    if (!workspaceId || workspaceId.length > 256) throw new SharedAccountWorkspaceError("invalid_request", "Workspace id is invalid.", 400);
    const workspace = await deps.operations.workspaces.getWorkspaceForAccount(accountId, workspaceId);
    const member = workspace?.id === workspaceId ? await liveMember(accountId, workspaceId) : undefined;
    if (!workspace || !member) throw new SharedAccountWorkspaceError("forbidden", "Current Workspace membership is required.", 403);
    return choice(workspace, member);
  };
  const directory: SharedAccountWorkspaceDirectory = {
    async bootstrap(session) {
      const account = await canonicalAccount(session);
      if (!deps.operations.workspaces.ensurePersonalWorkspaceForSharedAccount) {
        throw new SharedAccountWorkspaceError("capability_unavailable", "Personal Workspace bootstrap is unavailable.", 503);
      }
      const workspace = await ensurePersonalWorkspaceForAccount({ account, operations: deps.operations }).catch((error: unknown) => {
        if (error instanceof OpenTofuControllerError && error.code === "permission_denied") {
          throw new SharedAccountWorkspaceError("forbidden", "Current personal Workspace owner membership is required.", 403);
        }
        throw error;
      });
      await canonicalAccount(session);
      await authorized(account.subject, workspace.id);
      return workspace;
    },
    async menu(session, input = {}) {
      const account = await canonicalAccount(session);
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (input.after !== undefined && (!input.after || input.after.length > 4096))) {
        throw new SharedAccountWorkspaceError("invalid_request", "Directory page is invalid.", 400);
      }
      const page = await deps.operations.workspaces.listWorkspacesForAccountPage(account.subject, {
        limit, ...(input.after ? { cursor: input.after } : {}), includeArchived: false, order: "created_asc",
      });
      // The owner query already narrows by membership. Recheck exact rows to
      // avoid returning roles or choices revoked during page preparation.
      const choices: SharedAccountWorkspaceChoice[] = [];
      for (const workspace of page.items) {
        if (workspace.archivedAt || choices.some((row) => row.id === workspace.id)) continue;
        const member = await liveMember(account.subject, workspace.id);
        if (member) choices.push(choice(workspace, member));
      }
      let selected: SharedAccountWorkspaceChoice | undefined;
      const selectedWorkspaceId = input.selectedWorkspaceId ?? ("canonicalAccountId" in session ? session.activeWorkspaceId : undefined);
      if (selectedWorkspaceId) {
        selected = await authorized(account.subject, selectedWorkspaceId);
        if (!choices.some((row) => row.id === selected!.id)) choices.unshift(selected);
      }
      // Retained source-account personal Workspaces may be accessible with a
      // reviewed owner role after merge. They remain additional Workspaces,
      // not this canonical account's personal bootstrap fallback.
      const ownedPersonalIds = new Set(page.items.filter((row) =>
        row.type === "personal" && row.ownerUserId === account.subject,
      ).map((row) => row.id));
      const personal = choices.find((row) => row.type === "personal" && row.owner && ownedPersonalIds.has(row.id));
      await canonicalAccount(session);
      return {
        accountId: account.subject,
        ...(personal ? { personalWorkspaceId: personal.id } : {}),
        ...(selected ?? personal ?? choices[0] ? { activeWorkspace: selected ?? personal ?? choices[0] } : {}),
        choices, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    async choose(session, workspaceId) {
      const account = await canonicalAccount(session);
      const selected = await authorized(account.subject, workspaceId);
      await canonicalAccount(session);
      return selected;
    },
    async create(session, input) {
      const account = await canonicalAccount(session);
      // Personal is the durable singleton bootstrap. Explicit creation creates
      // additional purpose/team Workspaces, never another personal namespace.
      if (input.type !== "organization" || !WORKSPACE_HANDLE_PATTERN.test(input.handle) ||
        !input.displayName?.trim() || input.displayName.length > 256) {
        throw new SharedAccountWorkspaceError("invalid_request", "A valid organization Workspace is required.", 400);
      }
      const create = deps.operations.workspaces.createWorkspaceForSharedAccount;
      if (!create) throw new SharedAccountWorkspaceError("capability_unavailable", "Strict Workspace creation is unavailable.", 503);
      const workspace = await create.call(deps.operations.workspaces, {
        handle: input.handle, displayName: input.displayName, type: "organization", ownerUserId: account.subject,
      }).catch((error: unknown) => {
        if (error instanceof OpenTofuControllerError && error.code === "permission_denied") {
          throw new SharedAccountWorkspaceError("forbidden", "Current owner membership is required.", 403);
        }
        throw error;
      });
      await canonicalAccount(session);
      return await authorized(account.subject, workspace.id);
    },
    async billingOrganization(session, workspaceId) {
      const account = await canonicalAccount(session);
      await authorized(account.subject, workspaceId);
      if (!deps.resolveWorkspaceBilling) {
        throw new SharedAccountWorkspaceError("capability_unavailable", "Workspace billing resolver is unavailable.", 503);
      }
      const binding = await deps.resolveWorkspaceBilling({
        workspaceId, canonicalAccountId: account.subject,
        assertCurrentGrant: async () => {
          try { await canonicalAccount(session); return true; }
          catch { return false; }
        },
      });
      if (!binding || binding.workspaceId !== workspaceId ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(binding.workspaceRef) ||
        typeof binding.organizationId !== "string" || !binding.organizationId || binding.organizationId.length > 256) {
        throw new SharedAccountWorkspaceError("binding_unavailable", "Workspace billing binding is unavailable.", 503);
      }
      // A resolver can await an owner handshake. No authorization result from
      // before that wait survives a concurrent membership revocation or merge.
      await canonicalAccount(session);
      await authorized(account.subject, workspaceId);
      return { workspaceId, workspaceRef: binding.workspaceRef, organizationId: binding.organizationId };
    },
  };
  return directory;
}

function validRole(role: string): role is WorkspaceRole {
  return role === "owner" || role === "admin" || role === "member" || role === "viewer";
}

export function isSharedAccountWorkspaceRoute(pathname: string): boolean {
  return pathname === SHARED_ACCOUNT_WORKSPACES_PATH || pathname.startsWith(`${SHARED_ACCOUNT_WORKSPACES_PATH}/`);
}

export async function handleSharedAccountWorkspaceRoute(input: {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
  readonly directory?: SharedAccountWorkspaceDirectory;
  readonly authenticate?: SharedAccountWorkspaceAuthenticator;
}): Promise<Response | undefined> {
  if (!isSharedAccountWorkspaceRoute(input.url.pathname)) return undefined;
  const respond = (response: Response) => withPrivateNoStoreHeaders(response);
  const auth = input.authenticate
    ? await input.authenticate(input.request)
    : await (async () => {
      const result = await requireAccountSession({ request: input.request, store: input.store });
      return result.ok ? { ok: true as const, session: { subject: result.subject, sessionId: result.sessionId } } : result;
    })();
  if (!auth.ok) return respond(auth.response);
  if (!input.directory) return respond(errorJson("capability_unavailable", "Shared Workspace authority is unavailable.", 503, input.request));
  const session = auth.session;
  const method = input.request.method.toUpperCase();
  if (method === "POST" && !("canonicalAccountId" in session) && input.request.headers.get("origin") !== input.url.origin) {
    return respond(errorJson("csrf_failed", "Origin must exactly match Accounts.", 403, input.request));
  }
  const tail = input.url.pathname.slice(SHARED_ACCOUNT_WORKSPACES_PATH.length);
  try {
    if (tail === "") {
      if (method === "GET") {
        const rawLimit = input.url.searchParams.get("limit");
        return respond(json(await input.directory.menu(session, {
          ...(input.url.searchParams.has("selectedWorkspaceId") ? { selectedWorkspaceId: input.url.searchParams.get("selectedWorkspaceId")! } : {}),
          ...(input.url.searchParams.has("after") ? { after: input.url.searchParams.get("after")! } : {}),
          ...(rawLimit === null ? {} : { limit: /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN }),
        })));
      }
      if (method === "POST") {
        const body = await readJsonObject(input.request);
        if (!body || Object.keys(body).some((key) => !["handle", "displayName", "type"].includes(key)) ||
          typeof body.handle !== "string" || typeof body.displayName !== "string" || body.type !== "organization") {
          throw new SharedAccountWorkspaceError("invalid_request", "Body must contain handle, displayName and organization type only.", 400);
        }
        return respond(json({ workspace: await input.directory.create(session, { handle: body.handle, displayName: body.displayName, type: "organization" }) }, 201));
      }
      return respond(methodNotAllowed("GET, POST"));
    }
    if (tail === "/bootstrap") {
      if (method !== "POST") return respond(methodNotAllowed("POST"));
      const body = await readJsonObject(input.request);
      if (!body || Object.keys(body).length) throw new SharedAccountWorkspaceError("invalid_request", "Body must be an empty object.", 400);
      return respond(json({ workspace: await input.directory.bootstrap(session) }));
    }
    const match = /^\/([^/]+)\/(select|billing-organization)$/.exec(tail);
    if (match) {
      let workspaceId: string;
      try { workspaceId = decodeURIComponent(match[1]!); }
      catch { throw new SharedAccountWorkspaceError("invalid_request", "Workspace id is invalid.", 400); }
      if (match[2] === "select") {
        if (method !== "POST") return respond(methodNotAllowed("POST"));
        const body = await readJsonObject(input.request);
        if (!body || Object.keys(body).length) throw new SharedAccountWorkspaceError("invalid_request", "Body must be an empty object.", 400);
        return respond(json({ workspace: await input.directory.choose(session, workspaceId) }));
      }
      if (method !== "GET") return respond(methodNotAllowed("GET"));
      if ([...input.url.searchParams.keys()].length) throw new SharedAccountWorkspaceError("invalid_request", "Billing resolution accepts only a Workspace id.", 400);
      return respond(json(await input.directory.billingOrganization(session, workspaceId)));
    }
    return respond(errorJson("not_found", "not found", 404, input.request));
  } catch (error) {
    if (error instanceof SharedAccountWorkspaceError || error instanceof RequestBodyReadError) return respond(errorJson(error.code, error.message, error.status, input.request));
    // Owner storage failures do not expose private diagnostics or identities.
    return respond(errorJson("authority_unavailable", "Shared Workspace authority is unavailable.", 503, input.request));
  }
}
