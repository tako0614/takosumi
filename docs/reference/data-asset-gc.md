# asset GC {#data-asset-gc}

asset GC は optional asset extension の uploaded asset と、その裏付け object bytes を保守的に削除する operator extension worker です。rollback、 audit、CleanupBacklog の根拠になる asset を消さないことを優先します。

This is an operational surface for the optional asset extension. Source identity and asset metadata values are handled by different layers: Source belongs to the Installer API, while asset metadata values belong to operator distribution / connector policy. Compatibility names are listed in [asset Policy](./data-asset-policy.md#compatibility-names).

## Reachability

current reference asset extension は、GC 時に asset を次のいずれかに分類します。Core は Deployment history を保持しますが、asset-specific reachability class や GC event 名は要求しません。

| Class                | 意味                                                        |
| -------------------- | ----------------------------------------------------------- |
| `live`               | current Deployment の記録から参照されている。               |
| `snapshot-reachable` | Deployment の記録 / activation history から参照されている。 |
| `debt-pinned`        | open CleanupBacklog が cleanup 完了まで保持を要求している。 |
| `unreferenced`       | どの root からも到達できない。                              |

到達性チェックは保守的です。保持済み snapshot のどれかから参照されていれば、 current Deployment で使われていなくても sweep しません。

## Mark And Sweep

GC は mark-then-sweep です。

1. Deployment の記録、activation history、open CleanupBacklog を root として参照を辿る。
2. 到達可能な asset を `live`、到達不能なものを `unreferenced` と mark する。
3. `unreferenced` が grace window を過ぎたものだけ object storage から削除する。
4. sweep 結果を audit event として記録する。

grace window は operator policy / environment で調整できます。

Compatibility route / env / command names such as `/v1/artifacts`, `TAKOSUMI_ARTIFACT_*`, and `takosumi artifact` are listed in [asset Policy](./data-asset-policy.md#compatibility-names).

## Triggers

| Trigger  | 説明                                                                      |
| -------- | ------------------------------------------------------------------------- |
| periodic | `TAKOSUMI_ARTIFACT_GC_PERIODIC_HOURS` cadence。`0` で off。               |
| manual   | `takosumi artifact gc` または internal operator route。                   |
| pressure | asset storage usage が operator-defined pressure threshold を超えたとき。 |

同時に複数 trigger が発生した場合、1 つの cycle に合流します。

## Crash Safety

- mark / sweep cursor は batch boundary ごとに persist する。
- sweep は object deletion 成功後に asset row を `swept` に進める。
- crash 後は最後に commit された cursor から再開する。
- stale marker は sweep 前に re-mark を要求する。

## Audit Events

current reference extension の GC worker は `artifact-gc-marked` と `artifact-gc-swept` を発行します。payload は cursor、marked/swept count、 reclaimed bytes、trigger list、duration を含みます。詳細は [Audit Events](./audit-events.md)。

## Related Pages

- [asset Policy](./data-asset-policy.md)
- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [CleanupBacklog Model](./revoke-debt.md)
