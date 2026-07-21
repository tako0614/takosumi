# Takosumi platform worker deployment

This runbook covers the OSS Takosumi platform worker. Official Takosumi Cloud
adds closed handlers and commercial ports in its own wrapper and maintains its
deployment procedure in `takosumi-cloud/docs/operations/platform-worker.md`.

## Composition

The OSS entry is `deploy/platform/worker.ts`. One operator-managed platform
worker composes Accounts, the Git/OpenTofu control plane, dashboard assets,
runner dispatch, and the Interface/InterfaceBinding API. Canonical resources
include the Accounts/control databases, source/artifact/state/backup stores,
Run queue, coordination/run-owner Durable Objects, and an OpenTofu runner.

`deploy/platform/wrangler.toml` is a placeholder reference. Realized bindings,
origins, IDs, and secrets belong to operator state outside the repository.
Operators may wrap this composition through the documented generic extension
and port seams; the OSS config must not name a closed handler as a dependency.
An optional signed Takoform Form Registry uses the separate
[`form-package-installation.md`](form-package-installation.md) procedure; no
package, trust root, publisher, or activation is implicit in this worker.

## Build and deploy

Build and verify the OSS target from the product root:

```bash
bun install
bun run check
(cd dashboard && bun run build)
bun run docs:build
```

Before deploying code that requires a newer control-ledger D1 shape, run the
[Control D1 schema predeploy](control-d1-schema-predeploy.md) gate against the
same exact source commit. Back up, apply, and read-only verify staging before
production. A platform Worker deployment must not depend on its first request
to create or repair the required schema.

Then use the operator-owned Wrangler config:

```bash
bun run wrangler -- deploy --dry-run --latest=false \
  --config "$TAKOSUMI_WRANGLER_CONFIG"
bun run wrangler -- deploy --latest=false \
  --config "$TAKOSUMI_WRANGLER_CONFIG"
```

Container image reuse, capacity, keepalive, cache, egress, and timeout settings
are explicit operator policy. A class or binding rename requires a durable
migration; never assume production state can be discarded.

When Resource Shape kinds are enabled, the platform worker also runs bounded
read-only observation on the five-minute cron. Set its batch, concurrency,
cadence, and abandoned-lease window with the
`TAKOSUMI_RESOURCE_OBSERVATION_*` variables documented in
[Operator](../reference/operator.md). This scheduler reports drift but never
applies or refreshes a Resource.

## Authentication configuration

Upstream sign-in providers are configured by the generic non-secret descriptor
array `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`. Each descriptor contains its
issuer/endpoints/client id/redirect URI/scopes and names the runtime secret via
`clientSecretEnv`. `label` and `protocol` are the non-secret presentation and
protocol fields published by `GET /v1/auth/providers`; current workers also
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
than one relying party. A Takos native shell must be a host-specific public
PKCE client, for example:

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

Payment-provider secrets, enforced billing, official PriceCatalogs, managed
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
- one `Ready` scratch Resource produces a scheduled apply-disabled
  `drift_check`, the next tick does not duplicate its active lease, and
  `takosumi_resource_observation_count` reports the outcome without an apply;
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
enabled only through the corresponding explicit options. Cloud extension,
payment, and managed-capacity evidence belongs to the hosting layer, not this
OSS runbook.
