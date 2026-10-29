# Dedicated shared issuer on staging

The official rehearsal issuer is `https://auth-staging.takos.jp`, served by
`takosumi-auth-staging`. This is a separate Takosumi-owned Accounts entry,
not an alias for the app Worker or a Takoserver gateway. No selector in this
runbook accepts `auth.takos.jp`, a production Worker, or a production RP.
Source capability and local tests do not prove a live issuer or launch readiness.

The entry serves identity/OIDC, the Accounts account facade and the narrow
issuer sign-in and context-confirmation portals. It does not mount the dashboard, product Core APIs,
internal runner APIs or static assets. Accounts uses the existing protected
Accounts D1. The lazy `createInProcessDeployControlSeam(env).operations()` port
uses the same physical canonical Control D1, R2 resources and remote Durable
Object namespaces as the existing staging app Worker. It does not create a
second Workspace, membership or billing directory. Owner billing and merge ACK
adapters remain separately configured authority; absence fails closed.

## Protected migration and activation order

Preserve the original app staging config, source and provider rollback identity.
It is a historical baseline, not a config for the dedicated issuer. Neither
database is disposable simply because its environment is staging.

1. Merge the complete reviewed issuer/Control candidate after exact-head QA and
   its portable owner gate. Publish the reviewed ordinary compatible bridge
   with the shared profile **off** using the app's owning release lane.
2. Apply and verify the additive Accounts transition using the sole Accounts
   catalog/CLI. Run Control's own reviewed migration lane separately. The
   dedicated issuer accepts only exact checksummed Accounts v5 and the current
   canonical predeployed Control v75 catalog, including its physical Financial
   source hooks. The profile-disabled ordinary bridge supports exact Accounts
   v4/v5 and Control v71/v72/v73/v74/v75 before and after the additive transition.
   Ordinary Control readiness has a v71 floor; billing-binding ports require
   v72, identity reconciliation v73, and indexed Backup reads v74 with exact
   index shapes. Financial source operations require current v75 and its hooks.
   The v74 Backup indexes do not change identity authority or add a PostgreSQL
   migration. The corresponding protected Control expansions are PostgreSQL
   119/120 and Financial source 121; Accounts 045 is a separate lineage. Keep
   request/cold-start DDL disabled. Publish the profile-disabled compatible
   bridge on the existing catalog before applying any new schema; ordinary
   startup must not require v75 or the dedicated issuer's Accounts v5 transition.
3. Create the inert dedicated Worker slot. It has no stores, secrets, issuer or
   cookies, no routes, and disabled workers.dev/previews. Existing Workers are
   never overwritten by bootstrap.
4. Independently review and activate the exact stage authority/config closure
   on that route-less slot, including stable signing material, preserved salt
   and subject secrets, and distinct downstream credentials. This does not
   attach the auth domain.
5. Independently review the topology closure, configure and read back only
   `*/1 * * * *`, then attach the exact stage domain after schema, physical
   resource and immutable Version readback. No code release changes schedules.
   Run authenticated browser/RP E2E separately; discovery or DNS/TLS alone is
   not sufficient. Production remains awaiting operator approval.
6. Before enabling real merge readiness, qualify every official product's RP
   cutover and its shared authentication boundary on the primary origin and all
   Worker/preview aliases. Legacy human credentials must not bypass account
   fences; independent operator/Run credentials keep their actual owned actor
   checks. Obtain real financial, consumer-intent and RP custody receipts under
   the original operation keys. A flag or owner-ready boolean alone does not
   establish that release/configuration/topology closure.

Shared-profile activation cannot be the first bridge artifact on a v4 database.
A v4-only source build fails closed before serving dedicated account/OIDC paths.
An additive migration can still invalidate an old strict runtime: use the
schema owner's compatibility window, not an assumed code rollback.

## Context confirmation

After both original operation-bound provider proofs, the authenticated browser
can open `/identity-merges/{operationId}/contexts`. No token or proof receipt is
placed in that URL. The page displays the server-owned plan, canonical A personal
anchor and separate retained Workspace/Organization contexts. Each original leg
must accept with its own current issuer session. The configured other provider
link performs an ordinary same-browser login rotation and resumes this exact
operation; it does not claim a new password or MFA event. Final consent is
available only after both context acceptances and under the target session.

