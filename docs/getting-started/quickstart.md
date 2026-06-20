# Quickstart

Takosumi OSS は既存 OpenTofu/Terraform provider をそのまま実行します。最短確認は
Cloudflare API token を ProviderConnection に登録し、既存 `cloudflare/cloudflare`
provider の manifest を plan/apply する流れです。

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git
- provider credential (例: Cloudflare API token)

## 1. Start the service

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
PORT=8788 bun core/index.ts
```

別 terminal:

```bash
export BASE=http://127.0.0.1:8788
export AUTH="Authorization: Bearer dev-token"
```

## 2. Add a Git URL in `/new`

標準 product flow は dashboard の `/new` です。外部リンク
`/install?git=...&ref=...&path=...` は `/new` を prefill するだけで、server-side
install は行いません。

ユーザーは次を明示確認します。

```text
Git URL
compatibility check
ProviderConnection selection
plan result
apply approval
```

## 3. ProviderConnection

Credential は `.env` や manifest に書かず、ProviderConnection に保存します。

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

Run 時だけ `CLOUDFLARE_API_TOKEN` などの env/file が runner sandbox に注入されます。

## 4. Result

Run が成功すると Takosumi は以下を保存します。

```text
run log
plan/apply result
state version
outputs
audit event
```

Cloudflare Compatibility Gateway や managed resources は Takosumi Cloud 専用で、OSS
quickstart では使いません。
