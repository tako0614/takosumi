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

CatalogRelease verification: publisher key enrollment / 署名検証 / Space
adoption record / rotation audit は registry domain primitive として実装済み。
`AppContext` 構成時、 WAL は adopted CatalogRelease を pre/post-commit
verification として呼びます。 pre-commit 失敗は provider 呼出前に terminal
`abort`。 post-commit 失敗は verification failure を journal し、 committed
effect に対する RevokeDebt を enqueue して observe / finalize evidence を残し
ます。

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
- `compensate`: 同 digest / phase かつ `commit` 以降に到達した WAL を terminal
  `abort` に進め、 provider を呼ばずに `activation-rollback` RevokeDebt を
  enqueue

`apply` / `destroy` は lock 取得 → 実行 → release を `try { ... } finally` で
囲みます。 lock contention 時は client timeout で諦めるか、 operator が
single-writer apply tier (deploy traffic を 1 pod に固定する topology) を取り
ます。

## Lifecycle フェーズ {#lifecycle-phases}

v1 では 6 phase を 1:1 に区別します。各 phase は対応する Snapshot を入力 /
出力として動き、WAL は phase ごとに stage を進めます。

| Phase      | 入力 Snapshot                       | 出力 Snapshot / 副作用                                                | 触る WAL stage                                 |
| ---------- | ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `apply`    | DesiredSnapshot                     | OperationPlan + ResolutionSnapshot                                    | `prepare` → `pre-commit` → `commit`            |
| `activate` | ResolutionSnapshot                  | post-activate Exposure health (`unknown / observing`)                 | `commit` → `post-commit`                       |
| `destroy`  | ResolutionSnapshot                  | DesiredSnapshot 上で managed/generated を削除しきった状態             | `pre-commit` → `commit` → `finalize`           |
| `rollback` | 直前 ResolutionSnapshot             | prior ResolutionSnapshot を再 materialize したスナップショット        | `pre-commit` (compensate) → `commit` → `abort` |
| `recovery` | WAL 復元状態                        | recovery mode に応じた終端 (continue / compensate / inspect)          | (resume from last stage)                       |
| `observe`  | live runtime-agent describe results | Exposure health (`healthy / degraded / unhealthy`) と RevokeDebt 候補 | `observe` (long-lived)                         |

- `apply` の `prepare` で OperationPlan が確定。 idempotency key
  `(spaceId, operationPlanDigest, journalEntryId)` が各 entry に振られ、 同じ
  key の retry は副作用を増やしません。
- `activate` 直後の Exposure health は `unknown` で始まり、 `observe` 進行で
  `observing → healthy / degraded / unhealthy` へ遷移します。
- `destroy` は `finalize` で managed / generated lifecycle class object を完全
  削除。 external / operator / imported は触りません。
- `rollback` は `compensate` operation を `pre-commit` で起動して `abort` 終端
  へ進みます。
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

`POST /v1/lifecycle/verify` は lifecycle phase に含まれない補助 trigger です。
WAL stage を進めず、 Snapshot を materialize せず、 connector ごとの credential
/ network reachability の確認だけを行います。

推奨フロー: `apply` の前に `verify` を投げて `connector_not_found` /
`connector-extended:*` を切り分けます。 kernel apply pipeline は結果を直接消費
しませんが、 operator automation が pre-flight gate として扱う運用が想定です。
`verify` で `connector_failed` を返した connector には `apply` request を送ら
ず、 OperationPlan を `prepare` で止める選択を operator が取れます。

field 仕様は
[Runtime-Agent API — `POST /v1/lifecycle/verify`](./runtime-agent-api.md#post-v1lifecycleverify)
参照。

## 回復モード {#recovery-modes}

kernel restart や lock 失効後に `recovery` phase が走るとき、operator は 4 つの
mode を選択します。

| Mode         | 用途                                                                     | 終端                                                 |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `normal`     | デフォルト。WAL を読み直して `commit` 後の `post-commit` から自動 resume | 通常 phase 終端 (`apply` / `activate` / `destroy`)   |
| `continue`   | `pre-commit` まで進んでいたが `commit` で落ちた entry を強制続行         | `commit` → `post-commit` → 通常終端                  |
| `compensate` | `commit` 済み effect を逆再生し、prior ResolutionSnapshot に戻す         | `abort` (RevokeDebt が `activation-rollback` で発行) |
| `inspect`    | 何も実行せず、WAL と live state の差分だけを report                      | (副作用なし、operator 用 dump)                       |

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
- `compensate`: `commit` 以降到達の WAL entry に `activation-rollback`
  RevokeDebt を open し `abort` を追記。
- runtime-agent protocol は connector-native `compensate` を destroy fallback
  付きで公開。 apply rollback は provider compensate operation を優先。
- RevokeDebt store: retry attempt / policy-controlled aging / manual reopen /
  clearance / connector-backed cleanup worker / worker daemon 周期実行を実装
  済み。
- CatalogRelease adoption / 署名検証は registry domain に実装。 WAL は adopted
  release を fail-closed な pre/post-commit verification として呼ぶ。
- apply / destroy commit 呼出には WAL idempotency tuple が
  `PlatformContext.operation` と runtime-agent `idempotencyKey` 経由で渡る。

## クロスリファレンス {#cross-references}

- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Closed Enums](./closed-enums.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Runtime-Agent API](./runtime-agent-api.md)
- [Readiness Probes](./readiness-probes.md)
- [Cross-Process Locks](./cross-process-locks.md)

## 関連ページ

- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Approval Invalidation](./approval-invalidation.md)
