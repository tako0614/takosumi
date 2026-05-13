# Compliance Retention

> このページでわかること: コンプライアンス要件に基づくデータ保持ポリシー。

Takosumi v1 における compliance regime ごとの audit retention 仕様。 PCI-DSS /
HIPAA / SOX / regulated / default の 5 値 closed enum を採用し、 各 regime
の最小保持期間、PII / secret 取り扱い、archive sink 連携、 GDPR right-to-erasure
対応を operator-actionable に定義する。 [Audit Events](/reference/audit-events)
が定義する event-shape contract に、 本 reference が retention window を attach
する関係。

## Compliance regime closed enum (v1)

regime 値は closed enum で、追加には `CONVENTIONS.md` §6 RFC を要する。

| regime      | 想定                                                  |
| ----------- | ----------------------------------------------------- |
| `default`   | compliance constraint を持たない operator 既定        |
| `pci-dss`   | カード会員データを扱う Space (PCI DSS)                |
| `hipaa`     | 保護対象保健情報 (PHI) を扱う Space (HIPAA)           |
| `sox`       | 財務統制対象に関連する Space (SOX)                    |
| `regulated` | jurisdictional / industry-specific な operator 拡張枠 |

regime は **per-Space** に固定する。global default は
`TAKOSUMI_AUDIT_RETENTION_REGIME` で indicate し、Space 個別 override は
operator policy で書く。

## Retention windows (audit log)

各 regime の **minimum** 保持期間。operator は minimum を超える保持を policy
で延ばせるが、短縮はできない。

| regime      | audit minimum   | 根拠                                  |
| ----------- | --------------- | ------------------------------------- |
| `default`   | 90 days         | operator-tunable、最低 90 日          |
| `pci-dss`   | 365 days        | カードホルダー監査ログの 1 年保持     |
| `hipaa`     | 6 years         | PHI access 監査の 6 年保持            |
| `sox`       | 7 years         | 財務関連記録の 7 年保持               |
| `regulated` | operator policy | jurisdictional 要件で operator が指定 |

window は audit event の `ts` から数える。primary store には少なくとも window
分は読める形で残す。window を超えた entry は archive sink delivery
を確認した上で primary から drop してよい。

## Data field treatment

regime によらず共通の rule と、regime 固有の rule に分かれる。

### 全 regime 共通

- secret raw value は **どの audit event にも書かれない**
  ([Audit Events](/reference/audit-events) redaction rule)。regime に
  関係なく不変。
- secret reference (`${secret:...}` 形式) は payload に含まれてよい。
- audit envelope の hash chain は redact してはいけない。

### `pci-dss`

- カード会員データ (PAN / CVV / expiry) は **storage 全域で禁止**。 payload
  に混入し得る field は redaction 対象。
- actor identity は full retention 期間中、queryable に保つ。

### `hipaa`

- PHI を含み得る payload field は kernel が field-level redaction を実施。 hash
  chain に含まれる canonical bytes には redacted form が入る。
- access log (誰が PHI を resolve したか) は actor identity を 6 年間 queryable
  に保つ。

### `sox`

- 財務関連 mutation (deployment-applied / approval-granted / share-created など)
  は payload digest を含めて 7 年間 immutable に 保つ。改ざん検出は audit hash
  chain で証明する。
- archive sink への transfer は WORM (Write Once Read Many) を要件と する。

### `regulated`

- field 取り扱いは operator policy が指定。kernel は field-level redaction の
  policy point を提供し、operator が regulation ごとに rule を書く。

### `default`

- field redaction は operator policy 次第。secret redaction は強制。
- 保持 window は 90 日を minimum に operator が tune する。

## Configuration

### Environment variable

global default regime:

```
TAKOSUMI_AUDIT_RETENTION_REGIME=default | pci-dss | hipaa | sox | regulated
```

未指定なら `default`。env の詳細は [Environment Variables](/reference/env-vars)
参照。

### Per-Space override

global default を上書きする per-Space regime は operator policy で書く:

```yaml
spaces:
  <spaceId>:
    auditRetention:
      regime: <regime>
      minimumDays: <int> # regime minimum を超える延長のみ許容
      archiveSink: <ref> # archive sink への delivery target
```

`minimumDays` を regime minimum 未満に書いた policy は kernel boot で reject
される (`audit-retention-window-too-short`)。

### Regime change

regime は `regime-changed` audit event として記録される。

- `from-regime` / `to-regime` / `effective-at` を payload に持つ。
- 変更 actor は operator のみ。deploy bearer では regime 変更不可。
- 変更直後から新 regime の minimum window が適用される。既存 entry は 当時の
  regime に従って保持する (retroactive 削減はしない)。

## Archive sink

長期保持を primary audit store に置きっぱなしにすると I/O cost が
膨らむため、operator は archive sink を設定して長期 entry を逃がせる。

### Sink targets

- S3 Object Lock (compliance mode / governance mode)
- GCS Bucket Lock
- Azure Blob immutability policy
- 任意 operator-installed sink (custom adapter)

