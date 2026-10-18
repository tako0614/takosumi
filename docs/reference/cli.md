# CLI

Takosumi CLI は、dashboard でできる操作をスクリプトから行うための補助ツールです。サービスの
追加はふだん dashboard で行い（ストアか Git URL）、CLI はその後の確認（`takosumi status`、
`takosumi logs`）や、API キーと接続の管理に使います。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi status <run-id>
takosumi logs   <run-id>
```

`TAKOSUMI_DEPLOY_CONTROL_URL` には、dashboard にサインインしている origin を入れます。公式
ホスティング（Takosumi hosted service）なら `https://app.takosumi.com` です。
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` に入れる API キーは、下の[トークンを発行する](#トークンを発行する)で
作ります。

CLI は OpenTofu を直接実行しません。plan と apply は runner が行い、クラウドの認証情報は
Run の実行中だけ渡ります（[認証情報](../concepts/credentials.md)）。Git URL から追加画面を
開くリンクの形式は[Source と Capsule](../concepts/sources.md#画面と外部リンク)にあります。
`takosumi deploy` / `takosumi plan` で手元のファイルを送る方法は廃止しました。

## CLI を用意する

CLI はこのリポジトリの `cli/` にあり、Bun で直接動かします。package manager からの
配布はまだないので、チェックアウトで依存を入れてから `takosumi` を呼べるようにします。

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
alias takosumi="bun $PWD/cli/src/main.ts"
takosumi --help
```

このページと他のページの `takosumi ...` は、この alias を前提にしています。
`bun run cli -- <command>` でも動きますが、bun が実行するコマンド行を表示するため、
`--token` に渡した bearer が端末に残ります。

## トークンを発行する

CLI と、ほかのページの API の例は、`TAKOSUMI_DEPLOY_CONTROL_TOKEN` 環境変数の bearer を使います。
ふだんは、dashboard で発行した API キーを入れます。

1. dashboard の **設定** から **アカウント** を開きます。
2. **Takosumi API キー** で名前と有効期間（期間が過ぎると使えなくなります）を決め、**権限** に
   **読み取り** と **書き込み** の両方を選んで **API キーを作成** を押します。ほかのページの例には
   読み取りと変更の両方があり、`read` と `write` は互いを含まないため、**書き込み** だけでは
   読み取りの例が `403` になります。**現在のワークスペースだけで使用できるようにする** は最初から
   オンで、そのキーはそのワークスペースの中でしか使えません。ワークスペースの一覧を読む例や、
   ほかのワークスペースに触れる例では、オフにして作ります。
3. 秘密値は作成したときに 1 度だけ表示されます。コピーして `TAKOSUMI_DEPLOY_CONTROL_TOKEN` に
   入れます。

サーバーの設定にある同じ名前の値は operator 用の秘密で、operator 専用 API を呼ぶ作業にだけ
使います。このページの `takosumi connections` はその API を使うため、operator 用の秘密が要ります。

### CLI から発行する

Accounts のセッション bearer（`sess_...`）を持っている場合は、CLI からも同じ権限のキーを
発行できます。ワークスペースの制限はかかりません。期限は `--expires-at` を付けたときだけ
付きます。

```bash
takosumi accounts tokens create \
  --name my-cli \
  --scope read,write \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --token "$TAKOSUMI_ACCOUNTS_SESSION_BEARER"
```

| オプション       | 意味                                                |
| ---------------- | --------------------------------------------------- |
| `--name`         | 見分けるための名前                                  |
| `--scope`        | `read` / `write` / `admin`                          |
| `--expires-at`   | 失効日時 (ISO 8601)                                 |
| `--accounts-url` | Accounts の URL。環境変数は `TAKOSUMI_ACCOUNTS_URL` |
| `--token`        | **Accounts のセッション bearer** (`sess_...`)。省くと `TAKOSUMI_ACCOUNTS_TOKEN`、次に旧名の `TAKOS_TOKEN` を読みます。どれも無いと bearer なしで送られ、Accounts が拒否します |
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
使うだけなら不要です。公開して使う Accounts は、Cloudflare か Bun と PostgreSQL の雛形で
動かします（[自分で動かす](../concepts/self-host.md)）。

### スキーマを適用する

PostgreSQL を使う場合。

```bash
takosumi accounts migrate --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
```

`--dry-run` を付けると、適用せずに何が実行されるかだけを表示します。接続先は
`TAKOSUMI_ACCOUNTS_DATABASE_URL` からも読みます。

Cloudflare D1 の schema migration は利用者向けのコマンドではなく、運用する側（operator）が
release と同じ作業の中で行う手順です。自分で動かす場合の手順は
[自分で動かす](../self-host/cloudflare.md)にあります。

### 初期データを入れる

```bash
takosumi accounts seed \
  --issuer https://accounts.example.com \
  --subject tsub_example \
  --client-id example-client \
  --redirect-uri https://app.example.com/callback
```

### 手元の確認用に起動する

`takosumi accounts serve` は手元の確認用です。プロセスを起動するたびに使い捨ての署名鍵を
作るため、公開して使う Accounts には使えません。既定では `127.0.0.1:8787` で待ち受け、
データはメモリにだけ置きます。

```bash
takosumi accounts serve --issuer http://localhost:8787
```

`--database-url` を付けると、アカウントとセッションをそのデータベースに保存します。
その場合も署名鍵は起動のたびに変わります。

上流の ID プロバイダや passkey を使う場合は、`--upstream-providers` (JSON 配列)、
`--passkey-rp-id`、`--passkey-rp-name`、`--passkey-origin` などを併せて指定します。
手元の確認用に 1 つだけセッションを用意したい場合は `--dev-session-id sess_...` を
使います。`--dev-session-id` は `--database-url` を付けない場合だけ使えます。
**本番では使わないでください。**

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
  --workspace ws_example \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file <path-to-credential-env-json>

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

CLI から作る ProviderConnection では、対象の provider を `--provider` で明示します。
`--workspace` を省くと operator 範囲の Connection になり、既定の構成では Capsule の provider
割り当てに使えません。

## デプロイ先の secret

deployment runtime の secret を保存して適用するのは、その runtime adapter と operator
vault です。Takosumi CLI が扱うのは provider credential で、`takosumi connections` から
ProviderConnection として登録します。platform service の signing key や internal bearer
は、repo の外で生成して保管します。適用は、選んだ deployment adapter の native な
secret command で行います。
