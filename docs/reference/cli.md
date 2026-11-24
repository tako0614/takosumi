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

`status`は指定IDのRunを1回読み、`type id status`を表示します。exit 0は読取成功であり、表示が`failed`ならRunは失敗のままです。
正規の`{run: ...}`応答と既存flat形式を扱い、欠落・別ID・不正なtype/statusは表示せずexit 1にします。

`TAKOSUMI_DEPLOY_CONTROL_URL` には、dashboard にサインインしている origin を入れます。公式
ホスティング（Takosumi hosted service）なら `https://app.takosumi.com` です。
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` に入れる API キーは、下の[トークンを発行する](#トークンを発行する)で
作ります。

CLI は OpenTofu を直接実行しません。plan と apply は runner が行い、クラウドの認証情報は
Run の実行中だけ渡ります（[認証情報](../concepts/credentials.md)）。Git URL から追加画面を
開くリンクの形式は[Source と Capsule](../concepts/sources.md#画面と外部リンク)にあります。
`takosumi deploy` / `takosumi plan` で手元のファイルを送る方法は廃止しました。

## 初回導入の試行キーを保持する

`apps install --git <url>`は初回導入の試行を受け付ける補助コマンドです。Plan・承認・Applyの完了は意味しません。
送信前に、試行キーを標準エラーへ1行のJSON（`kind: "install_attempt_key"`、`idempotencyKey`）で出力します。
`--json`の標準出力は従来どおりserver responseの1 objectです。キーの出力自体は受付成功の証拠ではありません。

```bash
export TAKOSUMI_ACCOUNT_TOKEN='<Accounts PAT with read and write>'
takosumi apps install --git https://git.example.com/team/app.git \
  --ref main --idempotency-key initial-app-01 --url https://takosumi.example.com --json
```

`--idempotency-key`を省くとキーを自動生成します。出力したキーを、選択した接続先・本人・Git URL・ref・path・名前・環境と一緒に保持してください。
応答喪失などで受付結果が不明な場合は、同じ本人・接続先・要求を保ち、同じキーを`--idempotency-key`に指定して手動再送します。
`--idempotency-key=initial=app=01`も全体を保持します。応答喪失などで受付結果が不明な場合、CLIはPOSTを自動再送しません。
既存の互換動作として、`--workspace`指定時に新routeが未提供と分かる404を返した場合だけ、同じkeyと要求を旧Workspace routeへ送ります。
同じkeyと同じ要求は既存attemptを返し、同じkeyで要求が異なる場合は409です。
期限切れattemptも同じkeyでは新規に置き換えません。元attemptと現在の状態を確認し、不明なまま新keyで始め直さないでください。

## アプリのGit版更新を確認・実行する

`apps update`は、既存revision coordinatorで指定refの保存Planを作り、変更内容を表示します。承認・Applyは行いません。
Accountsの個人PATに独立した`read`と`write` scopeが必要です。`--token`を省くと`TAKOSUMI_ACCOUNT_TOKEN`を使い、
operator用の`TAKOSUMI_DEPLOY_CONTROL_TOKEN`へはfallbackしません。
1回のコマンド内では選択したURLと資格を固定し、各routeの現在の認可はserverで確認します。

```bash
export TAKOSUMI_ACCOUNT_TOKEN='<Accounts PAT with read and write>'
takosumi apps update cap_example --ref release/v2 --idempotency-key update-example-01 \
  --url https://takosumi.example.com --json
```

`--ref`は必須です。更新を開始するときは`--idempotency-key`を指定します。
受付応答を失った場合は、同じ本人・接続先・アプリ・ref・キーで再実行します。`--ref=release=v2`も値全体を保ちます。

既存の更新ID `revisionPlanId` が分かる場合は、次のコマンドで続けられます。更新IDは`planRunId`と別です。

```bash
takosumi apps update cap_example --ref release/v2 --revision-plan grp_example \
  --url https://takosumi.example.com --json
```

`--revision-plan`を指定すると、最初に同じ接続先でその更新を読み、アプリとrefの一致を確認します。
続行が必要な場合は現在の更新権限で同じ処理を進めます。Planがすでに準備済みなら読取りだけで内容を確認できます。
`--revision-plan`と`--idempotency-key`は排他です。明確な受付拒否は`refused`、受付済み更新の進行や結果を確認できない場合は`unconfirmed`、保存Planが期限切れなどで確認できない状態なら`plan_not_reviewable`で、いずれもexit 1です。

`review_required`は更新完了ではありません。表示されたapp、`planRunId`、ref、source snapshot、Plan digest、変更数、
resource actions、policyを確認します。`reviewUrl`でも同じ保存Planを開けます。欠けた変更数は`null`で、0とは扱いません。

## 保存済みの状態バージョンから復旧を準備する

`apps history`は、アプリの保存済み状態バージョンを1ページ表示します。`generation`、`createdAt`、`createdByRunId`を確認し、復旧したい行の`id`を選びます。Accountsの個人PATの`read` scopeで実行できます。

```bash
takosumi apps history cap_example --limit 10 --url https://takosumi.example.com --json
```

続きがある場合は`nextCursor`が返ります。同じアプリを指定し、`--cursor`にその値を渡すと次のページを読めます。

`apps rollback`は、選んだ状態バージョンIDを指定して復旧Planを作ります。
指定した状態バージョンが対象アプリに属することを確認し、Accountsの個人PATで実行します。結果の`review_required`には、対象の`stateVersionId`と保存済みの`planRunId`が含まれます。

```bash
takosumi apps rollback cap_example --state-version state_example --idempotency-key restore-example-01 \
  --url https://takosumi.example.com --json
