import { handleAuthorize } from "../../../../accounts/service/src/oidc-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type {
  OidcAuthorizationCodeFlow,
  OidcClientRegistration,
} from "../../../../accounts/service/src/mod.ts";

const issuer = "https://accounts.example.test";
const redirectUri = "https://client.example.test/oauth/callback";
const client: OidcClientRegistration = {
  clientId: "workerd-cache-client",
  redirectUris: [redirectUri],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
};
const flow: OidcAuthorizationCodeFlow = {
  subject: "unused",
  pairwiseSubjectSecret: "workerd-cache-secret",
  issueIdToken: async () => "unused-id-token",
};
const subject = "tsub_workerd_cache" as const;
const sessionId = "sess_workerd_cache";
const now = Date.now();
const store = new InMemoryAccountsStore();
store.saveAccount({ subject, createdAt: now, updatedAt: now });
store.saveAccountSession({
  sessionId,
  subject,
  createdAt: now,
  expiresAt: now + 60_000,
});
const clients = new Map([[client.clientId, client]]);

function authorizeUrl(): URL {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: "openid",
    state: "workerd-state",
    code_challenge: "workerd-challenge",
    code_challenge_method: "S256",
  }).toString();
  return url;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const branch = new URL(request.url).pathname.endsWith("/code")
      ? "code"
      : "sign-in";
    const url = authorizeUrl();
    const headers = new Headers({ "sec-fetch-dest": "document" });
    if (branch === "code") {
      headers.set("cookie", `takosumi_session=${sessionId}`);
    }
    return await handleAuthorize({
      request: new Request(url, { headers }),
      url,
      flow,
      clients,
      store,
    });
  },
};
