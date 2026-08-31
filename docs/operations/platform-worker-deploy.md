# Takosumi platform worker deployment

This runbook covers the OSS Takosumi platform worker, including the official
Takosumi service. The official composition runs this repository's ordinary
worker and connects optional commercial products through the public
`PlatformExtensionRoute` plus private service bindings. It does not use a
Takosumi hosted service wrapper.

The official Worker entry is `deploy/platform/entry-worker.ts`. A release is
not ready merely because Wrangler uploaded bytes: the owner reads the immutable
Version back and requires the exact expected binding closure.

This page documents the commands the platform worker deploy actually runs.
A self-hoster applying them against infrastructure they own is exercising their
own authority. The official operator uses the same owner entrypoint with
realized config held outside this repository.

The shared deploy rules — clean worktree, owner gate first, build from that
worktree, prove it on production's own inputs before the irreversible step,
readback plus one real authenticated request, never blind-retry — are in
`takos-control/engineering.policy.json` → `deploy`. This Worker surface never
carries a control-ledger schema mutation. Official control D1 changes use the
separate `takosumi-control-d1-schema-staging` and
`takosumi-control-d1-schema` irreversible surfaces.

## Composition

The OSS HTTP implementation is `deploy/platform/worker.ts`; the deployable
module entry is `deploy/platform/entry-worker.ts`. One operator-managed platform
worker composes Accounts, the Git/OpenTofu control plane, dashboard assets,
runner dispatch, and the Interface/InterfaceBinding API. Canonical resources
include the Accounts/control databases, source/artifact/state/backup stores,
Run queue, coordination/run-owner Durable Objects, and an OpenTofu runner.

`deploy/platform/wrangler.toml` is a placeholder reference. Realized bindings,
origins, IDs, and secrets belong to operator state outside the repository.
Operators may wrap this composition through the documented generic extension
and port seams; the OSS config must not name a closed handler as a dependency.
The worker does not install or host a Form Registry, FormActivation, or hosted
Form. Any such closed Cloud Host is deployed and operated by its owning
repository; the old package procedure is a superseded migration note.

The official staging composition binds the independently deployed private
`takosumi-hosted-staging` Worker under `HOSTED`. It mounts the account service at
`/api/v1/account/subscription` and the authenticated AI data plane at
`/api/v1/ai`; Marketplace, cloud Resource, wallet, migration, and object-storage
APIs remain Takoserver-owned and are not exposed as separate Takosumi APIs.
Takosumi authenticates the Principal and Workspace before forwarding. The
route-less Hosted target receives only verified context, never a browser cookie,
the original bearer, an account id, a legal Organization id, or an unverified
Workspace context.

## Official staging release

The official staging target is a reviewed two-step owner surface. Plan is
read-only: it requires clean pushed source, reproduces the environment-specific
dashboard build twice, seals every physical output path/size/digest, validates
that the external config points at that same worktree, seals the metadata-only
secret-name inventory and exact serving predecessor, and seals Wrangler's
strict immediate-rollout dry-run output tree in an external, non-worktree
release closure. It also reads and seals the exact healthy predecessor
Container application identity, immutable image, version, rollout state, and
instance health. A second sealed closure projects only that image literal back
to the predecessor digest for reviewed restore.

```bash
umask 077
export TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR=\
/absolute/durable/operator-private/takosumi-target-authority
mkdir -m 0700 "$TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR"

bun run deploy -- takosumi-platform-staging plan \
  --config /absolute/operator-private/wrangler.staging.toml \
  --plan-out /absolute/non-worktree-release-state/release-plan.json

bun run deploy -- takosumi-platform-staging execute \
  --plan /absolute/non-worktree-release-state/release-plan.json \
  --confirm sha256:<reviewed-plan-digest> \
  --review operator:<reviewer> \
  --evidence /absolute/non-worktree-release-state/release-evidence.json
```

