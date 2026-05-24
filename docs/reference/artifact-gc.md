# DataAsset GC (`/v1/artifacts`) {#artifact-gc}

DataAsset GC は optional DataAsset extension の uploaded DataAsset
と、その裏付け object bytes を保守的に削除する operator extension worker
です。rollback、audit、RevokeDebt の根拠になる DataAsset
を消さないことを優先します。

これは current implementation の operational surface です。`/v1/artifacts` route
と `takosumi artifact` command は historical name を残していますが、概念名は
DataAsset です。component kind と DataAsset metadata kind は operator
distribution / connector policy で扱います。

## Reachability

DataAsset は GC 時に次のいずれかに分類されます。

| Class                | 意味                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `live`               | current Deployment evidence から参照されている。                       |
| `snapshot-reachable` | retained Deployment evidence / activation history から参照されている。 |
| `debt-pinned`        | open RevokeDebt が cleanup 完了まで保持を要求している。                |
| `unreferenced`       | どの root からも到達できない。                                         |

到達性チェックは保守的です。保持済み snapshot のどれかから参照されていれば、
current Deployment で使われていなくても sweep しません。

## Mark and sweep

GC は mark-then-sweep です。

1. retained Deployment evidence、activation history、open RevokeDebt を root
   として参照を辿る。
2. 到達可能な DataAsset を `live`、到達不能なものを `unreferenced` と mark
   する。
3. `unreferenced` が grace window を過ぎたものだけ object storage から削除する。
4. sweep 結果を audit event として記録する。

grace window は `TAKOSUMI_ARTIFACT_GC_GRACE_DAYS` で調整できます。

DataAsset は optional operator extension の概念名です。`artifact*` env / command
/ event / field 名は existing wire compatibility のため残る名前で、prose では
DataAsset を使います。

## Triggers

| Trigger  | 説明                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| periodic | `TAKOSUMI_ARTIFACT_GC_PERIODIC_HOURS` cadence。`0` で off。                   |
| manual   | `takosumi artifact gc` または internal operator route。                       |
| pressure | DataAsset storage usage が operator-defined pressure threshold を超えたとき。 |

同時に複数 trigger が発生した場合、1 つの cycle に合流します。

## Crash safety

- mark / sweep cursor は batch boundary ごとに persist する。
- sweep は object deletion 成功後に DataAsset row を `swept` に進める。
- crash 後は最後に commit された cursor から再開する。
- stale marker は sweep 前に re-mark を要求する。

## Audit events

GC は `artifact-gc-completed` を発行します。payload は cursor、mark count、
sweep count、reclaimed bytes、trigger list、duration を含みます。詳細は
[Audit Events](./audit-events.md)。

## 関連ページ

- [DataAsset Policy](./data-asset-policy.md)
- [Kind Descriptor Examples § Source files and DataAssets](./kind-registry.md#source-files-and-dataassets)
- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [RevokeDebt Model](./revoke-debt.md)
