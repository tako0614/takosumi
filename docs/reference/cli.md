# CLI

Takosumi CLI は、画面でできる操作を自動化したい場合の補助ツールです。通常は
dashboard の `/install?git=...` / `/new` からサービスを選び、接続する provider を選んで
plan / apply します。CLI は任意の Takosumi endpoint に向けて使えます。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://git.example.com/example/photo-blog.git&path=deploy/opentofu&ref=v1.0.0"

takosumi status <run-id>
takosumi logs   <run-id>
```

Takosumi Cloud を使う場合の hosted endpoint は `https://app.takosumi.com` です。

CLI は OpenTofu を直接実行しません。通常の作成フローは dashboard の Git URL install で、
ここで Source / Capsule / Run を作ります。Run の source identity として Git commit / ref /
path を固定し、実行は runner sandbox で行います。credential は ProviderConnection と
CredentialRecipe から、Run の実行中だけ env/file として注入されます。
`takosumi deploy` / `takosumi plan` のローカルアップロード経路は廃止済みです。

## トークンを発行する

ほかのページが使えと書いている `TAKOSUMI_DEPLOY_CONTROL_TOKEN` は、ここで作ります。

```bash
takosumi accounts tokens create \
  --name my-cli \
  --scope write \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --token "$TAKOSUMI_ACCOUNTS_SESSION_BEARER"
```

| オプション | 意味 |
| --- | --- |
| `--name` | 見分けるための名前 |
| `--scope` | `read` / `write` / `admin` |
| `--expires-at` | 失効日時 (ISO 8601) |
| `--accounts-url` | Accounts の URL。環境変数は `TAKOSUMI_ACCOUNTS_URL` |
| `--token` | **Accounts のセッション bearer** (`sess_...`) |
| `--json` | JSON で出力する |

`accounts` 系の `--token` に渡すのは Accounts のセッション bearer であって、発行
された token ではありません。ここだけ他のコマンドと渡すものが違います。

**発行された token 文字列は作成時に 1 度しか返りません。** 一覧に出るのは名前、
接頭辞、scope、作成日時などのメタ情報だけです。失った場合は取り出せないので、
新しく作って古いものを失効させます。

```bash
takosumi accounts tokens list   --accounts-url "$TAKOSUMI_ACCOUNTS_URL" --token "$SESSION"
takosumi accounts tokens revoke pat_example --accounts-url "$TAKOSUMI_ACCOUNTS_URL" --token "$SESSION"
```

`admin` は自分では付けられません。operator が発行したものだけが持ちます。

## self-host のセットアップ

自分の環境で Accounts を動かす場合のコマンドです。すでに動いている endpoint を
使うだけなら不要です。

### スキーマを適用する

PostgreSQL を使う場合。

```bash
takosumi accounts migrate --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
```

`--dry-run` を付けると、適用せずに何が実行されるかだけを表示します。接続先は
`TAKOSUMI_ACCOUNTS_DATABASE_URL` からも読みます。

Cloudflare D1 を使う場合は別のコマンドです。保留中のマイグレーションごとに
`bunx wrangler d1 execute` を呼び、適用済みの版を `takosumi_accounts_schema_migrations`
に記録します。

```bash
takosumi accounts migrate-d1 --database-id takosumi-accounts --remote
```

| オプション | 意味 |
| --- | --- |
| `--database-id` | D1 のデータベース名または binding 名 |
| `--wrangler-config` | 別のチェックアウトから実行するときの wrangler 設定 |
| `--account-id` | Cloudflare のアカウント ID (既定と違う場合に必要) |
| `--remote` / `--local` | リモートの D1 か、手元の miniflare か。既定は `--remote` |
| `--env` | wrangler に渡す `--env` プロファイル |

初回デプロイ前に動作を確かめるときは `--local` を使います。

### 初期データを入れる

```bash
takosumi accounts seed \
  --issuer https://accounts.example.com \
  --subject tsub_example \
  --client-id example-client \
  --redirect-uri https://app.example.com/callback
```

### 起動する

```bash
takosumi accounts serve \
  --issuer https://accounts.example.com \
  --hostname 0.0.0.0 --port 8080 \
  --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
```

上流の ID プロバイダや passkey を使う場合は、`--upstream-providers` (JSON 配列)、
`--passkey-rp-id`、`--passkey-rp-name`、`--passkey-origin` などを併せて指定します。
手元の確認用に 1 つだけセッションを用意したい場合は `--dev-session-id sess_...` を
使います。**本番では使わないでください。**

