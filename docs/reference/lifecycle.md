# Lifecycle プロトコル {#lifecycle-protocol}

> このページでわかること: deployment lifecycle 6 phase と recovery mode の運用
> 規則。

Takosumi の lifecycle は
`apply / activate / destroy / rollback / recovery /
observe` の 6 phase。 phase
ごとの snapshot 対応や `LifecycleStatus` 遷移は
[Lifecycle Phases](./lifecycle-phases.md)、 WAL stage は
[WAL Stages](./wal-stages.md)、 approval 失効は
[Approval Invalidation Triggers](./approval-invalidation.md) 参照。

## クロスプロセスロック {#cross-process-lock}

::: warning Production では SQL-backed `OperationPlanLockStore` 必須 in-memory
store は dev / unit test 専用。 複数 kernel pod 配置で lock 保証ができません。
:::

- 同一 OperationPlan の `apply / activate / destroy / rollback` は
  `(spaceId, operationPlanDigest)` を key に直列化されます。
- Lock holder が異常終了すると SQL-backed store は heartbeat TTL で自動失効。
  取り直した kernel は `recovery` phase 経由で復帰します。
- in-memory store は per-key Promise chain のみで cross-process race を起こし
  ます。 production 配置で inject されると kernel boot 時に warning が出ます
  が、 SQL-backed への差し替えは operator 運用で行います。

installer apply / rollback は同一 Installation への並行変更を直列化します。 busy
即返却ではなく lease が空くまで wait します。

WAL 書込: installer lifecycle は `takosumi_operation_journal_entries` に WAL
stage record を書きます。provider side effect 前に `prepare` / `pre-commit` /
`commit`、 成功で `post-commit` / `observe` / `finalize`、 失敗で `abort`。 同じ
`(spaceId, operationPlanDigest, journalEntryId, stage)` + 同一 effect digest の
replay は冪等、 異なる effect digest は hard-fail。

Operator implementation verification: `AppContext` は operator-provided
`kindAliases`、 provider implementations、runtime-agent connector inventory
から構成されます。WAL は provider / connector resolution input を
pre/post-commit verification として扱い ます。pre-commit 失敗は provider
呼出前に terminal `abort`。post-commit 失敗は verification failure を journal
し、committed effect に対する RevokeDebt を enqueue して observe / finalize
evidence を残します。

Compensation: runtime-agent protocol は connector-native `compensate` を持ち、
専用 operation が無い connector は handle-keyed `destroy` を fallback。
RevokeDebt store は retry attempt / policy-controlled aging / manual reopen /
clearance を実装。 cleanup worker (`takosumi-worker` role daemon) が open debt
owner Space を周期列挙し、 Deployment record から handle を解決して provider
compensate / destroy fallback を呼び、 成功時に debt を `cleared` に進めます。

Fail-closed の precondition: 最新 WAL が terminal でない Installation への新規
apply / rollback は拒否します (provider 呼出なし、 WAL entry 追加なし)。
recovery は internal lifecycle orchestration で駆動:

- `inspect`: persist 済 WAL entries と latest stage summary を返す
- `continue`: AppSpec / mode から再現した OperationPlan digest が一致する場合
  のみ provider fencing token 付きで replay。 不一致は fail-closed
- `compensate`: `commit` 未到達の WAL は provider を呼ばず terminal `abort` に
  進める。`commit` 以降に到達した WAL は `activation-rollback` RevokeDebt を
  enqueue し、cleanup worker が connector-native `compensate` または
  handle-keyed `destroy` fallback を呼ぶ

`apply` / `destroy` は lock 取得 → 実行 → release を `try { ... } finally` で
囲みます。 lock contention 時は client timeout で諦めるか、 operator が
single-writer apply tier (deploy traffic を 1 pod に固定する topology) を取り
ます。

## Lifecycle フェーズ {#lifecycle-phases}

v1 では 6 phase を 1:1 に区別します。各 phase は対応する Snapshot を入力 /
出力として動き、WAL は phase ごとに stage を進めます。

