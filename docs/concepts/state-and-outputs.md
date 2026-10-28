# 状態と出力

デプロイ（apply）が成功するたびに、Takosumi は状態を 1 地点として保存します。これが
StateVersion です。そこから公開用に取り出した値が Output です。

## StateVersion は積み重なります

StateVersion は上書きされません。**戻す操作をしても履歴は巻き戻りません。**
戻した結果が新しい StateVersion として積まれます。そのため「戻したあとに、戻す前の
状態へ戻す」ことができ、その操作自体も記録に残ります。

保存されるのは Takosumi が管理している状態です。module が作った実物の中身
(データベースのレコード、保管されたファイル) は含まれません。

戻すときも通常の変更の確認とデプロイを通ります。**StateVersion を選んだ時点では何も起きません。**

例の `$TAKOSUMI_DEPLOY_CONTROL_TOKEN` には、`read` と `write` を持つ[発行した token](../reference/cli.md#トークンを発行する)を入れます。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/state-versions" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/state-versions/sv_example/rollback-plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

作られた Run を確認し、デプロイして初めて戻ります。Workspace 内の全 Capsule の現在地点は
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

Output は Run ごとの記録ではなく、いま公開されている値です。
`/api/v1/capsules/{capsuleId}/outputs` から読めます。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_db/outputs" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## 秘密と state

次の公開面には秘密の値を保存しません。

```text
spec
status
Output
Interface
ログ
監査記録
```

一方、provider が管理する OpenTofu state には、接続文字列などの secret が含まれる
ことがあります。Takosumi は state 全体を暗号化して保存し、権限のある Run にだけ
復号します。state を公開 Output や一般の export と同じものとして扱わないでください。

## アプリごとに入力を管理する

インストールしたアプリは、それぞれ独立した OpenTofu root と state、plan を持ちます。
Takosumi はあるアプリの Output を別のアプリの変数へ渡しません。`remote_state` も入力を
つなぐ仕組みとしては使いません。値が必要なら、そのアプリ自身の Git 設定と確認済みの
設定値で用意します。

リポジトリは `.well-known/takosumi.json` に任意のインストール補助情報を公開できます。
このファイルは入力項目や Interface request を記述できますが、アプリ間の OpenTofu 入力を
作ったり、実行権限を与えたりはしません。Interface は owner と lifecycle を持つ明示的な
契約です。アプリ所有の機能を記述・公開できますが、複数アプリの OpenTofu state を接続する
ものではありません。

旧 Dependency edge は廃止されています。Capsule に旧 edge が残っている間、新しい plan は
`dependency_retired` で失敗します。アプリ独自の明示的な入力へ移行したうえで、別途レビューした
データメンテナンスで旧 record を削除してから plan を作ってください。旧 dependency snapshot を
固定した saved plan も拒否されるため、新しい plan に置き換える必要があります。

**アプリ間で secret を共有する場合は、同じ Connection を両方のアプリに割り当てます。**
secret を Output として公開しないでください。

## 実物とずれたとき

保存されている状態と実物が食い違うことがあります。人が直接クラウドの画面で変更した
場合などです。

差分確認はこのずれを読み取り専用で報告します。**自動では直しません。** 現在の版と
endpoint を固定したまま報告するので、直すかどうかは人が決めます。

## 書き出しとの違い

Takosumi は制御情報 (Capsule の構成、Source の設定、Run と StateVersion の履歴) を
書き出せます。**サービスのデータそのものと、Connection に保存した秘密は対象外です。**

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/backups" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

直前のデプロイを取り消したいだけなら、書き出しではなく StateVersion から戻します。
書き出しが要るのは、Workspace ごと別の環境へ移す場合や、制御情報を Takosumi の外に
保管したい場合です。秘密は含まれないため、復元後に Connection を作り直す作業が
必ず発生します。

## 関連

- [実行モデル](./run-model.md)
- [認証情報](./credentials.md)
