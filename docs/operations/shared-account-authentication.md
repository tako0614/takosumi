# Optional shared-account browser authentication

An operator can opt the platform Worker into a private relying-party session
service. The stock OSS/self-host composition retains its existing account
sessions, OIDC clients and PAT behavior. The optional profile is currently
restricted to staging; this implementation does not enable a production origin.

Configure all of the following in the owning operator composition:

- `TAKOSUMI_SHARED_AUTH_PROFILE=shared-account`
- `TAKOSUMI_ENVIRONMENT=staging`
- `TAKOSUMI_SHARED_AUTH_ORIGIN`: the exact bare HTTPS public platform origin
- `HOSTED`: a private named service binding implementing the RPC port in
  `worker/src/shared_auth_rpc.ts`

The service binding alone does not enable the profile. Partial configuration,
a different environment, malformed origin or missing RPC methods fails closed.
The origin is operator configuration; public request headers cannot select it.

The private service implements:

| RPC | Responsibility |
| --- | --- |
| `fetchSharedAuth(Request)` | Handle exactly `/auth/oidc/login`, `callback`, `logout` and `session`; return a native `Response` |
| `authenticateSharedAuth(Request)` | Validate the RP's opaque host-only session and current issuer grant; return an authenticated canonical account ID, unauthenticated, or unavailable |
| `resolveSharedAuthWorkspace(Request, workspaceId)` | Read the common owner's current active membership; return the same account, exact Workspace and current role, forbidden, or unavailable |

The private RP keeps access/refresh tokens and verifies their client binding,
issuer profile, current grant, account fence and revocation. An ID token,
browser-supplied account ID or issuer session cookie is not product API
authority. The public gateway passes an allowlist of request headers to the
private RPC and does not forward unsigned context headers or request bodies to
the identity resolver. An explicitly presented Authorization or issuer-session
header cannot fall back to the RP cookie after failed verification.
On the opted-in product origin, OAuth access tokens carrying only identity scopes
(`openid`, `profile`, `email`, `offline_access`) cannot authorize a product
extension, even one with no required scopes. This uses the issuer's existing
standard introspection wire and does not introduce another profile claim.

The login/callback/logout/session responses pass through the private binding,
including host-only RP cookies. The gateway adds `Cache-Control: no-store`.
Cookie mutations require the exact configured public Origin. The existing
`GET /api/v1/account/session/me` browser mirror returns the verified account
as `subject` and `primaryAccountId`; `expiresAt: 0` means the RP does not expose
its expiry through that mirror. It creates no issuer session. Its DELETE
operation invokes the private RP logout under the same Origin check.
Identity/membership RPC waits are bounded at five seconds, and browser auth
route waits at forty seconds; failures return a generic unavailable result
without retrying. A wait deadline does not roll back the private RP operation.
If a callback fails, start a fresh login attempt rather than replaying its
single-use authorization code.

On that exact product origin, `/sign-in` redirects to the RP login and other
local `/api/v1/account/*` management routes return the same 404. Local PAT
management is not part of this profile. The dedicated issuer origin retains
its own standard token/grant-backed Workspace directory routes; the profile
does not proxy that namespace into the product or alter the separate machine
OAuth protocol namespace.

For authenticated extensions, the gateway obtains current Workspace membership
through the private RPC before constructing the existing authenticated context.
Raw cookies and forged context headers are removed before the extension
receives the request. A viewer cannot use a Workspace mutation route.

For public Control routes, the gateway passes the verified account into the
existing Accounts Control facade. The composition must use the same canonical
Workspace/member authority as the issuer's directory. This is not a replica
or a new membership store. Shared-profile requests require an active exact
membership even when the account appears in the Workspace owner field; ordinary
OSS owner behavior remains unchanged. Workspace inventory reads do not repair
owner membership implicitly in this profile. Existing mutation admission,
management-epoch checks and durable write CAS remain in the owning Control
operations. Run streams revalidate the RP grant and canonical account together
with current membership before emitting later snapshots.
The shared-profile public Control facade accepts the RP cookie path; an
explicit Authorization header receives 401. Machine protocol and private
operator/Run credential lanes retain their separately owned authority.

## Takosumi Mobile sessions

Takosumi Mobile cannot use the browser cookie: its HTTP stack (Tauri's HTTP
plugin) drops a `Cookie` header set by the app and always sends the webview's
`Origin`. People still enter only through the private RP. The phone gets an RP
session of the browser's kind through a code exchange, and presents it in a
dedicated header. No PAT or OAuth bearer is accepted on the product host.

Configure, in addition to the profile above:

- `TAKOSUMI_SHARED_AUTH_ISSUER`: the exact bare HTTPS origin of the issuer the
  private RP uses for browser login (`https://auth-staging.takos.jp` on
  staging). Discovery advertises it; the gateway never calls it.
