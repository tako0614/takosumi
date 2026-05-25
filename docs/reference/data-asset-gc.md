# DataAsset GC {#data-asset-gc}

DataAsset GC は optional DataAsset extension の uploaded DataAsset
と、その裏付け object bytes を保守的に削除する operator extension worker
です。rollback、 audit、RevokeDebt の根拠になる DataAsset
を消さないことを優先します。

This is an operational surface for the optional DataAsset extension. Component
kind and DataAsset metadata kind are handled by operator distribution /
connector policy. Compatibility names are listed in
[DataAsset Policy](./data-asset-policy.md#compatibility-names).

## Reachability

current reference DataAsset extension は、GC 時に DataAsset を次のいずれかに分
類します。Core は Deployment history を保持しますが、DataAsset-specific
reachability class や GC event 名は要求しません。

| Class                | 意味                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `live`               | current Deployment に紐づく retained evidence から参照されている。 |
| `snapshot-reachable` | retained evidence / activation history から参照されている。        |
| `debt-pinned`        | open RevokeDebt が cleanup 完了まで保持を要求している。            |
| `unreferenced`       | どの root からも到達できない。                                     |

到達性チェックは保守的です。保持済み snapshot のどれかから参照されていれば、
current Deployment で使われていなくても sweep しません。

## Mark And Sweep

GC は mark-then-sweep です。

1. retained evidence、activation history、open RevokeDebt を root として参照を辿
   る。
2. 到達可能な DataAsset を `live`、到達不能なものを `unreferenced` と mark
   する。
3. `unreferenced` が grace window を過ぎたものだけ object storage から削除する。
4. sweep 結果を audit event として記録する。

grace window は operator policy / environment で調整できます。

Compatibility route / env / command names such as `/v1/artifacts`,
`TAKOSUMI_ARTIFACT_*`, and `takosumi artifact` are listed in
[DataAsset Policy](./data-asset-policy.md#compatibility-names).

## Triggers

| Trigger  | 説明                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| periodic | `TAKOSUMI_ARTIFACT_GC_PERIODIC_HOURS` cadence。`0` で off。                   |
| manual   | `takosumi artifact gc` または internal operator route。                       |
| pressure | DataAsset storage usage が operator-defined pressure threshold を超えたとき。 |

同時に複数 trigger が発生した場合、1 つの cycle に合流します。

## Crash Safety

- mark / sweep cursor は batch boundary ごとに persist する。
- sweep は object deletion 成功後に DataAsset row を `swept` に進める。
- crash 後は最後に commit された cursor から再開する。
- stale marker は sweep 前に re-mark を要求する。

## Audit Events

current reference extension の GC worker は `artifact-gc-marked` と
`artifact-gc-swept` を発行します。payload は cursor、marked/swept count、
reclaimed bytes、trigger list、duration を含みます。詳細は
[Audit Events](./audit-events.md)。

## Related Pages

- [DataAsset Policy](./data-asset-policy.md)
- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [RevokeDebt Model](./revoke-debt.md)
