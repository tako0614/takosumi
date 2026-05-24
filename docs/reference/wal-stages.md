# WAL Stages

> このページでわかること: WriteAheadOperationJournal の 8 stage / idempotency
> key / replay rule。

apply pipeline の各 phase は本ページの stage を駆動し、 recovery / approval
invalidation / RevokeDebt 生成は本ページの規則に従います。

## Stage closed enum (8 値)

新 stage 追加は `CONVENTIONS.md` §6 RFC が必要です。

| Stage         | actual-effects 書き込み         | RevokeDebt キュー | approval re-validation                  | 失敗時の遷移先                      |
| ------------- | ------------------------------- | ----------------- | --------------------------------------- | ----------------------------------- |
| `prepare`     | no                              | no                | yes (entry 起動時)                      | `abort`                             |
| `pre-commit`  | no                              | no                | yes (provider / connector verification) | `abort`                             |
| `commit`      | yes                             | no                | no                                      | `abort` / `commit` retry            |
| `post-commit` | no (evidence / projection only) | yes               | no                                      | `observe` 続行 / RevokeDebt enqueue |
| `observe`     | no (read-only)                  | yes               | no                                      | `finalize` / `observe` 継続         |
| `finalize`    | no (cleanup のみ)               | yes (cleanup 残)  | no                                      | terminal                            |
| `abort`       | no                              | yes (compensate)  | no                                      | terminal                            |
| `skip`        | no                              | no                | no                                      | terminal                            |

stage 意味:

- `prepare`: OperationPlan 確定 / idempotency key 割当 / approval binding 再評
  価。 actual-effects 書込なし。 失敗は `abort`。
- `pre-commit`: provider / connector verification と external precondition
  (credential reachability / collision check / freshness re-confirm) を
  fail-closed で確認。 actual-effects 書込なし。 失敗は `abort`。
- `commit`: connector / runtime-agent 経由で external system を実際に変更。
  actual-effects はこの stage のみで書込。 retry は idempotency key 一致前提で
  冪等。 回復不能失敗は `abort`。
- `post-commit`: commit 後の evidence / projection / metadata sync を記録する。
  provider side effect は新規に実行しない。 external cleanup
  が完了できないときは RevokeDebt を `external-revoke` / `link-revoke` reason で
  enqueue。
- `observe`: long-lived な read-only stage。 runtime-agent describe を吸って
  health observation / DriftIndex / RevokeDebt 候補を更新。 stage 自身は
  actual-effects を変更しません。
- `finalize`: managed / generated lifecycle class の cleanup 完了。 external /
  operator / imported は触らず、 cleanup 不能な generated material は RevokeDebt
  に残します。
- `abort`: rollback / compensate 後の terminal。 `commit` 済 effect の逆再生で
  残った debt は `activation-rollback` reason で enqueue。
- `skip`: entry を no-op 確定する terminal。 approval が `invalidated` に落ち
  た場合や recovery `inspect` mode 終了時に使用。

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

`recovery` phase は最後に記録された stage の **次** から再開します。 `commit`
半ばで落ちた entry は `commit` retry から、 `post-commit` で落ちた entry は
`post-commit` retry から resume します。

## Idempotency key

WAL の各 entry は次の tuple で一意識別:

```
(spaceId, operationPlanDigest, journalEntryId)
```

- `spaceId`: entry 所有 Space ID。 Cross-Space で同 tuple は出現しません。
- `operationPlanDigest`: prepare stage で確定した OperationPlan content digest。
  OperationPlan が変われば必ず別値。
- `journalEntryId`: OperationPlan 内 entry を識別する ULID。 kernel が prepare
  時に発行し、 retry 中も保持。

生成 timing は prepare stage の最初の WAL append。 retry でも同じ
`journalEntryId` を再利用し、 新規 ULID は発行しません。

Collision policy: tuple は storage 上で primary key として強制。 同じ tuple を
異なる effect digest で書こうとすると hard-fail (Replay rule §)。

