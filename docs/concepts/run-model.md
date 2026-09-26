# 実行モデル

Run は Takosumi における実行の記録単位です。計画、適用、破棄、差分確認などの実行は、
それぞれ Run として記録されます。

## Plan と Apply は別の Run です

`plan` は Plan Run を作り、`apply` は確認した Plan Run に `planRunId` で結びついた
別の Apply Run を作ります。適用時は plan の digest、source snapshot、依存関係の snapshot、
state generation などを再検証するため、確認した計画からずれません。

**確認した計画と、適用される内容が食い違わない**ように、Apply Run はこの plan に固定されます。

## 計画から始まります

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

`plan` は Plan Run を作ります。破棄も同じで、`DELETE /api/v1/capsules/{capsuleId}` は
破棄計画を作る操作です。

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

納得したら、確認した plan の Run に対して適用します。別の Apply Run が作られ、承認が必要な
設定なら、適用の前に `/approve` を通します。

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

現在の runner が provider-free で lockfile を生成しなかった場合だけ、private metadata に
明示的な `null` を記録します。空の lockfile は存在した生バイト列（サイズ 0）として `null` と
区別します。古い runner の digest-only 記録は `undefined`（不明）のまま
扱い、後から lockfile を取得・再生成して過去のバイト列だとは主張しません。lockfile が
欠落、上限超過、改変、または別 Run の ref になった provider plan は成功になりません。

## 自動で進む範囲

Git の変更や drift を見つけただけで、Takosumi が apply を始めることはありません。

- Git に新しい commit が来ても、Capsule が `stale` になるだけです
- 差分確認で違いが見つかっても、報告するだけです
- 定期観測は読み取り専用で、配置先を選び直しません

例外は、利用者が dashboard のインストール操作または明示的な自動更新を開始した
場合です。この操作は「plan が安全に完了したら apply まで続ける」という要求を
`autoApplyRequested` として Run に記録します。それでも、削除を含む変更、承認ポリシー、
料金や policy の gate がある plan は自動で apply されず、確認画面で停止します。

つまり、**検出が apply を起動することはなく、開始済みの操作だけが安全な範囲で
plan から apply へ続きます。**

差分だけを見る操作は Capsule 単位でも Workspace 単位でも行えます。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/drift-check" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/drift-check" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## まとめて実行する

Workspace 全体を更新すると、複数の Run が RunGroup としてまとめられます。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/plan-update" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

承認は `/api/v1/run-groups/{runGroupId}/approve` でまとめて行えます。個々の Run の
記録は失われません。

## 失敗したとき

Run が失敗すると失敗として記録され、Takosumi が記録する状態は直前の成功した StateVersion の
ままです。まず Run の状態とログを確認し、apply の結果が分からない場合は provider 側の状態も
確認してください。結果が不明なまま apply を繰り返さないでください。変更を続ける場合は改めて
plan を作り、その内容を確認します。成功した変更を戻す場合も履歴を巻き戻すのではなく、対象の StateVersion から
rollback plan を作って確認・適用します ([状態と出力](./state-and-outputs.md))。

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
