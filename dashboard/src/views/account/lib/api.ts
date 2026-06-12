/**
 * Typed RPC client for the ACCOUNT-PLANE endpoints the dashboard still needs:
 * session, auth (upstream OAuth / passkey), Stripe billing checkout/portal,
 * and personal access tokens. The legacy `/v1/app-installations` plane and the
 * legacy `/v1/connections` group are gone — apps and connections live entirely
 * on the session-authed control surface (`lib/control-api.ts`).
 *
 * Every method talks same-origin with the HttpOnly `takosumi_session` cookie
 * (`credentials: "include"`) via {@link apiFetch} (transport in ./http) and
 * uses contract-mirrored paths (./paths).
 */
import { clearSession, refreshSession } from "./session.ts";
import * as tokens from "./tokens.ts";
import * as billing from "./billing.ts";
import * as auth from "./auth.ts";

export const rpc = {
  session: {
    /** Refresh + return the current session (null when unauthenticated). */
    me: refreshSession,
    /** Clear the local cache and ask the server to revoke the cookie. */
    signOut: clearSession,
  },
  tokens: {
    list: tokens.listTokens,
    create: tokens.createToken,
    revoke: tokens.revokeToken,
  },
  billing: {
    checkout: billing.startStripeCheckout,
    portal: billing.startStripePortal,
  },
  auth: {
    listProviders: auth.listAuthProviders,
    startUpstreamOAuth: auth.startUpstreamOAuth,
    completeUpstreamOAuth: auth.completeUpstreamOAuth,
    recallOAuthProvider: auth.recallOAuthProvider,
    requestPasskeyRegisterOptions: auth.requestPasskeyRegisterOptions,
    completePasskeyRegistration: auth.completePasskeyRegistration,
  },
} as const;

export { ApiError } from "./http.ts";

// Provider presentation descriptors (guided token flows / field catalogs) for
// the connections tab. Pure client-side presentation data — the connection
// CRUD itself goes through lib/control-api.ts.
export {
  CLOUDFLARE_CREATE_TOKEN_URL,
  PROVIDERS,
  providerDescriptor,
} from "./connections.ts";
export type {
  ProviderDescriptor,
  ProviderEnvField,
  ProviderTokenHelper,
} from "./connections.ts";

export type {
  CreateTokenInput,
  CreateTokenResult,
  PersonalAccessToken,
} from "./tokens.ts";
export type { StripeCheckoutResult, StripePortalResult } from "./billing.ts";
export type { CallbackResult, PasskeyRegisterOptions } from "./auth.ts";
