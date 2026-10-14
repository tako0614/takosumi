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
Identity-only introspection responses marked `oidc_profile: shared-account`
cannot authorize a product extension, even one with no required scopes.

The login/callback/logout/session responses pass through the private binding,
including host-only RP cookies. The gateway adds `Cache-Control: no-store`.
Cookie mutations require the exact configured public Origin. The existing
`GET /api/v1/account/session/me` browser mirror returns the verified account
as `subject` and `primaryAccountId`; `expiresAt: 0` means the RP does not expose
its expiry through that mirror. It creates no issuer session. Its DELETE
operation invokes the private RP logout under the same Origin check.

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

Portable tests cover stock OSS opt-out, exact configuration/origin, forged
context, credential fallback, CSRF, suspended owner membership, viewer writes
and stream revocation. A native workerd test crosses a named Worker service
binding, a Durable Object session store and a D1 membership store. Its isolated
database uses bootstrap mode; it does not establish an operator's predeployed
schema/fence readiness, actual issuer/RP OIDC verification, or staging E2E.
