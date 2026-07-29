# 自分で動かす

Takosumi は自分の環境に置いて、自分の endpoint として動かせます。ソフトウェアは
AGPL-3.0 で公開しています。立てるものは 1 つです。control plane、accounts、dashboard、
OpenTofu runner が同じ origin に同居します。CLI、dashboard、Takoform client と
その他の API client は、その origin に向かって話します。

リポジトリの `deploy/` に、置き場所の違う 3 つの雛形が入っています。

## 構成を選ぶ

| 構成 | 実行環境 | 状態の保存先 | 雛形 |
| --- | --- | --- | --- |
| Cloudflare | Cloudflare Workers | D1 / R2 / Durable Objects | `deploy/platform/wrangler.toml` |
| Bun と PostgreSQL | VM やコンテナ | PostgreSQL | `deploy/node-postgres/` |
| 手元だけ | 手元の Linux と Docker | compose のボリューム | `deploy/local-substrate/` |

**Cloudflare** は、サーバーを自分で持たずに運用したい場合に向きます。Cloudflare
アカウントと wrangler があれば動き、OpenTofu の実行も Cloudflare Container の runner が
引き受けます。1 つの Worker に accounts、control plane、dashboard、runner がまとまります。

**Bun と PostgreSQL** は、自分のインフラに置きたい場合に向きます。Docker が動くホストと
PostgreSQL、それに TLS を終端する Caddy があれば動きます。同梱の `docker-compose.yml` が
PostgreSQL、マイグレーション、サービス本体、Caddy をまとめて起動します。

**手元だけ**の構成は、公開せずに全体を通したい場合に使います。Linux と
Docker が前提です。ACME 用の Pebble、CoreDNS、Caddy を同じ Docker ネットワークに立て、
`*.takosumi.test` を本番と同じ形で解決します。

## Cloudflare に置く

必要な binding は `deploy/platform/wrangler.toml` にすべて書いてあります。

| binding | 役割 |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_DB` (D1) | セッション、OIDC、PAT を保存します |
| `TAKOSUMI_CONTROL_DB` (D1) | Run、StateVersion、Output の記録です |
| `R2_ARTIFACTS` | plan と state の成果物を置きます |
| `R2_SOURCE` | SourceSnapshot の tar.zst を置きます |
| `R2_STATE` | OpenTofu の state backend です |
| `R2_BACKUPS` | backup と export の束を置きます |
| `COORDINATION` / `RUN_OWNER` / `RUNNER` (Durable Object) | 排他制御、Run の所有、runner コンテナを担当します |
| `ASSETS` | dashboard の配布物を配ります |

Run は作成時に `RUN_OWNER` へ直接 schedule されます。Cloudflare Queue や
dead-letter queue はこの GA 構成にはありません。`RUN_OWNER` が再試行と終端失敗を
所有し、binding がなければ実行は fail closed になります。

まずリソースを作ります。名前は雛形に合わせています。

```bash
bunx wrangler d1 create takosumi-accounts
bunx wrangler d1 create takosumi-deploy
bunx wrangler r2 bucket create takos-artifacts
bunx wrangler r2 bucket create takosumi-source
bunx wrangler r2 bucket create takosumi-state
bunx wrangler r2 bucket create takosumi-backups
```

`wrangler.toml` を自分用に写します。書き換えるのは `database_id`、`routes` の
`pattern`、`[vars]` の `TAKOSUMI_ACCOUNTS_ISSUER` です。issuer は dashboard を配る
origin そのものです。雛形の `TAKOSUMI_ACCOUNTS_CLIENTS` には例示用の client が
入っていて、redirect 先が自分の持たない domain を指しています。自分の client に
差し替えるか、要らなければ丸ごと消してください。

本番として運用するなら `TAKOSUMI_ENVIRONMENT = "production"` も足します。この値が
`production` か `staging` のとき、暗号鍵と永続ストアの検査が fail-closed になります。
値の意味は[設定リファレンス](../reference/configuration.md)にまとめてあります。

dashboard をビルドします。`ASSETS` はこの出力を配ります。

```bash
bun install
bun run build:dashboard
```

secret を入れます。`wrangler.toml` には書かず、`wrangler secret put` で押し込みます。

```bash
bunx wrangler secret put TAKOSUMI_ACCOUNT_SESSION_HASH_SALT \
  --config deploy/platform/wrangler.toml