archive sink への delivery 方式は kernel が batch で push する。 delivery 確認は
sink ごとの ack semantics に従う (S3 Object Lock の PutObject 成功 + Object Lock
確認、など)。

SQL audit retention は `SqlObservabilitySink.applyRetentionPolicy()`
が担う。retention cutoff を超えた entry は、configured `AuditReplicationSink`
へ配送してから `archived=true` に mark される。汎用 object-store archive は
`ObjectStorageAuditReplicationSink` が担当し、`ObjectStoragePort` 経由で
`<prefix>/events/<sequence>-<hash>.json` に hash-chain record を保存する。S3
Object Lock / GCS Bucket Lock / R2 / MinIO などの immutability は adapter 側の
運用 policy として満たす。

### Delivery contract

- delivery は audit hash chain の連続性を維持する。chunk ごとに `from-eventId` /
  `to-eventId` / chunk hash を sink に書き込む。
- delivery 確認後に primary store から drop して良いのは regime minimum window
  を **超えた** entry のみ。
- delivery 失敗時は **primary 保持を継続** する。primary drop を delivery
  成功条件にしないと chain 切断のリスクが出る。

### Audit events

archive 経路の event:

- `audit-archive-delivery-started`
- `audit-archive-delivery-succeeded`
- `audit-archive-delivery-failed`
- `audit-primary-drop-applied`

すべて actor=`system` / severity=`info`〜`error` で記録される。

## Retention vs other layers

retention は層ごとに独立。混同を避ける:

| 層                   | retention 規則                                     |
| -------------------- | -------------------------------------------------- |
| `AuditLog`           | compliance regime ごと (本 reference)              |
| `OperationJournal`   | RevokeDebt non-terminal の間は削除禁止             |
| `ObservationSet`     | latest 1 entry only                                |
| `ObservationHistory` | opt-in、operator policy で trim、compliance 対象外 |

journal compaction は audit retention とは別機構で、recovery-critical な
範囲を保つことに最適化されている
([Journal Compaction](/reference/journal-compaction))。 ObservationHistory は
authoritative ではないため compliance 対象外
([Observation Retention](/reference/observation-retention))。

## Right-to-erasure (GDPR)

regime に関係なく、data subject の erasure 要求への応答が必要な operator
は以下の運用を取る。

### Field-level redaction

- 該当 audit event の payload 内、PII を含む field を redacted form に
  置換する。
- audit hash chain は **維持** する。redaction は payload field の
  原像を破棄しつつ canonical bytes (redacted form を含む) の hash を
  保つ仕組みで行う。chain の連続性は崩れない。
- 古い entry を archive sink にも逃がしている場合、archive 側でも 同じ field を
  redact する (sink の immutability 要件と整合させる ため、原則 archive 側は
  append-only な redaction marker を追加する 形を取る)。

### 制約

- secret partition の rotation 由来 entry は redaction 対象外
  ([Secret Partitions](/reference/secret-partitions))。
- compliance regime の minimum window 内にある entry でも、PII field の
  redaction は許容される (entry 全体の削除ではないため)。
- entry 全体の削除 (full deletion) は compliance regime minimum 内では
  禁止。erasure 要求は redaction で応答する。

### Audit

erasure 操作自体が audit event として記録される:

- `audit-pii-redacted` — eventId / field path / actor / reason

## Operator surface

- regime 設定 / 変更は operator-only operation。deploy bearer では実行 不可。
- regime change と archive sink delivery は operator internal tooling から確認
  する。current public `takosumi` CLI には audit regime / archive / redact
  subcommand はない。
- regime minimum window より短い retention を要求する operator policy は kernel
  boot で reject される。

## Failure modes

| 状況                                         | error code                         | 復旧                                |
| -------------------------------------------- | ---------------------------------- | ----------------------------------- |
| `minimumDays` が regime minimum 未満         | `audit-retention-window-too-short` | policy を regime minimum 以上に修正 |
| archive sink delivery 失敗                   | `audit-archive-delivery-failed`    | sink 復旧後に retry、primary 保持   |
| primary drop が delivery 未確認 entry を含む | `audit-primary-drop-blocked`       | delivery 完了を待つ                 |
| regime 値が enum 外                          | `audit-retention-regime-unknown`   | enum 5 値のいずれかに修正           |

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operator-boundaries.md` — operator-only な regime
  control の trust 境界
- `docs/reference/architecture/policy-risk-approval-error-model.md` — audit と
  Risk / approval の interplay
- `docs/reference/architecture/snapshot-model.md` — snapshot / journal / audit
  の retention 階層分離 rationale

## 関連ページ

- [Audit Events](/reference/audit-events)
- [Observation Retention](/reference/observation-retention)
- [Journal Compaction](/reference/journal-compaction)
- [Secret Partitions](/reference/secret-partitions)
- [Environment Variables](/reference/env-vars)
