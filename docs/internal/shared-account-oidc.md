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
old ID back on cannot resurrect it. Disabling configuration alone does not
update stale replicas: the owner must materialize the durable revocation marker
through the owning store port or a request resolved by the disabled registration
and read it back before relying on cross-replica revocation.

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
freshness. The consent transaction binds the complete authorization policy,
current rotating issuer session and validated freshness checkpoint. Its POST
rechecks that policy and the current session; an ordinary consent page cannot
be upgraded to a fresh-authentication request, nor can a strict policy be removed
from its submission. PostgreSQL persists these temporary transaction fields in
the protected metadata column, as do the memory and D1 stores.
Code TTL is 60 seconds. ID/access token TTL is 300 seconds. Shared ID
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

Shared creation installs the initial owner atomically only for a newly created
Workspace. An existing or concurrently recovered request requires its current
active owner membership and never restores suspended, demoted or missing rows.
The trusted shared-profile marker also reaches public Control Workspace and
member mutations: current roles are read without an owner-field substitute,
then checked again by the atomic store mutation against the captured member
and Workspace authority. Existing self-host owner-repair behavior is separate.

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
The private [Control reconciliation contract](./control-identity-reconciliation.md)
adds a server-generated context plan and separate explicit acceptance by each
proved leg. The plan fixes the original context inventory, current membership,
management epochs, immutable billing pins and A's existing personal anchor.
Provider consent or target-only final consent cannot replace these acceptances.
The initial supported case is two disjoint existing personal contexts; unsupported
team or resource-specific Principal references refuse admission before fencing.
W_B retains its historical owner, original member, personal slot and Org; an
explicitly approved additional A membership makes that context reachable without
combining roles or wallets. A Control receipt does not attest financial or RP
custody. Actual external owner adapters remain separately required.
The browser cannot resume through a revoked/fenced session. The composition
must give a trusted owner service custody of the persisted operation ID and
retry `activateIdentityMerge` with current proof/grant/generation checks before
expiry. After expiry, owner-reviewed recovery is required. The dedicated staging
entry mounts the same per-environment retry service for consent readiness and a
one-minute scheduled handler. Its existing Accounts pending index, bounded
cursor/CAS lease, queue capacity and proof deadline are checked before fencing.
Admission also requires a durable heartbeat from a successfully completed real
scheduled invocation within 120 seconds, matching the exact runtime version and
qualified owner-authority context. A readiness probe, private retry, configured
cron or owner-ready boolean cannot create it. An absent/stale heartbeat refuses
new consent before fences; pending retry and reviewed recovery continue, and
ordinary login remains available. Missing real owner readiness refuses consent.
Client credentials
or an arbitrary subject parameter never provide that retry authority.

Credential unlink requires a server-minted intent bound to the removed identity
and a different retained credential. A new operation-bound provider flow must
prove that retained identity is currently usable. Another non-disabled database
row or a generic recent session is insufficient. The exact removed/retained
tuple, proof reference and generation go to the explicit unlink-intent owner
ACK port. Atomic completion consumes that proof and intent, disables the chosen
provider, revokes grants and retains a value-free audit. An identical retry
cannot change the identity pair. The legacy unguarded unlink route refuses with
`unlink_intent_required`; it is never a compatibility fallback.

The issuer-browser inventory is read-only
`GET /api/v1/account/identity-credentials`, returning at most 100 current user's
`{providerId,upstreamIssuer,upstreamSubject,enabled}` records. It returns no email,
profile, proof, token or session anchor. The browser selects two existing
different identity tuples, then sends `{removedIdentity,retainedIdentity,consent:true}`
to `POST /api/v1/account/identity-credentials/unlink-intents`. The named intent's
`/upstream-proof/begin` accepts `{consent:true}` and returns a provider navigation
URL. Its verified callback returns `proof_receipt` and `unlink_intent_id`;
`/{intentId}/complete` accepts only `{receiptId,consent:true}`. These new mutating
routes require the exact issuer Origin and host-only current issuer/unlink
browser cookies. A retained social credential is supported; retained passkey
proof is not implemented in this intent flow.

Unlink does not split an account or a wallet. Reversing an active mistaken merge
requires reviewed owner recovery acknowledgements and preserved before-images.
A consented operation that was never activated uses separate reviewed
pre-activation abort semantics: prove no source alias exists, acknowledge rollback
of partial external changes and original pending-intent custody, atomically
remove only its own fences and advance authentication generations. Expired proof
alone never activates or releases a fence. Receipt assurance, timing and immutable
references remain identifiable in the append-only decision audit.

## Private financial-source protocol v1

