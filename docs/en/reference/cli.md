# CLI

The Takosumi CLI is a developer / operator helper. The standard product flow is
the dashboard `/install?git=...` / `/new` path: review a Git URL OpenTofu
Capsule, choose a ProviderConnection, then plan / apply.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi deploy ./my-capsule --space @me --name my-app --provider cloudflare=conn_cf --var region=apac
takosumi plan   ./my-capsule --space @me --name my-app
takosumi status <run-id>
takosumi logs   <run-id>
```

The CLI does not run OpenTofu directly. It uploads a local Capsule and asks the
control plane to create SourceSnapshot / Capsule / Run records. Execution
happens in the runner sandbox, and credentials are injected at run time from
ProviderConnections and CredentialRecipes.

## Connections

Provider credential values are read from files and are never printed.

```bash
takosumi connections set-cloudflare-token \
  --api-token-file /operator/vault/cloudflare-api-token

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

OSS Takosumi does not expose Gateway coverage as a normal CLI/API surface.

## Secrets

Check and apply Takosumi platform Worker secrets from the operator vault.

```bash
takosumi secrets status
takosumi secrets apply
takosumi secrets apply --init-protected --local-only
takosumi secrets apply --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

`status` / `apply` never print secret values. Remote-only secrets are not
deleted automatically.
`--init-protected` creates protected keys such as the OIDC signing key,
secret-store passphrase, pairwise secrets, and the upstream OAuth subject secret
only when they are missing.
Existing protected keys are never overwritten. `--local-only` initializes the
local vault without calling `wrangler secret put`.
