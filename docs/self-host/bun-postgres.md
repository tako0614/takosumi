# Bun と PostgreSQL に置く

構成の選び方と費用は[自分で動かす](../concepts/self-host.md)にあります。このページは、Bun と PostgreSQL の雛形
`deploy/node-postgres/` を置く手順です。

`deploy/node-postgres/` の Docker Compose 定義が、PostgreSQL、マイグレーション、サービス本体、
Caddy を順に起動します。サービス本体は accounts と control plane と dashboard を
同じ origin に載せた 1 プロセスです。リポジトリのルートから始めます。

```bash
cd deploy/node-postgres
[ -e .env ] || cp .env.example .env
```

`.env` を編集します。Compose はこのファイルを変数展開に使い、`docker-compose.yml` に
明示したサービス設定だけを `accounts` に渡します。最低限、次を埋めます。各値の生成
コマンドは `.env.example` の該当箇所に書いてあります。`https` issuer を使う場合は安定した
ES256 private JWK が必要です。ローカル smoke test は `http://localhost:26401` issuer を使えます。
`.env` は秘密を含むため commit しません。

| 変数 | なぜ要るか |
| --- | --- |
| `POSTGRES_PASSWORD` | PostgreSQL のパスワード |
| `TAKOSUMI_ACCOUNTS_ISSUER` / `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` | 公開する origin と、Caddy が証明書を取る hostname |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` | id_token の署名鍵 |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | 署名鍵と対で使う subject の導出鍵 |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` | セッション ID を保存時にハッシュする salt |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | 認証情報と state の封印鍵 |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | operator 専用 API の bearer |

まずホストで秘密値を生成します。次のコマンドは個別の値を表示するので、値を `.env` にだけ
記録し、terminal recording や共有ログに残さないでください。

```bash
openssl rand -hex 32 # POSTGRES_PASSWORD
openssl rand -hex 32 # TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET
openssl rand -hex 32 # TAKOSUMI_SECRET_STORE_PASSPHRASE
openssl rand -hex 32 # TAKOSUMI_ACCOUNT_SESSION_HASH_SALT
openssl rand -hex 32 # TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

OIDC の ES256 JWK は `.env.example` にある Bun の生成コマンドで作ります。生成した JSON は
`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` に設定します。ローカル確認用には issuer と passkey origin
を `http://localhost:26401`、RP ID を `localhost`、redirect URI を
`http://localhost:26401/oauth/callback` に合わせます。公開運用では利用者が開く HTTPS origin と
hostname に合わせます。

issuer が https のとき、署名鍵が届いていないとサービスは起動を拒否します。プロセスごとに
違う鍵で id_token に署名してしまい、再起動や複数レプリカで検証が壊れるためです。封印鍵が
無い場合も、平文で保存する代わりに起動を拒否します。

サインインの手段も `.env` で決めます。最初のアカウントは、上流の ID プロバイダ
(`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` と、そこで `clientSecretEnv` に指定した名前の
secret) でサインインして作ります。passkey (`TAKOSUMI_ACCOUNTS_PASSKEY_*`) は、サインイン
済みのアカウントに後から追加する手段です。どちらも `.env.example` に例があります。
任意名の `clientSecretEnv` は `docker-compose.override.yml` の `accounts.environment` に
1つずつ明示して渡します。`deploy/node-postgres/README.md`
に override の例があります。`.env` に名前と値を書くだけではコンテナへ届きません。記述子の
`redirectUri` は `https://<公開する origin>/sign-in/callback` で、ID プロバイダにもこの URI を
そのまま登録します。

`.env` は秘密を含むので commit しません。このリポジトリは `deploy/node-postgres/.env` を
`.gitignore` で除外しています。

公開運用で既定 Compose を使うと Caddy が port 80/443 に bind して ACME 証明書を取得します。
これは公開 HTTPS deployment 用です。Caddy を含めず loopback だけで確認する手順は次の
「ローカルで安全に起動して確認する」を使います。

## ローカルで安全に起動して確認する