```

同じ要領で、あと 4 つ入れます。`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` と
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` が OIDC の署名まわりです。
`TAKOSUMI_SECRET_STORE_PASSPHRASE` が認証情報と state の封印鍵、
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` が operator 専用 API の bearer です。

accounts 側の D1 スキーマを適用します。保留中のマイグレーションごとに
`bunx wrangler d1 execute` を呼び、適用した版が
`takosumi_accounts_schema_migrations` に残ります。

```bash
takosumi accounts migrate-d1 --database-id takosumi-accounts --remote
```

このコマンドは前に戻せません。複数のジョブから同時に走らせると、片方が version の
主キー衝突で失敗します。deploy ジョブ 1 つから呼んでください。初回デプロイの前に
挙動だけ見たいときは `--local` を付けて手元の miniflare を対象にできます。

control plane 側の D1 にマイグレーションは要りません。`TAKOSUMI_CONTROL_D1_SCHEMA_MODE`
が既定の `bootstrap` のあいだ、最初のリクエストでスキーマが整います。事前に用意した
スキーマだけで動かしたい場合は `predeployed` にします。

最後に deploy します。

```bash
bunx wrangler deploy --config deploy/platform/wrangler.toml
```

## Bun と PostgreSQL に置く

`deploy/node-postgres/` の compose が、PostgreSQL、マイグレーション、サービス本体、
Caddy を順に起動します。サービス本体は accounts と control plane と dashboard を
同じ origin に載せた 1 プロセスです。リポジトリのルートから始めます。

```bash
cd deploy/node-postgres
cp .env.example .env
```

`.env` を編集します。ここで書き換えるのは `POSTGRES_PASSWORD`、
`TAKOSUMI_ACCOUNTS_ISSUER`、`TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`、OIDC client の
登録です。

`.env` の値は compose ファイルの変数展開に使われるだけで、そのままコンテナへ渡るわけでは
ありません。同梱の `docker-compose.yml` が `accounts` サービスに渡すのは、上に挙げた
issuer と接続先と client 登録だけです。残りの秘密は、`accounts` サービスの
`environment:` に自分で足してください。compose なら同じディレクトリの
`docker-compose.override.yml` に書けます。

| 変数 | なぜ要るか |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` | id_token の署名鍵 |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | 署名鍵と対で使う subject の導出鍵 |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` | セッション ID を保存時にハッシュする salt |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | 認証情報と state の封印鍵 |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | operator 専用 API の bearer |

issuer が https のとき、署名鍵が届いていないとサービスは起動を拒否します。プロセスごとに
違う鍵で id_token に署名してしまい、再起動や複数レプリカで検証が壊れるためです。

起動します。

```bash
docker compose up -d
```

compose の `migrations` コンテナが `takosumi accounts migrate` を 1 回実行してから、
サービス本体が起動します。これで揃うのは accounts 側のテーブルだけです。control plane
側のテーブルは、同じデータベースに対して別に作ります。

control plane 側のマイグレーションは、リポジトリのチェックアウトから走らせます。同梱の
イメージには入っていません。同梱の compose は PostgreSQL を内部ネットワークにしか
出さないので、先に 5432 を公開するか、同じネットワークから届くホストで実行します。

```bash
cd ../..
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
```

`bun run db:migrate:dry-run` を先に実行すると、適用せずに SQL だけ表示します。
`--env=local` は接続せずメモリ上で走るので、実際のデータベースには何もしません。
実データベースに当てる `--env` は `production` と `staging` の 2 つだけです。
どちらもforward-onlyで、down/rollback commandはありません。使い捨てfixtureの
resetはlocal/development/test用の注入clientだけに限定され、ここで指定する
database URLやproduction credentialを読みません。

compose を使わず手で動かす場合は、同じ環境変数を渡して
`bun deploy/node-postgres/src/server.ts` を起動します。待ち受けは
`TAKOSUMI_ACCOUNTS_BIND_HOST` (既定 `0.0.0.0`) と `PORT` (既定 `8787`) で決まります。

`takosumi accounts serve` は手元の確認用です。プロセスごとに使い捨ての署名鍵を作るので、
公開して使う accounts は Cloudflare か Bun と PostgreSQL の雛形で動かしてください。

## 手元だけで通す

手元の Linux で、公開面を一切持たずに全体を動かします。

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
bash scripts/smoke.sh
```

`ca-install.sh` はホストの信頼ストアと、Chrome / Firefox の NSS データベースの両方に
Pebble の root CA を入れます。Pebble は起動のたびに root を作り直すので、`up.sh` を
やり直したら `ca-install.sh` も実行し直してブラウザを再起動します。

## 動いていることを確かめる

まずプロセスが応答することを見ます。

```bash
curl -s https://takosumi.example.com/healthz
```

次に依存が揃っていることを見ます。Cloudflare 構成の `/readyz` は binding の有無を
点検し、足りないものがあれば名前を挙げて `503` を返します。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://takosumi.example.com/readyz
```

サインインの土台が立っているかは、OIDC の discovery で見ます。`issuer` に
`TAKOSUMI_ACCOUNTS_ISSUER` と同じ値が返れば正しく設定できています。

```bash
curl -s https://takosumi.example.com/.well-known/openid-configuration
```

この endpoint が何を有効にしているかは、製品の discovery で分かります。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
curl -s https://takosumi.example.com/v1/capabilities
```

ここまでが通ったら、実データを 1 回読みます。dashboard でサインインして
[CLI](../reference/cli.md) の手順で token を作り、Workspace の一覧を取ります。`401` では
なく `200` が返れば、認証と記録の読み取りが通っています。

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

最後に、実際に 1 回デプロイします。dashboard の `/new` に Git URL を入れて計画を作り、
内容を確認してから適用します。Run が成功し、StateVersion と Output が残れば、runner と
state backend まで通っています。provider の認証を必要としない
`examples/opentofu-basic` が、この確認にちょうど使えます。

## 次に決めること

ここまでで endpoint は動きます。そのうえで、何を使えるようにするかは動かしている側が
決めます。使える Resource の型、配置先、runner の並列度、定期観測の頻度、秘密の
扱いはすべて設定で決まります。変数の一覧と決め方は
[設定リファレンス](../reference/configuration.md)にあります。

その endpoint を使う人から見て、あなたがどこまでを引き受けることになるのかは
[製品の境界](./boundaries.md)にまとめてあります。