The default source composition has a real local Control adapter but no real
financial/consumer/RP adapters. Final consent therefore remains unavailable
before reservation. A pending result is not success; the page reports completion
only when the Accounts API returns `active`. The initial supported case requires
two existing unshared personal contexts. See the [private reconciliation
contract](../internal/control-identity-reconciliation.md) for preserved IDs,
inventory refusals and reviewed recovery.

## Private target and credential custody

The owning entry is `bun run deploy -- <surface>`. The surfaces are:

- `takosumi-auth-staging-bootstrap`: creates the inert slot only.
- `takosumi-auth-staging-authority`: config/registration/secret activation with
  independent review. On a route-less slot the domain stays disabled; on an
  already served issuer the reviewed change replaces its authority in place,
  keeps the domain and retry schedule, and is read back publicly. It must keep
  the signing key, pairwise and subject secrets and session salt: every Version
  records their digest, and a served change refuses a different one. A
  predecessor from before that digest can be replaced once with an unchanged
  signing key id, and keeping its other identity secrets is an explicit review
  obligation of that change. The served public key set (key id and previous
  public keys) is kept the same way. Replacing the signing key or session salt
  of a served issuer is a separate reviewed mode of this surface; see
  [Rotating an exposed signing key or session salt](#rotating-an-exposed-signing-key-or-session-salt).
- `takosumi-auth-staging-code`: subsequent code bytes with unchanged authority
  digest, physical stores, registered clients, secret custody and topology.
- `takosumi-auth-staging-topology`: the exact dedicated domain attachment.
- `takosumi-accounts-d1-schema-staging`: guarded delegation to the existing
  Accounts migration CLI; it is not a second DDL writer.

`--contract` describes obligations without reading credentials or mutating a
provider. For the four Worker/domain surfaces, `plan` and `apply` accept exact
`--target` and `--canonical-config` paths. `apply` also takes `--confirm`; all
authority/topology steps require `--reviewer`, and code/authority take
`--secrets`. Only the authority surface accepts the rotation arguments
`--rotate-identity`, `--previous-secrets`, `--confirm-rotation`,
`--acknowledge-session-invalidation` and `--retire-previous-key`. Unknown
arguments, source overrides and environment overrides are refused. All input files are absolute physical single-link files, mode 0600,
outside Git repositories. Keep them in operator-private mode-0700 custody;
do not commit realized IDs, credentials, config or release evidence.

The target is the closed `takosumi.auth-staging-target@v1` JSON shape defined
in `scripts/auth-staging-release.ts`. It pins the merged source, account/zone,
current canonical staging Version, exact original canonical config digest,
private secret bundle digest, expected public JWKS digest and plain variables.
Resource IDs are derived from that config and compared with the **currently
serving** canonical staging Worker's immutable Version. Hashing two mutually
consistent caller files is not a substitute for that provider identity proof.

The issuer's lazy Control operations port (shared-Workspace directory and
identity reconciliation) constructs the canonical Control service, which refuses
to start in staging without a secret-store key and an Interface API guard token.
`TAKOSUMI_SECRET_STORE_PASSPHRASE` and `TAKOSUMI_DEPLOY_CONTROL_TOKEN` are therefore
required issuer secrets: random 32-byte values owned by the issuer, distinct from
every other secret. The issuer never reads or writes the platform's encrypted
secret blobs, and its in-process Interface API is not reachable over HTTP.

The Takoserver RP callback needs `GET /api/v1/account/shared-workspaces/:id/billing-organization`.
Its Workspace billing Organization follows Financial's
`takoserver.workspace-billing-organization@v1` contract. The issuer does not
create the Organization; it derives `organizationRef = "org_wb_" + the first 32
hex of SHA-256(JSON.stringify(["takoserver.workspace-billing-organization@v1",
billingAuthority, workspaceRef]))` and records that binding in Control. The RP
recomputes the same reference and creates the Organization in its own fresh
issuance. The staging target pins `TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY`
to Financial's TEST realm value `takoserver.hosted.staging-test.v1`.