| Phase      | 入力 Snapshot                                                    | 出力 Snapshot / 副作用                                                     | 触る WAL stage                                                   |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apply`    | DesiredSnapshot                                                  | OperationPlan + ResolutionSnapshot + provider resources                    | `prepare` → `pre-commit` → `commit` → `post-commit` → `finalize` |
| `activate` | ResolutionSnapshot                                               | ActivationSnapshot / GroupHead traffic assignment + initial observation    | `post-commit` → `observe`                                        |
| `destroy`  | 現行 Deployment の recorded snapshot / evidence                  | destroy Deployment evidence + WAL cleanup result。旧 snapshot は変更しない | `pre-commit` → `commit` → `finalize`                             |
| `rollback` | 巻き戻し対象 Deployment の recorded source / snapshot / evidence | 新しい rollback Deployment。過去 snapshot は入力 evidence として使う       | `pre-commit` (compensate) → `commit` → `abort`                   |
| `recovery` | WAL 復元状態                                                     | recovery mode に応じた終端 (continue / compensate / inspect)               | (resume from last stage)                                         |
| `observe`  | live runtime-agent describe results                              | append-only ObservationSet / health evidence と RevokeDebt 候補            | `observe` (long-lived)                                           |

- installer apply endpoint の `Deployment.status: "succeeded"` は、その
  Deployment を current として使うために必要な `apply` と `activate`
  の同期部分が 完了したことを表す。`observe` worker による health
  更新はその後も継続する。
- `apply` の `prepare` で OperationPlan が確定。 idempotency key
  `(spaceId, operationPlanDigest, journalEntryId)` が各 entry に振られ、 同じ
  key の retry は副作用を増やしません。
- `activate` は traffic assignment を immutable evidence
  として記録します。health は `observe` が append-only observation
  として追記し、`healthy / degraded /
  unhealthy` を判定します。
- `destroy` は現行 Deployment の recorded evidence を authority として managed /
  generated lifecycle class object を削除します。cleanup 結果は新しい destroy
  Deployment evidence / WAL / activation state に記録し、既存
  `ResolutionSnapshot` は編集しません。external / operator / imported
  は触りません。
- `rollback` は巻き戻し対象 Deployment の source pin、snapshot、internal
  evidence から新しい rollback Deployment を作り、その Deployment を materialize
  します。過去 snapshot は入力 evidence であり、出力 identity ではありません。
- `recovery` は kernel restart 時に WAL を読み直し、 最後に記録された stage の
  **次** から resume します。
- `observe` 起動 / 維持は kernel readiness 連動。 readiness DAG が未充足の間は
  observation worker が更新せず、 `/readyz` も 503。 詳細は
  [Readiness Probes](./readiness-probes.md)。

WAL stage の意味論は
[WAL Stages — Stage closed enum](./wal-stages.md#stage-closed-enum-8-値)
に対応します
(`prepare → pre-commit → commit → post-commit → observe →
finalize`、終端
`abort / skip`)。

## Verify トリガー {#verify-trigger}

reference runtime-agent の `verify` request は lifecycle phase に含まれない
operator preflight です。WAL stage を進めず、 Snapshot を materialize せず、
connector ごとの credential / network reachability の確認だけを行います。

推奨フロー: `apply` の前に `verify` を投げて `connector_not_found` /
`connector-extended:*` を切り分けます。 kernel apply pipeline は結果を直接消費
しませんが、 operator automation が pre-flight gate として扱う運用が想定です。
`verify` で `connector_failed` を返した connector には `apply` request を送ら
ず、 OperationPlan を `prepare` で止める選択を operator が取れます。

field 仕様は
[Runtime-Agent API — `POST /v1/lifecycle/verify`](./runtime-agent-api.md#post-v1-lifecycle-verify)
参照。

## 回復モード {#recovery-modes}

kernel restart や lock 失効後に `recovery` phase が走るとき、operator は 4 つの
mode を選択します。

| Mode         | 用途                                                                                 | 終端                                                 |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `normal`     | デフォルト。WAL を読み直して `commit` 後の `post-commit` から自動 resume             | 通常 phase 終端 (`apply` / `activate` / `destroy`)   |
| `continue`   | `pre-commit` まで進んでいたが `commit` で落ちた entry を強制続行                     | `commit` → `post-commit` → 通常終端                  |
| `compensate` | `commit` 済み effect を逆再生し、target Deployment の recorded evidence に沿って戻す | `abort` (RevokeDebt が `activation-rollback` で発行) |
| `inspect`    | 何も実行せず、WAL と live state の差分だけを report                                  | (副作用なし、operator 用 dump)                       |

選択ガイド:

- 直前 phase が `apply` で WAL が `pre-commit` まで: `normal` を選ぶ。 `commit`
  retry が冪等性を保つ。
- `commit` 半ばで落ち、 外部 side effect が実行済みの可能性が高い: `continue` で
  `commit` を最後まで走らせる。
- `commit` 完了後 `post-commit` で外部依存が壊れ続けて回復見込みなし:
  `compensate` で `activation-rollback` reason の RevokeDebt を open。
- 状況不明 / 差分確認: `inspect` で journalEntryId 単位の
  `actual-effects-overflow` を確認。

`inspect` 以外の mode は WAL idempotency key により副作用を再現しないため、 同じ
mode を繰り返しても重複 effect は出ません。

実装状態:

- `inspect`: 副作用なし WAL dump。 未完了 WAL は新規 apply / destroy を block。
- `continue`: 要求 phase と OperationPlan digest が unfinished WAL と一致時の み
  resume。
- `compensate`: `commit` 未到達なら副作用なしで `abort` を追記。`commit`
  以降到達の WAL entry は `activation-rollback` RevokeDebt を open し、 cleanup
  worker が connector compensate / destroy fallback を実行。
- runtime-agent protocol は connector-native `compensate` を destroy fallback
  付きで公開。 apply rollback は provider compensate operation を優先。
- RevokeDebt store: retry attempt / policy-controlled aging / manual reopen /
  clearance / connector-backed cleanup worker / worker daemon 周期実行を実装
  済み。
- operator implementation config / provider / connector resolution は
  fail-closed な pre/post-commit verification として扱う。
- apply / destroy commit 呼出には WAL idempotency tuple が
  `PlatformContext.operation` と runtime-agent `idempotencyKey` 経由で渡る。

## クロスリファレンス {#cross-references}

- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Closed Enums](./closed-enums.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Runtime-Agent API](./runtime-agent-api.md)
- [Readiness Probes](./readiness-probes.md)
- [Cross-Process Locks](./cross-process-locks.md)

## 関連ページ

- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Approval Invalidation](./approval-invalidation.md)
