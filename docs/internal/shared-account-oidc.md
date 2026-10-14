# Optional shared-account OIDC profile

Status: implementation contract for an explicitly configured profile. Deployment,
live client registration and owner reconciliation are separate operator actions;
this document does not claim that any public issuer is active. The earlier
[auth design](./auth-takos-jp-design.md) records the proposal and its review.

## Authority and subject

Accounts owns the immutable canonical account ID. Registered first-party
`profile: "shared-account"` clients receive that same ID as `sub`. Upstream
identity remains the exact provider ID, issuer and immutable provider subject;
email never creates a subject. An old source account retained after a merge is
an internal protected reference, not another active login account.

Existing Takosumi Control Workspace and member stores remain the sole Workspace
authority. Accounts supplies a facade over those existing operations and their
durable personal-Workspace claim. ID-token claims confer no Workspace roles,
Organization access, billing authority or permission to invoke resource APIs.
Workspace-to-Organization bindings and their existing opaque references are
immutable at launch. Takoserver owns the single Workspace billing ledger;
Hosted consumes it. A merge neither combines wallets nor rewrites historical
Organization, resource, ledger or pending billing-operation references.

Ordinary self-host login, installed/Capsule client pairwise subjects, Interface
OAuth, PAT and session-only business endpoints keep their existing contracts.
Shared profile admission is limited to the explicit directory route below.

## Registration and protocol

Shared clients require explicit `enabled: true`, unique client IDs, exact HTTPS
redirects, `client_secret_basic`, ES256 and an explicit subset of `openid`,
`profile`, `email`, `offline_access` containing `openid`. Each environment and
RP has separate IDs, redirects and secret bindings. Cloudflare JSON descriptors
name `clientSecretEnv`; they contain no secret values. Global legacy credentials
cannot override a shared client's binding. Disabled registrations leave a
durable client-revocation tombstone, so old replicas cannot issue or refresh
grants. Reactivation uses a newly reviewed, versioned client ID; toggling the
old ID back on cannot resurrect it.

| Operation | Path | Authentication |
| --- | --- | --- |
| Discovery | `/.well-known/openid-configuration` | public GET |
| JWKS | `/oauth/jwks` | public GET |
| Authorization/consent | `/oauth/authorize` | issuer browser session; GET then exact-Origin POST |
| Code/refresh exchange | `/oauth/token` | client secret Basic, form body |
| UserInfo | `/oauth/userinfo` | current access-token Bearer |
| Introspection | `/oauth/introspect` | registered client secret Basic; only that client's grant |
| Revocation | `/oauth/revoke` | registered client secret Basic |

Authorization code flow requires state, nonce, exact redirect and S256 PKCE.
Consent is browser-bound, single-use and origin checked. `prompt`/`max_age`
requirements fail closed when the issuer session cannot establish the requested
freshness. Code TTL is 60 seconds. ID/access token TTL is 300 seconds. Shared ID
tokens include `iss`, client `aud`, canonical `sub`, `iat`, `exp`, `nonce`, `sid`
and issuer `auth_time`; requested profile/email claims are scope limited and
address verification comes from current provenance, not a historical boolean.
UserInfo returns the same canonical `sub` and requested identity claims.
Introspection retains the standard identity-only shape: `active`, `token_use`,
`client_id`, `sub`, `aud`, `exp`, `scope`, with optional `iss`, `iat`, `sid`,
`auth_time`. It does not add an `oidc_profile` or product-role claim.

Refresh tokens rotate atomically, with a seven-day idle limit and 30-day absolute
family limit. Durable hashed custody and consumed-chain evidence make code or
refresh replay revoke the grant across replicas. Current grant, client status,
issuer, subject, authentication generation, account fences and revocation are
checked on use. Global logout revokes all grants of the current issuer session.
Issuer cookies are host-only, Secure, HttpOnly, SameSite=Lax; their idle limit is
12 hours and absolute limit seven days. Each RP owns its opaque cookie and
encrypted token custody. An RP cookie never becomes an issuer cookie.

## Common Workspace HTTP contract

The optional profile mounts `/api/v1/account/shared-workspaces`. A registered
RP sends `Authorization: Bearer <current shared-account access token>`. The
server resolves the persisted, current, same-client grant and derives the
canonical account internally. Resource/Interface grants, PATs, refresh tokens,
unsigned subjects and caller-selected account or role fields are rejected.
No client secret alone establishes an account context. The current-grant
closure is local code; responses contain plain cloneable DTOs only. Genuine
Accounts sessions remain supported; their mutating requests require issuer
Origin. RP Bearer requests use no ambient cookie authority.

