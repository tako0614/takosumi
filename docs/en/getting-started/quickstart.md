# Quickstart

Takosumi OSS runs existing OpenTofu/Terraform providers as-is. The shortest
useful check is to register a Cloudflare API token as a ProviderConnection and
plan/apply a normal `cloudflare/cloudflare` provider manifest.

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git
- provider credential, such as a Cloudflare API token

## 1. Start the service

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

## 2. Add a Git URL in `/new`

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

## 3. ProviderConnection

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

## 4. Result

When a Run succeeds, Takosumi stores:

```text
run log
plan/apply result
state version
outputs
audit event
```

Cloudflare Compatibility Gateway and managed resources are Takosumi Cloud-only
and are not used by the OSS quickstart.
