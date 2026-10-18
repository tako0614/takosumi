# 自分で動かす

Takosumi は自分の環境に置いて、自分の endpoint として動かせます。ソフトウェアは
AGPL-3.0 で公開しています。利用者が接続する origin に control plane、accounts、dashboard
をまとめます。OpenTofu runner と source/artifact/state の永続化は構成ごとに異なります。
CLI、dashboard、Takoform client とその他の API client は、その origin に向かって話します。

リポジトリの `deploy/` に、置き場所の違う 3 つの雛形が入っています。

## 構成を選ぶ

| 構成と雛形 | plan と apply | 実行環境 | 状態の保存先 |
| --- | --- | --- | --- |
| **Cloudflare**<br>`deploy/platform/` | plan はできます。apply と destroy には release tool が作る digest が要ります（[下記](#apply-と-destroy-について)） | Cloudflare Workers | D1 / R2 / Durable Objects |
| **Bun と PostgreSQL**<br>`deploy/node-postgres/` | runner を別に組み込むまでできません | VM やコンテナ | PostgreSQL |
| **手元だけ**<br>`deploy/local-substrate/` | できます（`--profile postgres` で起動する同梱の runner コンテナ） | 手元の Linux と Docker | Docker Compose のボリューム |

**Cloudflare** は、サーバーを自分で持たずに運用したい場合に向きます。Workers Paid プランの
Cloudflare アカウントと、Cloudflare で DNS を管理しているドメインが要ります。OpenTofu の
実行は Cloudflare Container の runner が引き受けます。1 つの Worker に accounts、
control plane、dashboard、runner がまとまります。

**Bun と PostgreSQL** は、自分のインフラに置きたい場合に向きます。Docker が動くホストが
あれば、同梱の `docker-compose.yml` が PostgreSQL、control plane と Accounts のデータベースの
移行（schema migration）、サービス本体、TLS 用 Caddy を起動します。この標準の構成には、
OpenTofu を動かす runner も、その成果物の保存先もありません。制御情報の書き出しと削除前の
書き出し（control / pre-destroy export）は `takosumi-runtime` volume に保存します。Accounts、
control plane、dashboard の確認には使えますが、Git の同期、plan、apply は
`runner_capability_missing` になります。plan と apply には、runner とその保存先を組み込んだ
構成を自分で用意する必要があります。

**手元だけ**の構成は、公開せずに全体を通したい場合に使います。Linux、Docker、Bun と、
証明書と DNS を設定するための `sudo` が要ります。ACME 用の Pebble、CoreDNS、Caddy を
同じ Docker ネットワークに立て、`*.takosumi.test` を本番と同じ形で解決します。

## 費用

Takosumi のソフトウェアに利用料はありません（AGPL-3.0）。かかるのは、Takosumi を置く場所の
料金と、追加したアプリが作るリソースの料金です。

- **Cloudflare** — Workers Paid プランの料金と、Workers、Containers、D1、R2、Durable Objects、
  ログ（observability）の使用量が Cloudflare から請求されます。dashboard の表示も Worker への
  リクエストになります。ほかに、ドメインの費用がかかります。金額は Cloudflare の
  [Workers の料金](https://www.cloudflare.com/plans/developer-platform/)と
  [Containers の料金](https://developers.cloudflare.com/containers/platform/pricing/)で
  確かめてください。

  runner のコンテナ（雛形では 2 vCPU・6 GiB・ディスク 10 GB、最大 10 台）が起動するのは、
  変更の確認・デプロイ・削除、リポジトリの取得、追加前の確認、利用者が依頼した復元・
  バックアップ・安定版タグの確認のときです。自動で同期するリポジトリがあると、毎時の確認でも
  起動します。drift の確認と、更新があるサービスの自動の変更確認は、有効にした場合だけ起動
  します。どれも、その処理が終わるか、約 30 秒操作がないと止まります。
- **Bun と PostgreSQL** — Docker を動かすサーバーと PostgreSQL の費用です。plan と apply には、
  別に組み込む runner の費用もかかります。
- **手元だけ** — Takosumi 自体は、手元のマシンの中だけで動きます。
- **追加したアプリのリソース** — アプリが作る Worker、bucket、データベースなどの料金は、
  接続したアカウントの事業者（Cloudflare など）から、そのアカウントに請求されます。

## Cloudflare に置く

次のものを用意します。

- Workers Paid プランの Cloudflare アカウント。runner に Cloudflare Containers を使うため、
  Free プランでは動きません。
- R2 を有効にしておくこと。無料枠の範囲で使う場合も、Cloudflare のダッシュボードの R2 で
  一度購入手続きを済ませるまでバケットを作れません。
- Cloudflare で DNS を管理しているドメイン。`routes` の hostname を custom domain として
  登録し、その origin を Accounts の issuer にします。
- `wrangler deploy` を実行するマシンで動いている Docker。deploy の途中で
  `runner/Dockerfile` から runner のイメージをビルドします。
- Bun と、このリポジトリのチェックアウト。dashboard のビルドと、Accounts の D1 スキーマを
  適用する `takosumi` CLI に使います。

必要な binding は `deploy/platform/wrangler.toml` にすべて書いてあります。

| binding | 役割 |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_DB` (D1) | セッション、OIDC、PAT を保存します |
| `TAKOSUMI_CONTROL_DB` (D1) | Run、StateVersion、Output の記録です |
| `R2_ARTIFACTS` | plan と state の成果物を置きます |
| `R2_SOURCE` | SourceSnapshot（commit に固定したソース）を tar.zst で置きます |
| `R2_STATE` | OpenTofu の state backend です |
| `R2_BACKUPS` | backup と export の束を置きます |
| `COORDINATION` / `RUN_OWNER` / `RUNNER` (Durable Object) | 排他制御、Run の所有、runner コンテナを担当します |
| `ASSETS` | dashboard の配布物を配ります |

Run は作成時に `RUN_OWNER` へ直接 schedule されます。この構成では、Cloudflare Queue も、
失敗した処理を退避させる dead-letter queue も使いません。`RUN_OWNER` が再試行と最終的な失敗の
扱いを受け持ち、binding がなければ Run を実行に回しません（fail closed）。

このリポジトリが固定している wrangler を入れてログインします。以下の `bun run wrangler` は
この版を使います。

```bash
bun install
bun run wrangler -- login
```

リソースを作ります。名前は雛形に合わせています。

```bash
bun run wrangler -- d1 create takosumi-accounts
bun run wrangler -- d1 create takosumi-deploy
bun run wrangler -- r2 bucket create takos-artifacts
bun run wrangler -- r2 bucket create takosumi-source
bun run wrangler -- r2 bucket create takosumi-state
bun run wrangler -- r2 bucket create takosumi-backups
```

### 自分用の設定を作る

雛形の `deploy/platform/wrangler.toml` は書き換えず、チェックアウトの外に写します。あとで使う
`takosumi accounts migrate-d1` は、変更のないチェックアウトでしか動かないためです。

```bash
install -d -m 700 "$HOME/.takosumi-private"
cp deploy/platform/wrangler.toml "$HOME/.takosumi-private/wrangler.toml"
```

写した設定で次を書き換えます。`<checkout>` はこのリポジトリの絶対パスです。雛形の相対パスは
設定ファイルの場所から解決されるため、写した先では絶対パスにします。

| 項目 | 書く値 |
| --- | --- |
| 2 つの `database_id` | `d1 create` が表示した ID |
| `[[routes]]` の `pattern` | 公開する hostname |
| `[vars]` の `TAKOSUMI_ACCOUNTS_ISSUER` | dashboard を配る origin（`https://` から） |
| `main`（先頭に追加） | `"<checkout>/deploy/platform/entry-worker.ts"` |
| `[assets]` の `directory`（追加） | `"<checkout>/dashboard/dist"` |
| `[[containers]]` の `image` と `image_build_context` | `"<checkout>/runner/Dockerfile"` と `"<checkout>"` |
| `[vars]` の `TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE`（追加） | `"predeployed"`。Accounts D1 のスキーマは下の CLI で入れ、Worker には作らせません |
| `[vars]` の `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`（追加） | サインインに使う上流の ID プロバイダの記述子を JSON にした**文字列**。`'[{"providerId": ...}]'` のように TOML の literal string で書きます |

この設定は自分の環境の値を含むので、公開しない場所で管理します。雛形の `[vars]` には
`TAKOSUMI_ENVIRONMENT = "production"` がすでに設定されています。この値が `production` か
`staging` のとき、暗号鍵と永続ストアの検査に通らなければ、警告で済ませずに起動しません
（fail closed）。値の意味は[設定リファレンス](../reference/configuration.md)にまとめてあります。

最初のアカウントは、上流の ID プロバイダでサインインして作ります。passkey は、サインイン
済みのアカウントに後から追加する手段です。`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` の書き方は
[設定リファレンス](../reference/configuration.md)にあります。provider の client secret と
`TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` は、下の secret と一緒に送ります。記述子の `redirectUri` は
`https://<公開する origin>/sign-in/callback` で、ID プロバイダにもこの URI をそのまま登録します。Cloudflare 構成では、記述子の中身が壊れて
いるとサインインの手段が出ず、ログに `auth_providers_upstream_oauth_disabled` が残ります。値を
TOML の配列で書くと Worker に文字列として届かず、ログを出さずにサインインの手段が出ません。

dashboard をビルドします。`ASSETS` はこの出力を配ります。dashboard はルートの workspace に
含まれないため、`build:dashboard` が dashboard 自身の lockfile で依存を入れてからビルドします。

```bash
bun run build:dashboard
```

### Accounts D1 のスキーマを入れる

accounts 側の D1 スキーマは、チェックアウトの `takosumi` CLI で、deploy の前に適用します。
用意の仕方は [CLI](../reference/cli.md) にあります。Accounts D1 が対応する版でないと Worker は
要求を処理せず、ログに `accounts_d1_schema_incompatible` を出します。上の表で
`predeployed` にしたので、Worker は Accounts D1 に DDL を出さず、版の確認だけを行います。

次の値を環境変数に入れます。

| 変数 | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | D1 の Edit 権限を持つ Cloudflare API トークン。CLI は値を表示しません |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |
| `CLOUDFLARE_DATABASE_ID` | `takosumi-accounts` の database ID |
| `SOURCE_COMMIT` | 変更のないチェックアウトの commit（`git rev-parse HEAD`）。一致しないと CLI は外部に触れずに止まります |

各段階は結果を JSON で表示します。`BACKUP_EVIDENCE_DIGEST` には backup-status が表示する
`backupEvidenceDigest` を入れます。`SOURCE_DIGEST`、`CATALOG_DIGEST`、`TARGET_DIGEST`、
`CONFIGURATION_DIGEST` には、plan が表示する `sourceDigest`、`catalogDigest`、`targetDigest`、
`configurationDigest` を入れます。`--out` には毎回新しいファイル名を指定します。同じ名前の
ファイルがあると止まります。

```bash
# 1. 適用前の状態を記録する。Time Travel の bookmark を非公開のファイルに書き出し、
#    backupEvidenceDigest を表示します
takosumi accounts migrate-d1 backup-status \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --out "$HOME/.takosumi-private/accounts-d1-backup-$(date +%Y%m%d%H%M%S).json"
# 2. 適用する内容を確かめる。遠隔の呼び出しはしません
takosumi accounts migrate-d1 plan \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --backup-evidence-digest "$BACKUP_EVIDENCE_DIGEST"
# 3. plan が表示した 4 つの digest を確かめてから適用する
#    （... には plan と同じ指定をすべて書きます）
takosumi accounts migrate-d1 apply ... \
  --confirm-source-digest "$SOURCE_DIGEST" \
  --confirm-catalog-digest "$CATALOG_DIGEST" \
  --confirm-target-digest "$TARGET_DIGEST" \
  --confirm-configuration-digest "$CONFIGURATION_DIGEST"
# 4. 読み取りだけで結果を確かめる
takosumi accounts migrate-d1 verify ...
```

新しく作った D1 には、apply が最初の版から最新の版まで順に適用します。apply は migration
ごとに 1 回だけ atomic な batch を送り、途中で失敗しても自動では再試行しません。読み取りだけの
`status` で状態を確かめてから、次の操作を決めます。CLI はデータベースを復元しません。書き出した
bookmark は復元の手がかりになるため、チェックアウトの外で非公開のまま保管します。適用した後は、
その版を受け付けない古い Worker には戻せません。すでに動いている環境の Accounts D1 を上げる
場合は、[Takosumi 本体を更新する](../self-host/upgrade.md)を参照してください。

control plane 側の D1 にマイグレーションは要りません。`TAKOSUMI_CONTROL_D1_SCHEMA_MODE`
が既定の `bootstrap` のあいだ、最初のリクエストでスキーマが整います。事前に用意した
スキーマだけで動かしたい場合は `predeployed` にします。

### secret と一緒に deploy する

wrangler は、環境変数の `CLOUDFLARE_API_TOKEN` を `wrangler login` より優先して使います。D1 の
権限しか持たないトークンで deploy しないよう、先に外します。

Worker がまだ無いうちは `wrangler secret put` で secret を入れられません。secret は非公開の
JSON ファイルにまとめ、最初の deploy と一緒に送ります。入れるのは
`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`、`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`、
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`、`TAKOSUMI_SECRET_STORE_PASSPHRASE`
（認証情報と state の封印鍵）、`TAKOSUMI_DEPLOY_CONTROL_TOKEN`（operator 専用 API の
bearer）と、上流の ID プロバイダの client secret と `TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` です。
値の作り方は [Bun と PostgreSQL に置く](#bun-と-postgresql-に置く)と同じです。値はすべて文字列に
します。ES256 の JWK も、生成した JSON をエスケープした文字列として入れます。client secret の
名前は、記述子の `clientSecretEnv` と同じにします。

```json
{
  "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK": "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"...\",\"x\":\"...\",\"y\":\"...\"}",
  "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT": "...",
  "COMPANY_SSO_CLIENT_SECRET": "..."
}
```

```bash
unset CLOUDFLARE_API_TOKEN
# $HOME/.takosumi-private/secrets.json に上の形で書く
chmod 600 "$HOME/.takosumi-private/secrets.json"
bun run wrangler -- deploy \
  --config "$HOME/.takosumi-private/wrangler.toml" \
  --secrets-file "$HOME/.takosumi-private/secrets.json"
```

以後の deploy でも、同じファイルを `--secrets-file` で渡します。secrets.json はほかの秘密と
同じように扱い、非公開の場所に置きます。

### apply と destroy について

この手順で置いた Worker では、変更の確認（plan）までは動きますが、apply と destroy は
止まります。apply と destroy には、実行物を示す 3 つの digest
（`TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST`、`TAKOSUMI_RUNNER_ARTIFACT_DIGEST`、
`TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST`）が要ります。今はこれらを Takosumi の release tool だけが
作り、self-host 向けに用意する手順はまだありません。digest の無い Worker は、apply と
destroy の Run を、provider 側には触れずに `execution_evidence_authority_unavailable` で失敗に
します。

## Bun と PostgreSQL に置く

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

### ローカルで安全に起動して確認する

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

### 公開して運用する

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
Pebble の root CA を入れます。Pebble はコンテナが起動するたびに root を作り直すので、
`down.sh` のあとに `up.sh` で起動し直したときや、ホストを再起動したあとに証明書の
エラーが出たときは、`ca-install.sh` も実行し直してブラウザを再起動します。設定の意味と
元に戻す手順は[クイックスタート](../getting-started/quickstart.md)にあります。

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

Bun と PostgreSQL の構成の `/readyz` は、`TAKOSUMI_INTERNAL_API_SECRET` が無いと `503` を返し、
理由に `internalApiSecret` を挙げます。同梱の Compose はこの値を渡さず、今はこの確認のほかに
使われていないので、`/healthz` が `200` なら動いています。`/readyz` も通したい場合は、
`openssl rand -hex 32` で作った値を `.env` に入れ、`docker-compose.override.yml` で渡します。

```yaml
services:
  accounts:
    environment:
      TAKOSUMI_INTERNAL_API_SECRET: ${TAKOSUMI_INTERNAL_API_SECRET:?set TAKOSUMI_INTERNAL_API_SECRET in .env}
```

サインインの土台が立っているかは、OIDC の discovery で見ます。`issuer` に
`TAKOSUMI_ACCOUNTS_ISSUER` と同じ値が返れば正しく設定できています。

```bash
curl -s https://takosumi.example.com/.well-known/openid-configuration
```

この endpoint が何を有効にしているかは、製品の discovery で分かります。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
curl -s https://takosumi.example.com/api/v1/capabilities
```

ここまでが通ったら、実データを 1 回読みます。dashboard でサインインし、
[API キーの作り方](../reference/cli.md#トークンを発行する)に沿って、**読み取り** を持ち、
**現在のワークスペースだけで使用できるようにする** が表示されていればオフにした API キーを作って、Workspace の
一覧を取ります。scope は互いを含まないので、`write` だけの token ではこの読み取りが `403` に
なります。使うのは発行した token で、operator 専用の `TAKOSUMI_DEPLOY_CONTROL_TOKEN` では
ありません。作ったキーを環境変数 `TAKOSUMI_READ_TOKEN` に設定して次を実行し、`200` が返れば、
認証と記録の読み取りが通っています。

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_READ_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

最後に、runner を含む構成で実際に 1 回デプロイします。dashboard の `/new` に Git URL を入れて計画を作り、
内容を確認してからデプロイします。Cloudflare 構成で 3 つの digest が無いあいだは、
[apply と destroy について](#apply-と-destroy-について)のとおり、計画の作成までを確かめます。Run が成功し、StateVersion と Output が残れば、runner と
state backend まで通っています。provider の認証を必要としない
`examples/opentofu-basic` が、この確認にちょうど使えます。

## 次に決めること

ここまでで endpoint は動きます。そのうえで、何を使えるようにするかは動かしている側が
決めます。有効にする runner の profile、定期的な確認 1 回で拾う Source の上限、削除の猶予期間、
秘密の保存のしかたなどは、すべて設定で決まります。変数の一覧と決め方は
[設定リファレンス](../reference/configuration.md)にあります。

その endpoint を使う人から見て、あなたがどこまでを引き受けることになるのかは
[製品の境界](./boundaries.md)にまとめてあります。

[運用ガイド](../self-host/index.md)