- `TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID`: Takosumi Mobile's client at that
  issuer. Register it as a `shared-account` profile client like the RP's own:
  `client_secret_basic`, identity scopes `openid email offline_access`, and the
  exact redirect `https://<product origin>/auth/oidc/native/callback`. Its
  secret goes only to the private RP. On staging the issuer's pinned client set
  (`deploy/accounts-cloudflare/src/staging-target.ts`) must be extended through
  the auth release lane; this document does not do that.

Both values or neither: a partial or malformed pair disables the lane.
Discovery on this host never returns `oidcClientId` (this Worker's own Accounts
authorize route is not mounted for people); with both values it returns
`shared_account_sign_in` (issuer, client id, redirect URI, exchange URL,
header name, scope).

The flow:

1. The app runs an authorization-code flow at the issuer as the Takosumi
   Mobile client with PKCE (S256), `state`, `nonce` and `prompt=consent`, and
   the redirect URI above on the host it connected to.
2. `GET /auth/oidc/native/callback` (gateway) accepts exactly one response
   (`code` or `error`/`error_description`, with `state` and an optional `iss`
   that must equal the configured issuer) and answers with a no-store page that
   hands it to `takosumi://oauth/callback` and nowhere else. It is a page, not
   a redirect, because the issuer's consent form limits where its submission
   may redirect (CSP `form-action`). The code is single-use, expires within a
   minute and needs both the RP-held client secret and the app's PKCE verifier.
3. `POST /api/v1/account/session/mobile-exchange` (gateway) takes
   `{code, code_verifier, nonce}` as JSON (8 KiB, exact keys and formats). It
   refuses any credential header (401), browser markers (`Sec-Fetch-*`, a web
   `Origin`: 403), more than 10 attempts per minute per source (429), and
   relays a gateway-built request with only that JSON to the RP. It never logs
   the request.
4. The app presents the returned session in `x-takosumi-native-session`.
   `GET`/`DELETE /api/v1/account/session/me` read and sign it out.

The private service implements two optional methods. An RP without them keeps
the browser lane; the exchange and native sign-out answer 503.

| RPC | Responsibility |
| --- | --- |
| `exchangeSharedAuthNativeSession(Request)` | Redeem the code at its issuer as the Takosumi Mobile client (with that client's secret, `redirect_uri` = the native callback, the given `code_verifier`). Verify the ID token as for the browser: ES256 signature through the issuer's JWKS, `iss`, `aud` and `azp` = the Takosumi Mobile client, `exp`/`iat` skew, `nonce` = the given nonce, `sid`/`auth_time`. Resolve the canonical account through the same resolver as the browser callback. Create a session with the same lifetime, refresh, grant health checks and revocation as a browser session, recorded as native. Return `{kind:"established", sessionToken, accountId, expiresAt}` (opaque URL-safe token of 32..256 characters, `tsub_` account, absolute expiry in epoch seconds), or `{kind:"refused"}` for every verification failure, or `{kind:"unavailable"}` |
| `revokeSharedAuthNativeSession(Request)` | Revoke the session presented in the header, exactly as the browser logout revokes a cookie session (including the issuer grant). Return revoked, unauthenticated or unavailable |

`authenticateSharedAuth` and `resolveSharedAuthWorkspace` receive the native
session in the same header. On this lane the gateway forwards that header and
`Accept` only: never a cookie, `Origin` or fetch metadata. The RP must accept a
native session only through the header and a browser session only through the
cookie, so neither credential can stand in for the other. Single use of the
code is enforced by the issuer (a reused code revokes the grant); the RP may
also refuse a repeated code or ID token for its lifetime.

On the shared origin, the gateway refuses the header with 401 on every path
when it is malformed or repeated, comes with `Authorization`, an issuer-session
header or `Proxy-Authorization`, carries `Sec-Fetch-*`, or carries an `Origin`
other than a native app's (none, `null`, `tauri://localhost`,
`http(s)://tauri.localhost`). The browser login routes refuse it with 401.
Extensions never receive it. A `Cookie` header alongside it is not refused,
because native cookie jars may hold unrelated edge cookies, but it is never
forwarded on this lane.

CSRF reasoning: CSRF needs an ambient credential that a browser attaches to a
forged request. This header is never ambient: a browser does not add it by
itself, setting it from another origin needs a CORS preflight this host does
not grant, and its value never exists in a browser. Cookie writes keep the
exact-Origin check; requests authenticated by the header skip it, because the
identity came from the header alone. Requiring the product `Origin` from the
app would instead require faking a browser header that Tauri does not allow.

Portable tests cover stock OSS opt-out, exact configuration/origin, forged
context, credential fallback, CSRF, suspended owner membership, viewer writes
and stream revocation. A native workerd test crosses a named Worker service
binding, a Durable Object session store and a D1 membership store. Its isolated
database uses bootstrap mode; it does not establish an operator's predeployed
schema/fence readiness, actual issuer/RP OIDC verification, or staging E2E.
