# Source と Capsule

Takosumi は Git を正とします。デプロイされているものの内容は、必ずどこかの
リポジトリのどこかの commit に対応します。

## Source

Source は「このリポジトリのこのディレクトリを、この ref で追う」という宣言です。

必須は Workspace、名前、URL の 3 つだけです。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_example",
    "name": "example-app",
    "url": "https://github.com/example/example-app.git",
    "defaultRef": "v1.2.0",
    "defaultPath": "deploy/opentofu"
  }'
```

| フィールド         | 省略時        | 意味                                                |
| ------------------ | ------------- | --------------------------------------------------- |
| `defaultRef`       | Git の `HEAD` | 追跡する branch / tag / commit                      |
| `defaultPath`      | `.`           | リポジトリ内の module ディレクトリ                  |
| `authConnectionId` | なし          | 非公開リポジトリを読むための Connection             |
| `autoSync`         | `false`       | operator の scheduler が Git ref を定期的に確認する |

作成の応答には `hookSecret` が含まれます。**これは作成時に 1 度だけ平文で返り、
以降は取得できません。** Source レコードにはハッシュだけを保存します。Git ホストの
webhook に設定するならこの時点で控えます。失った場合は再取得ではなく作り直しです。

## SourceSnapshot — ref と commit は別物

`defaultRef` は「どこを追うか」であって「何を実行したか」ではありません。実際に
実行されるのは、ref を解決した結果の commit です。これを SourceSnapshot として
保存します。

branch を指定していれば ref は動きますが、**過去の Run が指す SourceSnapshot は
動きません**。「あのとき何を流したか」は常に確定しています。

同期は明示的に起こします。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources/src_example/sync" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "intent": "manual_plan" }'
```

`intent` は 2 つあります。

- `observe` (省略時) — webhook や scheduler による観測。Capsule が opt-in して
  いれば自動更新の判定材料になります
- `manual_plan` — 人が確認する計画のための同期。この同期自体が別の自動更新を
  始めることはありません

同期 Run が `succeeded` になり、その Run の `sourceSnapshotId` が
`/api/v1/sources/{sourceId}/snapshots` に現れてから、互換性確認と計画に進みます。
**古い snapshot を「最新」として流用してはいけません。** 確認した内容と適用する
内容が一致しなくなります。

## Capsule

Capsule はデプロイされた 1 つのまとまりです。Source が「どこから」なら、Capsule は
「何が動いているか」です。

同じ Source から複数の Capsule を作れます。module は認証情報も環境の区別も持たない
ので、開発用と本番用は「別の Capsule に別の Connection を割り当てる」ことで表します
([認証情報](./credentials.md))。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/capsules" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Capsule が追跡している Source に新しい commit が来ると、Capsule は `stale` に
なります。**stale は状態であって動作ではありません。** 通常はそこで止まり、次の
plan と apply は人が始めます。

Capsule で `autoUpdate` を明示的に有効にした場合だけ、新しい snapshot ごとに 1 回、
更新用の plan を作ります。削除を含まず、承認や policy の gate がない clean plan は
apply まで続けられます。それ以外は Run 画面で停止します。単なる `stale`、drift の
検出、古い snapshot の再通知が無条件に apply を起動することはありません。

## 画面と外部リンク

標準の入口は dashboard の `/new` です。Git URL を入れると module を読み、必要な
変数と provider を提示します。

外部のアプリから利用者をこの画面へ送るためのリンクがあります。

```text
https://takosumi.example.com/install?git=https://github.com/example/app.git&ref=v1.2.0&path=deploy/opentofu
```

`/install` は `/new` の入力欄を埋めるだけです。**リンクを開いた時点では何も作られません。**
利用者は互換性の確認結果、使う認証情報、計画の内容を見てから自分で承認します。

戻り先 URI の規則など、組み立ての詳細は
[App Handoff](../reference/app-handoff.md) にあります。クエリ文字列はブラウザの
履歴やログに残るため、リンクに秘密を入れないでください。

## 関連

- [実行モデル](./run-model.md)
- [認証情報](./credentials.md)
- [API リファレンス](../reference/api.md)