Execute rechecks the exact source, config, secret names, complete dashboard
tree, and dry-run tree. It copies that closure with stable no-follow reads into
fresh external single-link upload custody, then deploys the custody dry-run
entry with `--no-bundle` and its exact projected config. Custody is re-sealed
immediately before and after upload, so upload does not re-read the retained
plan tree, live checkout, or ignored dashboard bytes. If no plan-derived
external checkpoint exists, it rechecks the
predecessor and fsyncs an `unknown` checkpoint immediately before the sole
`wrangler deploy --containers-rollout immediate --strict` command. The
checkpoint is derived from the physical plan and confirmation, not the chosen
evidence path, so an alternate output path cannot upload twice.

Execute parses exactly one `Current Version ID: <uuid>` from Wrangler's output,
records that accepted UUID in the checkpoint, and requires deployment status to
contain only that UUID at 100 percent. It reads the exact immutable Version back
and requires its nonce-bound plan-unique tag, message, required binding types,
configured Hosted service, and fetch handler. The public root and discovery
document must then emit that same UUID as `x-takosumi-version-id`; a cache hit,
50/50 split, unchanged predecessor, or concurrent Version cannot satisfy ready
evidence. Ready evidence also requires the unique Container list row and
authoritative detail to agree on the exact application id, name, version, and
immutable configured image. Wrangler's list row supplies the synthesized
application state; raw detail may omit that field, but must agree when it is
present. The result must have no active rollout and no failed, starting,
scheduling, or error entries.

If provider acknowledgement is lost, recovery lists the bounded recent Version
set and accepts exactly one post-plan Version carrying that unique plan tag.
Zero or multiple matches remain incomplete. The exact predecessor stays in the
plan and ready evidence for rollback.

Rollback is also owned by this surface; do not copy a printed Wrangler command
or bypass its checkpoint/readback boundary:

```bash
bun run deploy -- takosumi-platform-staging restore \
  --plan /absolute/non-worktree-release-state/release-plan.json \
  --confirm sha256:<reviewed-plan-digest> \
  --review operator:<reviewer> \
  --evidence /absolute/non-worktree-release-state/restore-evidence.json
```

Use `takosumi-platform` for production. Restore first consumes the sealed
image-only predecessor closure through a strict full deploy with immediate
Container rollout. Before that mutation it requires the live Container
application id and name to equal the reviewed plan and its image to be either
the reviewed forward image or predecessor image. An interrupted forward rollout
may be active or unhealthy at this pre-restore boundary; a changed application
identity or third image fails before the restore checkpoint and deploy. It
recovers a lost acknowledgement only from exactly one plan-tagged Version,
verifies that Version and the predecessor Container identity, image, settled
rollout, and zero-error health, then routes the exact predecessor Worker Version
alone at 100 percent. Separate fsynced `unknown` stages fence the Container
upload and Worker routing command. Ready restore evidence requires the public
predecessor Version plus the same exact healthy predecessor Container readback.
Failure evidence is derived from those stages: no restore checkpoint is
pre-mutation, an `unknown` or malformed checkpoint is post-mutation ambiguity,
and an accepted stage is post-mutation readback.

Every official forward execute/recovery, restore, and control-D1 schema
mutation for one environment/Worker first acquires the same target-scoped
inter-process authority. It lives under the explicitly configured durable
operator-private `TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR`, never under
`/tmp`, `/var/tmp`, `/run`, or `/dev/shm`. The directory must already exist,
be physical, caller-owned, mode `0700`, and outside every Git worktree. Every
plan seals its canonical path plus device/inode/birth-time/UID/mode identity
digest. The target file name is derived only from the exact official
environment and Worker name, so all plans in that authority root discover the
same unresolved owner. Its fsynced owner record binds the operation kind,
exact plan confirmation, canonical external checkpoint path, canonical file
identity, machine, PID namespace, boot, PID, and process start. A
post-checkpoint failure durably
changes that owner from `active` to `unresolved` without removing the lock.
The lock is held from each path's final live Version/predecessor check through
provider mutation and authoritative readback.
Thus a candidate forward deploy cannot replace the v66/v67 bridge between the
schema owner's last compatibility check and its released-v67 readback. This is
an enforced owner-surface boundary, not an operator instruction to serialize
commands manually.

