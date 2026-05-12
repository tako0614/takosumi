# RevokeDebt Model

> Stability: stable Audience: operator, kernel-implementer See also:
> [WAL Stages](/reference/wal-stages),
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Lifecycle Protocol](/reference/lifecycle)

Takosumi v1 で「commit 済みだが取り消しきれなかった external effect / generated
material」を表現するための RevokeDebt record の正式仕様です。reason / status の
closed enum、aging window、Multi-Space ownership、ActivationSnapshot propagation
を整理します。

## RevokeDebt record schema

```yaml
RevokeDebt:
  id: revoke-debt:01HZ... # ULID-based ID
  generatedObjectId: generated:... # 対象 generated material / external object
  sourceExportSnapshotId: export-snapshot:...
  externalParticipantId: external-participant:...
  reason: <enum: 5 値> # 後述
    status: <enum: 3 値> # 後述
      ownerSpaceId: space:... # 現 ownership を持つ Space
      originatingSpaceId: space:... # debt を最初に生んだ Space
      retryPolicy: {} # backoff / max attempts / aging window (policy-controlled)
      retryAttempts: 0
      lastRetryAt: optional
      nextRetryAt: optional
      lastRetryError: optional
      createdAt: 2026-... # 生成 timestamp
      statusUpdatedAt: 2026-... # status が最後に変わった timestamp
      agedAt: optional # operator-action-required 遷移時刻
      clearedAt: optional # cleared 遷移時刻
```

`generatedObjectId` は generated lifecycle class の object、external object、
または link projection の対象を指す。`sourceExportSnapshotId` は debt 発生時

`retryPolicy` は kernel 定数ではなく policy-controlled で、Space の policy pack
から派生する。kernel が直接解釈する portable subset は `maxAttempts`,
`backoffMs` / `backoffSeconds`, `agingWindowMs` / `agingWindowSeconds` /
ISO-8601 duration の `agingWindow` です。これ以外の policy-controlled fields は
operator policy engine が解釈してよい。

## reason 5 値

`reason` field は debt 発生の origin を示す closed enum。新 reason 追加は
`CONVENTIONS.md` §6 RFC を要する。

| Reason                 | 発生 trigger                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `external-revoke`      | 外部 system が revoke を ack せず、現実の外部状態が retain している          |
| `link-revoke`          | link revoke (link projection の解除) が cleanup できなかった                 |
| `activation-rollback`  | activation rollback / compensate recovery 後の cleanup 残り                  |
| `approval-invalidated` | 前承認のもとで retain した material が、approval invalidation で根拠を失った |

reason ごとの典型ケース:

- `external-revoke`: cloud API へ revoke を投げたが API が `still active` を
  返し続ける、または外部 system が後勝ち書き込みで revoke を巻き戻した。
- `link-revoke`: link projection の片側 cleanup が success、もう片側が permanent
  fail。`post-commit` 失敗が典型源。
- `activation-rollback`: `commit` 済み effect の逆再生で消しきれない generated
  material。`abort` 経路で enqueue。
- `approval-invalidated`: approval が `invalidated` に落ちたが既に materialize
  済みの retain 物。新規 approval の granting までは debt として可視化する。
  lifecycle が expiry に達し、importing Space 側で materialize された material
  が exporting Space 側の retention 範囲を超える。

## status 3 値

`status` field は debt の現在の処理段階を示す closed enum。

| Status                     | 意味                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `open`                     | retry queue に乗っている。retryPolicy に従い backoff retry 中 |
| `operator-action-required` | retry が permanent fail / policy block。operator 手動介入が要 |
| `cleared`                  | terminal。audit 用に保持される                                |

terminal は `cleared` のみ。`operator-action-required` から operator action 後
は `open` に戻すこともあれば、直接 `cleared` まで進むこともある (manual
clearance)。

Retry attempt の結果は次のように status に反映される:

- `cleared`: retry は成功し、`status = cleared` / `clearedAt = now` に進む。
- `retryable-failure`: `retryAttempts` を増やし、policy が許す間は `open` のまま
  `nextRetryAt` を更新する。`maxAttempts` 到達後は `operator-action-required`
  に進む。
- `blocked`: policy block / permanent failure として即座に
  `operator-action-required` に進む。

