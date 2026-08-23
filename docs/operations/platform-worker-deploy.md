# Takosumi platform worker deployment

This runbook covers the OSS Takosumi platform worker, including the official
Takosumi service. The official composition runs this repository's ordinary
worker and connects optional commercial products through the public
`PlatformExtensionRoute` plus private service bindings. It does not use a
Takosumi hosted service wrapper.

The official Worker entry is `deploy/platform/entry-worker.ts`. Besides the
default HTTP handler it exports
`TakosumiHostRuntimeMaterializerEntrypoint`; Takoserver reaches that named RPC
only through its reviewed service binding. A release is not ready merely
because Wrangler uploaded bytes: the owner reads the immutable Version back and
requires that exact export and binding closure.

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
read-only: it requires a clean pushed source, builds the dashboard, validates
that the external config points at that same worktree, reads the exact serving
predecessor, and runs Wrangler's dry-run.

```bash
bun run deploy -- takosumi-platform-staging plan \
  --config /absolute/operator-private/wrangler.staging.toml \
  --plan-out /absolute/operator-private/release-plan.json

bun run deploy -- takosumi-platform-staging execute \
  --plan /absolute/operator-private/release-plan.json \
  --confirm sha256:<reviewed-plan-digest> \
  --review operator:<reviewer> \
  --evidence /absolute/operator-private/release-evidence.json
```

Execute rechecks the source, config, dashboard bytes, and predecessor before
the single upload. A touched target with missing post-conditions is
`indeterminate`; reconcile the authoritative deployment before another
attempt. Successful execute records the immutable predecessor and new serving
Version. The immutable Version readback requires one exact required binding of
each expected type, the configured Hosted service, and the private host-runtime
materializer entrypoint. The public root and discovery document must then emit
that exact Version id as `x-takosumi-version-id`; a cache hit or another serving
Version cannot satisfy the release evidence. Plan and execute both read
Cloudflare's metadata-only secret list and require
`TAKOSUMI_HOST_RUNTIME_SECRET_DERIVATION_KEY`; the value never enters a plan,
command line, log, or evidence file. The authenticated Hosted subscription read
is a separate E2E post-condition after publication; cloud-resource and AI E2E
run against Takoserver's owning endpoints.

Host runtime materialization accepts at most one repository-declared public
OIDC identity per installation. Generated values are derived before Accounts
is mutated. If public-client registration changes, the private materializer
returns an authenticated opaque rollback receipt; a failed immutable Worker
Version upload must return that receipt to the same entrypoint and confirm the
exact Accounts compare-and-swap rollback. The provider never receives the
receipt payload or any materialized value in state, Output, audit, or an agent
response.

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
and self-hosted builds. An operator may set its own TCS server explicitly; the
official Takosumi build is likewise responsible for explicitly injecting
`https://store.takosumi.com`. Users can still add store servers themselves.

Before deploying code that requires a newer control-ledger D1 shape, run the
[Control D1 schema predeploy](control-d1-schema-predeploy.md) gate against the
same exact source commit. Back up, apply, and read-only verify staging before
production. A platform Worker deployment must not depend on its first request
to create or repair the required schema.

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