A dead PID or an `unresolved` owner is not generic stale-lock authority. Every
real platform or schema `plan`, every new execute, and every different plan,
checkpoint, or operation kind fails with
`platform_worker_target_mutation_reconciliation_required`. Only the exact
forward `recover`, the exact reviewed restore invocation, or the exact schema
`recover` may replace that owner record. It must then reconcile its own durable
checkpoint against authoritative provider or D1 state; a failed reconciliation
retains `unresolved`, while successful readback removes the lock. After a host
reboot, a matching machine identity plus a changed boot ID proves only that the
old PID is dead; exact owner/checkpoint recovery is still required. A foreign
machine, malformed/torn owner, changed authority directory inode, or alternate
root fails closed. Never delete, rename, edit, or redirect this target authority
to admit another plan.

The whole restore state machine runs under one inter-process lock derived from
the checkpoint and confirmation, including every staged checkpoint transition,
provider command, and authoritative readback. The owner record is fsynced under
a private pending name and published with an atomic no-overwrite hard link; it
binds the machine, PID namespace, boot, PID, and process start identity. A live
owner excludes an alternate evidence-path invocation. Restore also rejects
canonical-path or inode aliases involving its plan, evidence, closures,
checkpoints, lock, or reserved pending-lock namespace before opening the lock.
After a crashed local owner is proven dead, the next invocation removes only
that exact lock inode, re-reads the canonical staged checkpoint, and follows its
existing lost-acknowledgement recovery path instead of starting another
restore.

A forward-only control D1 transition may permanently retire this plan's
predecessor restore. The schema owner binds the exact accepted bridge plan and
Version in its private compatibility proof. It accepts only the complete
`takosumi.platform-worker-release-plan@v5`: the platform validator binds the
environment, source commit, confirmation, external checkpoint, and predecessor
before schema derives this same restore lock or the retirement path. Under the
lock, schema refuses every malformed, partial, or `unknown` restore checkpoint.
Such a checkpoint must be reconciled by this official restore owner surface;
stale-lock reclamation does not prove a provider mutation was rejected. Only
then may schema fsync a plan-scoped retirement marker before its mutation
checkpoint. Official restore reads that marker under the lock before its first
Container upload or Worker routing checkpoint and fails closed if it exists or
is malformed. The marker is not an incident toggle: deleting it would revive a
known v66-only restore against v67 and is prohibited.

The platform and schema owners share one artifact-path graph before any
schema-surface durable output write. It covers canonical future paths and
existing device/inode identities for the platform plan/config, both sealed
closure trees and their configs/entrypoints, forward checkpoint, `.restore`
checkpoint, retirement marker, target mutation lock, restore lock and both
pending-lock namespaces, plus the schema plan/evidence/checkpoint/proof/receipt
and raw platform ready-evidence paths. An absent recovery filename is still
reserved and cannot be claimed as a plan or evidence output.

The authenticated Hosted subscription read is a separate E2E post-condition
after publication; cloud-resource and AI E2E run against Takoserver's owning
endpoints.

## Self-host build and deployment

Build and verify the OSS target from the product root:

```bash
bun install
bun run check
(cd dashboard && bun run build)
bun run docs:build
```

The dashboard build resolves the Store tab's default store from
`VITE_TAKOSUMI_TCS_STORE_URL`. Unset or empty means no default store for OSS
and self-hosted builds. An operator may set its own TCS server explicitly. The
official owner release path injects `https://store.takosumi.com` for production
and the isolated `https://store-staging.takosumi.com` for staging. Users can
still add store servers themselves.

Before deploying code that requires control-ledger v67, first deploy the
reviewed zero-downtime bridge from the exact serving v66 source. The bridge's
bounded `predeployed-bridge` verifier accepts only the exact v66 or exact
candidate v67 ledger. Normal `predeployed` remains strict to the current v67
catalog. After the bridge's platform ready evidence is retained, the official read-only
proof owner emits the private serving-compatibility proof:

