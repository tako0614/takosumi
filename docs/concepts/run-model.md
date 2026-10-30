# 実行モデル

Run は Takosumi における実行の記録単位です。変更の確認（plan）、デプロイ（apply）、破棄、差分確認などの実行は、
それぞれ Run として記録されます。

## Plan と Apply は別の Run です

`plan` は Plan Run を作り、`apply` は確認した Plan Run に `planRunId` で結びついた
別の Apply Run を作ります。デプロイ時には plan の digest、source snapshot、compatibility evidence、state generation などを
再検証するため、確認した計画からずれません。旧 Dependency snapshot を持つ Plan は拒否されます。
アプリ独自の入力に移行し、別途レビューしたデータメンテナンスで旧 Dependency edge を処理してから、
新しい plan を作ってください。[アプリごとの入力](./state-and-outputs.md#アプリごとに入力を管理する)も参照してください。

**確認した計画と、デプロイされる内容が食い違わない**ように、Apply Run はこの plan に固定されます。
runner は通常の Plan、破棄計画、保存済み Plan の Apply の前に、state にない resource を
名前から推測して import しません。既存の実物を state に取り込む必要がある場合は、
module の明示的な OpenTofu `import` block を Plan に含め、その差分を確認します。

## 計画から始まります

公開 `/api/v1` は Accounts session か PAT を使います。読み取りには `read`、変更には `write` が要ります。
以下の例では、ほかのページと同じく `TAKOSUMI_DEPLOY_CONTROL_URL` を公開 API の origin とし、
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` に `read` と `write` を持つ[発行した token](../reference/cli.md#トークンを発行する)を入れます。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

`plan` は Plan Run を作ります。Capsule の通常の `DELETE` はデプロイ済みの Capsule の削除を
7 日（operator が変更可能）の猶予付きで予約します。猶予中は
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall` で取り消せます。猶予なしの破棄計画を
作る場合は `DELETE /api/v1/capsules/{capsuleId}?immediate=true` または
`POST /api/v1/capsules/{capsuleId}/destroy-plan` を使います。いずれも Plan 作成だけで、
破棄には owner による承認と Apply が必要です。

内容は Run から読みます。

```bash
takosumi status run_example
takosumi logs run_example
```

イベントと費用の見込みは別の経路です。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/events" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/cost" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

納得したら、確認した plan の Run に対してデプロイします。別の Apply Run が作られ、承認が必要な
設定なら、デプロイの前に `/approve` を通します。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/apply" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

途中でやめる場合は `/cancel` です。取り消したことも記録に残ります。

## 実行される場所

Run は runner sandbox の中で実行されます。認証情報が渡るのはこの中だけで、実行が
終われば消えます。Takosumi 本体は OpenTofu を直接実行せず、runner に渡して結果を
受け取ります。

## 何が保存されるか

| 保存されるもの             | 説明                     |
| -------------------------- | ------------------------ |
| source snapshot            | どの commit を実行したか |
| OpenTofu version           | 実行に使った版           |
| provider lock digest       | provider の固定内容      |
| ProviderBinding            | どの認証情報を使ったか   |
| 注入した環境変数の**名前** | 値は保存しません         |
| plan / apply の結果        | 変更内容                 |
| state version              | 実行後の状態             |
| outputs                    | 公開された値             |
| logs                       | 実行ログ                 |
| actor                      | 誰が実行したか           |
| audit evidence             | 監査用の記録             |

**値ではなく名前だけを残す**のが原則です。どの環境変数を注入したかは後から分かり
ますが、中身は残りません。

### provider lockfile の連続性

provider を使う plan では、runner が `tofu init` の直後に読んだ
`.terraform.lock.hcl` の**生バイト列**を 0 バイト以上 1 MiB 以下の private artifact として保持します。
SHA-256 はこのバイト列そのものに対して計算され、`providerLockDigest` と一致しなければ
plan は成功しません。runner の終了後も、既存の暗号化 artifact store に run と結び付いた
immutable object として残り、権限のある内部処理だけが読み出せます。Run / Output / log の
公開 projection には lockfile の本文も artifact ref も含めません。

lockfile の記録は検証されます。記録が上限を超えている、digest と一致しない、別の Run の
ものを指している、または provider を使うのに「lockfile なし」となっている plan は成功しません。
plan に digest があれば、apply は `tofu init` の後の lockfile の SHA-256 がその digest と
一致することを確かめてから provider を実行し、一致しなければ止まります。lockfile の記録を
持たない古い runner の plan は不明のまま扱い、後から作った lockfile で補うことはしません。

## 自動で進む範囲

既定では、Git の変更や drift を見つけただけで、Takosumi が apply を始めることはありません。

- Git に新しい commit が来ても、Capsule が `stale` になるだけです
- 差分確認で違いが見つかっても、報告するだけです
- 定期観測は既定では無効です。有効にしても読み取り専用で、配置先を選び直しません

例外は、利用者が Capsule の自動更新（`autoUpdate`）を有効にした場合です。新しい snapshot
ごとに 1 回、更新用の plan を作り、「plan が安全に完了したら apply まで続ける」という要求を
`autoApplyRequested` として Run に記録します。それでも、削除を含む変更、承認ポリシー、
料金や policy の gate がある plan は自動で apply されず、確認画面で停止します。

dashboard の **更新する** も、安全に完了した plan を apply まで続けます。これは押した画面が
行う操作で、Run に `autoApplyRequested` は記録されません。

つまり、**自動更新を有効にしていない限り、検出が apply を起動することはありません。**

差分だけを見る操作は Capsule 単位で行います。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/drift-check" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## アプリごとに実行する

plan、差分確認、承認はアプリ (Capsule) ごとに行います。Workspace 全体をまとめて
更新・差分確認する `POST /api/v1/workspaces/{workspaceId}/plan-update`・`drift-check` と、
RunGroup をまとめて承認する `POST /api/v1/run-groups/{runGroupId}/approve` は廃止され、
`410` と `run_group_retired` を返します。廃止前に作られた RunGroup は
`GET /api/v1/run-groups/{runGroupId}` で読めます (含まれる全 Run のアプリを見られる場合だけ)。

operator が `TAKOSUMI_AUTO_PLAN_STALE_CAPSULES=1` または `TAKOSUMI_DRIFT_CHECK_ENABLED=1` を
設定すると、定期処理は稼働中のアプリを一定数ずつ順に見て、アプリごとに判断します。
Source が進んだ (`stale`) アプリには、未完了の更新 plan が無ければ 1 つだけ plan を作り、
`active` のアプリには差分確認を作ります。どちらも Workspace を一覧せず、RunGroup も作りません。

旧 Dependency の設定が残る Capsule は `dependency_retired` で拒否され、Run は作成されません。
database operator に残存設定の保守を依頼し、完了後に新しい plan を作成してください。

## 失敗したとき

Run の失敗だけでは、provider 側の変更が戻ったかどうかは分かりません。provider の実行失敗時に
状態が保存されて StateVersion が進む場合も、apply 後の lifecycle action の失敗でデプロイ済みの状態が
残る場合もあります。Run の結果とログに加え、Run に StateVersion が記録されているか、Capsule の現在の
StateVersion と状態も確認してから対応してください。結果が不明な場合は provider 側の状態も確認し、
何がデプロイされたか分からないまま apply を繰り返さないでください。

## 履歴

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/runs" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/activity" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

操作履歴は Workspace に属します。

## 関連

- [状態と出力](./state-and-outputs.md)
- [認証情報](./credentials.md)
- [Source と Capsule](./sources.md)