This source contract does not grant payment authority or expose a public route.
The real Financial owner still supplies its challenge, Principal/payer decision,
same-primary command acceptance and actual receiver. Missing qualification or
ports keep this lane unavailable. Existing direct owner/session and independent
exact-Org payment-key contracts are separate; a shared key never becomes direct
because an admission is missing. Customer existence does not authorize another
subscription, top-up or card-setup command.

Accounts owns `financial-source-contract.ts`. Core owns its local raw
Workspace/member/source facade and does not import the Accounts service. Hosted
implements this closed wire independently without a sibling source import.

An event has exactly `{v,eventRef,registrationRef,incarnation,sequence,
previousDigest,kind,affectedRef,evidenceRef}`, with `v=1`, kind `advance|close`,
safe integer sequence >=1 and opaque ASCII refs of 1–256 bytes. Digests are
`sha256:` plus 64 lowercase hexadecimal digits, distinct from existing opaque
Core or base64url owner-evidence digests. The enrolled source head starts at
sequence 0 with its actual qualified `genesisDigest`; there is no event at -1 or
0. First raw event has sequence 1 and `previousEventRef=null`; subsequent events
name the exact prior raw event. Closing an incarnation is terminal.

SQL captures immutable raw facts without an assumed SHA function. The trusted
upper Accounts materializer builds wire events in sequence. The event digest is
SHA-256 of UTF-8 canonical sorted-key JSON
`{domain:"takosumi.financial-source-event@v1",event:<exact event>}`. It performs no
Unicode normalization or foreign-digest conversion. Portable raw-event metadata
uses `{domain:"takosumi.financial-source-raw@v1",value:<exact raw metadata>}`;
its `rawEventDigest` is not the owning store's full raw snapshot digest.

For the closed literal fixture in `financial-source-contract_test.ts`, the
independently computed Python JSON/SHA-256 event vector is
`sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93`.
Key insertion order does not change these bytes; unknown keys, malformed refs,
unsafe sequence, missing predecessor or a changed incarnation are rejected.

The owning store's `putMaterialization` must atomically compare the exact raw
event ref/incarnation/sequence, **full original raw payload bytes** and captured
current head before create-if-absent materialization. An identical readback is
idempotent; a conflicting envelope fails. Raw payload and previously committed
materializations remain immutable. A batch handles at most 100 events, resumes
from durable original refs, and cannot skip an unmaterialized predecessor.

Local Control capture is a private same-primary snapshot of the original
Workspace, actual active member, immutable Org/ref and enrolled source head.
Accounts derives the actor from the genuine current client-bound grant before
and after the awaited capture; no caller account/payer assertion or closure is
transported across RPC. Exact post-await snapshot currentness is rechecked.

Source registration fixes an immutable complete set of 1–8 receiver/target refs;
descriptors alone cannot qualify them. An event's actual receipt has exactly
`{v,eventRef,eventDigest,receiptRef,incarnation,sequence,state}`. A close requires
`state=admission-closed`; advance requires `advanced`. Local custody additionally
pins the actual qualified receiver/target. Only exact Server-local commit and
readback can acknowledge an event; a sent request, elapsed timeout, materialized
digest or partial receiver page cannot. Acknowledgement closes new admission,
not an already authorized provider effect or an original unknown-ACK obligation.
This source-head receipt is not an identity-merge activation acknowledgement.
The actual Financial owner must separately prove original-operation coverage and
durable readback of all retained prepared/dispatched Org/owner/ref/key/realm
custody. It need not invent terminal provider results or drain every unknown.

`financial-source-abi.ts` fixes the private receiver ABI separately from codec
implementation revision 2: payload `v:1` and the original event vector stay
unchanged. `applySourceEvent({v:1,event,eventDigest})` recomputes the event digest
and returns the exact seven-field receipt after actual receiver commit/readback.
`readSourceEventReceipt({v:1,registrationRef,eventRef,eventDigest})` returns that
original receipt or actual `undefined`. Bare events, materialization envelopes,
strings, `null`, errors and missing fields are not alternate external forms.
Closed failures are `invalid-request`, `unregistered-source`, `conflict` or
`unavailable`; a transport failure never becomes receipt absence.

The external receipt reference is `fsr_` plus the lowercase SHA-256 hex digest
of canonical UTF-8 `{domain:"takosumi.financial-source-receipt-ref@v1",value:{
registrationRef,receiverRef,targetRef,eventRef,eventDigest,incarnation,sequence,
state}}`. Its context comes from actual fixed receiver registration, not caller
identity. Local receipt-record evidence uses exactly
`{domain:"takosumi.financial-source-receipt-record@v1",value:{registrationRef,
receiverRef,targetRef,receipt}}`, with the `sha256:` hex prefix. These recipes
are distinct from Customer keys and processor fingerprints. Computing a hash
does not acknowledge a commit. Internal Financial bare/null adapters must expose
the same external receipt recipe, not relabel a different receipt at the sender.