```bash
bun run deploy -- takosumi-control-d1-bridge-proof-staging create \
  --predecessor-plan /absolute/private/staging-predecessor-plan.json \
  --predecessor-confirm sha256:<predecessor-plan-confirmation> \
  --predecessor-evidence /absolute/private/staging-predecessor-evidence.json \
  --bridge-plan /absolute/private/staging-bridge-plan.json \
  --confirm sha256:<bridge-plan-confirmation> \
  --bridge-evidence /absolute/private/staging-bridge-evidence.json \
  --confirm-patch sha256:<reviewed-canonical-patch-digest> \
  --review operator:<same-reviewer-as-bridge-ready-evidence> \
  --proof-out /absolute/private/staging-bridge-compatibility.json
```

Use `takosumi-control-d1-bridge-proof` for production. This producer validates
the complete v5 predecessor and bridge plans, both accepted forward
checkpoints, and both complete raw ready-evidence artifacts. The validated
predecessor deployment must be the bridge plan's exact predecessor Version.
Its source commit must be a Git ancestor of the validated bridge source commit,
their diff must be exactly the code-owned reviewed 20-path scope, and the proof
binds the SHA-256 of Git's deterministic full-index binary patch.
`--confirm-patch` must match that recomputation and `--review` must match the
independent bridge ready-evidence reviewer; the bridge commit author cannot be
that reviewer. The consumer repeats the repository calculation instead of
trusting the retained digest.

The producer also validates the exact live immutable Worker Version, D1
binding, and `TAKOSUMI_CONTROL_D1_SCHEMA_MODE=predeployed-bridge` binding. It then sends a
credential-free, cache-free random-nonce challenge and requires the physical v66
ledger's complete rows plus the code-owned exact v66/v67 allowset before one mode-`0600`
no-overwrite write. The proof retains the raw plan/evidence digests and raw
canonical challenge response/digest; the schema consumer validates those source
artifacts again. The challenge cannot establish source compatibility by itself.
Hand-authored compatibility JSON is not an owner artifact.

On exact v66 the bridge keeps ordinary authenticated control-plane routes
available but rejects explicit or sealed Interface-bearing Plan sidecars before
Apply dispatch, rejects Interface intent commit/restore writes, and makes intent
draining return no work. This avoids querying the v67-only
`capsule_interface_materialization_intents` table or mutating a provider without
durable intent authority. Exact v67 lifts those gates after physical ledger
validation and supports Interface commit/read normally.

The resulting proof is consumed by the
[Control D1 schema predeploy](control-d1-schema-predeploy.md) surface. The
schema plan and execute both bind the exact immutable bridge Version and fail
before mutation if the proof, accepted bridge plan, Version, or D1 binding
drifts. A two-field checkpoint/confirmation object is not a platform plan and
cannot establish this authority. Schema execute first holds the shared target
lock and then that bridge plan's restore lock across final prestate and
restore-checkpoint reconciliation, durable retirement of its v66-only
predecessor restore, the sole apply, and exact readback. Platform forward and
restore cannot enter their provider mutation/readback sections until schema
has finished this boundary.

Create the candidate platform plan **after** the bridge is serving. The plan
therefore seals that compatible bridge as its predecessor and restore target.
Then run staging schema rehearsal, production schema plan/execute, and exact
v67 readback before executing the candidate Worker plan. Keep the bridge as
the rollback floor through candidate readback. Once v67 commits, the old
v66-only Version is not a valid restore target; preparing the candidate plan
before the bridge would seal an invalid predecessor and is prohibited. The
schema transition permanently fences the old bridge deployment plan's restore;
the later candidate plan remains the valid rollback lane because its sealed
predecessor is the v66/v67 bridge. The Worker plan does not apply or release a
schema fence, and a first request must never create or repair the required
shape.

Accounts D1 v4 uses a separate one-time owner lane. First deploy the feature
bridge, which accepts only exact legacy v3 or exact checksummed v4 and performs
no request-time DDL in `predeployed` mode. Privately retain the current backup /
Time Travel bookmark, pass only its opaque evidence digest to
`accounts migrate-d1 apply`, confirm the backup-bound configuration digest,
complete its deterministic 100-row pre-ledger backfill, and read-only verify the
atomic v4 result. The v4 batch first re-fences the exact v3 ledger/schema
closure plus zero-missing. After
the observation window, deploy the separate exact-v4 tightening artifact. Once v4 commits, do
not roll code back to a v3-only artifact; the bridge is the compatible rollback
floor. Restore is a separate incident action and the migration CLI never invokes
it.

