import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { clearAccountSessionCookie } from "./account-session.ts";
import { errorJson, json } from "./http-helpers.ts";
import { personalAccessTokenIsActive } from "./pat-routes.ts";
import type {
  AccountsBearerCredentialCandidates,
  AccountsStore,
  TakosumiAccountRecord,
} from "./store.ts";

export interface LoginEmailAllowlist {
  readonly emails: readonly string[];
  readonly requireVerifiedEmail?: boolean;
}

export interface LoginEmailIdentity {
  readonly email?: string;
  readonly emailVerified?: boolean;
}

const ALLOWED_CREDENTIAL_CACHE_TTL_MS = 5_000;
const MAX_ALLOWED_CREDENTIAL_CACHE_ENTRIES = 512;

const allowedCredentialCache = new Map<string, number>();
const pendingAllowlistChecks = new Map<string, Promise<Response | undefined>>();

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
      error_description: "This deployment limits preview access before launch.",
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
    "This deployment limits preview access before launch.",
    403,
    request,
    {
      "cache-control": "no-store",
      "set-cookie": clearAccountSessionCookie(secureCookie),
    },
  );
}

/**
 * 403 for a presented token credential (personal access token / OAuth access
 * token) whose owning account is no longer allowed. No `set-cookie` is emitted:
 * the caller authenticated with a token, and any browser cookie riding along on
 * the same request belongs to a different credential.
 */
export function credentialLoginNotAllowedResponse(request: Request): Response {
  return errorJson(
    "login_not_allowed",
    "This deployment limits preview access before launch.",
    403,
    request,
    { "cache-control": "no-store" },
  );
}

/**
 * Per-request deployment access gate. Rejects any presented account-plane
 * credential whose owning account is outside the deployment's login e-mail
 * allowlist.
 *
 * The presented value may be an account session id, a personal access token, or
 * an OAuth access token: `requireAccountsBearer` accepts all three for the
 * account/control plane, so all three must be gated. Prefixes are generation /
 * display formatting only, so the credential is resolved against every
 * account-plane credential store rather than routed by its spelling.
 *
 * When the deployment configures no allowlist this returns immediately and
 * costs no store round trip.
 */
export async function rejectDisallowedPresentedSession(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly credential: string | null;
  readonly allowlist?: LoginEmailAllowlist;
  readonly secureCookie: boolean;
}): Promise<Response | undefined> {
  if (!input.allowlist || !input.credential) return undefined;
  const credential = input.credential;
  const now = Date.now();
  const cachedUntil = allowedCredentialCache.get(credential);
  if (cachedUntil !== undefined && cachedUntil > now) return undefined;
  if (cachedUntil !== undefined) allowedCredentialCache.delete(credential);

  const pending = pendingAllowlistChecks.get(credential);
  if (pending) return await pending;

  const check = rejectDisallowedPresentedCredentialUncached(
    { ...input, credential, allowlist: input.allowlist },
    now,
  );
  pendingAllowlistChecks.set(credential, check);
  try {
    return await check;
  } finally {
    pendingAllowlistChecks.delete(credential);
  }
}

/** One live account-plane credential resolved from the presented value. */
interface PresentedCredential {
  readonly kind: "session" | "oauth-access-token" | "personal-access-token";
  readonly subject: TakosumiSubject;
  /** Owning account when the store resolved it alongside the credential. */
  readonly account?: TakosumiAccountRecord;
  /** Credential expiry, used to bound how long an allow decision is cached. */
  readonly expiresAt: number;
}