次の一時 override は checkout 外に作成し、host port を loopback の `26401` にだけ bind します。
専用の一意な Compose project を使います。Compose の既定 `caddy` service は明示して起動せず、
ローカル確認で ACME/TLS 用 Caddy を使いません。前の `.env` 設定後、同じ shell で実行します。

```bash
set -euo pipefail
local_project="takosumi-local-test-$(date +%s)-$$"
local_dir="$(mktemp -d)"
cat > "$local_dir/compose.local-test.yml" <<'YAML'
services:
  accounts:
    environment:
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: ""
    ports:
      - "127.0.0.1:26401:8787"
YAML
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose up --build -d --wait accounts
local_compose ps
curl -fsS http://localhost:26401/healthz
```

`--wait` は Docker Compose v2 が必要です。この一時構成は checkout の通常
`docker-compose.override.yml` を読み込まず、host port は loopback だけに bind します。

`migrations` が終了コード 0 で完了し、`accounts` が healthy なら dashboard を
`http://localhost:26401/` で開きます。この既定の health/dashboard smoke test は upstream provider を
無効にし、account は作りません。sign-in も確認する場合は起動前に一時 override の空の
`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` を provider descriptor に置き換え、その `clientSecretEnv` 名を
同じ override に追加してください。通常の `docker-compose.override.yml` は host port の公開設定も
持つ可能性があるため、丸ごと読み込まず必要な secret mapping だけを一時 override に写します。
provider/client callback も `localhost:26401` に合わせます。passkey は既存 account への追加手段です。確認後は
`local_compose down`
で停止し、`rm -rf "$local_dir"` で一時 override を削除します。専用の PostgreSQL volume は
残るため、`down` はデータを消しません。

## 公開して運用する

本番では、HTTPS の issuer と公開する hostname を設定してから、既定の構成を起動します。Caddy が
80 番と 443 番で待ち受けるので、hostname がこのホストを指し、ACME の確認で外から届く必要が
あります。

```bash
docker compose up --build -d
curl -fsS https://app.example.com/healthz # 設定した公開 hostname に置き換えます
```

初回はイメージのビルドに数分かかります。`migrations` コンテナが control plane と accounts の
2 つのスキーマを同じデータベースに適用し、成功してからサービス本体と Caddy が起動します。

マイグレーションを compose の外から適用する場合は、リポジトリのルートで実行します。同梱の
Docker Compose 定義は PostgreSQL を内部ネットワークにしか出さないので、先に 5432 を公開するか、
同じネットワークから届くホストで実行します。

```bash
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
takosumi accounts migrate --database-url "$DATABASE_URL"
```

`bun run db:migrate:dry-run` を先に実行すると、適用せずに SQL だけ表示します。表示されるのは catalog 全体で、この database に未適用のものだけではありません。
`--env=local` は接続せずメモリ上で走るので、実際のデータベースには何もしません。
実データベースに当てる `--env` は `production` と `staging` の 2 つだけです。
どちらもforward-onlyで、down/rollback commandはありません。使い捨てfixtureの
resetはlocal/development/test用の注入clientだけに限定され、ここで指定する
database URLやproduction credentialを読みません。

Docker Compose を使わず手で動かす場合は、同じ環境変数を渡して
`bun deploy/node-postgres/src/server.ts` を起動します。待ち受けは
`TAKOSUMI_ACCOUNTS_BIND_HOST` (既定 `0.0.0.0`) と `PORT` (既定 `8787`) で決まります。

`takosumi accounts serve` は手元の確認用です。プロセスごとに使い捨ての署名鍵を作るので、
公開して使う accounts は Cloudflare か Bun と PostgreSQL の雛形で動かしてください。

この雛形には OpenTofu runner が入っていません。accounts、control plane、dashboard は
動きますが、Git の同期、plan、apply は `runner_capability_missing` で失敗します。plan と
apply を実行するには、runner を組み込んだ構成を使います。Cloudflare 構成か、
`deploy/local-substrate/` のように runner コンテナをつないだ、自分で組んだ構成です。
