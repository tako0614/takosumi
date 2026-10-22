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
  obligation of that change.
- `takosumi-auth-staging-code`: subsequent code bytes with unchanged authority
  digest, physical stores, registered clients, secret custody and topology.
- `takosumi-auth-staging-topology`: the exact dedicated domain attachment.
- `takosumi-accounts-d1-schema-staging`: guarded delegation to the existing
  Accounts migration CLI; it is not a second DDL writer.

`--contract` describes obligations without reading credentials or mutating a
provider. For the four Worker/domain surfaces, `plan` and `apply` accept exact
`--target` and `--canonical-config` paths. `apply` also takes `--confirm`; all
authority/topology steps require `--reviewer`, and code/authority take
`--secrets`. Unknown arguments, source overrides and environment overrides are
refused. All input files are absolute physical single-link files, mode 0600,
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
| `takoserver-console-staging-v1` | `https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev/auth/oidc/callback` and `https://integration-root-ga-573f46e4.shoutatomiyama0614.workers.dev/auth/oidc/callback` |

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
`region = "aws:ap-southeast-1"`, and the authority digest binds it. After
activation, `GET /workers/scripts/takosumi-auth-staging/settings` must report
that exact region; a missing or different placement leaves the release
incomplete rather than ready. Placement only moves the `fetch` handler, never
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