```

受付結果が不明なら、同じ接続先・本人・アプリ・状態バージョン・キーで再実行します。CLI内の待機は同じRunの読取りです。

## 保存Planを実行する

更新または復旧Planの変更内容を確認して実行を決めたら、別のコマンドに返却されたPlan IDを渡します。

```bash
takosumi apps apply cap_example --plan plan_example --yes \
  --url https://takosumi.example.com --json
```

`--yes`はこの保存Planを実行する明示確認です。削除があるか変更数が不明なら`--allow-destroy`も必要です。
実行前reviewは標準エラーへJSONを1行、`--json`の最終結果は標準出力へ1 objectとして返します。
CLIは現在appと保存Plan、全pageの履歴を照合し、既存のlinked Applyがあれば再作成せず読みます。
承認待ちの場合だけ既存approveを呼び、Planを再読してから通常applyを呼びます。
現在の本人・app権限、資格種別、epoch、policy、state/Plan guard、apply-onceは既存serverが判定します。
手元のPlan IDや`--yes`だけで権限が得られるわけではありません。

Apply Runの作成応答だけでは成功にしません。既定で最大120秒観測し、Runが`succeeded`になった場合だけexit 0です。
`--timeout-ms <1..120000>`は観測budgetであり、観測終了はserverのRun取消ではありません。
承認・Apply応答が不明な場合は別の最大5秒で同じPlanとlinked Applyを読むだけで、POSTを自動再送しません。
この再読で終端Runを照合できた場合は、通常の観測と同じ`status`、Run自身の`code`と注意書き、`runUrl`を返します。
通常の`failed`・`cancelled`・`expired`は`status: failed`でexit 1です。
保存Runが`failed`で`code: runner_mutation_indeterminate`なら、結果は不明のため`status: indeterminate`、`runStatus: failed`でexit 1になります。
このRunと実際の状態を確認してから次の操作を判断します。再読の拒否・照合失敗を、期限後に届いた元応答で成功へ置き換えません。
`pending`や`indeterminate`はexit 1で元IDを保持します。以後の読取は次を使います（`read` scopeが必要です）。

```bash
takosumi apps apply cap_example --plan plan_example --observe-only \
  --url https://takosumi.example.com --json
```

`--observe-only`は承認もApplyも作りません。linked Applyが無いことは、元要求に効果が無かった証明ではありません。
`--yes`と`--observe-only`は同時指定できません。
failed/cancelled/expiredのRunも新Planで盲目的に再実行せず、保存Runとアプリ状態を確認します。

## 別の接続でアンインストールを再開する

別キーを同じクラウドアカウントの確認済みProvider Connectionとして登録した後、元の接続IDと代替の接続IDを指定します。
アプリの割当は管理画面または `GET /api/v1/capsules/{app-id}/provider-bindings` で確認できます。
この操作には対象アプリを管理できるAccounts PATの `read` と `write` が必要です。

```bash
takosumi apps recover-uninstall cap_example \
  --connections '[{"connectionId":"conn_old","replacementConnectionId":"conn_new"}]' \
  --url https://takosumi.example.com --json
```

サーバーが現在の所有者、クラウドアカウント、適用済みの接続設定を照合し、削除Planを準備します。
部分削除で代替した割当を元の接続に戻す場合は、`connectionId` と `replacementConnectionId` に同じ元のIDを指定します。
現在のアプリ所有者が選んだ確認済み接続を、サーバーが保存済みの部分削除の記録と照合します。
`refused` に `connectionRecoveryFailure` がある場合、`replacement_unverified` なら代替接続を確認し、
`bindings_mismatch` ならアカウントと適用済みの接続設定を確認してください。
`applied_evidence_unavailable` は、照合に必要な適用記録をサーバーが確認できなかったことを示します。
`review_required` になったPlanでは、削除内容と `providerConnections` の有効な接続を確認できます。前回の削除から引き継いだ接続も表示します。
`plan_pending` なら返された `planRunId` を指定して、同じPlanを読み直せます。作成結果が `unconfirmed` なら、`--current-review` で準備中・レビュー可能・失敗のいずれかにある最新の手動削除Planを確認できます。
`failed` ではPlanのIDと、取得できた場合は失敗コードを返します。前の要求が受理されたかは未確認のままです。

```bash
takosumi apps recover-uninstall cap_example --current-review \
  --url https://takosumi.example.com --json
```

```bash
takosumi apps recover-uninstall cap_example --destroy-plan destroy_plan_example \
  --url https://takosumi.example.com --json
```

両方の確認には `read` scopeを使います。`--destroy-plan` は指定のPlanを読みます。

確認したPlanを実行する場合だけ、別のコマンドで明示します。

```bash
takosumi apps apply cap_example --destroy-plan destroy_plan_example --yes \
  --url https://takosumi.example.com --json
```

`--destroy-plan` は破棄用の保存Planを指定します。接続の準備状態や資格ポリシーを理由に適用が拒否され、
同じPlanの読み戻しで紐付く削除Runが見つからなければ、`refused` と理由を返します。
同じクラウドアカウントの確認済み接続を選び、`apps recover-uninstall --connections` で新しい削除Planを準備して確認してください。
応答が不明なら、同じPlan IDで `--yes` を `--observe-only` に替えると、
紐付いた削除Runを読み取れます。通常の削除予約は `apps uninstall <app-id> --yes` から行います。

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

公開前に運用の証跡（launch readiness）をそろえる operator 向けの機能です。hosted service や別の edition が
求める追加の証跡を、OSS の baseline に組み込みます。サービスを追加して使うだけなら、この節は要りません。

::: details contribution の作り方と検証を開く

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

:::

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
