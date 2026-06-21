/**
 * Typed RPC client for the ACCOUNT-PLANE endpoints the dashboard still needs:
 * auth (upstream OAuth) and Stripe billing checkout/portal. The account-plane
 * `/v1/installation-projections` projection surface and legacy `/v1/connections`
 * group are gone from the SPA — Capsules and connections live entirely on
 * the session-authed control surface (`lib/control-api.ts`); session reads go
 * through `./session.ts` directly.
 *
 * Every method talks same-origin with the HttpOnly `takosumi_session` cookie
 * (`credentials: "include"`) via {@link apiFetch} (transport in ./http) and
 * uses contract-mirrored paths (./paths).
 */
import * as billing from "./billing.ts";
import * as auth from "./auth.ts";

export const rpc = {
  billing: {
    checkout: billing.startStripeCheckout,
    portal: billing.startStripePortal,
  },
  auth: {
    listProviders: auth.listAuthProviders,
    startUpstreamOAuth: auth.startUpstreamOAuth,
    completeUpstreamOAuth: auth.completeUpstreamOAuth,
    recallOAuthProvider: auth.recallOAuthProvider,
    recallOAuthReturnTo: auth.recallOAuthReturnTo,
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
  ProviderCredentialField,
  ProviderTokenHelper,
} from "./connections.ts";

export type { StripeCheckoutResult, StripePortalResult } from "./billing.ts";
export type { CallbackResult } from "./auth.ts";