| Method/path suffix | Input | Result |
| --- | --- | --- |
| GET root | `selectedWorkspaceId?`, `after?`, `limit?` (1–100) | `accountId`, optional `personalWorkspaceId`/`activeWorkspace`, `choices`, optional `nextCursor` |
| POST `/bootstrap` | `{}` | existing or atomically ensured personal Workspace |
| POST root | `{handle, displayName, type:"organization"}` | current authorized Workspace choice |
| POST `/{workspaceId}/select` | `{}` | authorized choice |
| GET `/{workspaceId}/billing-organization` | no account/Org input | `{workspaceId, workspaceRef, organizationId}` |

Each choice contains `id`, `handle`, `displayName`, `type`, current `roles` and
`owner`. Exact active membership is re-read from canonical Control. A stored
owner field cannot override suspended/deleted membership. Menu reads do not
create Workspaces or repair memberships. Billing lookup checks membership and
the same current grant again after awaiting the owner port. Missing directory
or billing capability returns 503; pending/ambiguous bindings fail closed.

## Verified-address merge

Email equality is only a candidate lookup. Evidence binds address, normalized
address, provider, immutable upstream identity, verification method, observation
and expiry. Legacy scalar `emailVerified` is unknown for merge purposes. Gmail,
or Google's verified hosted-domain identity, can provide authoritative proof;
Google third-party mail without `hd` also requires a fresh mailbox challenge.
GitHub proof requires the newly exchanged token's numeric `/user` ID and the
complete authenticated private `/user/emails` verified primary address. Public
profile email, API failure, changed/reused addresses, normalization collision,
more than two candidates or conflicting existing bindings never auto-link.
See [Google verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
and [GitHub email API](https://docs.github.com/en/rest/users/emails).

An issuer-browser operation chooses immutable source B and target A. Its
five-minute lifetime, browser binding, direction and policy version are fixed.
`POST /api/v1/account/identity-merges` creates it; named operation routes expose
read, proof consumption, final consent and owner activation. For each leg,
`POST /api/v1/account/identity-merges/{operationId}/upstream-proof/begin` accepts
only `{role:"source"|"target", providerId, consent:true}` with the exact issuer
Origin and host-only issuer/merge browser cookies. The server derives the
expected existing identity and records a new state/nonce/S256 transaction
after operation creation. Normal login transactions cannot become merge proofs.
Begin responds 200 with `{authorization_url, operation_id, role}` and an opaque
upstream browser-binding cookie. The browser navigates to that configured
provider URL explicitly; it does not follow a cross-origin fetch redirect.

A verified callback returns an opaque `proof_receipt` and `operation_id`. The
server-only receipt records method `upstream-oauth-operation`, the operation,
leg, identity tuple, generation, transaction digest, address digest, browser,
policy, explicit leg consent and bounded times. `issuer-credential-reauth` is a
different receipt method. Provider-session confirmation proves present control
and conscious consent; it never invents fresh password/MFA entry or writes
`reauthenticatedAt`. Signed upstream `auth_time`, when supplied, is distinct
from issuer `auth_time`. Ordinary session rotation preserves the receipt;
logout, recovery, disable, generation or identity-binding changes fence it.
Receipt consumption and operation transition are atomic. An identical retry
may return that immutable operation's previous result, but cannot mint a second
operation, grant or receipt use.
`POST /{operationId}/prove` accepts only `{receiptId}`;
`POST /{operationId}/consent` accepts only `{consent:true}`. Caller-supplied
proofs, role overrides, timestamps or authentication generations are rejected.

Google A (Gmail, signed nonce token without `auth_time`) and GitHub B (private
verified primary email) can complete both new provider flows sequentially in
one browser, approve both legs and final consent without a passkey. Activation
requires exact owner acknowledgements for external bindings, current Workspace
membership, ledger preservation, RP revocation and **consumer pending-intent
custody**. Then both providers resolve canonical A and both RPs receive `sub=A`.
Old A/B sessions and grants are revoked. Existing W_A→Org_A and W_B→Org_B,
balances and original pending/unknown operation keys remain protected and
reachable through the reviewed custody adapter. Missing reconciliation refuses
consent before fencing; partial acknowledgements after reservation leave a
pending fenced operation for explicit recovery, never a partial active merge.

Ordinary credential unlink disables the chosen provider and revokes its grants;
it does not split an account or a wallet. Reversing a mistaken merge requires
reviewed owner recovery acknowledgements, preserved before-images and audit.

## Protected rollout

See [the operator runbook](../operations/shared-account-oidc.md). PostgreSQL
migration 045 adds nullable metadata/private identity records. Ordinary readers
and writers remain compatible with protected head 044. Accounts D1 version 5
adds indexes to existing document storage, preserves exact v0–v4 lineage and
does not rewrite account IDs, Workspace/member data, ledger or resource FKs.
The ordinary bridge supports exact v4/v5 closures. Cloudflare shared mode
requires `TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY=true`, `predeployed` schema
mode and exact verified v5; request handlers never apply that migration.
