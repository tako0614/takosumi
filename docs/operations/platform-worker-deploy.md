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
`takos-control/engineering.policy.json` → `deploy`. This surface is
`state-change` whenever it carries a control-ledger schema change, and
`reversible` otherwise.

## Composition

The OSS HTTP implementation is `deploy/platform/worker.ts`; the deployable
module entry is `deploy/platform/entry-worker.ts`. One operator-managed platform
worker composes Accounts, the Git/OpenTofu control plane, dashboard assets,
runner dispatch, and the Interface/InterfaceBinding API. Canonical resources
include the Accounts/control databases, source/artifact/state/backup stores,
Run queue, coordination/run-owner Durable Objects, and an OpenTofu runner.

`deploy/platform/wrangler.toml` is a placeholder reference. Realized bindings,
origins, IDs, and secrets belong to operator state outside the repository.

## The realized config names a source identity, not a path

A realized config declares no `main` and no `[assets] directory`. It declares
what it *is* — account, Worker name, database ids, vars, bindings — and the
source it deploys is named by identity in a sibling file:

```json
// <realized config>.source.json, e.g. platform/wrangler.staging.source.json
{
  "kind": "takosumi.platform-release-source@v1",
  "repository": "https://github.com/tako0614/takosumi.git",
  "commit": "<40 hex>"
}
```

`plan` refuses a config that states either source path
(`platform_worker_release_config_declares_source_path`), and refuses to run at
all from a checkout that is not exactly that repository at that commit
(`platform_worker_release_source_pin_mismatch`). It then injects both paths
itself: into the immutable `git archive` snapshot for the bytes that get
uploaded, and into a transient private projection for read-only provider
queries.

Why: a path names a directory on one machine. The production realized config
carried `main = "../../.release/TASK-0041-takosumi-production/..."` — a second
clone, absent from `git worktree list`, named after a task id the ledger has
never contained — while staging pointed at a different tree entirely, so the two
environments could no longer be released from one checkout, and neither config
could say **which commit** it meant.

Materialize the pinned source when the current checkout is not it:

```bash
bun run deploy -- takosumi-platform-staging materialize-source \
  --config <realized config> --into <empty directory>
```

That is a fresh, disposable, depth-1 checkout of the pinned commit. Install the
toolchain there and run `plan` from it. The recovery path is the same command
against the commit the stored plan recorded, so a restore no longer depends on
one directory continuing to exist.

Advancing the pin is part of cutting a release: set `commit` to the reviewed
source commit, then plan and execute.
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

### Realized Hosted extension descriptors

`TAKOSUMI_PLATFORM_EXTENSIONS` is operator-realized config outside this
repository, but the release gate pins the official composition's two `HOSTED`
descriptors exactly, key set included. An unknown key is a refusal, not a
tolerated addition, because a descriptor the OSS parser rejects makes the whole
route unloadable rather than degrade quietly.

- `takosumi-hosted-sponsorship` at `/api/v1/account/subscription`, carrying the
  account service, the `hosted-resource.inventory.v1` workspace contribution,
  the generic Run credential audience, and the provider credential broker.
- `takosumi-ai` at `/api/v1/ai`, the authenticated OpenAI-compatible data
  plane. Its `workspaceContext` is `query-optional`: an OpenAI-compatible client
  is configured with a base URL and sends `POST /chat/completions`, so it cannot
  attach a `workspaceId` query, and `query-required` would answer every such
  request with `invalid_request`. When the query is present it is still bound to
  verified platform access before dispatch.

The sponsorship descriptor's `providerCredentialBroker` declares exactly ten
keys. Six are the broker identity — `connectionId`, `recipeId`,
`providerSource`, `displayName`, `exchangePath`, `envNames` — and
`runCredentialSettings` carries the provider floor for run-issued credentials.
The remaining three are required, not optional, for an official release:

- `publicInputExchangePath` is the non-secret public-input route. Takosumi OSS
  neither allocates nor derives a Capsule's public origin; it asks the host
  composition that publishes the Worker, over this path. A broker without it
  cannot answer, and Capsules that need their own origin fail closed at plan.
- `publicInputCapabilities` is the closed set of public-input questions the
  broker answers. v1 defines one, `http_endpoint_url`.
- `runtimeInputs` is the value-free run-scoped sensitive-input protocol
  descriptor: `contract`, the two provider-block argument names
  (`nonceArgument`, `mapArgument`), and the exact provider version floor at
  which those arguments exist. Without it a broker Connection is invisible to
  the run-scoped sensitive-input lane, so a Capsule asking for
  binding-delivered values has nowhere to deliver them.

Exactly one realized route may declare `publicInputExchangePath`. A Capsule has
one public origin and no rule for splitting it, so the runtime seam throws when
two routes claim to answer, and the release refuses that composition rather than
deciding an authority question by array order. Every realized descriptor's
`handlerKey` must also name a declared `[[services]]` binding; an unbound
handler is an unroutable route that would only fail on the first real request
after the irreversible upload.

A realized config predating this shape fails the gate at plan, before any
upload. Reconciling it is a non-secret config edit: add the three broker fields
to the sponsorship descriptor, and set `takosumi-ai.workspaceContext` to
`query-optional`. The Hosted service must serve the declared
`publicInputExchangePath` before the platform that advertises it is released.

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

Before deploying code that requires a newer control-ledger D1 shape, run the
[Control D1 schema predeploy](control-d1-schema-predeploy.md) gate against the
same exact source commit. Back up, apply, and read-only verify staging before
production. A platform Worker deployment must not depend on its first request
to create or repair the required schema.

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
