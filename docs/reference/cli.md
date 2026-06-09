# CLI

Takosumi CLI の主役は **`takosumi deploy`** です。`wrangler deploy` と同じく、ローカルの OpenTofu Capsule
ディレクトリをそのまま自分の Space にデプロイします。dashboard が原理的にできない「ローカル作業ディレクトリを
読む」を担うのが CLI の存在理由で、git Source への push は不要です（git 連携は任意の add-on）。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi deploy ./my-capsule --space @me --name my-app --var region=apac
takosumi plan   ./my-capsule --space @me --name my-app   # upload + plan のみ
takosumi status <run-id>
takosumi logs   <run-id>
```

CLI は重い処理（Capsule Gate / plan / apply）を実行しません。ローカルを tar(zstd) で固めて control plane に
upload し、`/api/deploy` に「Installation を解決/作成して upload snapshot を plan せよ」と依頼するだけです。
実行は runner container 内で、credential は vault が phase ごとに mint します。CLI は credential を一切扱いません。

## Deploy のしくみ

1. `takosumi deploy <dir>` がローカル Capsule を `tar --zstd` で固める
2. `POST /api/spaces/:id/uploads` に binary で送り、R2_SOURCE に保存して **upload origin の SourceSnapshot** を記録
3. `POST /api/deploy` が `@space/name` の Installation を解決/作成し（無ければ既定 InstallConfig を合成）、その
   upload snapshot を pin した plan Run を起こす
4. CLI が Run を poll し、状態を表示する

git Source は「繋ぐと push で自動ビルドしてくれる任意機能」であり、Installation の前提ではありません。

## Operator

operator が `app.takosumi.com` を運用するための薄い helper も同じ bin に同居します。

```bash
takosumi run connections
takosumi run secrets
```

内部/開発用の accounts / installations / launch-readiness / migration helper は repo 内に残りますが、通常の運用手順や
root help には出しません。public API / dashboard / Run ledger が正本で、CLI は OpenTofu configuration を解釈しません。

## 日本語表示

```bash
TAKOSUMI_LANG=ja takosumi run connections --help
TAKOSUMI_LANG=ja takosumi run secrets --help
```

`TAKOSUMI_LANG=ja` または `LANG=ja_JP.UTF-8` のような日本語 locale で help が日本語になります。

## 登録

operator machine では wrapper または symlink を PATH に置きます。

```bash
ln -sf /root/dev/takos/takosumi/packages/cli/src/main.ts /usr/local/bin/takosumi
chmod +x /root/dev/takos/takosumi/packages/cli/src/main.ts
```

clone 直後のローカル確認だけ、同じ code path を直接叩けます。

```bash
cd takosumi
bun run cli -- run connections --help
```

## Connections

Takosumi 提供 provider default を登録・確認する operator-only CLI です。credential 値は file からだけ読み、出力しません。
Space/user-owned provider env set は dashboard/API flow で作成し、CLI では作りません。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<operator-deploy-control-bearer>

takosumi run connections set-cloudflare-token \
  --api-token-file /operator/vault/cloudflare-api-token \
  --default cloudflare

takosumi run connections list
takosumi run connections defaults list
takosumi run connections defaults set cloudflare conn_...
takosumi run connections test conn_...
takosumi run connections revoke conn_...
```

## Secrets

Takosumi platform Worker 自体の secret を operator vault から確認・適用します。provider credential は
Takosumi 提供 default なら `connections`、user-owned credential は dashboard/API flow です。

`apply` は不足している生成可能 secret を作ってから push します。既存の signing key、secret-store passphrase、
pairwise secret、provider credential は上書きしません。個別に再生成できるのは safe rotation 対象だけです。

```bash
takosumi run secrets status
takosumi run secrets apply
takosumi run secrets apply --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

`takosumi-private/` が `takos/` または `takosumi/` の隣にある通常の operator checkout では、CLI が
`takosumi-private/platform/wrangler.toml` と `takosumi-private/.secrets/production` を自動検出します。
別の場所を使う場合だけ指定します。

```bash
export TAKOSUMI_WRANGLER_CONFIG=/operator/takosumi-private/platform/wrangler.toml
export TAKOSUMI_SECRETS=/operator/takosumi-private/.secrets/production
```

`status` / `apply` は secret 値を表示しません。remote-only secret の削除は自動では行わず、operator が
`status` で確認してから明示的に `wrangler secret delete` で行います。

## Environment

| Variable                        | 用途                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `TAKOSUMI_DEPLOY_CONTROL_URL`   | deploy-control endpoint                                    |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | operator bearer                                            |
| `TAKOSUMI_WRANGLER_CONFIG`      | realized wrangler config                                   |
| `TAKOSUMI_SECRETS`              | local operator vault directory                             |
| `TAKOSUMI_LANG`                 | `ja` で日本語 help                                         |
