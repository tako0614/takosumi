# 廃止済み Dependency の operator データ保守

Dependency / OutputShare は廃止済みです。self-host operator が管理する database に
旧 Dependency 行が残っていると、その consumer Capsule は `dependency_retired` で
停止します。通常の plan、drift check、destroy plan、アンインストールの teardown
plan が対象です。ガードは互換性チェックや Run 作成より前に働きます。
行を削除する API / CLI はありません。利用者ではなく database operator が以下の
保守を行います。これは自動 migration ではなく、対象行を選択する一回限りの操作です。

Workspace update / drift-check RunGroup は廃止済みです (`410` `run_group_retired`)。
廃止前の group は、対象に含まれた consumer の失敗を `graphJson.failures[capsuleId]` に
`dependency_retired` として記録しており、読むと `failed` です。定期巡回はアプリごとに
plan / drift check を作り、拒否された Capsule の PlanRun は作りません。保守後は
アプリごとに新しい plan を作成します。
予約アンインストールも `blockedReason: dependency_retired` で停止し、自動再試行しません。

## 準備

1. 自分が管理する self-host database と対象 Workspace / consumer Capsule ID を確認します。
   その環境の API writer、scheduler、queue consumer を停止し、実行中の Run がない状態で
   保守します。停止方法は自分の deployment 構成に従います。
2. adapter が所有する database の完全な backup を取り、復元手順を確認します。
   現在の部分的な control export は旧 Dependency 行を含まず、この backup の代用には
   なりません。退避データを公開 ticket、repo、ログへ貼り付けないでください。
3. 下の SELECT で検出した行の ID、所属 Workspace、producer / consumer を確認し、
   旧 variable injection / remote state に代わる入力を consumer の source / config に
   明示設定します。destroy する場合も現在の state と teardown に必要な入力を確認します。
   operator が削除対象と変更後の動作を review してから DELETE を実行します。

以下は現在の storage schema の物理名を使います。`ws_REPLACE`、`cap_REPLACE`、
`dep_REPLACE` を確認済みの ID に置換します。複数行は ID ごとに同じ限定 DELETE を
繰り返します。Workspace が一致しない行を検出した場合は所属の不整合を調査し、
WHERE 条件を外して削除しないでください。

## D1

自分の環境の D1 SQL 実行手段で、まずこの read-only query を実行します。
consumer に対するガードは Workspace 条件を持たないため、検出でも全所属を確認します。

```sql
SELECT id, space_id, producer_installation_id, consumer_installation_id
FROM installation_dependencies
WHERE consumer_installation_id = 'cap_REPLACE'
ORDER BY id;
```

backup と対象 ID を確認したら、review 済みの行だけを削除します。
`SELECT changes()` は同じ接続で直後に実行し、1 行だったことを確認します。

```sql
DELETE FROM installation_dependencies
WHERE id = 'dep_REPLACE'
  AND space_id = 'ws_REPLACE'
  AND consumer_installation_id = 'cap_REPLACE';
SELECT changes() AS deleted_rows;
```

## Postgres

自分の環境の SQL client で、まずこの read-only query を実行します。

```sql
SELECT id, space_id, producer_installation_id, consumer_installation_id
FROM takosumi_installation_dependencies
WHERE consumer_installation_id = 'cap_REPLACE'
ORDER BY id;
```

同じ接続で transaction を開始し、review 済みの行だけを削除します。

```sql
BEGIN;
DELETE FROM takosumi_installation_dependencies
WHERE id = 'dep_REPLACE'
  AND space_id = 'ws_REPLACE'
  AND consumer_installation_id = 'cap_REPLACE'
RETURNING id, space_id, producer_installation_id, consumer_installation_id;
```

返った行が review 対象と完全一致した場合だけ、同じ接続で `COMMIT;` を実行します。
0 行、想定外の行、途中のエラーなら `ROLLBACK;` で終了して原因を調べます。

## 完了確認と復旧

最初の SELECT を再実行し、対象 consumer の行が 0 件であることを確認します。
retired `dependency_snapshots` / `takosumi_dependency_snapshots` と
`output_shares` / `takosumi_output_shares` は履歴として保持します。PlanRun の
`dependencySnapshotId`、Run / state / Output 履歴は書き換えません。旧 snapshot pin を
持つ PlanRun は保守後も Apply できないため、新しい plan を作ります。

writer を再開し、対象 Capsule の新しい plan または destroy plan が依存ガードを通り、
意図した入力と差分を持つことを確認します。plan の作成は Apply の承認ではありません。
他の Capsule の行が変わっていないことと、削除 ID / 件数 / backup 参照を private な
operator 作業記録に残します。エラー時は自動再試行や削除範囲の拡大をせず、診断を保持します。

既に停止した予約アンインストールを再開する場合は、owner が通常の
`POST /api/v1/capsules/{id}/cancel-uninstall` で予約を取り消し、保守後に
`POST /api/v1/capsules/{id}/uninstall` で新しい予約を作成します。猶予期間は新しい予約から
始まります。database の停止理由や Plan ID マーカーを手動で消して再試行させないでください。

Postgres の commit 前は rollback できます。D1 の削除後、または Postgres の commit 後に
取り消す場合は writer を止めたまま adapter の検証済み backup 復元手順を使います。
旧行を戻すとガードも戻ります。新しい plan / Apply 後に database 全体を巻き戻すと
state が不整合になるため、その場合は履歴を保った forward repair を行います。