Registered head/genesis lookup is
`readRegisteredHead({v:1,head:{registrationRef,incarnation,affectedRef}})`.
One registration/incarnation may contain multiple original contexts; there is
no registration-only fallback or request-time genesis. The source interface
returns that exact key, original genesis, complete receiver/target set and actual
source schema, immutable credential-custody and clock-policy references. Separate
owning key-custody/clock ports supply current private capability context. Their
actual registration, key, target, binding graph and staging values remain
unconfigured here; consistent descriptor data cannot qualify them. The captured
adapter refuses absent ports/state and verifies the fixed target/receipt recipe
without remote function `.bind` property lookups.

The Financial-owned identity challenge is exactly
`{v,challengeRef,registrationRef,clientId,workspaceId,organizationId,workspaceRef,
requestFingerprint,createdAt,expiresAt}` with a maximum five-minute lifetime.
Here `registrationRef` belongs to the Accounts producer and all four Accounts
parent heads. A Hosted RP source has its own independently qualified
registration/incarnation/affectedRef; it must not require its registration to
equal the Accounts registration. The RP validates the complete returned
challenge and Accounts parent vector against that Accounts-owned registration,
while retaining its own source head separately.
The actual owned Financial reader supplies it; a browser cannot choose these
authority fields. The Accounts producer uses the real RP access grant, exact
registered client and current issuer/store/Control state. Its private proof is
identity/context evidence only, never a new Principal or payment consent.
`requestFingerprint` is an opaque Financial-defined, versioned pre-Customer
public-request identity. Top-up's full processor fingerprint is generated after
Customer pinning, so requiring that fingerprint here would create a cycle.
Accounts preserves the actual Financial challenge bytes and does not derive or
substitute that recipe, existing Customer fingerprint, original key or realm.

The private `createAccountsFinancialSource` producer reads the actual stored
access token and current shared-account grant. Its input carries only that
bearer and a challenge reference; the actual challenge owner supplies the
registered client, original Workspace/Org/ref and request identity. It checks
the current canonical account and authentication generation, active issuer
session/client, identity-only scope and exact Control snapshot. Resource grants,
caller-selected subjects and membership-derived payer authority are rejected.
The fixed parent vector is grant SID, stable issuer session, registered client
and account/authentication generation. These scopes are independent of a
challenge: retrying a challenge cannot create a second revocation ancestry.

Enrollment and proof writes require a transient, single-use in-process
checkpoint minted after the real grant/challenge/Control reads. It binds the
whole mutation, actual token hash, current grant/generation and original context
expiry. Each backend consumes its original object identity after asynchronous
preparation and rechecks its actual current token/identity rows immediately
before the local write. Fresh trusted time bounds both checkpoint and evidence;
copied objects, changed scope, elapsed validity and backwards clocks deny the
write. This is a local precommit boundary, not a cross-database transaction or a
claim about D1 server execution time.

The persisted proof also carries the actual captured Control source
registration/incarnation, permission sequence, original event reference (null
only at qualified genesis), materialized event digest and complete original
receiver/target set. A snapshot hash cannot be reversed into that vector. The
upper adapter derives these fields from the actual canonical Control head and
retains the full original snapshot for its currentness check. The Control
registration is distinct from the Accounts four-parent registration; a shared
name, caller descriptor or a role never substitutes one authority for another.

Revocation closes the appropriate fixed parent in the same local atomic update
as its actual grant/session/client revocation. A previously unenrolled scope
also retains a terminal closure fence, preventing a concurrent first enrollment
from reviving it. Successful merge/unlink security-generation mutations close
the previous account-generation parent under that same winner claim. Routine
issuer-cookie rotation does not close the stable session parent. Existing
unenrolled self-host behavior stays independent of this source lane.

The producer materializes retained raw events and delivers one bounded pending
page. A lost ACK is recovered by the same original event/ref/digest readback;
there is no new event, command or identity recipe on retry. A new identity proof
requires exact acknowledgements for all four current parents and every original
receiver/target. Its response contains only an opaque proof reference. The
proof is not a payer grant, Customer admission or provider-dispatch approval.
The existing `prove({accessToken,challengeRef}) -> {proofRef}` operation is
idempotent for the same **original request**, rather than for every request with
the same challenge. New issuers derive an opaque locator as `afp_` plus the
unpadded base64url SHA-256 of canonical UTF-8 JSON
`{domain:"takosumi.accounts.financial-proof-original-request@v1",value}`.
The value contains the full captured registration (including incarnation and
complete receiver set), full original challenge, actual issuer/subject/clientId,
SID, stable issuerSessionId, identityGeneration and original accessTokenHash.
Bearer bytes never enter the locator, durable record or log. This locator is
not an authority claim; event/receipt and Customer recipes are unchanged.

