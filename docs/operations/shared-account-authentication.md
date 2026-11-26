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

`GET /auth/oidc/login` additionally requires
`HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER` and
`HOSTED_OIDC_LOGIN_IP_RATE_LIMITER`, each implementing Cloudflare's
`limit({ key }): Promise<{ success: boolean }>` binding port. Admission runs
after the existing origin/credential guards, before the private RPC. Missing,
throwing or malformed bindings return unavailable without entering the RP.
A refusal returns 429 with `Cache-Control: no-store` and `Retry-After: 60`.
Callback/session/logout and the stock profile remain outside this gate.

The reference template uses 60 requests/minute across the location and
10 requests/minute per client cohort. Its numeric namespace IDs are placeholders:
choose distinct unused IDs in the owning operator-private config. These are
staging examples, not production traffic policy. The limiter is approximate
and local to each Cloudflare location, not a strict worldwide storage quota.
Its client key uses ingress `CF-Connecting-IP` (IPv4 or IPv6 /64); invalid or
missing values share an `unknown` cohort. Shared IPs can group different users.
No address becomes identity or is forwarded to the private RP. See the
[Cloudflare binding contract](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Existing pending/expired attempt retention and independent maintenance remain
separate; this gate does not qualify deployed bindings or repair old rows.

The private service implements:

| RPC | Responsibility |
| --- | --- |
| `fetchSharedAuth(Request)` | Handle exactly `/auth/oidc/login`, `callback`, `logout` and `session`; return a native `Response` |
| `authenticateSharedAuth(Request)` | Validate the RP's opaque host-only session and current issuer grant; return an authenticated canonical account ID, unauthenticated, or unavailable |
| `resolveSharedAuthWorkspace(Request, workspaceId)` | Read the common owner's current active membership; return the same account, exact Workspace and current role, forbidden, or unavailable |
| `drainSharedAuthRevocations()` (optional) | Purge a bounded slice of expired RP records and retry one pending session family's issuer revocation |

The official staging gateway can opt in to this maintenance with
`TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED=1`, a compatible private binding and
the existing `*/5 * * * *` trigger. With the setting unset, the maintenance is
disabled. The gateway calls the private method once per matching delivered
event. A later event can resume a failure from the RP's durable pending state.
Repeated event delivery can repeat an idempotent issuer revoke. Other scheduled
tasks and normal login are independent of this optional method. An unavailable
or failed call logs `hosted_auth_maintenance_failed` without issuer or session
details.

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
route waits, including login admission, at forty seconds; failures return a generic unavailable result
without retrying. A wait deadline does not roll back the private RP operation.
An admission result arriving after that deadline cannot start another limiter
check or a new private RP call.
If a callback fails, start a fresh login attempt rather than replaying its
single-use authorization code.

On that exact product origin, `/sign-in` redirects to the RP login. The
dedicated issuer retains its own account management and token/grant-backed
Workspace directory. The product mounts the browser session mirror and
notification-pusher routes, plus the optional personal-access-token lifecycle
below. Other local `/api/v1/account/*` management routes return 404. The machine
OAuth protocol remains a separate namespace.

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
The shared-profile public Control facade accepts the RP cookie path. The
optional personal-access-token path below is its only human Bearer lane.
Machine protocol and private operator/Run credentials retain their separately
owned authority.

Portable tests cover stock OSS opt-out, exact configuration/origin, forged
context, credential fallback, CSRF, suspended owner membership, viewer writes
and stream revocation. A native workerd test crosses a named Worker service
binding, a Durable Object session store and a D1 membership store. Its isolated
database uses bootstrap mode; it does not establish an operator's predeployed
schema/fence readiness, actual issuer/RP OIDC verification, or staging E2E.

## Personal access tokens on shared staging

The operator can select `TAKOSUMI_SHARED_AUTH_API_KEYS=enabled` for the
canonical `https://app-staging.takosumi.com` shared-account Worker. The feature
uses the same Accounts D1 as the staging issuer and the existing Accounts PAT
records. Other shared-profile deployments keep the browser-only Control surface.

With this option, **CLI / API keys** in the product dashboard lists, issues,
and revokes the signed-in account's keys. The browser uses its current RP
session. Creation and revocation require the exact product Origin. Key
creation uses the existing per-peer mint admission and Accounts scope/app
validation. Management requires a browser session from the RP. The key value
is displayed once, and responses are private and non-cacheable.

The CLI sends a PAT alone as its Bearer credential to the canonical Control
API. The Worker checks the stored PAT's activity, current canonical account,
scope and optional app or Workspace restrictions. Control checks current app
and Workspace authority for each operation and retains the PAT ID when
rechecking a Run or uninstall request. Extension and machine protocol admission
retain their existing credential verifiers. Browser sign-in and ordinary OSS
PAT paths keep their existing selection.

Changing this option on a served staging Worker is an authentication
configuration change. Before enabling it, confirm that the product Worker
and the dedicated issuer both run the field-only PAT usage and revocation
updates against the common Accounts D1. An older issuer can still write PAT
usage from its OAuth verification routes. Roll back only to versions that
retain those field updates while both Workers share the database. Verify the
management and CLI flow after activation with a designated QA account.

Use the independently reviewed, Version-only staging transition from a clean
checkout. Copy the currently serving TOML with its existing settings, add
`TAKOSUMI_SHARED_AUTH_API_KEYS = "enabled"` under `[vars]`, and pin the
checkout in the sibling source file. Take the IDs and digests from the
reviewed code-publication receipts for the current product and issuer.

```sh
bun run deploy -- takosumi-platform-staging-api-keys apply \
  --config /absolute/operator-private/wrangler.staging.toml \
  --predecessor "<current product Version ID>" \
  --issuer-version "<current issuer Version ID>" \
  --entry-digest "sha256:<current product entry>" \
  --dashboard-digest "sha256:<current product dashboard>"
```

The entrypoint verifies that removing exactly this declaration gives the
serving predecessor's configuration. It requires the same bundle and
dashboard digests, validates the issuer Version again before activation, and
reuses the existing upload, activation and preservation checks. The predecessor
Version is the key-disabled rollback point. The option changes route admission
without issuing or revoking saved keys.

## Existing-account password sign-in

Takosumi Accounts can optionally accept a username and password
for an existing OAuth account. A signed-in user chooses a username and sets the password under
**Sign-in methods**. The credentials attach to the existing subject, Workspaces
and identity bindings. Users who forget a password can sign in again
with their existing OAuth provider and set another one. This feature has no
registration or recovery-by-email endpoint. Usernames are unique on the issuer,
case-insensitive and fixed once claimed. They use 3–32 ASCII letters, digits,
dots, underscores or hyphens, starting with a letter or digit.

Set `TAKOSUMI_ACCOUNTS_PASSWORD_AUTH=login` on the Accounts issuer to enable it.
For Cloudflare, set it as a Worker variable on the issuer. On the official
staging issuer use the [reviewed authority release](auth-staging.md#private-target-and-credential-custody).
The default is `disabled`. Outside a local loopback development issuer, use
HTTPS. For Postgres, apply the additive Accounts migration `049_password_auth.sql`
using the Accounts migration path before enabling the feature. D1 uses the
existing Accounts document storage. Changing the setting does not delete
existing passwords. A client that consumes an issuer uses that issuer's
existing sign-in redirect; for the dedicated staging issuer its management
page is `/account` on the issuer origin.

Password attempts are limited by the issuer, normalized username and
trusted peer address when the runtime supplies one. A self-hosted reverse
proxy shares its peer bucket; it should also enforce its own per-client
limit at ingress. If an issuer sets an email allowlist, account admission still applies that
policy to both OAuth and username sign-in. A password change invalidates
existing account sessions and OAuth grants for that subject. An account with
Financial Source enrollment cannot change its password through this flow
until that operation can close the owned Financial Source records together
with grant revocation. Hosted session password writes are supported only
with D1; self-hosted Postgres uses the ordinary Accounts profile. The
existing OAuth login remains available in either case.

Password verifiers remain private Accounts data. An approved account erasure
must cover its verifier as well as the account; a Postgres delete refuses
until that separate row is removed by the erasure owner.
