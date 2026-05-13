# WAL Stages

> このページでわかること: WAL の各ステージとステート遷移。

Takosumi v1 の WriteAheadOperationJournal (WAL) における stage closed enum、
idempotency key の構造、replay rule、および pre/post-commit verification
lifecycle を まとめる reference です。kernel apply pipeline の各 phase
は本ページの stage を駆動し、recovery / approval invalidation / RevokeDebt
生成は本ページの 規則に従います。

## Stage closed enum (8 値)

WAL stage は 8 値の closed enum です。新 stage 追加は `CONVENTIONS.md` §6 RFC
を要します。

| Stage         | actual-effects 書き込み | RevokeDebt キュー | approval re-validation     | 失敗時の遷移先                      |
| ------------- | ----------------------- | ----------------- | -------------------------- | ----------------------------------- |
| `prepare`     | no                      | no                | yes (entry 起動時)         | `abort`                             |
| `pre-commit`  | no                      | no                | yes (catalog verification) | `abort`                             |
| `commit`      | yes                     | no                | no                         | `abort` / `commit` retry            |
| `post-commit` | yes (補助 effect)       | yes               | no                         | `observe` 続行 / RevokeDebt enqueue |
| `observe`     | no (read-only)          | yes               | no                         | `finalize` / `observe` 継続         |
| `finalize`    | no (cleanup のみ)       | yes (cleanup 残)  | no                         | terminal                            |
| `abort`       | no                      | yes (compensate)  | no                         | terminal                            |
| `skip`        | no                      | no                | no                         | terminal                            |

stage の意味:

- `prepare`: OperationPlan を確定し、idempotency key を割り当て、approval
  binding を再評価する。actual-effects は書かない。失敗時は `abort`。
- `pre-commit`: catalog / provider verification を実行し、external precondition
  (credential reachability、collision check、freshness re-confirm) を
  fail-closed で確認する。actual-effects は書かない。失敗時は `abort`。
- `commit`: connector / runtime-agent 経由で external system を実際に変更する。
  actual-effects はこの stage でのみ書き込む。retry は idempotency key 一致を
  前提に冪等。回復不能な失敗は `abort`。
- `post-commit`: commit 後の補助 effect (link projection、metadata sync、
  generated material の materialize) を行う。external 失敗が発生した場合は
  RevokeDebt を `external-revoke` / `link-revoke` reason で enqueue する。
- `observe`: long-lived な read-only stage。runtime-agent describe を吸い、
  Exposure health / DriftIndex / RevokeDebt 候補を更新する。stage 自身は
  actual-effects を変更しない。
- `finalize`: managed / generated lifecycle class の cleanup を完了させる。
  external / operator / imported は触らない。cleanup できなかった generated
  material は RevokeDebt に残る。
- `abort`: rollback / compensate 後の terminal stage。`commit` 済み effect の
  逆再生で残った debt は `activation-rollback` reason で enqueue。
- `skip`: 当該 entry を no-op として確定する terminal stage。前段 stage で
  approval が `invalidated` に落ちた場合や、recovery `inspect` mode 終了時に
  使う。

## Stage 進行図

```
                       +-----------+
                       | prepare   |
                       +-----+-----+
                             |
                             v
                       +-----+-----+
                       | pre-commit|
                       +--+---+----+
                          |   |
                fail      |   | ok
                          v   v
                    +-----+   +------+
                    |abort|   |commit|
                    +--+--+   +--+---+
                       ^         |
                       |         v
                       |   +-----+------+
                       |   | post-commit|
                       |   +-----+------+
                       |         |
                       |         v
                       |   +-----+----+
                       |   | observe  |  (long-lived)
                       |   +-----+----+
                       |         |
                       |         v
                       |   +-----+----+
                       +---+ finalize |
                           +----------+

skip は任意 stage の代替 terminal として記録される。
```

`recovery` phase は最後に記録された stage の **次** から再開する。`commit`
半ばで落ちた entry は `commit` retry から、`post-commit` で落ちた entry は
`post-commit` retry から resume する。

## Idempotency key

WAL の各 entry は以下の tuple で一意に識別される。

```
(spaceId, operationPlanDigest, journalEntryId)
```

- `spaceId`: entry を所有する Space ID。Cross-Space で同じ tuple は出現しない。
- `operationPlanDigest`: prepare stage で確定した OperationPlan の content
  digest。OperationPlan が変われば必ず異なる値になる。
- `journalEntryId`: OperationPlan 内の entry を識別する ULID。kernel が prepare
  時に発行し、retry 中も保持する。

生成 timing は **prepare stage の最初の WAL append**。同じ entry が retry
された場合、kernel は同じ `journalEntryId` を再利用し、新規 ULID を発行しない。

Collision policy: tuple は kernel storage 上で primary key として強制される。
同じ tuple を異なる effect digest で書き込もうとすると hard-fail (詳細は replay
rule §)。

## Replay rule

