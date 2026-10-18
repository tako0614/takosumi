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

## 値を別の Capsule に渡す

同じ Workspace 内なら依存関係で表します。受け取る側の Capsule の変更の確認（plan）を作る
とき、Takosumi は渡す側の Capsule の Output を読み、受け取る側の OpenTofu 変数として
渡します。

dashboard の **依存関係** では、つながりを見られます。作成と削除は API で行います。例の
`$TAKOSUMI_DEPLOY_CONTROL_TOKEN` には、`read` と `write` を持つ
[発行した token](../reference/cli.md#トークンを発行する)を入れます。作成と削除ができるのは、
Workspace の owner か admin だけです。

### 作り方

1. 渡す側をデプロイし、渡したい Output があることを確かめます。`sensitive` の Output は
   渡せません。
2. 受け取る側の module に、受け取る値の `variable` を宣言します。宣言が無いと、値は渡されても
   使われません。

   ```hcl
   variable "base_domain" {
     type = string
   }
   ```

3. 受け取る側の Capsule に依存関係を作ります。パスに書くのが受け取る側、
   `producerCapsuleId` が渡す側です。

   ```bash
   curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_app/dependencies" \
     -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
     -H 'content-type: application/json' \
     -d '{
       "producerCapsuleId": "cap_dns",
       "outputs": {
         "base_domain": { "from": "base_domain", "to": "base_domain", "required": true }
       }
     }'
   ```

   `from` は渡す側の Output の名前、`to` は受け取る側の変数の名前です。`required` は省けず、
   `true` か `false` を書きます。`true` の値を渡す側がまだ出していないと、受け取る側の変更の
   確認は `dependency_outputs_unavailable` で止まります。`false` なら、その値は渡されません。
   成功すると `201` と、`dependency.id` を含む結果が返ります。
4. 受け取る側の **更新** タブの **サービスを更新** で **変更を確認** を押し、内容を確かめて
   デプロイします。依存関係を作っただけでは、受け取る側の状態は変わりません。

作成のときには、渡す側の Output があるかは確かめません。同じつながりを 2 回作っても拒否され
ないため、作る前に一覧で確かめます。つながりが輪になる依存関係は作れません。

### 渡す側が変わったとき

渡す側をデプロイして、受け取る側に渡している Output の値が変わると、受け取る側の状態が
**更新があります** になります（**デプロイ済み** のときだけです）。Takosumi が自動で変更の
確認を作ることはありません。受け取る側で **更新する** を押すと、新しい値で変更の確認が
作られます。

dashboard から追加したサービスでは、受け取る側の変更の確認を作ったあとで渡す側をデプロイすると、
受け取る側のデプロイは `dependency_snapshot_stale` で止まります。渡す側の Output が変わらない
デプロイでも同じです。受け取る側の変更の確認を作り直します。

### 見る、削除する

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_app/dependencies" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X DELETE "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/dependencies/dep_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

削除しても、受け取る側の状態は変わりません。次の変更の確認から、その値は渡されなく
なります。Workspace 全体のつながりは `/api/v1/workspaces/{workspaceId}/graph` で読めます。

### Workspace をまたぐとき

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

## 書き出しとの違い

Takosumi は制御情報 (Capsule の構成、Source の設定、Run と StateVersion の履歴) を
書き出せます。**アプリのデータそのものと、Connection に保存した秘密は対象外です。**

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
