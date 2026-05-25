# ストレージスキーマ {#storage-schema}

このページは Takosumi core records と reference/operator extension records の
索引です。実際の storage backend は Postgres / SQLite / D1 / in-memory など
operator が選べますが、record の意味と lifecycle boundary はここで揃えます。

Account、billing、OIDC issuer、customer onboarding、support workflow の record
は operator account-plane 側の storage schema に置きます。

## Core Records

| Record         | 役割                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Installation` | AppSpec が Space に installed された core record。current pointer を持つ。                                       |
| `Deployment`   | 1 回の apply / rollback target になる result record。source identity、status、public/non-secret outputs を持つ。 |

## Reference Kernel Retained Evidence Records

| Record               | 役割                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `ResolutionSnapshot` | AppSpec component、kind、provider、publication / binding の解決結果を固定する。               |
| `DesiredSnapshot`    | apply で実現したい desired state。provider side effect の input になる。                      |
| `OperationPlan`      | Deployment で実行する operation の順序と依存関係。                                            |
| `ActivationSnapshot` | active routing / traffic assignment。health は ObservationSet と retained evidence 側に残す。 |

snapshot は reference kernel が Deployment に紐づく implementation/operator
evidence を説明するための内部 record です。public Deployment wire に portable な
top-level `evidence` field はありません。rollback は retained Deployment を
current pointer として再選択し、rollback metadata / audit を記録します。
Deployment record は追加しません。

## Core Journal And Lock Records

| Record               | 役割                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `JournalEntry`       | write-ahead operation journal。provider side effect 前後の replay point。 |
| `InstallerLeaseLock` | Installation 単位の apply / rollback 排他制御。                           |
| `LockRecord`         | cross-process lock adapter が使う generic lock row。                      |

詳細は [WAL Stages](./wal-stages.md) と
[Cross-Process Locks](./cross-process-locks.md)。

## Reference Policy And Safety Records

| Record           | 役割                                              |
| ---------------- | ------------------------------------------------- |
| `Approval`       | operator approval が必要な operation の承認状態。 |
| `RevokeDebt`     | revoke が必要だが即時反映できなかった状態の追跡。 |
| `DriftIndex`     | observed state と desired state の drift index。  |
| `ObservationSet` | provider / runtime observation の現在値。         |

これらは reference implementation が apply / observe / recovery を fail-safe に
進めるための record です。顧客向け approval UI や account role model は operator
account plane が所有します。

## Reference Implementation, Connector, And DataAsset Records

| Record                         | 役割                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `OperatorImplementationConfig` | operator が attach した kind alias / provider implementation / connector inventory。 |
| `ImplementationRegistry`       | operator が attach した provider implementation / connector の registry view。       |
| `ConnectorDescriptor`          | runtime-agent connector の id、accepted DataAsset metadata、health。                 |
| `DataAssetRecord`              | optional operator DataAsset extension の digest、size、retention metadata。          |
| `SecretPartitionReference`     | secret store partition の logical reference。secret value は secret backend に置く。 |

DataAsset retention は [DataAsset GC](./data-asset-gc.md)、connector envelope は
[Connector Guide](./connector-contract.md)。

## Audit

`AuditLogEvent` は kernel operation の audit envelope です。event type と
payload の詳細は [Audit Events](./audit-events.md) にあります。

## 実装の自由度

この schema は logical model です。backend 固有の table 名、index 名、
partitioning、compaction strategy は実装の自由度に含まれます。Takosumi core の
portable record は Installation と Deployment です。下の項目は reference kernel
や operator ledger が採用する consistency / audit pattern です。

- Deployment を再構成できる snapshot と journal を保持する。
- apply / rollback の同時実行を lock で防ぐ。
- audit event は hash chain または同等の tamper-evident 証跡を持つ。
- secret value を kernel record に平文保存しない。

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Audit Events](./audit-events.md)
- [DataAsset GC](./data-asset-gc.md)
- [Secret Partitions](./secret-partitions.md)
- [Drift Detection](./drift-detection.md)