An original-record census selects retained proofs by Accounts registration,
challenge reference and original access-token hash, then validates the complete
original caller/challenge, four parents, Control source vector and current ACKs.
Exactly one matching original retains its original random or deterministic ref;
multiple or inconsistent originals refuse issuance. A lost issuance reply or
conditional-write conflict causes a fresh original-input readback, not a new
write/key/vector. The returned proof's original issuedAt/expiresAt and Control
bounds are never renewed by a fresh observation wrapper. A properly refreshed
different token is a separate original request and can issue a separate proof.
It cannot replace an already accepted/unknown Financial command's original
proof, key, fingerprint or custody.

New same-input writers arbitrate on the existing deterministic proof primary
key. The original-record census introduces no new JSON index or physical
schema; PostgreSQL snapshot `NOT EXISTS` alone is not that arbitration. Existing
random history is neither rewritten nor erased. Global retry qualification also
requires actual all-old-writer drain/fencing: an old writer can still create a
new random key, and a local marker cannot prove its absence. A census result
limit bounds the returned count, not database rows scanned; incomplete/error
reads fail closed. Expired or revoked originals remain historical custody and
cannot be reissued as fresh permission by retrying the same input.

The private proof reader has exact `{v:1,proofRef,challengeRef}` arguments.
`loadFinancialIdentityProof` returns `{v:1,status:'found',proof}` or
`{v:1,status:'not-found'}` and preserves the original after expiry/closure.
`verifyCurrentFinancialIdentityProof` returns
`{v:1,status:'current',proof,observedAt}` or `{v:1,status:'not-current'}` after
actual token-hash, grant, client/account/generation, Control and complete source
ACK checks. Its public projection excludes internal token hashes/expiry fields
and parent lookup scopes. Current verification is an observation; Financial
still checks the original vector, class and genuine payer at its L1/L2 command
CAS. Historical load grants no new permission and is never replaced by fresh
auth when recovering the original accepted/unknown command.

The optional `loadFinancialSourceEventEvidence({v:1,eventRef,eventDigest})`
reader returns `{v:1,status:'found',materialization:{event,eventDigest},
registeredHead}` or `{v:1,status:'not-found'}`. It reads the original persisted
materialization and full local raw record, recomputes the existing event digest
and checks the original predecessor, enrolled genesis and complete peers. It
does not enroll, materialize, dispatch or write during the read. The outward
projection excludes raw metadata, parent/cause, token hashes and internal
scopes. Not-found describes missing materialization; it is neither legacy
history clearance nor an admission or permission to create a fresh command.

Its fixed private composition supplies source credential/schema references,
receiver/target/schema, actual registered-head and credential-custody readers,
and a trusted clock. The distinct `event-evidence-read` capability is checked
before not-found as well as before a found result. Missing qualification,
genesis, mismatched full head/peers, expired context and backward clock fail
closed. Existing `event-apply` and `receipt-read` purposes are unchanged.

`createAccountsFinancialControlSource` connects the same canonical
`WorkspacesService.financialSource` facade. Captures retain the original Core
snapshot privately; copied or modified snapshots do not acquire provenance.
Its bounded outbox page maps full retained raw records through the Accounts
codec and uses the full captured Core head CAS. Original receiver readback
precedes delivery, and all original receiver/target receipts use the same
eight-field recipe. The C event reader uses a separate fixed C registration
and qualification context; the Financial owner selects the qualified source
binding. It never prefix-searches or falls back between Accounts and Control.
Named service transport, actual source registration/enrollment, receiver graph,
Financial Principal/payer producers and live qualification remain separate
owning composition work; this module has no public route or affirmative default.

## Protected rollout

See [the operator runbook](../operations/shared-account-oidc.md). PostgreSQL
migration 045 adds nullable metadata/private identity records. Ordinary readers
and writers remain compatible with protected head 044. Accounts D1 version 5
adds indexes to existing document storage, preserves exact v0–v4 lineage and
does not rewrite account IDs, Workspace/member data, ledger or resource FKs.
The ordinary bridge supports exact v4/v5 closures. Cloudflare shared mode
requires `TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY=true`, `predeployed` schema
mode and exact verified v5; request handlers never apply that migration.
