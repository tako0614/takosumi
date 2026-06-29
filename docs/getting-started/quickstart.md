# Quickstart

まず Takosumi Cloud の通常フローです。ブラウザでサービスを選ぶか Git URL
を貼り、必要な接続と変更内容を確認してから deploy します。

セルフホストや OSS runner を確認したい場合は、後半の「OSS / local runner
で確認する」を使ってください。

## Takosumi Cloud

1. `https://app.takosumi.com/` を開きます。
2. **サービスを追加** からスターターを選ぶか、OpenTofu/Terraform module を含む
   Git URL を貼ります。
3. 必要なクラウドアカウントを接続します。credential は manifest や `.env`
   ではなく ProviderConnection に保存されます。
4. Takosumi が取得内容、必要な接続、変更予定を表示します。
5. 内容を確認して deploy を承認します。
6. 完了後、サービスの URL、履歴、state version、outputs、activity を確認できます。

Cloud でも内部モデルは同じです。

```text
Source
ProviderConnection
ProviderBinding
Run
StateVersion
Output
AuditEvent
```

通常画面ではこれらを「サービス」「接続」「変更内容」「履歴」として扱い、必要なときだけ詳細を開けるようにします。

## OSS / local runner で確認する

Takosumi OSS は既存 OpenTofu/Terraform provider をそのまま実行します。最短確認は
Cloudflare API token を ProviderConnection に登録し、既存 `cloudflare/cloudflare`
provider の manifest を plan/apply する流れです。

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

Run 時だけ `CLOUDFLARE_API_TOKEN` などの env/file が runner sandbox に注入されます。

### 4. Result

Run が成功すると Takosumi は以下を保存します。

```text
run log
plan/apply result
state version
outputs
audit event
```

Compatibility API framework は OSS Takosumi の capability surface ですが、この
quickstart は OpenTofu Stack flow に絞るため使いません。公式 managed target pool /
Takosumi-owned native resource internals / enforced billing / support/SLA は
Takosumi for Operator / Cloud の運用層です。
