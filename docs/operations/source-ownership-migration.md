# Source ownership の backfill と split

この手順は operator 用であり、staging / production の実行や承認を意味しない。
まず [Source maintenance](./source-maintenance.md) の flag で自動 retirement を停止し、
Control DB と archive store の復元可能な backup、対象 release commit、schema version、operator を記録する。
Control schema の maintenance fence は**解除した状態**で実行する。fence はすべての Control の書き込みを止め、
group の commit も拒否されるため、fence 中の route は dry-run の読み取り・archive のコピー・commit の前に
`503 control_schema_maintenance_active` を返す。この移行の安全性は全体の書き込み停止ではなく、
group ごとの CAS（観測した行と件数を同じ D1 batch で再確認し、変化があれば `conflict`）、
実行中の Run・lease による `blocked`、レビュー済み dry-run の digest の一致で守る。
Source ごとに snapshot 行数、distinct archive 数、総 byte 数、live / destroyed アプリ数、
foreign archive 参照数を計測し、dry-run の group と照合する。

D1 の archive 棚卸し例（実行結果は operator の管理領域へ保存する）:

```sql
WITH refs AS (
  SELECT source_id, json_extract(record_json, '$.archiveRef') AS archive_ref
    FROM source_snapshots
  UNION ALL
  SELECT source_id, json_extract(run_json, '$.archiveRef') AS archive_ref
    FROM runs WHERE type = 'source_sync'
)
SELECT s.id AS source_id,
       (SELECT COUNT(*) FROM source_snapshots ss WHERE ss.source_id = s.id) AS snapshot_count,
       (SELECT COUNT(DISTINCT archive_ref) FROM refs r WHERE r.source_id = s.id) AS archive_count,
       (SELECT COALESCE(SUM(json_extract(ss.record_json, '$.archiveSizeBytes')), 0)
          FROM source_snapshots ss WHERE ss.source_id = s.id) AS snapshot_archive_bytes
FROM sources s ORDER BY snapshot_count DESC, s.id;
```

重複 snapshot の byte 合計は object store の実測使用量とは区別する。
PostgreSQL では `takosumi_sources`、`takosumi_source_snapshots`、`takosumi_runs`
と対応する JSONB field を用いて同じ内訳を確認する。

D1 の既存 HTTP operator は `scripts/operator-source-ownership.ts`。全 group の dry-run は read-only で、
1 group の準備エラーはその group の `blocked` 理由として返し、他 group の棚卸しを続ける。
互換性レポートは識別子（Source・アプリ・SourceSnapshot）だけを付け替え、分析結果の列は保存されたまま運ぶ。
`providers_json` として受け付ける形は次の3つだけで、どれも新しい形へ変換しない。
- 現在の形: `{ providerPackages, rootProviderRequirements }`。
- 平たい配列（2026-06-07〜08-27 17:07 UTC）: 要素は `source`・`allowed` が必須で、ほかに持てるのは
  `aliases`・`versionConstraint`・`credentialSources`（`takosumi_managed`／`user_env_set`、06-09〜06-20）・
  `ownershipOptions`（06-20〜06-27）・`credentialRequired`（07-14〜）・`localName`（07-29〜）だけ。空の `[]` も含む。
- 平たい配列（2026-08-27 17:07 UTC〜二層の形まで）: 要素は `source`・`moduleLocalName`・`allowed` が必須で、
  ほかに持てるのは `childAlias`・`version`・`credentialRequired` だけ。

JSON が壊れている、または上のどれでもないレポートは、その group だけを
`source_ownership_migration_compatibility_report_unreadable` で `blocked` にする。

`source_id` が NULL のレポート（2026-07-14 より前）は、参照するアプリがすべてその group にあれば
group を止めない。retire と backfill では触らない。split でもコピーせず、Source も推測しない。移すアプリは元の行を
参照したままにして、dry-run の `inventory.notices` に `legacy_unscoped_report_kept` の件数を出す。
別の group のアプリも同じレポートを参照している場合や、split の後にそうなる場合は、関係する group だけを
`compatibility_report_unscoped_shared` で `blocked` にする。
適用には対象 Source の正確な `preparedAt` と `reportDigest` を使う。
詳細な引数と guarded SQL は [移行の記録と手順](../internal/tasks/20261028-task0118-source-ownership-migration.md) を参照。

ownerless な orphan / 全アプリ destroyed の Source は、作成から24時間以上経過し、
非終端の source / preflight plan や live creator plan がない場合だけ `retire` で mark する。
retire は archive をコピーしない。ownerless Source は古いという理由だけでは sweep されない。
アプリの既存 owner が destroyed の Source は通常の owner lifecycle に従う。

split は staging で適用し、移動したすべてのアプリの完全な re-plan と期待するリソース差分、
出力、lane、provider binding、アプリ動作を検証してから production の適用を独立レビューする。
production は backup → dry-run → review → 明示的な operator 承認の順に進める。
新しい split Source は毎回新規の verifier hash を持ち、`webhookReregistrationRequired` を返す。
secret rotation API で新しい secret を取得し、Git 側 webhook を再登録する。旧 secret は共有しない。
承認 digest は新規ランダム verifier の値以外の計画全体を固定する。

コピーは create-only、size / digest 検証付きで順次進める。native R2 は元 object を stream で渡し、
put の checksum とコピー完了後の readback で検証する。元 archive がなければ
`source_archive_missing` の blocked group として停止し、DB の group commit を行わない。
backup から必要な原本を復元するなど理由を解決してから再度 dry-run を行う。

## Node / PostgreSQL の metadata-only backfill

既に設定した `TAKOSUMI_ACCOUNTS_DATABASE_URL` をプロセス環境から読み、接続文字列を出力しない。
DDL / migration / server startup は行わない。単一の live アプリの active な ownerless Source だけを扱い、
split、retire、archive copy や履歴の書き換えが必要な group は理由付きで拒否する。
採用済み provenance からの ref / path の収束は、同じ group CAS に含める。

```sh
bun scripts/operator-source-ownership-postgres.ts --source-id src_EXAMPLE > reviewed-source.json
# backup と dry-run の独立レビュー・operator 承認を完了してから実行する。
bun scripts/operator-source-ownership-postgres.ts --source-id src_EXAMPLE --apply reviewed-source.json
```

apply はレビュー済み JSON を読み、同じ `preparedAt` で再準備して digest と変更予定 lane を照合する。
途中で変更された group は適用しない。retirement が完了するまでは最大32 object ごとの進捗を確認し、
不要な範囲を再び sweep しないよう operator の flag 管理と棚卸しを続ける。
