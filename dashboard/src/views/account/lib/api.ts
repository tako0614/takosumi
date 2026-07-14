/**
 * Typed RPC client for the ACCOUNT-PLANE endpoints the dashboard still needs:
 * auth (upstream OAuth). Capsules and connections live entirely on
 * the session-authed control surface (`lib/control-api.ts`); session reads go
 * through `./session.ts` directly.
 *
 * Every method talks same-origin with the HttpOnly `takosumi_session` cookie
 * (`credentials: "include"`) via {@link apiFetch} (transport in ./http) and
 * uses contract-mirrored paths (./paths).
 */
import * as auth from "./auth.ts";

export const rpc = {
  auth: {
    listProviders: auth.listAuthProviders,
    startUpstreamOAuth: auth.startUpstreamOAuth,
    completeUpstreamOAuth: auth.completeUpstreamOAuth,
    recallOAuthProvider: auth.recallOAuthProvider,
    recallOAuthReturnTo: auth.recallOAuthReturnTo,
  },
} as const;

export { ApiError } from "./http.ts";

// Generic projection of service-installed CredentialRecipe presentation for
// the connections tab. The dashboard contains no provider catalog.
export {
  credentialRecipePresentationText,
  providerSetupOptionsFromCredentialRecipes,
} from "./connections.ts";
export type {
  ProviderConnectionSetupOption,
  ProviderCredentialField,
} from "./connections.ts";

export type { CallbackResult } from "./auth.ts";
