# 実行モデル

Run は Takosumi における実行の唯一の記録単位です。計画も適用も破棄も差分確認も、
すべて Run になります。

## Run は 1 つのエンティティです

`plan` / `apply` / `destroy` / `refresh` / `output` は別々のエンティティではなく、
1 つの Run が持つ操作です。「計画レコード」と「適用レコード」が分かれているわけでは
ありません。

この設計の効果は 1 つです。**確認した計画と、適用される内容が食い違いません。**
適用は同じ Run に対して行います。

## 計画から始まります

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Run は必ず、何かの計画として生まれます。破棄も同じで、
`DELETE /api/v1/capsules/{capsuleId}` は破棄計画を作る操作です。

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

納得したら適用します。承認が必要な設定なら、適用の前に `/approve` を通します。

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

Run が失敗すると失敗として記録され、状態は直前の StateVersion のままです。

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