stage retry / recovery / 同一 OperationPlan の再 apply で WAL を読み直す
ときの規則:

1. **同じ tuple、同じ effect digest** → idempotent re-apply。actual-effects
   は重複登録されず、entry は最後に到達した stage を保つ。
2. **同じ tuple、異なる effect digest** → hard-fail。kernel は
   `failed_precondition` で reject し、新規 OperationPlan の resolve を operator
   に要求する (ResolutionSnapshot が変わると `operationPlanDigest` も変わるため
   tuple が一致しなくなる、という invariant に依拠)。
3. **tuple 一部欠損** (例: WAL header が読めるが entry body が破損) → recovery
   mode 経由でしか進行できない。`normal` / `continue` / `compensate` / `inspect`
   の選択は
   [Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes)
   を参照。

`actual-effects-overflow` Risk が発火している entry は、replay 時に必ず
`inspect` mode で確認してから他 mode に進める。`continue` で先に進める前に
overflow の origin connector を operator が手動で resolve する必要がある。

Public deploy route の v1 `continue` は、requested phase と
`operationPlanDigest` が unfinished WAL と一致する場合だけ同じ OperationPlan を
再実行する。これにより `(spaceId, operationPlanDigest, journalEntryId)` 由来の
idempotency tuple が変わらず、runtime-agent / connector に渡る external request
token も同じになる。digest が変わる manifest は recovery ではなく新しい intent
なので `failed_precondition` で拒否される。

Public deploy route の v1 `compensate` は、同じ digest / phase の unfinished WAL
が `commit` / `post-commit` / `observe` まで進んでいる場合だけ terminal `abort`
を追記し、各 OperationPlan entry に対して `activation-rollback` RevokeDebt を
enqueue する。`prepare` / `pre-commit` だけの WAL は actual effect が無いため
compensate 対象ではなく `failed_precondition` になる。

## Public deploy provenance

`POST /v1/deployments` は upstream client から top-level `provenance` を受け
取ることがあります。 kernel はこの値を opaque JSON として扱い、 workflow を
実行したり build log を parse したり git field を解釈したりはせず、 WAL evidence
として永続化します。

- public WAL の effect detail には `provenance` object 全体を含める
- 解決後の resource には `metadata.takosumiDeployProvenance` を付け、
  `kind: "takosumi.deploy-provenance-digest@v1"` と provenance digest を記録
- 当該 metadata は public OperationPlan digest に参加する。 同じ manifest body
  でも artifact provenance が違えば別 operation intent になる
- status / recovery inspect の response から audit consumer に記録済 provenance
  を返せる

これにより `takosumi-git` のような client は、 artifact URI -> workflow run id
-> git commit SHA -> step log digest の traceability を kernel に workflow
を持ち込まずに永続化できます。

## Pre/post-commit verification lifecycle

kernel contract には catalog 供給の実行可能 hook package runtime はありませ ん。
WAL stage は kernel が所有する validation / evidence collection を含む
ことがありますが、 marketplace hook code を load したり、 汎用の `pre-commit` /
`post-commit` hook 実行を公開拡張点として露出したりはしません。

hook 的挙動が必要な workflow / repository automation は `takosumi-git` など
の上流 product 側で行い、 compile 済 Shape manifest を `POST /v1/deployments`
に送る前に検査を済ませる前提です。

`prepare` 詳細には manifest provenance、 resource operation plan、 kernel
validation evidence のみが含まれます。

## Orphaned debt 経路

WAL stage が actual-effects を書いた後で外部依存が壊れると、kernel は RevokeDebt
entry を生成する。発生条件:

- `post-commit` 中: link projection / metadata sync が回復不能に失敗 →
  `link-revoke` reason で enqueue。
- `observe` 中: 既に commit 済み external object が外部から revoke された /
  消失した → `external-revoke` reason で enqueue。
- `abort` 経路 (compensate recovery): `commit` 済み effect の逆再生でつぶし
  きれなかった generated material → `activation-rollback` reason で enqueue。
- `finalize` 中: managed / generated cleanup が permanent fail → 該当 reason で
  enqueue。

RevokeDebt の reason / status / aging window は
[RevokeDebt Model](/reference/revoke-debt) を参照。WAL stage 側からは RevokeDebt
を **enqueue する責務** だけを持ち、retry / aging の semantics は RevokeDebt
subsystem に委ねる。

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  WAL stage 設計 の動機、idempotency tuple の derivation、catalog verification
  contract の議論
- `docs/reference/architecture/execution-lifecycle.md` — phase ↔ stage
  マッピングの設計 rationale と recovery mode の選定背景
- `docs/reference/architecture/observation-drift-revokedebt-model.md` — orphaned
  debt の taxonomy と observe 経路の設計議論

## 関連ページ

- [Lifecycle Protocol](/reference/lifecycle)
- [Approval Invalidation Triggers](/reference/approval-invalidation)
- [RevokeDebt Model](/reference/revoke-debt)
