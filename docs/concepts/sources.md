# Source と Capsule

Takosumi は Git を正とします。デプロイされているものの内容は、必ずどこかの
リポジトリのどこかの commit に対応します。

## Source

Source は「このリポジトリのこのディレクトリを、この ref で追う」という宣言です。

必須は Workspace、名前、URL の 3 つだけです。

例の `$TAKOSUMI_DEPLOY_CONTROL_TOKEN` には、`read` と `write` を持つ[発行した token](../reference/cli.md#トークンを発行する)を入れます。

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
| `defaultPath`      | `.`           | sync/archive/scan の対象にする repository subtree  |
| `authConnectionId` | なし          | 非公開リポジトリを読むための Connection             |
| `autoSync`         | `false`       | operator の scheduler が Git ref を定期的に確認する |

Git URL、ref、source subtree が Source の取得座標です。専用の source catalog はありません。
`defaultPath` は取得範囲を狭めますが、実行 module を選びません。Source sync は exact
commit の source subtree 配下に
ある tracked regular file を走査し、実在する OpenTofu root module と provider source を
`SourceSnapshot` に固定します。この file-derived scan だけが module/provider 候補を作れます。

作成の応答には `hookSecret` が含まれます。**これは作成時に 1 度だけ平文で返り、
以降は取得できません。** Source レコードにはハッシュだけを保存します。Git ホストの
webhook には `Authorization: Bearer <hookSecret>` として設定します。値を失った場合も
Source を削除・再作成せず、同じ Source の secret をローテーションできます。

### webhook secret のローテーション

漏えいが疑われる場合や値を失った場合は、Git ホストの webhook 設定を更新できる状態で
次の API を呼び出します。対象 Workspace の owner/admin として認証する必要があります。
この例でも、Takosumi の origin を `TAKOSUMI_DEPLOY_CONTROL_URL` に、その owner/admin が発行した、
読み取りと書き込みを持つ API キーを `TAKOSUMI_DEPLOY_CONTROL_TOKEN` に入れます。PAT の Workspace 制限も対象と一致する必要があります。
要求本文はありません。成功すると `200` と `Cache-Control: no-store` を返し、応答の
`hookSecret` はこのときだけ平文で見えます。

```bash
curl --silent --show-error --fail-with-body -X POST \
  "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources/src_example/hook-secret/rotate" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

ローテーションには **grace window（旧 secret の猶予期間）がありません**。応答を受け取ったら、
管理された端末上で値を一度だけ確認し、forge（GitHub 等）の該当 webhook の secret /
Authorization bearer を新しい値に置き換えます。secret を URL や query string に入れず、
ログ、shell history、Issue/PR/chat、ファイルへ出力・保存しないでください。コマンドの出力を
`tee`、ファイル、ログ収集へ流さず、端末録画や共有画面にも載せないでください。Git ホストの
設定変更後、新しい secret で webhook が受理され、古い secret では `401` になることを確認します。

forge 側の設定は rotate 後 **即時に更新**してください。更新までの間に旧 secret で届いた
webhook は `401` となり、変更を取りこぼす可能性があります。取りこぼしがあれば、下の
[SourceSnapshot の手動同期](#sourcesnapshot-ref-と-commit-は別物)で `POST /api/v1/sources/{sourceId}/sync`
を `intent: manual_plan` で実行し、同期 Run の成功と新しい snapshot を確認してから plan に進みます。

ローテーションの commit 後に検証される webhook request では、旧 secret は直ちに無効です。
すでに認証済みの webhook や進行中の webhook/Run は取り消されません。並行するローテーションは
元の Source と Workspace の active authority に対して原子的に競合し、勝者だけが secret を受け取り、
敗者は `409` で secret の変更も受けません。POST は毎回新しい secret を発行するため、失敗時に
自動再試行しないでください。成功応答を失った場合、secret の再取得はできません。状態を確認したうえで
手動でもう一度ローテーションし、新しい応答を Git ホストへ設定します。ローテーション履歴には actor、
Source、Workspace のみを記録し、secret は記録しません。

## SourceSnapshot: ref と commit は別物

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
**古い snapshot を「最新」として流用してはいけません。** 確認した内容とデプロイする
内容が一致しなくなります。

dashboard はこの scan 結果を読み、利用者が実在する module を選びます。同じ path の
`.well-known/takosumi.json` entry は input の表示 hint と generic Host API/service request
を追加できますが、module path、provider、Connection、Plan、Run の authority ではありません。

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

標準の入口は dashboard の `/new` です。Git URL を入れると scan で実在 module を求め、
必要な変数と provider を提示します。ref は必要に応じて指定できます。

Connection の選択が必要な項目は画面に表示されます。provider source だけでは区別できないため、
項目ごとに表示される module 名と alias を確認して、それぞれに Connection を選びます。
認証情報が不要な provider に Connection は必要ありません。

外部のアプリから利用者をこの画面へ送るためのリンクがあります。

```text
https://takosumi.example.com/install?git=https://github.com/example/app.git&ref=v1.2.0&sourcePath=infra&path=deploy/opentofu
```

`sourcePath` は sync/archive/scan する Git subtree で、省略時は `.` です。`path` はその
subtree の Snapshot を scan した後に照合される archive-relative module 選択の初期値です。
この 2 つを結合・推測せず、それぞれ Source の取得座標と module の選択座標として扱います。
`path` を省略した場合は1候補だけを自動選択し、複数候補なら利用者が選びます。`/install` は
`/new` の入力欄を埋めるだけです。**リンクを開いた時点では何も作られません。**
利用者は互換性の確認結果、使う認証情報、計画の内容を見てから自分で承認します。

戻り先 URI の規則など、組み立ての詳細は
[App Handoff](../reference/app-handoff.md) にあります。クエリ文字列はブラウザの
履歴やログに残るため、リンクに秘密を入れないでください。

## 関連

- [実行モデル](./run-model.md)
- [認証情報](./credentials.md)
- [API リファレンス](../reference/api.md)