async function rejectDisallowedPresentedCredentialUncached(
  input: {
    readonly request: Request;
    readonly store: AccountsStore;
    readonly credential: string;
    readonly allowlist: LoginEmailAllowlist;
    readonly secureCookie: boolean;
  },
  now: number,
): Promise<Response | undefined> {
  const presented = await resolvePresentedCredentials(
    input.store,
    input.credential,
    now,
  );
  // Nothing live resolved (unknown, expired, or revoked value): leave the
  // answer to the route's own authentication, exactly as before.
  if (presented.length === 0) return undefined;

  let allowedUntil = now + ALLOWED_CREDENTIAL_CACHE_TTL_MS;
  let disallowedSession = false;
  let disallowed = false;
  for (const candidate of presented) {
    const account =
      candidate.account ?? (await input.store.findAccount(candidate.subject));
    if (account && loginEmailIsAllowed(account, input.allowlist)) {
      allowedUntil = Math.min(allowedUntil, candidate.expiresAt);
      continue;
    }
    disallowed = true;
    if (candidate.kind === "session") disallowedSession = true;
  }
  if (!disallowed) {
    rememberAllowedCredential(input.credential, allowedUntil);
    return undefined;
  }

  allowedCredentialCache.delete(input.credential);
  if (disallowedSession) {
    // Browser sessions keep their existing revocation behaviour: the session
    // record is deleted and the cookie cleared on the spot.
    await input.store.deleteAccountSession(input.credential);
    return accountLoginNotAllowedResponse(input.request, input.secureCookie);
  }
  // Token credentials are refused but left intact: re-adding the address to the
  // allowlist restores access without the operator re-issuing credentials.
  return credentialLoginNotAllowedResponse(input.request);
}

/**
 * Resolve the presented value against every account-plane credential store and
 * return the live candidates that carry deployment login authority.
 *
 * Capsule/Interface runtime access tokens are deliberately excluded: they are
 * audience-bound invocation authority that `requireAccountsBearer` already
 * refuses for the account plane, so this gate leaves them untouched.
 */
async function resolvePresentedCredentials(
  store: AccountsStore,
  credential: string,
  now: number,
): Promise<readonly PresentedCredential[]> {
  const resolved: AccountsBearerCredentialCandidates =
    store.resolveAccountsBearerCandidates
      ? await store.resolveAccountsBearerCandidates(credential)
      : await resolveCredentialCandidatesSeparately(store, credential);

  const presented: PresentedCredential[] = [];
  const session = resolved.session;
  if (session && session.expiresAt >= now) {
    presented.push({
      kind: "session",
      subject: session.subject,
      ...(resolved.sessionAccount ? { account: resolved.sessionAccount } : {}),
      expiresAt: session.expiresAt,
    });
  }
  const accessToken = resolved.accessToken;
  if (
    accessToken?.takosumiSubject &&
    accessToken.expiresAt > now &&
    accessToken.role !== "interface-runtime" &&
    accessToken.role !== "runtime"
  ) {
    presented.push({
      kind: "oauth-access-token",
      subject: accessToken.takosumiSubject,
      expiresAt: accessToken.expiresAt,
    });
  }
  const personalAccessToken = resolved.personalAccessToken;
  if (
    personalAccessToken &&
    personalAccessTokenIsActive(personalAccessToken, now)
  ) {
    presented.push({
      kind: "personal-access-token",
      subject: personalAccessToken.subject,
      expiresAt: personalAccessToken.expiresAt ?? Number.POSITIVE_INFINITY,
    });
  }
  return presented;
}

async function resolveCredentialCandidatesSeparately(
  store: AccountsStore,
  credential: string,
): Promise<AccountsBearerCredentialCandidates> {
  const [session, accessToken, personalAccessToken] = await Promise.all([
    store.findAccountSession(credential),
    store.findAccessToken(credential),
    store.findPersonalAccessToken(credential),
  ]);
  return {
    ...(session ? { session } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(personalAccessToken ? { personalAccessToken } : {}),
  };
}

function rememberAllowedCredential(
  credential: string,
  expiresAt: number,
): void {
  allowedCredentialCache.set(credential, expiresAt);
  if (allowedCredentialCache.size <= MAX_ALLOWED_CREDENTIAL_CACHE_ENTRIES) {
    return;
  }
  const oldest = allowedCredentialCache.keys().next().value;
  if (oldest) allowedCredentialCache.delete(oldest);
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
