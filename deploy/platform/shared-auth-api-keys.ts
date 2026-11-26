import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type { ControlPlaneOperations } from "../../accounts/service/src/control-operations.ts";
import {
  RequestBodyReadError,
  errorJson,
  methodNotAllowed,
  withPrivateNoStoreHeaders,
} from "../../accounts/service/src/http-helpers.ts";
import {
  type PatWorkspaceMembershipReader,
  createPersonalAccessTokenForVerifiedSubject,
  listPersonalAccessTokensForVerifiedSubject,
  personalAccessTokenScopeCatalogResponse,
  revokePersonalAccessTokenForVerifiedSubject,
} from "../../accounts/service/src/pat-routes.ts";
import { matchAccountTokenRevokeRoute } from "../../accounts/service/src/route-matchers.ts";
import type { AccountsStore } from "../../accounts/service/src/store.ts";
import type { SharedAuthIdentity } from "../../worker/src/shared_auth_rpc.ts";

type SharedAuthApiKeyRoute =
  | { readonly kind: "tokens" | "scopes" }
  | { readonly kind: "revoke"; readonly tokenId: string };

/** Only the browser management endpoints. PAT self-read endpoints use their own auth. */
export function matchSharedAuthApiKeyRoute(pathname: string): SharedAuthApiKeyRoute | undefined {
  if (pathname === TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH) return { kind: "tokens" };
  if (pathname === TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH) return { kind: "scopes" };
  const revoke = matchAccountTokenRevokeRoute(pathname);
  return revoke ? { kind: "revoke", tokenId: revoke.tokenId } : undefined;
}

interface SharedAuthApiKeyDependencies {
  readonly origin: string;
  readonly store: AccountsStore;
  /** The private RP must verify the browser session. */
  readonly authenticate: (request: Request) => Promise<SharedAuthIdentity | undefined>;
  readonly writeCsrfFailure: (request: Request) => Response | undefined;
  readonly creationLimiter: { consume(request: Request): Response | undefined };
  readonly membershipReader?: PatWorkspaceMembershipReader;
  readonly resolveOperations?: () => Promise<ControlPlaneOperations | undefined>;
}

function isAccountSubject(value: string): value is TakosumiSubject {
  return /^tsub_[A-Za-z0-9_-]+$/u.test(value);
}

/** Reuse Accounts management with the canonical RP principal in this process. */
export async function handleSharedAuthApiKeyRequest(
  request: Request,
  dependencies: SharedAuthApiKeyDependencies,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = matchSharedAuthApiKeyRoute(url.pathname);
  if (!route) return undefined;

  const fail = (code: string, message: string, status: number) =>
    withPrivateNoStoreHeaders(errorJson(code, message, status, request));
  if (url.origin !== dependencies.origin) return fail("not_found", "not found", 404);
  if ([...request.headers.keys()].some((name) =>
    name === "authorization" || name === "proxy-authorization" ||
    name === "x-takosumi-account-session" || name.startsWith("x-auth-") ||
    name.startsWith("x-takosumi-platform-")
  )) {
    return fail("unauthenticated", "This host accepts the shared account session only.", 401);
  }
  const { method } = request;
  const allowed = route.kind === "tokens" ? ["GET", "POST"]
    : route.kind === "scopes" ? ["GET"] : ["POST"];
  if (!allowed.includes(method)) {
    return withPrivateNoStoreHeaders(methodNotAllowed(allowed.join(", ")));
  }
  if (method === "POST") {
    const csrfFailure = dependencies.writeCsrfFailure(request);
    if (csrfFailure) return withPrivateNoStoreHeaders(csrfFailure);
    if (route.kind === "tokens") {
      const limited = dependencies.creationLimiter.consume(request);
      if (limited) return withPrivateNoStoreHeaders(limited);
    }
  }

  const { store } = dependencies;
  let subject: TakosumiSubject;
  try {
    const identity = await dependencies.authenticate(request);
    if (identity?.kind === "unavailable" ||
      !store.findCanonicalAccount || !store.isAccountAuthenticationFenced) {
      return fail("authentication_unavailable", "authentication unavailable", 503);
    }
    if (identity?.kind !== "authenticated" || !isAccountSubject(identity.accountId)) {
      return fail("unauthenticated", "sign in required", 401);
    }
    subject = identity.accountId;
    const [account, fenced] = await Promise.all([
      store.findCanonicalAccount(subject),
      store.isAccountAuthenticationFenced(subject),
    ]);
    if (account?.subject !== subject || fenced !== false) {
      return fail("unauthenticated", "sign in required", 401);
    }
  } catch {
    return fail("authentication_unavailable", "authentication unavailable", 503);
  }

  try {
    if (route.kind === "scopes") {
      return withPrivateNoStoreHeaders(personalAccessTokenScopeCatalogResponse());
    }
    if (route.kind === "revoke") {
      return withPrivateNoStoreHeaders(await revokePersonalAccessTokenForVerifiedSubject({
        tokenId: route.tokenId, store, subject,
      }));
    }
    if (method === "GET") {
      return withPrivateNoStoreHeaders(await listPersonalAccessTokensForVerifiedSubject({
        url, store, subject,
      }));
    }
    return withPrivateNoStoreHeaders(await createPersonalAccessTokenForVerifiedSubject({
      request,
      store,
      subject,
      membershipReader: dependencies.membershipReader,
      resolveOperations: dependencies.resolveOperations,
    }));
  } catch (error) {
    if (error instanceof RequestBodyReadError) {
      return fail(error.code, error.message, error.status);
    }
    throw error;
  }
}
