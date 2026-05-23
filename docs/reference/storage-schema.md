# ストレージスキーマ {#storage-schema}

このページは Takosumi kernel が扱う logical record の索引です。実際の storage
backend は Postgres / SQLite / D1 / in-memory など operator が選べますが、record
の意味と lifecycle boundary はここで揃えます。

Account、billing、OIDC issuer、customer onboarding、support workflow の record
は kernel storage schema ではありません。それらは operator account-plane 側の
責務です。

## Deployment snapshots

| Record               | 役割                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `ResolutionSnapshot` | AppSpec component、kind、provider、namespace path の解決結果を固定する。 |
| `DesiredSnapshot`    | apply で実現したい desired state。provider side effect の input になる。 |
| `OperationPlan`      | Deployment で実行する operation の順序と依存関係。                       |
| `ActivationSnapshot` | activate 済み Deployment の routing / namespace / artifact state。       |

snapshot は Deployment に紐づきます。rollback は過去 snapshot を根拠に新しい
Deployment を作ります。

## Journal と lock

| Record               | 役割                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `JournalEntry`       | write-ahead operation journal。provider side effect 前後の replay point。 |
| `InstallerLeaseLock` | Installation 単位の apply / rollback 排他制御。                           |
| `LockRecord`         | cross-process lock adapter が使う generic lock row。                      |

詳細は [WAL Stages](./wal-stages.md) と
[Cross-Process Locks](./cross-process-locks.md) を参照してください。

## Policy と安全性

| Record           | 役割                                              |
| ---------------- | ------------------------------------------------- |
| `Approval`       | operator approval が必要な operation の承認状態。 |
| `RevokeDebt`     | revoke が必要だが即時反映できなかった状態の追跡。 |
| `DriftIndex`     | observed state と desired state の drift index。  |
| `ObservationSet` | provider / runtime observation の現在値。         |

これらは kernel が apply / observe / recovery を fail-safe に進めるための record
です。顧客向け approval UI や account role model は含みません。

## Catalog、connector、artifact

| Record                     | 役割                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `CatalogReleaseDescriptor` | 採用する kind / provider descriptor set の digest と source。                   |
| `CatalogReleaseAdoption`   | Space / operator context が採用した catalog release。                           |
| `ImplementationRegistry`   | operator が attach した materializer / connector の registry view。             |
| `Connector`                | runtime-agent connector の id、accepted kinds、health。                         |
| `ArtifactRecord`           | build service output や uploaded artifact の digest、size、retention metadata。 |
| `SecretPartitionReference` | secret store partition の logical reference。secret value は含まない。          |

artifact retention は [Artifact GC](./artifact-gc.md)、connector envelope は
[Connector Contract](./connector-contract.md) を参照してください。

## Audit

`AuditLogEvent` は kernel operation の audit envelope です。event type と
payload の詳細は [Audit Events](./audit-events.md) にあります。

## 実装の自由度

この schema は logical model です。backend 固有の table 名、index 名、
partitioning、compaction strategy は実装の自由度に含まれます。ただし次の互換性は
保ちます。

- Deployment を再構成できる snapshot と journal を保持する。
- apply / rollback の同時実行を lock で防ぐ。
- audit event は hash chain または同等の tamper-evident 証跡を持つ。
- secret value を kernel record に平文保存しない。

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Audit Events](./audit-events.md)
- [Artifact GC](./artifact-gc.md)
- [Secret Partitions](./secret-partitions.md)
- [Drift Detection](./drift-detection.md)
