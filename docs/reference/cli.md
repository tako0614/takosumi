# CLI

Takosumi CLI は developer / operator 向けの補助です。標準 product flow は
dashboard の `/install?git=...` / `/new` から Git URL の OpenTofu Capsule を確認し、
ProviderConnection を選んで plan / apply する導線です。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi deploy ./my-capsule \
  --workspace @me \
  --project my-app \
  --capsule my-app \
  --provider-binding cloudflare.default=conn_cf \
  --var region=apac

takosumi plan ./my-capsule \
  --workspace @me \
  --project my-app \
  --capsule my-app
takosumi status <run-id>
takosumi logs   <run-id>
```

CLI は OpenTofu を直接実行しません。ローカル Capsule を upload し、control plane に
Source / Capsule / Run を作らせ、Run の source identity として Git commit / ref / path を固定します。実行は runner sandbox で行い、
credential は ProviderConnection と CredentialRecipe から run 時だけ env/file として注入されます。

## Connections

Provider credential 値は file から読み、表示しません。

```bash
takosumi connections set-cloudflare-token \
  --api-token-file /operator/vault/cloudflare-api-token

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

OSS Takosumi は Gateway coverage を CLI/API の通常 surface として扱いません。

## Secrets

Takosumi platform Worker 自体の secret を operator vault から確認・適用します。

```bash
takosumi secrets status
takosumi secrets apply
takosumi secrets apply --init-protected --local-only
takosumi secrets apply --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

`status` / `apply` は secret 値を表示しません。remote-only secret は自動削除しません。
`--init-protected` は OIDC signing key、secret-store passphrase、pairwise secret、
upstream OAuth subject secret などの protected key を初回だけ operator vault に作成します。既存 protected key
は上書きしません。`--local-only` は `wrangler secret put` を呼ばず、local vault
の初期化だけを行います。
