# auth.takos.jp: shared hosted sign-in proposal

Status: **proposed, unimplemented design** (TASK-0106). This document requests
review of a shared hosted login built on Takosumi Accounts. It does not change
the [current Core Spec](./core-spec.md), existing self-host login, schema,
runtime, client registrations, secrets, or deployment state. The first
deliverable is this design PR around 2026-10-18; an implementation and isolated
staging proof around 2026-10-22 are a separate phase, subject to the decisions
and acceptance criteria below. Production publication requires a separate
operator approval.

The [account-group/context continuation follow-up](./account-group-context-continuation-design.md)
requests separate policy review for multi-context and later merge operations.
It leaves this issuer/session baseline intact and does not adopt or implement v2.

## 1. Outcome, owners, and current gaps

A user signs in to `auth.takos.jp` with Google or GitHub, then signs in to the
official hosted Takoserver console or Takosumi Hosted without repeating the
upstream login while the issuer session remains valid. Each relying party
(RP) creates its own session bound to the shared canonical account. A verified
email helps find existing accounts; merging login identities preserves their
existing data and requires proof of ownership, as defined in section 6.

Revision following the design review: official hosted Takoserver and Takosumi
share **one canonical Accounts account and common Workspace authority**.
Product-local principal/customer IDs are retained as internal migration
references, not separate customer identities. The earlier proposal of SSO
between independent accounts is superseded. RPs keep separate browser sessions.

| Concept | Owner in the proposal | Authority retained locally |
| --- | --- | --- |
| Accounts implementation, upstream login, canonical account ID, client registry, issuer session, consent, refresh/revocation | Takosumi OSS Accounts | Shared account and identity; no resource execution or billing implementation |
| Operation of the official `auth.takos.jp` instance, issuer keys, upstream OAuth applications and exact registrations | Official identity operator using the Accounts owner deploy lane | Realized configuration and credentials outside public repositories |
| Common Workspace/personal Workspace creation and membership | Takosumi Workspace authority | One current membership/role source used by both hosted products |
| Takoserver RP binding and local session | Takoserver | Internal Principal/Organization mappings to canonical account/Workspace, API keys, resources, supply and execution |
| Hosted RP binding and local session/composition | Takosumi Hosted | Canonical account/Workspace bindings, Marketplace UX and support; no second customer identity or billing ledger |
| Single customer billing ledger and wallet keyed to shared account/Workspace | Takoserver billing authority, consumed through its published contract | USD micro-USD ledger; Hosted is its client, not a second retail wallet/ledger |
| Optional external issuer selection and existing self-host Accounts login | Each self-host operator | Independent issuer, authentication choices, local accounts and data |
| Cross-product permission to add the shared login and consumed wire contracts | takos-control architecture/policy/inventory owners | No runtime or identity database in control |

Implementation must consume published OIDC HTTP contracts. Neither consumer
imports Takosumi Accounts source or reads its database. Accounts is the canonical
account-ID owner; both RPs explicitly bind their internal references to that
one account. Customer authorization uses live common Workspace membership;
resource execution remains Takoserver-owned. Issuer cookies, refresh tokens,
email and raw ID tokens are not forwarded as resource execution credentials.
The existing opaque reseller grant seam is kept during compatibility, and its
Workspace-to-Organization mapping is made explicit by its owner before cutover.
No unreviewed cross-plane lookup or shared database is introduced.

### Baseline observed when preparing this proposal

- Accounts exposes the paths in [identity-oidc.ts](../../contract/identity-oidc.ts),
  code flow with S256 PKCE, ES256 signing, client-bound token revocation,
  durable refresh rotation/reuse detection, and upstream identity records.
  [The Accounts contract](../../accounts/contract/src/mod.ts) explicitly says it
  is not a generic public login platform without a complete registry/consent UX.
- [The upstream resolver](../../accounts/service/src/identity.ts) uses a stable
  upstream identity or derived subject. It does not currently merge by email.
  [The store](../../accounts/service/src/store.ts) has a verified-email lookup,
  but that is not an authorization rule or a collision-safe linking workflow.
  The current tri-state verification scalar has no provider/proof-time binding
  and can preserve a prior value when an upstream omits verification; inventory
  must classify that legacy evidence as unknown and obtain fresh proof.