The secret bundle is a JSON object containing exactly the reviewed required
binding names. Its values never appear in arguments, logs or public metadata.
Code releases reuse the exact pinned bundle rather than inheriting secrets from
an unqualified latest uploaded Version. Initial setup does not rotate existing
stage credentials. New session/identity secrets must retain their durable
custody for later releases. Private P-256 signing JWKs are imported and verified
locally before mutation; the public readback must match the expected public key
set. Downstream stage client secrets are separate random 32-byte base64url values.

The two registrations are fixed:

| Client | Exact callback |
| --- | --- |
| `takosumi-hosted-staging-v1` | `https://app-staging.takosumi.com/auth/oidc/callback` |
| `takoserver-console-staging-v1` | `https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev/auth/oidc/callback`, `https://integration-root-ga-573f46e4.shoutatomiyama0614.workers.dev/auth/oidc/callback` and `https://integration-root-ga-9d9c84f4281649c884e0579d93e5c926.shoutatomiyama0614.workers.dev/auth/oidc/callback` |

Both use enabled `shared-account`, Basic, S256 and only
`openid email offline_access`. Metadata references independent secret bindings.
The Server callback belongs to the API Worker that owns the host-only RP session;
the static Console origin is a post-login navigation target, not the callback.
The upstream Google/GitHub descriptors explicitly pin their protocol and
verification profile and `https://auth-staging.takos.jp/oauth/upstream/callback`.
Each upstream secret is an explicit, distinct `clientSecretEnv` reference in the
operator descriptor, with a bounded upstream secret-binding name. The release
secret set is derived exactly from those descriptors and the issuer/client
secrets; there are no fixed global provider credential slots or implicit fallbacks.
They require actual stage provider registration and secret custody; no production
descriptor or guessed console origin is a fallback. Optional passkeys pin the
same stage RP ID/origin. The issuer and product cookies remain separate and
host-only; authenticated E2E must verify cookie attributes, current claims,
revocation, client separation and existing Workspace authority.

Schema commands are `plan`, `backup-status`, `status`, `verify`, `apply`.
The wrapper fixes environment/DB/source and forwards only canonical CLI evidence
and confirmation options. `apply` additionally requires a named independent
reviewer and `--rehearsal-digest`; the owner CLI requires private backup evidence
and exact source/catalog/target/config digests. There is no down/reset command.

## Rotating an exposed signing key or session salt

Use this when the issuer's ES256 signing key or session hash salt may have been
exposed, for example in a transcript or log. An ordinary authority release on
the served issuer refuses a different identity (`auth_staging_identity_continuity_changed`)
or a different public key set (`auth_staging_jwks_continuity_changed`). Do not
work around that by detaching the domain or the retry schedule by hand: the
rotation mode below is the only supported path.

What can rotate:

- `signing-key` (`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`): the new key signs every
  ID token from activation. Public JWKS keeps the previous public key for
  verification only, until a later retirement step removes it. Subjects and
  sessions do not change.
- `session-salt` (`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`): **every issuer account
  session ends at activation and every user must sign in again.** Session rows
  are found by a salted hash, so existing session cookies stop resolving. Work
  that needs the current issuer session, such as an identity merge leg, also
  needs the new sign-in. RP refresh grants (keyed by `sid`), access tokens and
  personal access tokens are not keyed by the salt. They stay valid until they expire or are revoked. The
  apply step requires `--acknowledge-session-invalidation`.
- Both in one reviewed change: `--rotate-identity signing-key,session-salt`.

The pairwise subject secret and the subject secret never rotate here
(`auth_staging_identity_rotation_subject_refused`). They derive every RP `sub`
and upstream account link, so replacing them creates a new identity rather than
rotating one.

### Preconditions

1. The served Version records `TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST`. A
   predecessor from before that digest first takes an ordinary authority release
   with its current bundle (`auth_staging_identity_rotation_predecessor_unrecorded`).
