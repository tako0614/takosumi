# Credentials

Takosumi **stores credentials write-only, hands them over only while a Run is executing,
and keeps only their names in the record**. Everything on this page rests on those three
properties.

## Connection

Credentials live in a Connection, not in a `.env` file or a manifest. A stored value is
write-only, and **there is no path that reads it back after creation**. It is never shown
again on screen or through the API, so a lost value is replaced by creating a new
Connection.

```bash
takosumi connections create \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file ./provider-credentials.json
```

| Option | Meaning |
| --- | --- |
| `--provider` | The provider's source address |
| `--recipe` | The id of the Credential Recipe to use, including the generic `generic-env` |
| `--auth-mode` | `env` (injected as environment variables), and other modes |
| `--secret-partition` | The partition the secret is stored in |
| `--values-file` | JSON of environment variable names and values |
| `--files-file` | JSON of credentials passed as files |
| `--workspace` | The Workspace this belongs to |
| `--expires-at` | When it expires |

`--provider` is the fully qualified address, starting with the hostname. Short forms such
as `example/example` are rejected. If your module's `required_providers` says
`example/example`, the default registry is filled in and it matches the same provider as
`registry.opentofu.org/example/example`, so create the Connection with that form.

`--recipe`, `--auth-mode`, and `--secret-partition` are always required. When Takosumi has
no knowledge of which environment variables a given provider needs, choose
`--recipe generic-env` and `--auth-mode env`. The names you write in `--values-file` are
then used as they are.

Through the API this is `POST /api/v1/connections`. The `/api/v1/provider-connections`
path is **read-only** and returns the list visible from a Workspace; it does not create
anything.

Verify a Connection with `/test`. To take one out of service, use `/revoke` rather than
deleting it. A revoked Connection cannot be used by later Runs, and the records of past
Runs remain.

## How far the values travel

Values reach the runner sandbox only while a Run is executing, and they are gone when it
ends. How they are handed over is decided by the Connection, either as environment
variables or as files.

In both cases you **specify the variable names or file names yourself**, following your
module's `required_providers` and the provider's own documentation. The provider name does
not imply which credentials get filled in.

What stays in the Run is which environment variable names were injected. The values do
not.

## Rules for variable names

The JSON given to `--values-file` maps environment variable names to string values. A name
has to be an uppercase environment variable identifier: an uppercase letter or `_` first,
then uppercase letters, digits, and `_`.

```text
^[A-Z_][A-Z0-9_]*$
```

Names the runner uses itself cannot be overridden. Creation fails with
`invalid_argument` for `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `PWD`, `OLDPWD`, `SHELL`,
`USER`, `LOGNAME`, `HOSTNAME`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
`GIT_ASKPASS`, `SSH_AUTH_SOCK`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and for any name
beginning with `TAKOSUMI_`, `TF_`, `OPENTOFU_`, `NODE_`, `NPM_`, `BUN_`, `LD_`, or
`DYLD_`. The same rule applies when you pass credentials as files and also announce their
location through an environment variable (`envName`).

## Without an assignment, a Run does not start

If a provider your module requires has no Connection assigned to it, that Run fails before
OpenTofu is started. A Connection with similar settings is never substituted.

The reasoning is in the Run's `providerResolutions`, one entry per provider.

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

| `status` | Meaning |
| --- | --- |
| `resolved_provider_connection` | The Connection to use has been decided |
| `blocked_missing_connection` | No Connection is assigned to that provider |

A resolved entry carries `evidence` with the provider name, the id of the chosen
Connection, and the environment variable names that will be injected
(`requiredEnvNames`). A blocked entry carries the provider name and why it stopped
(`reason`). Neither contains credential values.

## A Credential Recipe is a convenience

An operator can supply Credential Recipes. A Recipe is a **convenience** that saves you
from naming the environment variables yourself.

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/credential-recipes" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

A provider with no Recipe runs just as well once you create a generic env or file
Connection for it.

## Keep non-secret settings out

Non-secret values such as an endpoint or a region belong in module variables or in
`providerConfig`, not in a Connection. Writing a credential-shaped field there — a token,
a password, a private key — **is rejected**.

## Running one module against different credentials

Modules carry no credentials. Which Connection is used is decided by the Capsule's
ProviderBinding. Create a development Capsule and a production Capsule from the same
module, and assign each its own Connection. That is how environments are separated in
Takosumi.

```bash
curl -X PUT "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/provider-bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d @bindings.json
```

## Interface tokens work differently

The token used to call an Interface is issued separately from a Connection. It is minted
per request, lives for a very short time, and has no refresh token. Do not build anything
that keeps one around (see [Interfaces](./interfaces.md)).

## Related

- [Run model](./run-model.md)
- [Sources and Capsules](./sources.md)