- Static operator OIDC clients and Capsule-bound pairwise clients have different
  subject behavior in [oidc-routes.ts](../../accounts/service/src/oidc-routes.ts).
  Hosted identity-only RPs need an explicit shared-account registration class, not a
  fabricated Capsule grant or an existing control delegation client.
- Takoserver currently verifies Google assertions and maps provider/subject to a
  local principal and session. Its current schema/API accepts Google/GitHub
  provider identities, not an arbitrary external OIDC RP binding. The owner
  must add that seam rather than relabel a central subject as a Google subject.
- Hosted's current OSS composition verifies a platform session and Workspace,
  then strips identity before Marketplace/provider calls. It is not an
  independently implemented public OIDC login/callback today. Adding its RP
  and preserving its local Workspace authorization is explicit future work.

### Canonical policy changes required before implementation

The current
[control architecture](https://github.com/tako0614/takos-ecosystem/blob/main/ARCHITECTURE.md)
stable invariants 16, 18, and 19 prohibit account linking/shared OIDC sessions
and active legacy account import. Its dependency boundaries and the generated
Takoserver/Hosted guidance reinforce those restrictions. The user's new shared
login request is the target of this proposal; it does not silently amend those
canonical sources. Proposal approval alone cannot make conflicting runtime
implementation conformant.

The policy observations above come from the current control checkout read for
this design; `takos-control` is its checkout name and `takos-ecosystem` its
remote repository identity. The remote `main` projection was not verified to
match that checkout. Unrelated local control changes are outside this PR and
are not published by it.

| Current constraint / gap | Proposed narrow change | Required owner change before use |
| --- | --- | --- |
| Invariant 16: Hosted does not link users to Accounts/Takoserver | Adopt the canonical shared hosted account/Workspace and explicit Workspace-to-Takoserver Organization binding | Control architecture; both consumers' account/composition docs |
| Invariant 18: independent identity stores and no user linking/shared OIDC session | Adopt one canonical Accounts ID and Workspace membership authority; keep product sessions, stores and resource execution separate | Control architecture/policy-generated guidance; all three product auth contracts |
| Invariant 19: fresh accounts/no active import | Permit additive identity bindings for explicitly inventoried current durable accounts; no archived database, wallet, grant, resource or PAT import | Control architecture and owning migration runbooks |
| Dependency boundary prohibits account linking and Accounts IDs in consumers | Permit declared shared-account OIDC and current Workspace authorization contracts; retain source-import prohibition and scoped execution grants | Control architecture and consumed-contract inventory, then consumer API docs |
| Hosted retail wallet and direct Takoserver wallet are separate | Adopt one shared-account/Workspace customer ledger and explicit Workspace-to-Organization mapping; preserve old rows during transition | Control architecture; Takoserver billing API/ledger owner and Hosted client specification |
| Accounts has no complete public registry/consent or hosted-RP subject policy | Add an operator-controlled identity-only RP class, consent, prompt/max_age behavior, lifecycle/revocation and proof workflow | Takosumi Accounts contract/source/tests and self-host docs |
| Hosted has no independent RP; existing platform Workspace flow is not OIDC | Add a Hosted-owned public login/session adapter without bypassing the platform's local Workspace authorization | Hosted owner specification and composition tests; OSS published session adapter only if required |
| Official issuer operation/deploy surface is not yet declared | Declare the exact owning Accounts surface, environment and operator obligations before any publication | Takosumi deploy owner/operator; no invented control deploy coordinator |

Self-host does not depend on `auth.takos.jp`. Existing operator-selected
upstreams, passkeys, local issuer, memberships and login remain usable. Choosing
an external OIDC issuer is optional and does not require Hosted or Takoserver.

## 2. Issuer, protocol, and identity

The proposed production issuer is exactly `https://auth.takos.jp` (no trailing
slash). It is a new issuer identity, not a redirect/alias for an existing
Takosumi issuer. An isolated staging issuer uses an operator-selected different
HTTPS origin, separate clients, keys, cookie namespace and stores. No staging
client trusts the production issuer or upstream production application.

| Proposed Accounts endpoint | Contract |
| --- | --- |
| `/.well-known/openid-configuration` | Exact issuer and supported endpoints/features only |
| `/oauth/authorize` | Authorization code only; exact registered redirect; state, nonce and S256 PKCE |
| `/oauth/token` | Code exchange and allowed refresh grants with registered client authentication |
| `/oauth/jwks` | Public ES256 verification keys, with bounded cache and key overlap |
| `/oauth/userinfo` | Identity-only projection for that client's access token |
| `/oauth/revoke` | Authenticated client-scoped revocation, idempotent without token-existence disclosure |
| `/oauth/introspect` | Authenticated client-scoped activity check; no account or cross-client inventory |

These existing path names are proposed for the new deployment; this PR does
not publish them there. RP logout/global sign-out requires a separate, reviewed
session operation; discovery must not advertise logout until it works.

RPs pin the configured issuer and fetch discovery/JWKS over HTTPS from that
origin, not an untrusted token field. Reject wrong issuer, algorithm/key,
signature, audience, nonce, expiry, stale `iat`, or incompatible client policy.
Allow at most 60 seconds clock skew. ID tokens authenticate only the callback;
they are never API credentials. UserInfo `sub` must equal the validated ID-token
`sub`. These checks follow
[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
and [Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html).

Accounts retains an opaque internal identity root; it never derives identity
from an email, username, organization, or domain. An upstream login is uniquely
keyed by provider configuration plus canonical upstream issuer/subject. Google
uses its validated `sub`; GitHub uses the authenticated immutable numeric user
`id`, never `login`. Existing subject IDs remain immutable. New internal roots
may use the existing stable derivation only with persisted mappings and key
version custody; changing a derivation key must never regenerate existing IDs.

Both explicitly registered first-party hosted clients receive `sub` equal to
the canonical Accounts account ID. They intentionally share one customer
identity; accepting `(iss, sub)` is not permission to create another product
account. Consumer Principals/customers bind explicitly to that ID. Stable
canonical IDs are persisted and never change with signing/derivation-key
rotation, email updates or issuer browser sessions. Existing installed apps'
pairwise subject profiles remain independent and are not changed by this
first-party registration class. Privacy-sensitive future RPs may use pairwise
subjects with a separately approved canonical-account claim; they are not an
independent account plane. Old pairwise mappings remain readable migration
references, never authorization aliases to another person.

### Common Workspace and billing contract

After first successful hosted login, the Accounts composition invokes the
common Workspace authority's idempotent personal-Workspace ensure. It uses an
atomic per-canonical-account uniqueness constraint/CAS so simultaneous logins
in both products create exactly one personal Workspace. Both products resolve
that same ID; failure leaves onboarding incomplete and retryable, not a second
local organization or Workspace. Additional Workspaces serve team, billing
and environment contexts through the existing Workspace creation/membership
contract. A client selects an accessible Workspace explicitly and rechecks its
current membership for sensitive actions; tokens do not union roles or turn
authentication into Workspace access.

Takoserver Organizations become internal mappings of these Workspaces. A
durable unique, immutable Workspace-to-Organization binding keeps existing resources,
wallet rows and API-key references intact and permits an idempotent lookup or
personal-organization creation. Membership authority stays common rather than
being inferred from an old Principal's owner flag. Service/operator credentials
keep their own scoped authority and cannot create user membership implicitly.
Launch does not support Organization relinking. Existing Workspace IDs and
their Organization/ledger pins are retained through account merge; a
conflicting mapping remains pending for an owner-reviewed transition, not a
race between a billing lookup and an active Run's measurement reference.

The customer billing destination is **one ledger per shared account/Workspace**,
owned by Takoserver billing and consumed by Hosted. Its separate launch billing
design specifies USD micro-USD accounting, free $1.50/month, $10 plans including
$20 and $50 plans including $100, Cloudflare cost at 3x, 80/95% warnings, default
stop at the limit, opt-in postpaid/on-demand, and no card requirement in the
free tier. Login/membership changes do not mint credits or combine balances.
This auth design provides stable account/Workspace keys and migration seams;
pricing, subscriptions, top-up, Stripe and settlement belong to the billing
owner's design. Hosted must not add another retail wallet/ledger. Protected
historical ledgers are reconciled by the billing owner before cutover, not
deleted or silently summed by account merge.

## 3. Claims and client registration

The following is an identity-only profile, separate from existing installed
Capsule/Workspace delegation clients. Undeclared scope, workspace selection,
control scopes, or Interface invocation on these clients is rejected before
code issuance. Access tokens for this profile authorize only Accounts
UserInfo/introspection where applicable, never either product's business API.

| Claim | Proposed policy |
| --- | --- |
| `iss`, `sub`, `aud`, `iat`, `exp` | Required; `aud` is one exact registered client ID; `sub` is the same canonical account ID for both configured first-party hosted clients |
| `nonce` | Required for initial code callback; matched once to the RP transaction |
| `auth_time` | Required; actual last proved interactive authentication time, unchanged by refresh |
| `azp` | Emit only where OIDC requires it; launch profile uses one audience |
| `sid` | Opaque per-client session reference for session/revocation correlation; no issuer cookie value |
| `email`, `email_verified` | Only with approved `email` scope; verified=true applies to the exact address and proof record; never an authorization or unconditional merge claim |
| `name`, `picture` | Optional approved `profile` scope; display input only, absent by default |
| Roles, organization IDs, wallet/billing/resource IDs, upstream subject/token | Never emitted by hosted identity-only clients; common Workspace membership is looked up through its owner contract |
| `acr`, `amr` | Omit until verified semantics exist; an OAuth login does not invent MFA assurance |

Registrations are operator-reviewed, versioned records owned by Accounts. No
anonymous dynamic registration is offered at launch. Disable a registration
to stop new codes/refresh and revoke its grants. Store secret verifiers at the
issuer; keep RP secrets in its own operator secret boundary. Rotate with a
short explicit overlap and test both expiry and revocation.

| Registration field | Takoserver hosted console | Takosumi Hosted |
| --- | --- | --- |
| Logical client name | `takoserver-console` | `takosumi-hosted` |
| Proposed production `client_id` | `takoserver-console-production-v1` | `takosumi-hosted-production-v1` |
| Proposed production callback | `https://console.takoserver.com/auth/oidc/callback` | `https://app.takosumi.com/auth/oidc/callback` |
| Token exchange/session owner | Takoserver server-side RP | Hosted-owned server-side RP/login adapter |
| Allowed scopes | `openid email`; `offline_access` only with explicit continuing-session consent | Same |
| Grants / response type | `authorization_code`, optional `refresh_token` / `code` | Same |
| Client authentication | `client_secret_basic` initially, plus S256 PKCE | Same; independent secret |
| Account binding | `(iss,sub)` is the canonical Accounts ID; existing internal Principal binds to it | The same canonical Accounts ID; adapter obtains a canonical account session, not an independent customer account |
| Allowed post-login destination | Relative allowlisted console paths | Relative allowlisted Hosted paths |

The control architecture's product naming identifies `app.takosumi.com` as
the official Hosted browser destination; this is the proposed default, not
evidence that the callback or any registration exists. The Hosted owner must
confirm its realized browser origin and adapter before activation. A private Marketplace
service-binding Worker is not an OIDC browser callback. The exact Hosted
composition that turns its login into a local platform account session must
be reviewed by both owners; an auth issuer token cannot directly grant
Workspace access. Avoid an identity hop that forwards issuer session cookies
or exposes a client secret to the OSS dashboard.

Register each environment independently. Redirects are exact HTTPS strings,
without wildcard, open redirect, fragment, or user-controlled origin. Store
short-lived state/nonce/PKCE verifier server-side, bound to the initiating
browser and intended client; consume once after validation. Upstream callbacks
are likewise distinct from RP callbacks. Reject unsolicited login/link flows
and authorization-server mix-up. No implicit/password grant. This profile
applies the protections in
[OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html#section-2).

The proposed staging IDs are `takoserver-console-staging-v1` and
`takosumi-hosted-staging-v1`, with only each operator-confirmed staging browser
origin plus `/auth/oidc/callback` registered. Integration uses separate
`takoserver-console-integration-v1` and `takosumi-hosted-integration-v1` IDs and
its own exact callback origins. Each registration is pinned to its environment's
issuer. No production callback, client secret or subject mapping is reused in
staging/integration. Environment-specific origins are required operator inputs
before registration; the names above are design candidates, not live IDs.

## 4. Google and GitHub upstream login

Accounts owns the social callbacks and adapts the upstream result into
validated identity plus address evidence. Raw tokens or browser-supplied
email/verified flags are never trusted or forwarded to RPs. Request the
minimal scopes explicitly on every login; signing in does not grant repository
or cloud API access. Keep upstream login tokens ephemeral and do not request
upstream offline refresh merely to maintain the issuer session.

- **Google:** use code flow, state, nonce and S256 PKCE. Validate Google ID-token
  signature, issuer, audience/authorized presenter, expiry and nonce; bind
  UserInfo to its `sub` if used. Request `openid email`, adding `profile` only
  with a display requirement. Its address may change independently of `sub`.
  [Google's OIDC contract](https://developers.google.com/identity/openid-connect/openid-connect)
  explains those identity fields and code flow.
- **GitHub:** use code flow with state and S256 PKCE; validate the exchange and
  fetch authenticated `/user` plus all bounded pages of `/user/emails` using
  `user:email`. Do not interpret GitHub OAuth as OIDC or its actions/workload
  OIDC issuer as user login. Prefer `primary && verified` as contact address;
  another verified address requires explicit user selection. Missing, null,
  unverified or incomplete email data cannot enter email-assisted merge. Public
  `/user.email` is insufficient; private verified addresses can be used without
  changing their visibility. See
  [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
  and [email API](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user).

Google distinguishes addresses it currently controls from non-Gmail addresses
without `hd`: `email_verified=true` alone can reflect earlier verification of
an address whose current owner changed. Gmail, or a verified Google-hosted
domain claim, supplies stronger current address evidence; neither proves
ownership of a historical product account after reassignment. Non-authoritative
Google addresses require a fresh challenge to that address before linking.
GitHub `verified` is an upstream verification fact, not a promise against later
mailbox recycling. This design uses that distinction for proof requirements,
not product authorization. See
[Google's verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## 5. Sessions, refresh, logout, and outages

These are proposed hosted defaults; configuration validates explicit limits
at boot. They do not alter the existing self-host defaults (current code uses
5-minute codes/access tokens and 30-day refresh tokens).

Existing rotation/reuse records are reusable building blocks. Hosted family
idle/absolute expiry, issuer-session grant linkage, hash-only token custody,
the `__Host-` cookie policy, `auth_time`/`sid`, identity-only subject projection,
prompt/max_age enforcement and RP grant-health checks require explicit
implementation and tests; current code support is not assumed from this table.

| State | Hosted target | Storage and revocation |
| --- | --- | --- |
| Login/link transaction | 5 minutes, single-use | Browser-bound server record; no token in redirect destination/log |
| Issuer browser session | 12-hour idle, 7-day absolute | Opaque rotated ID; `__Host-` cookie, Secure, HttpOnly, Path=/, SameSite=Lax, no Domain |
| Authorization code | 60 seconds, one exchange | Atomic consume; bound client, redirect, nonce and PKCE |
| ID/access token | 5 minutes | ID token callback only; access token client/audience restricted and revocable |
| Refresh family | 7-day idle, 30-day absolute from initial grant | Hash-only server token records, RP encrypted server storage; rotate atomically on each use |
| Local RP session | 12-hour idle, 7-day absolute; fresh account/role checks on requests | Own host-only HttpOnly cookie and local session record; not the issuer cookie |
| Account-link or sensitive auth operation | Interactive proof no older than 5 minutes | Enforced `max_age`/`prompt=login`, one-use proof bound to operation; refresh is not reauthentication |

No parent-domain `.takos.jp` cookie, localStorage token, shared RP refresh
family, or cross-product bearer acceptance. A browser top-level navigation to
the issuer reuses its login session; it returns a new RP-bound code. Each RP
checks CSRF/Origin for session mutations and rotates its session at login/link.

Refresh verifies live identity status, client policy/consent, issuer session
grant, local binding status where applicable, original scope/audience and
family absolute expiry. Concurrent refresh is serialized by the RP; any reuse
revokes the entire family and associated access tokens, fails closed and
requires login. A lost refresh response is not retried with the old token and
does not receive an unlimited grace window. Retain replay tombstones for the
family absolute lifetime plus clock skew, even when a child is removed.

Local sign-out clears the RP session and revokes its refresh family. A clearly
labelled global sign-out revokes the issuer session and every linked hosted
client grant. RPs check grant activity at least once per 5 minutes, and before
linking, account/security changes or new sensitive authority; inactive grants
terminate the local session. Current grant-health evidence does not replace
local role/account checks. Thus global sign-out has a bounded 5-minute delay
for ordinary RP sessions and immediate issuer/new-token rejection. Stronger
back-channel logout is later work and must not be claimed at launch.

Browser cookie expiry alone does not revoke an explicitly consented offline
grant. That grant has its own idle/absolute bounds and is attached to the
originating issuer session's revocation record; global sign-out revokes both.
Refresh cannot extend an RP session beyond its 7-day absolute deadline or
update `auth_time`; after that deadline a new code flow with fresh interactive
authentication is required. Disabling a local binding revokes its grant and
cannot be undone by a still-valid issuer session.

An issuer outage prevents login, refresh and sensitive actions requiring
fresh proof. Ordinary local sessions stop once their last successful grant
check is 5 minutes old. Local authorization remains live; an issuer outage
never permits bypass or accepts an unrelated upstream token directly. Existing
self-host login and independently scoped API keys/PATs continue their own
policies; global web sign-out does not silently revoke or unify them.

Client-scoped revocation follows
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html). Refresh rotation,
client/scope binding, expiry and replay handling apply
[OAuth Security BCP section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).

## 6. Verified-email merge without account takeover

Merge at launch converges duplicate login identities on **one canonical
Accounts account**, rather than SSO between independent product accounts.
Each provider login resolves to that same account; both hosted clients bind
to it. Existing Principal/customer IDs, Workspace/data references and applied
ledger history remain protected migration records. Roles are derived from
common live Workspace membership, not a union of old product claims. Account
merge does not merge wallets, mint credits, move resources or unify invitations,
PATs, API keys or passkeys without their owner's separate transition.

Persist address evidence as the exact address, source provider/subject,
verification type, observed time and current validity. Changing an address
invalidates its old verified state. Legacy `emailVerified` booleans without
bound address/proof provenance are unknown for merge and require fresh proof.
Match trimmed surrounding whitespace plus lowercased IDNA domain, preserving
local-part case. Never remove dots, strip `+tags`, normalize aliases, conflate
`gmail.com`/`googlemail.com`, Unicode-fold local parts or use display names.
Historical lowercase indexes are candidate-only. Unsupported internationalized
local parts go to recovery instead of fuzzy matching. Email is not an account
ID or a fallback that overrides an already bound provider subject.

| Situation | Result |
| --- | --- |
| Known immutable upstream issuer/subject | Resolve its current canonical binding; email changes do not redirect it to another account |
| New upstream identity; no eligible candidate | Explicit signup creates one canonical account and atomically ensures its personal Workspace; RPs do not create another identity |
| Exactly one verified-email candidate | Show a masked candidate after login; require fresh proof of the new identity and existing account plus explicit merge consent |
| Same validated Google issuer/subject already controls the old account | That fresh proof can satisfy existing-account ownership after owner validation of the stored binding; persist an explicit canonical migration link |
| Google non-authoritative address or stale/unknown evidence | Fresh mailbox challenge plus existing-account authentication; mailbox access alone cannot reclaim a historical account |
| GitHub private verified email | Eligible after authenticated email API proof, with the same dual-proof requirement and no public disclosure |
| Multiple candidates, conflicting provider binding, normalization collision, reused address or concurrent merge | Quarantine the conflict; no first-match choice, automatic role union or override |
| Old account's credential lost | Existing recovery/independently reviewed support proof; a new verified-email login cannot take it over |
| Two active canonical account candidates | Freshly prove both, choose the canonical survivor explicitly, then perform the protected reconciliation below |

Proof is bound to the operation, provider identity and exact old account,
expires after 5 minutes and is consumed atomically once. Login/merge mutations
need browser/CSRF binding, rate limiting and explicit consent. Unauthenticated
candidate queries and conflict errors do not reveal account existence. PATs,
invitations or an assertion from another product are not user ownership proof.

Durable state includes immutable provider bindings, a canonical-account mapping,
operation-bound proof/merge intents, an append-only decision trail, membership
reconciliation and unique Workspace-to-Organization bindings. An upstream
identity has one active canonical account. A merge uses a stable operation ID
and idempotent `pending -> proved -> reconciled -> active` transitions; pending
records confer no new authority. CAS/unique constraints serialize proof
consumption and activation. Cross-owner acknowledgement is resumable; there
is no cross-database transaction or direct read of another product's tables.

### Successful merge example: Google A and GitHub B

Google account A and GitHub account B have the same current verified address.
A has personal Workspace W_A and a Hosted legacy customer H; B has personal
Workspace W_B and Takoserver legacy Principal T. Letters are illustrative,
not real data or new ID formats.

1. Email discovery creates a powerless merge intent. The user freshly proves
   Google A, GitHub B and ownership of their existing account/resource contexts,
   then explicitly chooses **canonical Accounts account A** and personal
   Workspace W_A. Existing balances and memberships are inspected privately;
   ambiguous ownership or ledger conflicts block activation.
2. Retain B/H/T and their old immutable references, but bind both upstream
   identities and both consumers' legacy references to canonical A. Additive
   mappings make H/T internal references to one customer, not independently
   authenticated accounts. Both hosted RPs now receive `sub=A` under their
   respective audience. New sessions never carry `sub=B` as another customer.
3. W_A is the one common personal Workspace. Preserve W_B and its resources
   as an additional common Workspace after explicit owner confirmation, rather
   than deleting or merging its data. Reconcile each Workspace's membership
   independently with proof of prior access; conflicting roles/owners require
   review and never become the union of two role claims. Both products query
   this one membership authority.
4. The billing owner maps each selected common Workspace to exactly one
   Takoserver Organization/ledger, retaining all historical rows. Existing
   duplicate wallets must be reconciled by that owner before activation; the
   auth service cannot sum balances or create a Hosted retail wallet. The
   resulting account/Workspace has one customer billing ledger.
5. Fence new grants for A/B, revoke their old issuer/RP sessions and refresh
   families, and obtain idempotent acknowledgement of binding, Workspace and
   billing reconciliation before activation. A partial handshake remains
   pending/recoverable without exposing half-linked authority. After fresh
   login, either Google or GitHub resolves canonical A and the same W_A;
   Workspace selection exposes only current common memberships.
6. Unlink a login method requires fresh proof and another working credential.
   Removing GitHub from A does not silently resurrect B as a second live
   customer or fork its shared Workspace/ledger. A mistaken merge can be
   reversed through the reviewed undo operation: revoke all affected grants,
   restore the exact prior provider/account mappings and reconcile membership/
   billing references with their owners before reactivation. B/H/T and old
   history remain available to make that repair non-destructive. Legitimate
   resource/financial operations performed meanwhile are never rolled back.

Record operation/undo IDs, opaque source/target references, actor, proof type
and time, policy version, previous generation, acknowledgements and conflict
state. Raw tokens/assertions/credentials never enter audit or PR output.
Notify existing contacts without disclosing other-product membership. Suspected
links are quarantined and their sessions revoked. An ordinary unlink is a
credential operation; splitting a canonical customer/Workspace/ledger is a
separate owner-reviewed recovery transition, not email login behavior.

## 7. Protected migration and rollback window

All existing shared/staging/customer/operator accounts and databases are
**protected** unless the exact owner explicitly declares an isolated target
disposable. No wipe/reinitialize, archived Accounts import or irreversible
account consolidation is proposed. Applied migrations are immutable. Future
implementation adds forward migrations in both Accounts PostgreSQL and D1
lineages, plus owning consumer migrations; no migration is executed by this PR.

1. **Inventory and decision:** each owner inventories current issuer/subject,
   account IDs, verification provenance, email collisions, credentials and data
   references privately. Count unresolved candidates without publishing PII.
   Confirm the Hosted callback/session adapter, policies in section 1, exact
   environments and recovery owners. Historical archives remain read-only.
2. **Expand:** add nullable local external-login bindings and Accounts proof,
   canonical-account, Workspace/Organization and grant-family metadata with
   uniqueness and indexes. Existing
   login readers/writers continue working; implement dual-path compatible
   readers before activation. Do not rewrite current subject derivations,
   membership/PAT foreign keys or old issuer token records.
3. **Rehearse:** synthetic production-shaped fixtures cover both D1/Postgres
   lineages and consumers: duplicate emails, reused addresses, changed upstream
   email, missing verification, distinct same-email users, multiple contexts,
   concurrent/replayed proofs, partial handshakes, restore, drift and large
   inventories. Check schema fingerprints, row/reference counts, tenant
   isolation, immutability of balances/resources and old-runtime compatibility.
   Use bounded indexed cursor batches and idempotent resumable operations, not
   table-wide updates or unbounded D1 parameter lists.
4. **Link gradually:** only on user consent/proof or a reviewed exact stored
   provider/subject match. Email-only inventory never activates a binding.
   Preserve old login and checkpoint each batch. A provider failure leaves the
   account unmigrated, not inaccessible. A product-local binding can be staged
   until the issuer/client readback confirms the same operation.
5. **Activate staged RPs:** with isolated credentials and synthetic accounts,
   prove Google/GitHub login to the same canonical account, one atomic common
   personal Workspace, current common membership, idempotent Workspace-to-Org
   binding and one customer billing ledger, consent, refresh,
   replay/revocation/global logout, conflicts, recovery, and reseller identity
   firewall. Existing clients do not silently change issuer: old issuer tokens
   are accepted only by their original verifier until their own expiry;
   production and staging subjects/tokens never cross environments.
6. **Production decision later:** independently review the exact authority
   candidate, migration proof and recovery plan. Production DNS/routes/client
   credentials/signing keys/publication require operator approval. No launch
   date or design merge provides that approval.
7. **Contract later:** retain the old login and data until owner-confirmed
   adoption/recovery metrics show no stranded accounts and a separately
   reviewed removal is safe. No fixed date deletes identities or credentials.

During the compatibility window, disable the new RP/login flags and return to
old authentication without deleting new metadata. Revoke new grants and
quarantine incorrect bindings; retain durable account/resource/billing rows.
After a schema mutation, failure repairs forward with checkpoints/readback,
not a destructive down migration. Keep key/subject mappings and refresh replay
history recoverable. Restoring a backup must invalidate restored sessions and
grants that could resurrect revoked authority. Verification logs contain
candidate identities, schema/count summaries and evidence digests only.

## 8. Acceptance and remaining decisions

The design PR is complete when the named reviewers can assess issuer/claims,
both RP registrations, session/refresh, safe email-assisted merge and protected
migration together. Its local CI result is repository/doc regression evidence,
not proof that OIDC or migration works. Implementation has not started here.

Before the separate implementation/staging phase:

- Adopt the narrow control/product contract changes in section 1 with their
  owners; confirm the official Accounts deployment surface without runtime
  changes in this design PR.
- Confirm Hosted's exact browser origin/callback and public login adapter,
  including how it obtains a product-local platform account session and
  verifies live Workspace rights through the existing OSS contract.
- Approve the proposed hosted TTLs and strict refresh replay policy; design
  global-grant activity checks and issuer-outage UX in both consumers.
- Confirm dual-proof recovery ownership, notifications, conflict handling and
  canonical account/Workspace reconciliation; keep ambiguous migrations blocked
  with old login until the exact owning transitions are proved.
- Implement focused negative/security tests and a protected migration rehearsal
  before full owner gates and exact-head QA. Prove wrong issuer/audience/nonce,
  key rotation, code/refresh replay across replicas, unregistered redirect,
  client disable/revocation, address reassignment, GitHub private/unverified
  addresses, simultaneous link, partial migration, rollback-compatible readers,
  session restore and issuer outage. Check that the new identity-only profile
  never exposes existing Workspace/control claims or accepts issuer tokens at
  either product's business/reseller API.

Google/GitHub login and the two hosted RPs are the launch scope. Unifying
invitations, PATs and API keys is deferred until after launch and needs a
separate design. Shared account/Workspace authorization and the single billing
ledger are launch requirements; the billing owner supplies its separate design
and implementation rather than this auth PR creating another ledger.
A design QA approval does not approve
implementation merge, staging mutation or production publication. Follow the
normal exact-head QA/review workflow for each subsequent candidate.