2. The served Version runs the same source commit and artifact digest that the
   rotation uploads. A rotation changes identity only
   (`auth_staging_identity_only_code_changed`). First serve the merged commit
   that contains this mode through `takosumi-auth-staging-code`, using the
   served target with only `sourceCommit` changed and the served bundle.
3. The served target and the served bundle (the one the issuer runs now) are in
   private custody. The lane reads the served bundle to prove the served
   identity and to check that nothing else changes. It prints digests, never
   values.

### Prepare the new files

Keep both new files mode 0600 in private custody outside Git, like every input.

- **New bundle**: copy the served bundle and replace only the rotated values:
  a newly generated P-256 private JWK, and/or a new random 32-byte base64url
  salt. Never reuse material that appeared where the exposure happened. Every
  other value stays byte-identical
  (`auth_staging_identity_rotation_non_identity_changed`,
  `auth_staging_identity_rotation_scope_exceeded`).
- **New target**: copy the served target and edit these fields in place:
  - `secretsSha256`: the SHA-256 of the new bundle file.
  - For `signing-key`: `vars.TAKOSUMI_ACCOUNTS_ES256_KEY_ID` set to a new,
    distinct key id. `vars.TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS` set to
    `{"keys":[...]}` containing the served public key: the
    `kty`/`crv`/`x`/`y`/`kid`/`use`/`alg` entry that
    `https://auth-staging.takos.jp/oauth/jwks` serves now, with no `d`.
    `jwksSha256` set to the digest of the new public key set (new key plus
    previous keys). `plan` refuses a mismatch with
    `auth_staging_signing_configuration_invalid`.
  - `sourceCommit`: the commit the served Version runs (precondition 2).
    `canonicalStageVersionId` and `canonicalStageConfigSha256` name the current
    canonical staging Version, as for any release.

  Change nothing else and keep the variable order. The lane recomputes the
  served authority digest from this target with only the identity fields
  substituted. Any other difference is refused
  (`auth_staging_identity_only_authority_changed`).

### Plan, review, apply

`plan` stays local. With `--rotate-identity` it also reads both bundles and
prints an `identityRotation` block. That block contains `rotate`,
`fromContinuityDigest` (served), `toContinuityDigest` (new), `signingKey`
(`fromKid`, `toKid`, the published kids and the minimum overlap), `sessions`
(`all-invalidated` or `preserved`), the plain `statement` of consequences and
the rotation `confirmation`.

```bash
bun run deploy -- takosumi-auth-staging-authority plan \
  --target /private/auth-staging/target.rotated.json \
  --canonical-config /private/auth-staging/takosumi-staging.toml \
  --rotate-identity signing-key,session-salt \
  --secrets /private/auth-staging/secrets.rotated.json \
  --previous-secrets /private/auth-staging/secrets.served.json
```

The independent reviewer checks the plan `confirmation` and the statement.
They also check that `fromContinuityDigest` equals the served Version's
`TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST` binding, and they check the kids.
The rotation confirmation has the form
`rotate-identity:<scopes>:<served digest>:<new digest>`, so approving it means
approving both digests.

```bash
CLOUDFLARE_ACCOUNT_ID=<stage account id> \
bun run deploy -- takosumi-auth-staging-authority apply \
  --target /private/auth-staging/target.rotated.json \
  --canonical-config /private/auth-staging/takosumi-staging.toml \
  --rotate-identity signing-key,session-salt \
  --secrets /private/auth-staging/secrets.rotated.json \
  --previous-secrets /private/auth-staging/secrets.served.json \
  --confirm <plan confirmation> \
  --confirm-rotation 'rotate-identity:session-salt,signing-key:sha256:<served>:sha256:<new>' \
  --reviewer '<independent reviewer>' \
  --acknowledge-session-invalidation
```

For a signing-key-only rotation, use `--rotate-identity signing-key` and omit
`--acknowledge-session-invalidation`; the lane refuses that flag without a salt
rotation. For a salt-only rotation, the key id and previous public keys stay as
served.