For a self-host/operator-owned Cloudflare reference deployment only, the
operator may use its own Wrangler config:

```bash
bun run wrangler -- deploy --dry-run --latest=false \
  --config "$TAKOSUMI_WRANGLER_CONFIG"
bun run wrangler -- deploy --latest=false \
  --config "$TAKOSUMI_WRANGLER_CONFIG"
```

Do not use this block to deploy the official hosted service. Its credentials,
target binding, lease, idempotency, and authoritative readback belong to whoever runs the deploy, on the machine that
holds the credential.

Container image reuse, capacity, keepalive, cache, egress, and timeout settings
are explicit operator policy. A class or binding rename requires a durable
migration; never assume production state can be discarded.

For the Cloudflare reference runner, this repository owns both
`runner/Dockerfile` and the
[`takosumi-runner-image`](./runner-image-release.md) build/verification surface.
The platform surface remains the sole full Worker/Container mutation authority.
The official realized digest pin and operator-only evidence remain in
`takosumi-private`; they are not source-controlled here.

The platform worker does not advertise or dispatch the retired Resource Shape,
TargetPool, SpacePolicy, Form Host, or FormActivation HTTP families. Their
`/v1` paths are unconditional JSON `404`/reserved responses, including with a
bearer; no drain flag, observation cron, or CLI caller restores them. Retained
rows and schemas remain migration data for typed operations or an owning
external Host.

## Authentication configuration

Upstream sign-in providers are configured by the generic non-secret descriptor
array `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`. Each descriptor contains its
issuer/endpoints/client id/redirect URI/scopes and names the runtime secret via
`clientSecretEnv`. `label` and `protocol` are the non-secret presentation and
protocol fields published by `GET /api/v1/auth/providers`; current workers also
provide safe `Single sign-on` / `oidc` defaults for older descriptor config.
Malformed descriptors fail the public discovery request closed with a generic
`503` and never expose endpoints or credential references. There is no
canonical provider-specific env family.

```json
[
  {
    "providerId": "company-oidc",
    "label": "Company SSO",
    "protocol": "oidc",
    "issuer": "https://issuer.example",
    "authorizationEndpoint": "https://issuer.example/authorize",
    "tokenEndpoint": "https://issuer.example/token",
    "userInfoEndpoint": "https://issuer.example/userinfo",
    "clientId": "takosumi",
    "clientSecretEnv": "OPERATOR_OIDC_CLIENT_SECRET",
    "redirectUri": "https://takosumi.example/sign-in/callback",
    "scopes": ["openid", "profile", "email"]
  }
]
```

ProviderConnection credentials remain vault-backed Run material. Do not turn
them into ambient Worker env. Interface invocation credentials are issued only
for an exact Ready InterfaceBinding and are never derived from Capsule names or
OpenTofu Outputs.

Downstream OIDC clients are separate from upstream identity providers. Use the
non-secret `TAKOSUMI_ACCOUNTS_CLIENTS` JSON array when the platform serves more
than one relying party.

The Takosumi native shell is a public PKCE client with the exact
`takosumi://oauth/callback` redirect URI. Register it in that same array:

```json
[
  {
    "clientId": "takosumi-mobile-operator-example",
    "redirectUris": ["takosumi://oauth/callback"],
    "tokenEndpointAuthMethod": "none",
    "allowedScopes": [
      "openid",
      "profile",
      "offline_access",
      "capsules:read",
      "capsules:write"
    ]
  }
]
```

`/.well-known/takosumi` publishes the exact registered public client selected
by `TAKOSUMI_MOBILE_OIDC_CLIENT_ID`. The selector is not a second client
definition: it must name one entry in `TAKOSUMI_ACCOUNTS_CLIENTS`. An absent
selector leaves `oidcClientId` absent and blocks native sign-in; an unknown or
incompatible selected client is invalid configuration.

A Takos native shell connecting to this Accounts issuer is a separate,
host-specific public PKCE client, for example:

