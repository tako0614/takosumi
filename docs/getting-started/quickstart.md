# Quickstart

Takosumi には 2 つの入口があります。

```text
Takosumi software:
  self-host / local / operator endpoint で OpenTofu control plane を確認する

Takosumi Cloud:
  app.takosumi.com の公式 hosted service と managed resources を使う
```

Software としての動きを確認する場合は、まず OSS / local runner から始めます。
公式 hosted service として使う場合は、後半の Takosumi Cloud flow を使います。

## OSS / local runner

Takosumi OSS は既存の OpenTofu/Terraform provider をそのまま実行します。いちばん短い
確認の流れは、Cloudflare API token などの認証情報を ProviderConnection に登録し、
既存 provider の定義をそのまま plan / apply することです。

### Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git
- provider credential (例: Cloudflare API token)

### 1. Start the service

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

### 2. Add a Git URL in `/new`

標準の流れは dashboard の `/new` です。外部リンク
`/install?git=...&ref=...&path=...` は `/new` に値を入れておくだけで、サーバー側で
勝手に install することはありません。

ユーザーは次の項目を自分で確認して進みます。

```text
Git URL
compatibility check
ProviderConnection selection
plan result
apply approval
```

### 3. ProviderConnection

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

Run の実行中だけ、`CLOUDFLARE_API_TOKEN` などの環境変数やファイルが実行環境
(runner sandbox) に渡されます。

### 4. Result

Run が成功すると Takosumi は以下を保存します。

```text
run log
plan/apply result
state version
outputs
audit event
```

この quickstart は OpenTofu Stack flow に絞っています。Compatibility API framework は
OSS の機能ですが、公式の managed target pool、Takosumi 自社リソースの内部実装、
強制課金、support / SLA は Takosumi for Operator / Cloud の運用側にあります。

## Hosted Cloud flow

公式 hosted service としての `app.takosumi.com` の使い方、managed resources、
pricing、API key、usage、spend guard は
[Takosumi Cloud docs](https://app.takosumi.com/docs/) に分けています。

Cloud でも software の基礎 model は同じですが、この quickstart では portable な
Takosumi software / operator endpoint の動作だけを扱います。
