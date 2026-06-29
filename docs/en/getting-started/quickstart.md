# Quickstart

Start with the normal Takosumi Cloud flow. In the browser, choose a starter or
paste a Git URL, review the required connections and planned changes, then
deploy.

Use the OSS / local runner section later when you want to verify the open-source
control plane directly.

## Takosumi Cloud

1. Open `https://app.takosumi.com/`.
2. Choose **Add service**, then pick a starter or paste a Git URL that contains
   an OpenTofu/Terraform module.
3. Connect the cloud account the service needs. Credentials are stored in a
   ProviderConnection, not in the manifest or a local `.env` file.
4. Takosumi shows the fetched source, required connections, and planned changes.
5. Review and approve the deploy.
6. After the run succeeds, open the service URL and inspect history, state
   versions, outputs, and activity.

The underlying model is the same in Cloud and OSS:

```text
Source
ProviderConnection
ProviderBinding
Run
StateVersion
Output
AuditEvent
```

The normal Cloud UI presents those as services, connections, changes, and
history. Advanced details remain available when needed.

## OSS / local runner

Takosumi OSS runs existing OpenTofu/Terraform providers as-is. The shortest
useful check is to register a Cloudflare API token as a ProviderConnection and
plan/apply a normal `cloudflare/cloudflare` provider manifest.

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

This OSS quickstart uses the normal Cloudflare provider flow and does not use a
compatibility profile. Compatibility profiles are OSS capability surfaces, while
Takosumi Cloud's official managed capacity remains an Operator/Cloud operation
concern.