```json
[
  {
    "clientId": "takos-mobile-workspace-example",
    "redirectUris": ["takos://oauth/callback"],
    "tokenEndpointAuthMethod": "none",
    "allowedScopes": [
      "openid",
      "profile",
      "offline_access",
      "spaces:read",
      "spaces:write",
      "threads:read",
      "threads:write",
      "runs:read",
      "runs:write",
      "agents:execute",
      "memories:read",
      "memories:write"
    ]
  }
]
```

Configure that exact client id as `OIDC_MOBILE_CLIENT_ID` on the corresponding
Takos Worker. Redirect comparison is exact; do not add a trailing slash, use a
wildcard, reuse a client across unrelated hosts, or ship a client secret in the
native app. If either the configured Accounts issuer or mobile client id is
missing, `/.well-known/takos` deliberately returns 503 and the app cannot start
authorization.

The standalone Takosumi app uses a separate public client because its token is
authorized for the Takosumi Accounts/control API rather than the Takos product
API. Add it to the same `TAKOSUMI_ACCOUNTS_CLIENTS` array:

```json
{
  "clientId": "takosumi-mobile-operator-example",
  "redirectUris": ["takosumi://oauth/callback"],
  "tokenEndpointAuthMethod": "none",
  "allowedScopes": [
    "openid",
    "profile",
    "offline_access",
    "capsules:read",
    "capsules:write"
  ]
}
```

Then set the non-secret selector
`TAKOSUMI_MOBILE_OIDC_CLIENT_ID=takosumi-mobile-operator-example`. The platform
publishes that exact id from `/.well-known/takosumi` only after validating the
public-client method, exact `takosumi://oauth/callback` redirect, and required
scopes. Omitting the selector leaves mobile discovery disabled without changing
browser dashboard sign-in.

## Secret handling

Keep one approved vault as authority. Push values through the deployment
adapter without displaying them, verify remote secret names only, and never
delete unknown remote secrets automatically. Rotation follows
[Secret Rotation](secret-rotation.md).

Payment-provider secrets, enforced billing, official PriceCatalogs, Cloud
capacity credentials, and Cloud-specific smoke commands are not OSS deployment
inputs. A commercial host supplies them through its extension ports.

## Verification

After deploy, verify:

- `/healthz`, `/readyz`, OIDC discovery, and JWKS;
- unauthenticated API requests fail closed;
- a signed-in user can create a scratch Workspace/Project/Capsule, run plan and
  apply, read StateVersion/Output, and destroy;
- the Credential Recipe discovery response exactly matches the
  operator-installed catalog (an intentionally empty catalog stays empty), and
  ProviderConnection material appears only in the intended Run phase;
- one installed `declaredEnv` recipe runs an otherwise unknown provider while
  recipe presence remains unrelated to provider execution admission;
- OAuth setup exposes exactly the helpers selected by the host composition; an
  unconfigured Core exposes none;
- Interface resolution and one exact InterfaceBinding authorization work
  without a reserved Output schema;
- retired Resource/Form, TargetPool, and SpacePolicy paths return JSON `404`
  with or without a bearer; portable Takoform Host checks run against the
  external Host's own endpoint and contract;
- logs, audit events, state, Outputs, and diagnostics contain no credential.

Record these proofs with the OSS
`platform.hardening.oss-baseline.v1` contribution. A host with additional
substrate/provider assertions injects its own checked
`takosumi.platform-hardening-contribution@v1` object and generates the private
manifest with the matching `--contribution` file. The validator emits one
generic `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` bundle; the worker does not read
per-check env aliases or infer checks from the runner/provider name.

For source-and-run coverage use `bun run smoke:platform-control-plane` with
operator-owned inputs. Its default path is the providerless plain OpenTofu
fixture; a Cloudflare connection, resource preflight, or Worker verification is
enabled only through the corresponding explicit options. A host that needs to
bind the lifecycle to one immutable serving release supplies the generic paired
`--expected-service-identity-header` / `--expected-service-identity` options.
The v3 smoke checks that header before the first lifecycle mutation and after
cleanup, records only its SHA-256 digest, and writes `--out-file` once to a new
owner-private path outside the source checkout. Session-token files follow the
same owner-private boundary. Cloud extension, payment, and Cloud-capacity
evidence belongs to the hosting layer, not this OSS runbook.
