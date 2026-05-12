# Lifecycle Protocol

> Stability: stable Audience: operator, kernel-implementer See also:
> [Lifecycle Phases](/reference/lifecycle-phases),
> [WAL Stages](/reference/wal-stages),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Approval Invalidation](/reference/approval-invalidation)

Takosumi の deployment lifecycle
(`apply / activate / destroy / rollback /
recovery / observe`) を、kernel apply
pipeline と runtime-agent dispatch の 両側から v1 確定形で整理する reference
です。phase ごとの input / output snapshot・WAL stage
対応・失敗時挙動・`LifecycleStatus` 5 値の trigger 別遷移は
[Lifecycle Phases](/reference/lifecycle-phases) を参照してください。 WAL stage
の意味論は [WAL Stages](/reference/wal-stages)、approval 失効規則は
[Approval Invalidation Triggers](/reference/approval-invalidation) を
参照してください。

## Cross-process lock

**Production 配置では SQL-backed `OperationPlanLockStore` の使用が必須です。**
in-memory store は dev / unit test 専用で、複数 kernel pod が走る環境では lock
を保証できません。

- 同一 OperationPlan に対する `apply / activate / destroy / rollback` は
  `(spaceId, operationPlanDigest)` を key として **直列化** されます。
- Lock holder が異常終了した場合、SQL-backed store は heartbeat の TTL で
  自動失効します。失効した lock を取り直した kernel は WAL を `recovery` phase
  経由で復帰させます。
- in-memory store は単一プロセス内の per-key Promise chain しか持たず、
  cross-process では race を起こします。production 配置で in-memory store を
  inject すると、kernel boot 時に warning を出すよう実装されています
  が、**warning を見て operator が SQL-backed に差し替える運用が前提** です。

現在の public deploy route (`POST /v1/deployments`) は `takosumi_deploy_locks`
の SQL lease を使い、scope `(tenantId, deploymentName)` で同じ deployment への
apply / destroy を複数 kernel pod 間で直列化します。この route は busy
を即時返却せず、lease が空くまで wait します。

public deploy の apply / destroy は、公開 OperationPlan preview から導出した
`takosumi_operation_journal_entries` に WAL stage record を書きます。 `prepare`
/ `pre-commit` / `commit` は provider side effect の前に記録され、 成功時は
`post-commit` / `observe` / `finalize`、失敗時は `abort` が追記されます。 同じ
`(spaceId, operationPlanDigest, journalEntryId, stage)` に対する同一 effect
digest の replay は冪等で、異なる effect digest は hard-fail します。

CatalogRelease の publisher key enrollment、署名検証、Space adoption record、
rotation audit は registry domain primitive として実装済みです。public route の
WAL は `AppContext` から構成された場合、adopted CatalogRelease を
pre/post-commit verification として呼びます。pre-commit verification failure は
provider side effect 前に terminal `abort` へ進み、post-commit verification
failure は verification failure を journal し、committed effect に対する
RevokeDebt を enqueue して observe / finalize evidence を残します。runtime-agent
protocol には connector-native `compensate` operation があり、専用 operation
を持たない connector は handle-keyed `destroy` を compensation fallback
とします。RevokeDebt store には retry attempt、 policy-controlled aging、manual
reopen / clearance の lifecycle primitive が実装 されています。connector-backed
RevokeDebt cleanup worker は deployment record から handle を解決して provider
compensate / destroy fallback を呼び、成功時に debt を `cleared`
へ進めます。この cleanup worker は `takosumi-worker` role の daemon task として
open debt owner Space を列挙して周期実行されます。

public deploy route は latest WAL が terminal (`finalize` / `abort` / `skip`)
でない deployment に対する新しい `apply` / `destroy` を fail-closed
で拒否します。 この場合 provider は呼ばれず、新しい WAL entry
も書かれません。operator は同じ `POST /v1/deployments` に
`recoveryMode: "inspect"` を付けて、persist 済み public WAL entries と latest
stage summary を取得します。同じ manifest / mode から同じ OperationPlan digest
を再現できる場合のみ、`recoveryMode: "continue"` は provider fencing token
付きで同じ OperationPlan を再実行します。digest / phase が一致しない場合は
fail-closed です。`recoveryMode: "compensate"` は同じ digest / phase かつ
`commit` 以降に到達した WAL だけを terminal `abort` に進め、provider を呼ばずに
`activation-rollback` RevokeDebt を enqueue します。

`apply` / `destroy` は lock 取得 → 実行 → release を `try { ... } finally`
で囲みます。lock contention 時は client 側 timeout で諦めるか、operator
側で「single-writer apply tier」（deploy 系 traffic を 1 pod に固定する
deployment topology）を取るかのどちらかを選択します。

## Lifecycle phases

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

- `apply` の `prepare` で OperationPlan が確定し、Idempotency key
  `(spaceId, operationPlanDigest, journalEntryId)` が WAL の各 entry に
  振られます。同じ key の retry は副作用を増やしません。
- `activate` 直後の Exposure health は `unknown` から始まり、`observe` phase
  が回るにつれて `observing → healthy / degraded / unhealthy` へ 遷移します。
- `destroy` は `finalize` stage で managed / generated lifecycle class の object
  を完全に消し、external / operator / imported は触りません。