## Replay rule

WAL を読み直すときの規則:

1. 同じ tuple + 同じ effect digest → idempotent re-apply。 actual-effects は
   重複せず、 entry は最後に到達した stage を保つ
2. 同じ tuple + 異なる effect digest → hard-fail。 kernel は
   `failed_precondition` で reject (ResolutionSnapshot 変化で
   `operationPlanDigest` も変わる invariant に依拠)
3. tuple 一部欠損 (例: WAL header は読めるが entry body 破損) → recovery mode
   経由でしか進行不可。 mode 選択は
   [Recovery modes](./lifecycle.md#recovery-modes) 参照

`actual-effects-overflow` Risk 発火 entry は replay 時必ず `inspect` mode で
確認してから他 mode に進めます。 `continue` で進める前に overflow の origin
connector を operator が手動 resolve する必要があります。

Public deploy route v1:

- `continue`: requested phase と `operationPlanDigest` が unfinished WAL と
  一致時のみ同 OperationPlan を再実行。 idempotency tuple が変わらず外部 request
  token も同じ。 digest 変化は recovery ではなく新 intent として
  `failed_precondition`
- `compensate`: 同 digest / phase の unfinished WAL が `commit` / `post-commit`
  / `observe` まで進んでいる場合のみ terminal `abort` を追記し、 各
  OperationPlan entry に `activation-rollback` RevokeDebt を enqueue。 `prepare`
  / `pre-commit` だけの WAL は actual effect が無いため compensate 対象外で
  `failed_precondition`

## Deployment provenance

operator automation may supply source / provenance evidence to the reference
kernel. kernel は opaque JSON として internal Deployment / WAL evidence に永続化
し、workflow 実行 / build log parse / git field 解釈は行いません。この evidence
は public Installer API の必須 field ではありません。

- WAL evidence に provenance object または `provenanceDigest` を含められる
- operator が provenance を operation identity に含めたい場合は
  `operationPlanDigest` の入力 evidence として記録する
- status / recovery inspect response は audit consumer 向けに記録済 provenance
  digest を返せる

これで upstream automation は prepared source digest → workflow run id → git
commit SHA → step log digest の traceability を、kernel に workflow を持ち込
まずに永続化できます。

## Pre/post-commit verification lifecycle {#prepost-commit-verification-lifecycle}

WAL stage は kernel 所有の validation / evidence collection を含みます。汎用の
`pre-commit` / `post-commit` hook 的挙動は upstream product / repository
automation に置きます。

hook 的挙動が必要な workflow / repository automation は上流 product 側で行い、
installer API に source を渡す前に検査を済ませる前提です。

`prepare` 詳細には AppSpec provenance / resource operation plan / kernel
validation evidence のみが含まれます。

## Orphaned debt 経路

WAL stage が actual-effects を書いた後で外部依存が壊れると、 kernel は
RevokeDebt entry を生成します。 発生条件:

- `post-commit` 中: link projection / metadata sync が回復不能失敗 →
  `link-revoke`
- `observe` 中: commit 済 external object が外部 revoke / 消失 →
  `external-revoke`
- `abort` 経路 (compensate recovery): `commit` 済 effect の逆再生で残った
  generated material → `activation-rollback`
- `finalize` 中: managed / generated cleanup が permanent fail → 該当 reason

reason / status / aging は [RevokeDebt Model](./revoke-debt.md) 参照。 WAL stage
側は enqueue 責務のみで、 retry / aging semantics は RevokeDebt subsystem
に委ねます。

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — WAL stage 設計 の動機、idempotency tuple の derivation、descriptor
  verification contract の議論
- `docs/reference/architecture/execution-lifecycle.md` — phase ↔ stage
  マッピングの設計 rationale と recovery mode の選定背景
- `docs/reference/drift-detection.md` — orphaned debt と observe 経路の設計議論

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [RevokeDebt Model](./revoke-debt.md)