Before the single upload, `apply` uses only read requests. It checks these
points:

- The issuer is served.
- The served Version records exactly `fromContinuityDigest`.
- The served key id is the key the new JWKS keeps as previous, and no previous
  key that was not served is added.
- The served Version runs the same source and artifact.
- Its authority digest recomputes from the new target, with the served key id,
  previous keys, public key set and served bundle digest substituted. This
  proves that every other variable, registration, resource, secret, placement
  and schedule, and the pairwise and subject secrets, are unchanged.

After the upload, the Version must record `toContinuityDigest` before
activation. Public readback must then serve the new public key set. Otherwise
the run reports `incomplete` with `auth_staging_jwks_identity_mismatch`.

Success reports `identity-rotated-served` with both digests, the session
outcome and `signingKey.retireNotBefore`. From then on the rotated target and
bundle are the served custody: ordinary code and authority releases use them,
and the exposed bundle is refused (`auth_staging_identity_continuity_changed`).
No later step needs the exposed bundle. Rotating the key and the salt in
separate runs is also valid. Each run uses the bundle being served at that
moment as `--previous-secrets`.

### Overlap and retirement

The ES256 key signs only ID tokens, which live 300 seconds for the
shared-account clients, and the issuer never verifies its own tokens. The
previous public key therefore only lets an ID token signed just before
activation still verify at its RP. An RP that caches JWKS learns the new key id
only when it refetches; keeping the previous key does not change that.

`--retire-previous-key` removes previous public keys no sooner than 15 minutes
after the serving deployment's `created_on`. A later deployment restarts that
wait, and a missing or future timestamp is refused
(`auth_staging_previous_key_overlap_unverifiable`). **For an exposed key, retire
as soon as the minimum has passed.** While the previous key is published, a
token signed with the exposed key still verifies. An RP that cached the overlap
JWKS keeps accepting it until its cache expires, and the issuer cannot shorten
that.

The retirement target is the rotated target with
`TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS` removed (or reduced to the keys
being kept) and `jwksSha256` recomputed. The bundle is unchanged. The kids
given must be exactly the removed ones.

```bash
bun run deploy -- takosumi-auth-staging-authority plan \
  --target /private/auth-staging/target.retired.json \
  --canonical-config /private/auth-staging/takosumi-staging.toml \
  --retire-previous-key <previous kid>
CLOUDFLARE_ACCOUNT_ID=<stage account id> \
bun run deploy -- takosumi-auth-staging-authority apply \
  --target /private/auth-staging/target.retired.json \
  --canonical-config /private/auth-staging/takosumi-staging.toml \
  --secrets /private/auth-staging/secrets.rotated.json \
  --retire-previous-key <previous kid> \
  --confirm <plan confirmation> \
  --reviewer '<independent reviewer>'
```

Retirement recomputes the served authority digest the same way and refuses any
other change. An ordinary authority release cannot drop a published previous
key (`auth_staging_jwks_continuity_changed`). Success reports
`previous-key-retired-served`.

### Failure, reversal and related custody

Every refusal above happens before the upload and leaves the served issuer
untouched. After the upload, the usual `incomplete` report applies, and nothing
is retried. Restoring the predecessor Version re-serves the exposed key or
salt, and sessions created after a salt rotation end again. After an exposure,
repair forward with another reviewed rotation instead.

The staging platform Worker `takosumi-staging` binds the same Accounts D1. On
handler-owned extension routes it refuses issuer bearer credentials, hashing
them with its own `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`. Its canonical config
also names its own issuer, `https://app-staging.takosumi.com`. If that Worker
holds the same exposed signing key or salt, this rotation does not change them.
Rotate them through that Worker's owner lane. Until then, its handler-route
refusal stops recognizing new issuer sessions; access tokens and personal
access tokens are unaffected.

Production has no separate auth Worker. The production platform Worker serves
Accounts OIDC itself and composes the same `deploy/accounts-cloudflare/src/handler.ts`.
So the runtime JWKS overlap (`TAKOSUMI_ACCOUNTS_ES256_KEY_ID` plus
`TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS`) and the session-salt effects are
the same code path there. This lane's rotation mode, continuity digest and
retirement step are not: the production platform release pins only secret
names, and the operator sets the values. Production issuer rotation is out of
scope here and needs its own reviewed procedure.