- `rollback` は WAL の `commit` 済み effect を逆再生するため `compensate`
  operation を `pre-commit` で起動した上で `abort` 終端に進みます。
- `recovery` は kernel restart 時に WAL を読み直して再開します。最後に
  記録された stage の **次** から resume します。
- `observe` phase の起動 / 維持は kernel readiness と連動します。kernel pod の
  readiness DAG (storage / lock store / runtime-agent registry など) が
  満たされていない間は observation worker が観測値を更新せず、`/readyz` も 503
  を返します。詳細は [Readiness Probes](/reference/readiness-probes)
  を参照してください。

WAL stage の意味論は
[WAL Stages — Stage closed enum](/reference/wal-stages#stage-closed-enum-8-値)
に対応します
(`prepare → pre-commit → commit → post-commit → observe →
finalize`、終端
`abort / skip`)。

## Verify trigger

runtime-agent の `POST /v1/lifecycle/verify` は本 reference の lifecycle phase
と以下のように対応します:

- `verify` は **どの phase にも含まれない補助 trigger** です。WAL stage を
  進めず、Snapshot を materialize せず、connector ごとの credential / network
  reachability を確認するためだけに動きます。
- `apply` の前に operator が `verify` を投げて `connector_not_found` /
  `connector-extended:*` を切り分けるのが推奨フローです。kernel apply pipeline
  は `verify` の結果を直接消費しませんが、operator dashboard が `verify` 結果を
  `pre-flight gate` として扱う運用が想定されています。
- `verify` 中に connector が `connector_failed` を返した場合、kernel は 当該
  connector に対する `apply` request を **送らず**、operator が 対処するまで
  OperationPlan を `prepare` から先に進めない選択を取れます。

`verify` request / response の field 仕様は
[Runtime-Agent API — `POST /v1/lifecycle/verify`](/reference/runtime-agent-api#post-v1lifecycleverify)
を参照してください。

## Recovery modes

kernel restart や lock 失効後に `recovery` phase が走るとき、operator は 4 つの
mode を選択します。

| Mode         | 用途                                                                     | 終端                                                 |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `normal`     | デフォルト。WAL を読み直して `commit` 後の `post-commit` から自動 resume | 通常 phase 終端 (`apply` / `activate` / `destroy`)   |
| `continue`   | `pre-commit` まで進んでいたが `commit` で落ちた entry を強制続行         | `commit` → `post-commit` → 通常終端                  |
| `compensate` | `commit` 済み effect を逆再生し、prior ResolutionSnapshot に戻す         | `abort` (RevokeDebt が `activation-rollback` で発行) |
| `inspect`    | 何も実行せず、WAL と live state の差分だけを report                      | (副作用なし、operator 用 dump)                       |

選択ガイド:

- 直前 phase が `apply` で WAL が `pre-commit` まで進んでいる: `normal` を
  選ぶ。`commit` の retry が冪等性を保つ。
- 直前 phase が `commit` 半ばで落ち、外部 side effect (cloud API call) が
  実行済みの可能性が高い: `continue` で `commit` を最後まで走らせる。
- `commit` まで終わったが `post-commit` で外部依存が壊れ続けて回復見込みが ない:
  `compensate` を選び、`activation-rollback` reason の RevokeDebt を open v1 の
  recovery mode では扱わない。
- 状況不明 / 復旧前にまず差分を見たい: `inspect` を選び、WAL の journalEntryId
  単位で `actual-effects-overflow` の有無を確認する。

`inspect` 以外の mode は WAL の **idempotency key** に基づいて副作用を再現
しないように動作するため、同じ mode を繰り返し起動しても重複 effect は
発生しません。

Current public deploy implementation status: `recoveryMode: "inspect"` is
implemented as a side-effect-free WAL dump, unfinished WAL entries block new
apply / destroy requests, and `recoveryMode: "continue"` resumes only when the
requested phase and OperationPlan digest match the unfinished WAL.
`recoveryMode: "compensate"` is implemented for public WAL entries that reached
`commit` or later by opening `activation-rollback` RevokeDebt and appending
`abort`. Runtime-agent protocol exposes connector-native `compensate` with
destroy fallback, and apply rollback uses a provider compensate operation when
available. RevokeDebt store-level retry attempt, policy-controlled aging, manual
reopen, clearance transitions, connector-backed cleanup worker, and worker
daemon scheduling are implemented. CatalogRelease adoption / signature
verification is implemented in the registry domain, and public apply / destroy
WAL invokes the adopted release as fail-closed pre/post-commit verification.
Apply / destroy commit calls receive the WAL idempotency tuple through
`PlatformContext.operation` and runtime-agent lifecycle `idempotencyKey`.

## Cross-references

- [Lifecycle Phases](/reference/lifecycle-phases)
- [WAL Stages](/reference/wal-stages)
- [Approval Invalidation Triggers](/reference/approval-invalidation)
- [RevokeDebt Model](/reference/revoke-debt)
- [Closed Enums](/reference/closed-enums)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Runtime-Agent API](/reference/runtime-agent-api)
- [Readiness Probes](/reference/readiness-probes)
- [Cross-Process Locks](/reference/cross-process-locks)