Kernel の connector-backed cleanup worker は `open` かつ `nextRetryAt <= now` の
debt を対象にする。Public deploy 由来の debt は
`(ownerSpaceId,
deploymentName, resourceName, providerId)` から persisted
deployment record の handle を解決し、provider の `compensate` operation
を呼ぶ。 `compensate` が無い provider では handle-keyed `destroy` を fallback
として実行する。成功時は `cleared`、 一時失敗は `retryable-failure`、handle /
provider が解決できない場合は `blocked` として `operator-action-required`
に進む。

`takosumi-worker` role の worker daemon は persistent `RevokeDebtStore` から
open debt を持つ owner Space を列挙し、`revoke-debt-cleanup` task として cleanup
worker を周期実行する。cadence と batch size は
`TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS` /
`TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT` で調整する。

## Aging window

`open` 状態が一定時間経過した debt は自動で `operator-action-required` に
遷移する。これを **aging window** と呼ぶ。

- aging window の長さは kernel 定数ではなく **policy-controlled** で、Space の
  policy pack 上で設定する。
- 自動遷移は **idempotent / journaled**。重複 transition は WAL 同様の tuple
  で抑止し、journal entry が残る。
- 自動遷移は `agedAt` timestamp を立てる。
- **manual operator action は aging window を無視して**
  `operator-action-required` に遷移できる。operator が status を直接 force
  した場合 `agedAt` は手動 transition 時刻になる。
- `operator-action-required` から `open` に戻す path も aging window を消費
  しない (operator の判断で retry queue に戻す)。

## Future Multi-Space ownership

は次の規則で決める:

- **生成 Space が default owner**: generated material を最初に materialize した
  Space が `ownerSpaceId` を持つ。 された debt は、importing Space を
  `ownerSpaceId` とする。`originatingSpaceId` は exporting Space を保持する
  (audit / drift 連動の参照点)。
- **Exporting Space は read-only mirror**: exporting Space からは status を
  mutate できない。`open` / `operator-action-required` / `cleared` への
  transition は importing Space owner の責務。 state に反映する
  (`refresh-required` / `revoked` などへの遷移条件)。

## ActivationSnapshot propagation (fail-safe-not-fail-closed)

RevokeDebt の status は ActivationSnapshot に伝播し、traffic shift の挙動を gate
する。Takosumi のスタンスは **fail-safe-not-fail-closed**:

- `operator-action-required` の debt が ownerSpaceId 配下に 1 件でも存在
  すると、**新規 traffic shift は block** される。GroupHead pointer の前進を
  停止する。
- ただし **既存 GroupHead pointer は roll back しない**。既に流れている traffic
  は維持し、operator が状況を判断する時間を確保する。
- `open` 状態の debt は traffic shift を block しない。retry が回っているうちは
  通常の lifecycle 操作を続ける。
- `cleared` の debt は traffic shift に影響を与えない。

これにより「debt が出るたびに自動 rollback で更に状況を悪化させる」のを避ける。

## Production readiness check

production deployment では status 表示を必須とする:

- operator dashboard / CLI status は `open` / `operator-action-required` /
  `cleared` の件数を Space 単位で表示する。
- `operator-action-required` 1 件以上の状態を **production readiness check
  失敗** として扱い、kernel の `/readyz` に直接は反映しないが、operator gate で
  deploy を止める運用にする。
- audit event は debt の status transition ごとに 1 entry 出す
  (`createdAt → agedAt → clearedAt` を hash chain で繋ぐ)。

## Cross-references

- WAL stage 側からの enqueue 経路:
  [WAL Stages — Orphaned debt 経路](/reference/wal-stages#orphaned-debt-経路)
- Public deploy recovery: `/v1/deployments` の `recoveryMode: "compensate"`
  は、同じ OperationPlan digest / phase の unfinished WAL が `commit` 以降に
  到達している場合に `activation-rollback` RevokeDebt を `takosumi_revoke_debts`
  へ enqueue し、WAL を terminal `abort` に進める。
- Approval invalidation との連動:
  [Approval Invalidation Triggers](/reference/approval-invalidation)
- Recovery mode 中の `activation-rollback` 発生条件:
  [Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes)
- `revoke-debt-created` Risk: [Risk Taxonomy](/reference/risk-taxonomy)

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/observation-drift-revokedebt-model.md` —
  RevokeDebt taxonomy、 reason / status の選定理由、aging window が
  policy-controlled である根拠
- `docs/reference/architecture/exposure-activation-model.md` —
  ActivationSnapshot propagation と fail-safe-not-fail-closed スタンスの議論
- `docs/reference/architecture/space-model.md` — future Multi-Space ownership と
