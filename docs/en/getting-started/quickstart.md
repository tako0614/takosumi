# Quickstart

Takosumi has two entry points.

```text
Takosumi software:
  verify the OpenTofu control plane on a self-hosted, local, or operator endpoint

Takosumi Cloud:
  use the official hosted service and managed resources at app.takosumi.com
```

Start with OSS / local runner when you want to verify Takosumi as software. Use
the Takosumi Cloud flow when you want the hosted service.

## OSS / local runner

Takosumi OSS runs existing OpenTofu/Terraform providers as-is. The shortest
useful check is to register a provider credential such as a Cloudflare API token
as a ProviderConnection and plan/apply a normal provider manifest.

### Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git
- provider credential, such as a Cloudflare API token

### 1. Start the service

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

In another terminal:

```bash
export BASE=http://127.0.0.1:8788
export AUTH="Authorization: Bearer dev-token"
```

### 2. Add a Git URL in `/new`

The standard product flow is the dashboard `/new` route. External links such as
`/install?git=...&ref=...&path=...` only prefill `/new`; they do not perform a
server-side install.

The user explicitly reviews:

```text
Git URL
compatibility check
ProviderConnection selection
plan result
apply approval
```

### 3. ProviderConnection

Credentials are stored in ProviderConnections, not in `.env` files or
manifests.

```yaml
connections:
  cloudflare-main:
    provider: cloudflare
    auth_type: api_token
    secrets:
      api_token: sec_cloudflare_token
    values:
      account_id: xxxxx
```

At run time, Takosumi injects env/files such as `CLOUDFLARE_API_TOKEN` only into
the runner sandbox.

### 4. Result

When a Run succeeds, Takosumi stores:

```text
run log
plan/apply result
state version
outputs
audit event
```

This quickstart focuses on the OpenTofu Stack flow. Compatibility API framework
is an OSS Takosumi capability surface, while official managed target pools,
Takosumi-owned native resource internals, enforced billing, and support/SLA
belong to the Takosumi for Operator / Cloud operation layer.

## Hosted Cloud flow

The hosted service at `app.takosumi.com`, including managed resources, pricing,
API keys, usage, and spend guard behavior, is documented separately in
[Takosumi Cloud docs](https://app.takosumi.com/docs/en/).

Cloud uses the same underlying software model, but this quickstart covers only
the portable Takosumi software / operator endpoint behavior.
