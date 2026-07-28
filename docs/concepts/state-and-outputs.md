# 状態と出力

適用が成功するたびに、Takosumi は状態を 1 地点として保存します。これが
StateVersion です。そこから公開用に取り出した値が Output です。

## StateVersion は積み重なります

StateVersion は上書きされません。**戻す操作をしても履歴は巻き戻りません。**
戻した結果が新しい StateVersion として積まれます。そのため「戻したあとに、戻す前の
状態へ戻す」ことができ、その操作自体も記録に残ります。

保存されるのは Takosumi が管理している状態です。module が作った実物の中身
(データベースのレコード、保管されたファイル) は含まれません。

戻すときも通常の計画と適用を通ります。**StateVersion を選んだ時点では何も起きません。**

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/state-versions" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/state-versions/sv_example/rollback-plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

作られた Run を確認し、適用して初めて戻ります。Workspace 内の全 Capsule の現在地点は
`/api/v1/workspaces/{workspaceId}/current-state-versions` でまとめて読めます。

戻す前に確認すべきことが 2 つあります。作り直しでデータが失われる種類のリソースが
計画に含まれていないか、そして戻す先が指す commit がリポジトリにまだあるかです。
後者が無ければ計画は失敗します。認証情報は StateVersion に含まれないため、戻しても
現在の Connection が使われます。

## Output は明示的に公開した値だけです

Output は Capsule が外に見せる値です。公開されるのは**明示的に対応付けた非 secret の
値だけ**です。

OpenTofu で `sensitive = true` を付けた output は、OpenTofu としては正しくても
**公開 Output になりません**。秘密を運ぶ経路として使えないようにしてあります。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_db/outputs" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## 秘密が入らない場所

次のいずれにも秘密の値は保存されません。

```text
spec
status
OpenTofu の state
Output
Interface
ログ
監査記録
```

## 値を別の Capsule に渡す

同じ Workspace 内なら依存関係で表します。Takosumi が順序を理解し、依存先の Output を
参照できるようになります。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_app/dependencies" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X DELETE "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/dependencies/dep_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Workspace 全体のつながりは `/api/v1/workspaces/{workspaceId}/graph` で読めます。

Workspace をまたぐ場合は OutputShare を使います。**渡す側が作り、受け取る側が承認
するまで有効になりません。** 失効させると以降の参照は止まり、すでに実行された Run の
記録は残ります。

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/output-shares/share_example/approve" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

どちらの経路でも渡せるのは公開 Output だけです。**秘密を渡したい場合は Output では
なく、Connection を両方の Capsule に割り当てます。**

## 実物とずれたとき

保存されている状態と実物が食い違うことがあります。人が直接クラウドの画面で変更した
場合などです。

差分確認はこのずれを読み取り専用で報告します。**自動では直しません。** 現在の版と
endpoint を固定したまま報告するので、直すかどうかは人が決めます。

取り込み直す場合は refresh を使います。refresh は外部の実物を変更せず、Takosumi 側の
状態と Output だけを更新し、成功したときだけ関連する Interface の版を解決し直します。

## 書き出しとの違い

Takosumi は制御情報 (Capsule の構成、Source の設定、Run と StateVersion の履歴) を
書き出せます。**アプリのデータそのものと、Connection に保存した秘密は対象外です。**

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/backups" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

直前の適用を取り消したいだけなら、書き出しではなく StateVersion から戻します。
書き出しが要るのは、Workspace ごと別の環境へ移す場合や、制御情報を Takosumi の外に
保管したい場合です。秘密は含まれないため、復元後に Connection を作り直す作業が
必ず発生します。

## 関連

- [実行モデル](./run-model.md)
- [認証情報](./credentials.md)
