import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsBearerRequiredScope,
  type AccountsBearerSubject,
  bearerWorkspaceAllows,
  requireAccountsBearer,
} from "./account-session.ts";
import {
  subjectCanAccessAccount,
  subjectCanAccessCapsule,
} from "./installation-routes.ts";
import type { AccountsStore } from "./store.ts";
import {
  errorJson,
  json,
  readJsonObject,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";

export async function requireAppCapsuleCreateWriteAccess(input: {
  request: Request;
  store: AccountsStore;
}): Promise<
  | Response
  | {
      readonly auth: AccountsBearerSubject;
      readonly accountId: string;
      readonly workspaceId: string;
    }
> {
  const body = await readJsonObject(input.request);
  if (!body) {
    return errorJson("invalid_request", "request body is required", 400);
  }
  const accountId = stringValue(body.accountId);
  const workspaceId =
    stringValue(body.workspaceId) ??
    stringValue(body.spaceId) ??
    stringValue(body.space_id);
  const createdBySubject = takosumiSubjectValue(body.createdBySubject);
  if (!workspaceId) {
    return errorJson(
      "missing_field",
      "workspaceId is required to authorize Capsule create",
      400,
    );
  }
  return await requireAccountCreateWriteAccess({
    request: input.request,
    store: input.store,
    accountId,
    workspaceId,
    createdBySubject,
  });
}

export async function requireCapsulePlanRunWriteAccess(input: {
  request: Request;
  store: AccountsStore;
}): Promise<Response | undefined> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "write",
  });
  if (!bearer.ok) return bearer.response;
  const body = await readJsonObject(input.request.clone());
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const workspaceId =
    stringValue(body.workspaceId) ??
    stringValue(body.space_id) ??
    stringValue(body.space);
  if (!workspaceId) {
    return errorJson("invalid_request", "workspaceId is required", 400);
  }
  if (!bearerWorkspaceAllows(bearer.auth, workspaceId)) {
    return errorJson("space_not_found", "space not found", 404);
  }
  const space = await input.store.findWorkspace(workspaceId);
  // A not-yet-created space is allowed for any write-scoped subject: this is the
  // New-user external prefill case: open `/install?git=...`, sign in, land on
  // `/new` with a Git source summary, then explicitly request compatibility /
  // planning. The space may be created later at install time with this workspaceId. A
  // PlanRun is a read-only OpenTofu dry-run of the git module, and ownership is
  // enforced at install create. An EXISTING space owned by someone else is
  // still rejected so a subject cannot plan against another account's space.
  if (
    space &&
    !(await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      space.accountId,
    ))
  ) {
    return errorJson("space_not_found", "space not found", 404);
  }
  return undefined;
}

export async function requireAppCapsuleAccountAccess(input: {
  request: Request;
  store: AccountsStore;
  capsuleId: string;
  scope: AccountsBearerRequiredScope;
}): Promise<Response | undefined> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: input.scope,
  });
  if (!bearer.ok) return bearer.response;
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (!bearerWorkspaceAllows(bearer.auth, installation.workspaceId)) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  if (
    !(await subjectCanAccessCapsule(
      input.store,
      bearer.auth.subject,
      installation,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  return undefined;
}

async function requireAccountCreateWriteAccess(input: {
  request: Request;
  store: AccountsStore;
  accountId?: string;
  workspaceId: string;
  createdBySubject?: TakosumiSubject;
}): Promise<
  | Response
  | {
      readonly auth: AccountsBearerSubject;
      readonly accountId: string;
      readonly workspaceId: string;
    }
> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "write",
  });
  if (!bearer.ok) return bearer.response;
  if (
    input.createdBySubject &&
    bearer.auth.subject !== input.createdBySubject
  ) {
    // Body's createdBySubject must match the authenticated session.
    // We respond with `account_not_found` (rather than the stricter 403) to
    // preserve the existing non-disclosure shape; combined with the upstream
    // session enforcement, mismatched callers cannot proceed regardless.
    return errorJson("account_not_found", "account not found", 404);
  }
  if (!bearerWorkspaceAllows(bearer.auth, input.workspaceId)) {
    return errorJson("account_not_found", "account not found", 404);
  }
  const workspace = await input.store.findWorkspace(input.workspaceId);
  if (workspace && input.accountId && workspace.accountId !== input.accountId) {
    return errorJson("account_not_found", "account not found", 404);
  }
  const accountId = workspace?.accountId ?? input.accountId;
  if (!accountId) {
    return errorJson("account_not_found", "account not found", 404);
  }
  const account = await input.store.findLedgerAccount(accountId);
  if (
    account &&
    !(await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      account.accountId,
    ))
  ) {
    return errorJson("account_not_found", "account not found", 404);
  }
  return {
    auth: bearer.auth,
    accountId,
    workspaceId: input.workspaceId,
  };
}