## Readback and recovery

An upload and its activation are attempted once. Before activation, immutable
Version metadata must match the exact resources, remote DO namespace IDs,
runtime compatibility settings, exact `fetch`/`scheduled` handlers, plain
variables and secret names. The same cached per-environment retry service is
used by consent admission and the scheduled handler; absent actual owner
readiness denies consent before reservation. The configured financial owner
remains a separate required adapter, not a fabricated ACK. The trusted owner
composition supplies `retryAuthorityContextDigest`, a nonsecret SHA256 fingerprint
of its actually qualified authority/configuration. Consent also requires a
successful scheduled heartbeat in the existing Accounts checkpoint within
120 seconds, matching that context and `TAKOSUMI_VERSION_METADATA.id`. No missing
or invalid context, readiness probe, owner-ready boolean, private retry, schedule
readback or manually invented evidence may mint that heartbeat. Login and
existing pending retry/recovery remain available when admission is refused.

[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
may take up to 15 minutes to propagate. After topology/version changes, verify
an actual matching scheduled completion before attempting merge qualification;
a five-minute proof must never be reserved based on cron configuration alone.
Serving deployment readback requires exactly one Version at 100 percent.

The issuer's directory, token and grant paths make many sequential reads of
the Accounts D1, whose primary runs in Singapore, while callers reach the
Worker in their nearest colo. Every authority and code upload therefore sends
[targeted placement](https://developers.cloudflare.com/workers/configuration/placement/)
`region = "aws:ap-southeast-1"`, and the authority digest binds it. Before
activation, the uploaded Version must report `resources.script.placement` as
`{mode: "targeted", target: [{id, region: "aws:ap-southeast-1", type: "region"}]}`
(the shape the provider returned on 2026-10-22; the field is not in the API
reference). After activation, `GET /workers/scripts/takosumi-auth-staging/settings`
must report `{mode: "targeted", target: [id]}` with that same target id. Any
other shape stops before activation, or leaves the release incomplete rather
than ready. Placement only moves the `fetch` handler, never
RPC or named entrypoints, and it is a hint for where Cloudflare runs the Worker,
not a guarantee. The Control D1 primary is in a different location, so judge
the effect by comparing whole bootstrap and grant timings before and after
under the same conditions. Because the authority digest binds placement, an
already served issuer first takes it through the reviewed authority lane; the
code lane refuses that digest change until then. Restoring a predecessor Version
from before this change also removes the placement.

Topology readback requires the exact stage domain with previews disabled,
workers.dev/previews disabled, the exact one-minute retry schedule, and no
unrelated Worker routes. Schedule APIs use the documented `{schedules:[...]}`
response. See [Cloudflare schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/).
Cloudflare's
default service-environment label `production` in its metadata is distinct from
the selected `takosumi-auth-staging` Worker and staging origin.

Public checks use `/healthz`, `/readyz`, OIDC discovery and public JWKS. They
require the serving Version header, no cookie on those read-only paths, exact
issuer/endpoints, the selected public keys and exact schema readiness. The
sign-in portal and authenticated product login/refresh/logout/merge E2E are
separate requirements. Merge activation additionally needs real owner ACK and
durable retry adapters; a missing adapter is never replaced by a no-op ACK.

Pre-mutation refusal leaves the target untouched. After any attempted provider
mutation, timeout or lost acknowledgement, the entry reports `incomplete`,
retains known predecessor/uploaded identities, and does not retry. Inspect
provider Version/deployment/schedule/domain history before explicit repair. An
explicit later topology invocation can adopt an already applied exact approved
cron after readback without repeating its PUT; arbitrary schedules are refused.
A provider
rollback is usable only while its schema and authority remain compatible;
otherwise retain the schema owner's boundary and repair forward. No step
deletes a Worker, destroys data, rewrites history or switches a production route.
