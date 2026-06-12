import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsBearerRequiredScope,
  requireAccountsBearer,
} from "./account-session.ts";
import {
  subjectCanAccessAccount,
  subjectCanAccessInstallation,
} from "./installation-routes.ts";
import type { AccountsStore } from "./store.ts";
import { requireSameSpaceWorkloadControlForInstallation } from "./workload-service-tokens.ts";
import {
  errorJson,
  json,
  readJsonObject,
  stringValue,
 takosumiSubjectValue,
} from "./http-helpers.ts";

export async function requireAppInstallationCreateWriteAccess(input: {
  request: Request;
  store: AccountsStore;
}): Promise<Response | undefined> {
  const body = await readJsonObject(input.request);
  if (!body) {
    return errorJson("invalid_request", "request body is required", 400);
  }
  const accountId = stringValue(body.accountId);
  const createdBySubject = takosumiSubjectValue(body.createdBySubject);
  // Previously this returned `undefined` (auth skipped) when the body lacked
  // accountId / createdBySubject, which let unauthenticated callers bypass the
  // ownership check by simply omitting those fields. Always require an
  // authenticated session and require the body to declare both fields so the
  // session subject can be matched against them.
  if (!accountId || !createdBySubject) {
    return errorJson("missing_field", "accountId and createdBySubject are required to authorize installation create", 400);
  }
  return await requireAccountCreateWriteAccess({
    request: input.request,
    store: input.store,
    accountId,
    createdBySubject,
  });
}

export async function requireInstallationPlanRunWriteAccess(input: {
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
  const spaceId = stringValue(body.spaceId) ??
    stringValue(body.space_id) ??
    stringValue(body.space);
  if (!spaceId) {
    return errorJson("invalid_request", "spaceId is required", 400);
  }
  const space = await input.store.findSpace(spaceId);
  // A not-yet-created space is allowed for any write-scoped subject: this is the
  // new-user one-click install case (open /install?git=... -> sign in -> plan),
  // where the space is created later at install time with this spaceId. A
  // PlanRun is a read-only OpenTofu dry-run of the git module, and ownership is
  // enforced at install create. An EXISTING space owned by someone else is
  // still rejected so a subject cannot plan against another account's space.
  if (
    space &&
    !await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      space.accountId,
    )
  ) {
    return errorJson("space_not_found", "space not found", 404);
  }
  return undefined;
}

export async function requireAppInstallationImportWriteAccess(input: {
  request: Request;
  store: AccountsStore;
}): Promise<Response | undefined> {
  const body = await readJsonObject(input.request);
  if (!body) {
    return errorJson("invalid_request", "request body is required", 400);
  }
  const accountId = stringValue(body.targetAccountId) ??
    stringValue(body.accountId);
  const createdBySubject = takosumiSubjectValue(
    body.createdBySubject ?? body.subject,
  );
  // Previously this returned `undefined` (auth skipped) when the body lacked
  // targetAccountId / createdBySubject, which let unauthenticated callers
  // bypass the ownership check by omitting those fields. Always require an
  // authenticated session and require the body to declare both fields so the
  // session subject can be matched against them. This mirrors the
  // `requireAppInstallationCreateWriteAccess` shape exactly.
  if (!accountId || !createdBySubject) {
    return errorJson("missing_field", "targetAccountId (or accountId) and createdBySubject (or subject) are required to authorize installation import", 400);
  }
  return await requireAccountCreateWriteAccess({
    request: input.request,
    store: input.store,
    accountId,
    createdBySubject,
  });
}

export async function requireAppInstallationAccountAccess(input: {
  request: Request;
  store: AccountsStore;
  installationId: string;
  scope: AccountsBearerRequiredScope;
}): Promise<Response | undefined> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: input.scope,
  });
  if (!bearer.ok) return bearer.response;
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);
  if (
    !await subjectCanAccessInstallation(
      input.store,
      bearer.auth.subject,
      installation,
    )
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  return undefined;
}

export async function requireAppInstallationAccountOrWorkloadControlAccess(
  input: {
    request: Request;
    store: AccountsStore;
    installationId: string;
    scope: AccountsBearerRequiredScope;
  },
): Promise<Response | undefined> {
  const accountBlocked = await requireAppInstallationAccountAccess(input);
  if (!accountBlocked) return undefined;
  const workloadControl = await requireSameSpaceWorkloadControlForInstallation({
    request: input.request,
    store: input.store,
    targetInstallationId: input.installationId,
  });
  if (workloadControl.ok) return undefined;
  return preferredCompositeAuthResponse(accountBlocked, workloadControl.response);
}

async function requireAccountCreateWriteAccess(input: {
  request: Request;
  store: AccountsStore;
  accountId: string;
  createdBySubject: TakosumiSubject;
}): Promise<Response | undefined> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "write",
  });
  if (!bearer.ok) return bearer.response;
  if (bearer.auth.subject !== input.createdBySubject) {
    // Body's createdBySubject must match the authenticated session.
    // We respond with `account_not_found` (rather than the stricter 403) to
    // preserve the existing non-disclosure shape; combined with the upstream
    // session enforcement, mismatched callers cannot proceed regardless.
    return errorJson("account_not_found", "account not found", 404);
  }
  const account = await input.store.findLedgerAccount(input.accountId);
  if (
    account &&
    !await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      account.accountId,
    )
  ) {
    return errorJson("account_not_found", "account not found", 404);
  }
  return undefined;
}

function preferredCompositeAuthResponse(
  accountResponse: Response,
  workloadResponse: Response,
): Response {
  if (accountResponse.status === 401 && workloadResponse.status !== 401) {
    return workloadResponse;
  }
  return accountResponse;
}
