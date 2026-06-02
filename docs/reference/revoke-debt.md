# CleanupBacklog Model

## CleanupBacklog record schema

```yaml
CleanupBacklog:
  id: cleanup-backlog:01HZ... # ULID-based ID
  generatedObjectId: generated:... # 対象 generated material / external object
  platformServiceSnapshotId: svcsnap_...
  externalParticipantId: external-participant:...
  reason: <enum: 4 値> # 後述
    status: <enum: 3 値> # 後述
      ownerSpaceId: space:... # 現 ownership を持つ Space
      originatingSpaceId: space:... # debt を最初に生んだ Space
      retryPolicy: {} # backoff / max attempts / escalation timeout (policy-controlled)
      retryAttempts: 0
      lastRetryAt: optional
      nextRetryAt: optional
      lastRetryError: optional
      createdAt: 2026-... # 生成 timestamp
      statusUpdatedAt: 2026-... # status が最後に変わった timestamp
      agedAt: optional # operator-action-required 遷移時刻
      clearedAt: optional # cleared 遷移時刻
```

`generatedObjectId` は generated lifecycle class の object、external object、または link projection の対象を指す。`platformServiceSnapshotId` は debt 発生時に binding が参照していた platform service snapshot を指す。既存実装や古い audit record に `sourcePublicationSnapshotId` が残る場合は互換読み取り名として扱い、新しい prose / schema 例では conceptual surface にしない。

`retryPolicy` は service 定数ではなく policy-controlled で、 Space の policy pack から派生する。 Takosumi service が直接解釈する portable subset は次のみ:

- `maxAttempts`
- `backoffMs` / `backoffSeconds`
- `agingWindowMs` / `agingWindowSeconds` / ISO-8601 duration の `agingWindow`

これ以外の policy-controlled fields は operator policy engine が解釈してよい。

## reason 4 値

`reason` field は debt 発生の origin を示す closed enum。新 reason 追加は `CONVENTIONS.md` §6 RFC を要する。

| Reason                 | 発生 trigger                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `external-revoke`      | 外部 system が revoke を ack せず、現実の外部状態が retain している      |
| `link-revoke`          | link revoke (link projection の解除) が cleanup できなかった             |
| `activation-rollback`  | activation rollback / compensate recovery 後の cleanup 残り              |
| `approval-invalidated` | 前承認のもとで保持した出力データが、approval invalidation で根拠を失った |

reason ごとの典型ケース:

- `external-revoke`: cloud API へ revoke を投げたが API が `still active` を返し続ける、または外部 system が後勝ち書き込みで revoke を巻き戻した。
- `link-revoke`: link projection の片側 cleanup が success、もう片側が permanent fail。`post-commit` 失敗が典型源。
- `activation-rollback`: `commit` 済み effect の逆再生で消しきれない generated 出力データ。`abort` 経路で enqueue。
- `approval-invalidated`: approval が `invalidated` に落ちたが既に実体化済みの保持データ。新規 approval decision までは debt として可視化する。 cross-Space sharing の TTL / revocation / cleanup debt は current v1 の reason enum には含めず、sharing RFC でまとめて定義します。

## status 3 値

`status` field は debt の現在の処理段階を示す closed enum。

| Status                     | 意味                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `open`                     | retry queue に乗っている。retryPolicy に従い backoff retry 中 |
| `operator-action-required` | retry が permanent fail / policy block。operator 手動介入が要 |
| `cleared`                  | terminal。audit 用に保持される                                |

terminal は `cleared` のみ。`operator-action-required` から operator action 後は `open` に戻すこともあれば、直接 `cleared` まで進むこともある (manual clearance)。

Retry attempt の結果は次のように status に反映される:

- `cleared`: retry は成功し、`status = cleared` / `clearedAt = now` に進む。
- `retryable-failure`: `retryAttempts` を増やし、policy が許す間は `open` のまま `nextRetryAt` を更新する。`maxAttempts` 到達後は `operator-action-required` に進む。
- `blocked`: policy block / permanent failure として即座に `operator-action-required` に進む。