## Platform readiness の contribution を追加する

`takosumi launch-readiness template` は OSS/Operator に共通する baseline を生成します。
hosted service や別の edition が追加の運用証跡を要求する場合は、owner 側が versioned な
`PlatformReadinessContribution` JSON を管理します。template を生成するときに
`--contribution-file <path>` で選びます。

```bash
takosumi launch-readiness template \
  --contribution-file <owner-controlled-contribution.json> \
  > readiness.private.json

takosumi launch-readiness validate --file readiness.private.json
```

生成される `takosumi.platform-readiness@v2` document には、contribution の `id` /
`version` / `capability` が埋め込まれます。追加の requirement / evidence schema も同じ
document に入ります。そのため validate と public-summary は、その document だけで
検証でき、根拠が足りなければ安全側に停止します。
provider 固有のコードや外部 registry の lookup は使いません。contribution の version が
違えば、別の readiness profile として扱います。旧 baseline ID は validate 時に二重解釈せず、
明示的な `launch-readiness migrate-final-model` で一度だけ更新します。

contribution が collection planning を補助するときに使えるのは `collectionClassHints`
だけです。これは contribution 自身が定義した evidence type を、既存の固定 class へ
割り当てる hint です。固定 class は `browser-user-e2e` / `external-provider` /
`operator-review` / `live-probe-sync` / `operation-drill` / `release-provenance` の
6 つです。hint を省略した extension evidence は、validation 上は有効なまま
collection planning では uncategorized になります。

validate が返す `takosumi.platform-readiness-report@v2` には、組み合わせた定義の
`requiredDomainIds` / `requiredRehearsalStepIds` も含まれます。進捗を集計する側は
OSS 固定の ID ではなくこの配列を使います。そうすることで、Operator / Cloud の
contribution を含めた total と complete の件数を正確に数えられます。

## ProviderConnection を登録する

Provider credential の値はファイルから読み込み、画面には表示しません。

```bash
takosumi connections create \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file <path-to-credential-env-json>

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

Compatibility API は、operator が extension capability として明示的に構成します。CLI から
作る ProviderConnection でも、対象の provider は `--provider` で明示します。

## Resource Shape を操作する

Resource Shape flow が操作するのは、Takosumi に保存された Resource / TargetPool /
SpacePolicy の宣言と、明示的な reconcile operation です。write request は non-secret な
JSON object を file から読みます。通常の出力は Resource の phase、Target、Run id といった
要約だけで、request body や Output の値は表示しません。完全な public response が必要な
場合だけ `--json` を指定します。

```bash
takosumi resources preview --file resource.json
takosumi resources apply EdgeWorker api --file resource.json
takosumi resources import EdgeWorker api --file resource-with-native-id.json

takosumi resources list --space space_...
takosumi resources get EdgeWorker api --space space_...
takosumi resources events EdgeWorker api --space space_...
takosumi resources observe EdgeWorker api --space space_...
takosumi resources refresh EdgeWorker api --space space_...
takosumi resources delete EdgeWorker api --space space_...
```

`preview` / `apply` の file は Resource Shape API と同じ `kind` / `metadata` / `spec` を持ちます。
`import` はそれに top-level の `nativeId` を足します。credential や secret は Resource spec や
`nativeId` に入れず、ProviderConnection / CredentialRecipe で管理します。`delete --force` は endpoint
側で operator break-glass 認可が明示されている場合だけ成功します。

Target と Policy の宣言も同じ endpoint に直接送ります。

```bash
takosumi target-pools put default --file target-pool.json
takosumi target-pools list --space space_...
takosumi target-pools get default --space space_...
takosumi target-pools delete default --space space_...

takosumi space-policies put default --file space-policy.json
takosumi space-policies list --space space_...
takosumi space-policies get default --space space_...
takosumi space-policies delete default --space space_...
```

`target-pool.json` は top-level に `space` と `spec.targets` を持つ API request body です。
`space-policy.json` は top-level に `space` と `spec` を持ちます。一覧の `nextCursor` は
opaque なので、内容を解釈せず、そのまま次ページの `--cursor` に渡します。

## デプロイ先の secret

deployment runtime の secret を保存して適用するのは、その runtime adapter と operator
vault です。Takosumi CLI が扱うのは provider credential で、`takosumi connections` から
ProviderConnection として登録します。platform service の signing key や internal bearer
は、repo の外で生成して保管します。適用は、選んだ deployment adapter の native な
secret command で行います。
