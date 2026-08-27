# CLI

Takosumi CLI は、画面でできる操作を自動化したい場合の補助ツールです。通常は
dashboard の `/install?git=...` / `/new` からサービスを選び、接続する provider を選んで
plan / apply します。CLI は任意の Takosumi endpoint に向けて使えます。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://git.example.com/example/photo-blog.git&ref=v1.0.0&sourcePath=infra&path=deploy/opentofu"

takosumi status <run-id>
takosumi logs   <run-id>
```

Takosumi hosted service を使う場合の endpoint は `https://app.takosumi.com` です。

CLI は OpenTofu を直接実行しません。通常の作成フローは dashboard の Git URL install で、
ここで Source / Capsule / Run を作ります。`sourcePath` は Source が取得する Git subtree、
`path` はその Snapshot 内で scan された module path です。Run の source identity として
Git commit / ref と両方の path を固定し、実行は runner sandbox で行います。credential は ProviderConnection と
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

| オプション       | 意味                                                |
| ---------------- | --------------------------------------------------- |
| `--name`         | 見分けるための名前                                  |
| `--scope`        | `read` / `write` / `admin`                          |
| `--expires-at`   | 失効日時 (ISO 8601)                                 |
| `--accounts-url` | Accounts の URL。環境変数は `TAKOSUMI_ACCOUNTS_URL` |
| `--token`        | **Accounts のセッション bearer** (`sess_...`)       |
| `--json`         | JSON で出力する                                     |

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

Cloudflare D1 の schema migration は customer-facing CLI workflow ではなく、
deployment owner が release と同じ change window で扱う運用手順です。この公開 CLI
reference には account/database identifiers、backup custody、confirmation digests、
apply/verify sequencing を掲載しません。

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
`takosumi.platform-readiness-contribution@v2` の
`PlatformReadinessContribution` JSON を管理します。template を生成するときに
`--contribution-file <path>` で選びます。

```bash
takosumi launch-readiness template \
  --contribution-file <owner-controlled-contribution.json> \
  > readiness.private.json

takosumi launch-readiness validate \
  --file readiness.private.json \
  --contribution-file <owner-controlled-contribution.json>
```

生成される `takosumi.platform-readiness@v2` document には、contribution の `id` /
`version` / `capability` が埋め込まれます。追加の requirement / evidence schema も同じ
document に入ります。ただし embedded copy は authority ではありません。contribution を
含む document の validate / public-summary / public-summary validate では、owner-controlled
`--contribution-file` をもう一度渡します。validator はその trusted input で profile を組み立て、
embedded copy の全 content が完全一致しなければ安全側に停止します。
provider 固有のコードや外部 registry の lookup は使いません。contribution の version が
違えば、別の readiness profile として扱います。旧 baseline ID は validate 時に二重解釈せず、
明示的な `launch-readiness migrate-final-model` で一度だけ更新します。

一定期間だけ再利用できる証跡は、evidence schema の `formats` で対象 field を
`utc-timestamp` と宣言し、同じ field を `notExpired` に列挙します。validator は field 名から
有効期限を推測せず、この schema data がある場合だけ canonical UTC timestamp を現在時刻と
比較します。期限切れの reference は incomplete となり、report の `ready` は false です。
domain と rehearsal をまたぐ複数の evidence type が同じ identity field を持つ必要がある場合は、
contribution 直下の `consistentFields` に対象 field と type の組を宣言します。各 type は profile
全体でちょうど一つの requirement group に属する必要があり、値が違えば validation は失敗します。
`ready` は選択した profile の証跡が validation 時点で整合しているという結果だけを表し、
GA/open-access の判断、deploy/release approval、mutation authority は与えません。

contribution が collection planning を補助するときに使えるのは `collectionClassHints`
だけです。これは contribution 自身が定義した evidence type を、既存の固定 class へ
割り当てる hint です。固定 class は `browser-user-e2e` / `external-provider` /
`operator-review` / `live-probe-sync` / `operation-drill` / `release-provenance` の
6 つです。hint を省略した extension evidence は、validation 上は有効なまま
collection planning では uncategorized になります。

validate が返す `takosumi.platform-readiness-report@v2` には、組み合わせた定義の
`requiredDomainIds` / `requiredRehearsalStepIds` も含まれます。進捗を集計する側は
OSS 固定の ID ではなくこの配列を使います。そうすることで、Operator / hosted service の
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

## デプロイ先の secret

deployment runtime の secret を保存して適用するのは、その runtime adapter と operator
vault です。Takosumi CLI が扱うのは provider credential で、`takosumi connections` から
ProviderConnection として登録します。platform service の signing key や internal bearer
は、repo の外で生成して保管します。適用は、選んだ deployment adapter の native な
secret command で行います。
