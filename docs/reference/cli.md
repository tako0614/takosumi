# CLI

Takosumi CLI は、画面でできる操作を自動化したい場合の補助です。通常は
dashboard の `/install?git=...` / `/new` からサービスを選び、接続する provider を選んで
plan / apply します。CLI は任意の Takosumi endpoint に向けられます。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://github.com/example/photo-blog.git&path=deploy/opentofu&ref=main"

takosumi status <run-id>
takosumi logs   <run-id>
```

Takosumi Cloud を使う場合の hosted endpoint は `https://app.takosumi.com` です。

CLI は OpenTofu を直接実行しません。通常の作成フローは dashboard の Git URL install で
Source / Capsule / Run を作り、Run の source identity として Git commit / ref / path を固定します。実行は runner sandbox で行い、
credential は ProviderConnection と CredentialRecipe から run 時だけ env/file として注入されます。
`takosumi deploy` / `takosumi plan` のローカル upload 経路は退役済みです。

## Connections

Provider credential 値は file から読み、表示しません。

```bash
takosumi connections set-cloudflare-token \
  --api-token-file <path-to-cloudflare-token-file>

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
