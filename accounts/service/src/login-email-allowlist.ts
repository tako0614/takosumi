import { clearAccountSessionCookie } from "./account-session.ts";
import { errorJson, json } from "./http-helpers.ts";
import type { AccountsStore, TakosumiAccountRecord } from "./store.ts";

export interface LoginEmailAllowlist {
  readonly emails: readonly string[];
  readonly requireVerifiedEmail?: boolean;
}

export interface LoginEmailIdentity {
  readonly email?: string;
  readonly emailVerified?: boolean;
}

export function normalizeLoginEmail(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)
    ? normalized
    : undefined;
}

export function loginEmailIsAllowed(
  identity: LoginEmailIdentity,
  allowlist: LoginEmailAllowlist | undefined,
): boolean {
  if (!allowlist || allowlist.emails.length === 0) return true;
  if (
    allowlist.requireVerifiedEmail !== false &&
    identity.emailVerified !== true
  ) {
    return false;
  }
  const email = normalizeLoginEmail(identity.email);
  if (!email) return false;
  return allowlist.emails
    .map((entry) => normalizeLoginEmail(entry))
    .filter((entry): entry is string => entry !== undefined)
    .includes(email);
}

export function upstreamLoginNotAllowedResponse(
  secureCookie: boolean,
): Response {
  return json(
    {
      error: "access_denied",
      error_description: "Takosumi Cloud preview access is limited before GA.",
    },
    403,
    {
      "cache-control": "no-store",
      "set-cookie": clearAccountSessionCookie(secureCookie),
    },
  );
}

export function accountLoginNotAllowedResponse(
  request: Request,
  secureCookie: boolean,
): Response {
  return errorJson(
    "login_not_allowed",
    "Takosumi Cloud preview access is limited before GA.",
    403,
    request,
    {
      "cache-control": "no-store",
      "set-cookie": clearAccountSessionCookie(secureCookie),
    },
  );
}

export async function rejectDisallowedPresentedSession(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly sessionId: string | null;
  readonly allowlist?: LoginEmailAllowlist;
  readonly secureCookie: boolean;
}): Promise<Response | undefined> {
  if (!input.allowlist || !input.sessionId?.startsWith("sess_")) {
    return undefined;
  }
  const session = await input.store.findAccountSession(input.sessionId);
  if (!session || session.expiresAt < Date.now()) return undefined;
  const account = await input.store.findAccount(session.subject);
  if (account && loginEmailIsAllowed(account, input.allowlist)) {
    return undefined;
  }
  await input.store.deleteAccountSession(input.sessionId);
  return accountLoginNotAllowedResponse(input.request, input.secureCookie);
}

export function accountMatchesLoginAllowlist(
  account: TakosumiAccountRecord,
  allowlist: LoginEmailAllowlist | undefined,
): boolean {
  return loginEmailIsAllowed(
    { email: account.email, emailVerified: account.emailVerified },
    allowlist,
  );
}