Takosumi の runtime handler-backed cleanup worker は `open` かつ `nextRetryAt <= now` の debt を対象にする。Public deploy 由来の debt は `(ownerSpaceId,
deploymentName, resourceName, providerId)` から persisted deployment record の handle を解決し、provider の `compensate` operation を呼ぶ。 `compensate` が無い provider では handle-keyed `destroy` を fallback として実行する。成功時は `cleared`、一時失敗は `retryable-failure`、handle / provider が解決できない場合は `blocked` として `operator-action-required` に進む。

`takosumi-worker` role の worker daemon は persistent `CleanupBacklogStore` から open debt を持つ owner Space を列挙し、`cleanup-backlog-cleanup` task として cleanup worker を周期実行する。cadence と batch size は `TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS` / `TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT` で調整する。

## Escalation timeout

`open` 状態が一定時間経過した debt は自動で `operator-action-required` に遷移する。これを **escalation timeout** と呼ぶ。

- escalation timeout の長さは service 定数ではなく **policy-controlled** で、Space の policy pack 上で設定する。
- 自動遷移は **idempotent / journaled**。重複 transition は WAL 同様の tuple で抑止し、journal entry が残る。
- 自動遷移は `agedAt` timestamp を立てる。
- **manual operator action は escalation timeout を無視して** `operator-action-required` に遷移できる。operator が status を直接 force した場合 `agedAt` は手動 transition 時刻になる。
- `operator-action-required` から `open` に戻す path も escalation timeout を消費しない (operator の判断で retry queue に戻す)。

## TrafficSnapshot propagation (fail-safe-not-fail-closed)

CleanupBacklog の status は TrafficSnapshot に伝播し、traffic shift の挙動を gate する。Takosumi のスタンスは **fail-safe-not-fail-closed**:

- `operator-action-required` の debt が ownerSpaceId 配下に 1 件でも存在すると、**新規 traffic shift は block** される。RoutingPointer pointer の前進を停止する。
- ただし **既存 RoutingPointer pointer は roll back しない**。既に流れている traffic は維持し、operator が状況を判断する時間を確保する。
- `open` 状態の debt は traffic shift を block しない。retry が回っているうちは通常の lifecycle 操作を続ける。
- `cleared` の debt は traffic shift に影響を与えない。

これにより「debt が出るたびに自動 rollback で更に状況を悪化させる」のを避ける。

## Production deploy gate

production deployment では status 表示を必須とする:

- operator UI / CLI status は `open` / `operator-action-required` / `cleared` の件数を Space 単位で表示する。
- `operator-action-required` 1 件以上の状態を **production deploy gate 失敗** として扱い、service の `/readyz` に直接は反映しないが、operator gate で deploy を止める運用にする。
- audit event は debt の status transition ごとに 1 entry 出す (`createdAt → agedAt → clearedAt` を hash chain で繋ぐ)。

## Cross-references

- WAL stage 側からの enqueue 経路: [WAL Stages — Orphaned debt 経路](./wal-stages.md#orphaned-debt-経路)
- Internal recovery / compensate path: 同じ OperationPlan digest / phase の unfinished WAL が `commit` 以降に到達している場合に `activation-rollback` CleanupBacklog を `takosumi_cleanup_backlogs` へ enqueue し、WAL を terminal `abort` に進める。public rollback endpoint は retained `succeeded` Deployment へ current pointer を戻す操作であり、unfinished WAL recovery を直接 drive しない。
- Approval invalidation との連動: [Approval Invalidation Triggers](./approval-invalidation.md)
- Recovery mode 中の `activation-rollback` 発生条件: [Lifecycle Protocol — Recovery modes](./lifecycle.md#recovery-modes)
- `cleanup-backlog-created` Risk: [Risk Taxonomy](./risk-taxonomy.md)

## Related architecture notes

関連 architecture notes:

- `docs/reference/drift-detection.md` — CleanupBacklog と drift observation の連動
- `docs/reference/architecture/ingress-routing.md` — TrafficSnapshot propagation と fail-safe-not-fail-closed スタンスの議論
- `docs/reference/architecture/space-model.md` — future Multi-Space ownership と CleanupBacklog scope の設計議論

## 関連ページ

- [WAL Stages](./wal-stages.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Lifecycle Protocol](./lifecycle.md)
