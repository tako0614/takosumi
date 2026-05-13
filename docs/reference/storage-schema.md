# Storage Schema

> このページでわかること: kernel storage のスキーマ定義。

Takosumi kernel が永続化する record の論理 wire schema を定義します。 SQL dump
や column 単位 DDL ではなく、 各 record class を relational table / key-value
engine / log-structured store のいずれで保持しても構いません。 他 record
から導出可能な field は実装側で省略 persist できます。

schema は record class として表現し、 必須 / optional field、 primitive 型、
永続化のセマンティクス、 immutability rule を持ちます。 field が別 record
を参照する場合は識別子参照で、 由来 snapshot と read consistent と
なるよう読みます。

primitive 型:

- `string`: UTF-8 文字列。 field ごとの上限は inline で記述
- `sha256`: `sha256:` プレフィックス付き小文字 hex digest
- `timestamp`: RFC 3339 UTC、 ミリ秒精度
- `enum`: inline 宣言の閉じた文字列 enum
- `array<T>`: 内部型 T を持つ順序付き列
- `digest`: opaque な content-addressed 識別子。 v1 では常に sha256

## Relationship overview

```text
             +----------------------+
             | ResolutionSnapshot   |
             +----------+-----------+
                        |
                        v
             +----------------------+
             | DesiredSnapshot      |
             +----------+-----------+
                        |
           +------------+------------+
           v                         v
+----------------------+  +----------------------+
| OperationPlan        |  | Approval             |
+----------+-----------+  +----------+-----------+
           |                         |
           v                         |
+----------------------+             |
| JournalEntry (WAL)   |<------------+
+----------+-----------+
           |
           v
+----------------------+
| ActivationSnapshot   |
+----------+-----------+
           |
           v
+----------------------+    +----------------------+
| ObservationSet       |--->| DriftIndex           |
+----------------------+    +----------+-----------+
                                       |
                                       v
                            +----------------------+
                            | RevokeDebt           |
                            +----------------------+
```

## ResolutionSnapshot

deploy 時点で解決された manifest 世界を記録する。

| Field               | Type            | Required | Notes                                                      |
| ------------------- | --------------- | -------- | ---------------------------------------------------------- |
| `id`                | string          | yes      | Snapshot 識別子。 immutable。                              |
| `spaceId`           | string          | yes      | 所属 Space。                                               |
| `manifestDigest`    | sha256          | yes      | canonical manifest bytes の digest。                       |
| `catalogReleaseId`  | string          | yes      | resolve 時点で adopt された catalog release。              |
| `exportSnapshotIds` | `array<string>` | yes      | この resolution が参照する自 Space export の Snapshot 群。 |
| `recordedAt`        | timestamp       | yes      | resolve 時刻。                                             |

Persistence: 本 snapshot を参照する DesiredSnapshot が replay 可能な間は保持。
`(spaceId, recordedAt)` で index。

Immutability: ResolutionSnapshot は immutable。 異なる catalog release または
import set に対して replay すると新しい snapshot が生まれる。

## DesiredSnapshot

deploy 対象の component / link / exposure / data-asset グラフの desired 状態を
記録する。

| Field                  | Type            | Required | Notes                               |
| ---------------------- | --------------- | -------- | ----------------------------------- |
| `id`                   | string          | yes      | Snapshot 識別子。                   |
| `resolutionSnapshotId` | string          | yes      | 由来 ResolutionSnapshot。           |
| `spaceId`              | string          | yes      | 所属 Space。                        |
| `desiredGeneration`    | integer         | yes      | Space ごとに monotonic な世代番号。 |
| `components`           | `array<object>` | yes      | 解決済 component record 群。        |
| `links`                | `array<object>` | yes      | 解決済 link record 群。             |
| `exposures`            | `array<object>` | yes      | 解決済 exposure record 群。         |
| `dataAssets`           | `array<object>` | yes      | 解決済 DataAsset binding 群。       |
| `createdAt`            | timestamp       | yes      | snapshot 作成時刻。                 |

Persistence: 本 DesiredSnapshot を参照する OperationPlan または
ActivationSnapshot がある間は保持。 `(spaceId, desiredGeneration)` で index。

Immutability: DesiredSnapshot は immutable。

## OperationPlan

DesiredSnapshot のペア (現在の activation / target desired) から導出される。
OperationPlan は authoritative state ではなく、 参照先の snapshot 群から再計算
可能なものである。

| Field               | Type            | Required | Notes                            |
| ------------------- | --------------- | -------- | -------------------------------- |
| `id`                | string          | yes      | Plan 識別子。                    |
| `desiredSnapshotId` | string          | yes      | target の DesiredSnapshot。      |
| `spaceId`           | string          | yes      | 所属 Space。                     |
| `operations`        | `array<object>` | yes      | 順序付き Operation record 列。   |
| `planDigest`        | sha256          | yes      | canonical plan bytes の digest。 |
| `createdAt`         | timestamp       | yes      | plan 作成時刻。                  |

Persistence: `planDigest` を参照する JournalEntry stream が replay 可能な間は
保持。 journal が完全に完了し次の plan に置換された時点で plan 本体を破棄して
よい。 `(spaceId, createdAt)` と `(planDigest)` で index。

Immutability: OperationPlan は `id` 単位で immutable。 再計算は別の新 plan を
生成する。

## ActivationSnapshot

deploy 完了時点の Space activation 状態を記録する。

| Field                     | Type            | Required | Notes                                             |
| ------------------------- | --------------- | -------- | ------------------------------------------------- |
| `id`                      | string          | yes      | Snapshot 識別子。                                 |
| `desiredSnapshotId`       | string          | yes      | activation が実現する DesiredSnapshot。           |
| `spaceId`                 | string          | yes      | 所属 Space。                                      |
| `assignments`             | `array<object>` | yes      | Object → Implementation の割当。                  |
| `activatedAt`             | timestamp       | yes      | activation 完了時刻。                             |
| `health`                  | enum            | yes      | `healthy` / `degraded` / `unhealthy` のいずれか。 |
| `sourceObservationDigest` | sha256          | yes      | health 算出に用いた ObservationSet の digest。    |

Persistence: 本 snapshot が group-activation chain の head である間、または
DriftIndex に参照されている間は保持。 `(spaceId, activatedAt)` で index。

Immutability: ActivationSnapshot は immutable。 group-head の移動は既存 snapshot
の mutation ではなく新規 ActivationSnapshot として記録する。

## JournalEntry (WriteAheadOperationJournal)

apply pipeline を駆動する write-ahead log。

| Field                 | Type            | Required | Notes                                                                                           |
| --------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `journalId`           | string          | yes      | Journal 識別子。 Space ごとに 1 つ。                                                            |
| `operationId`         | string          | yes      | plan 内での識別子。                                                                             |
| `deploymentId`        | string          | yes      | 所属 deployment。                                                                               |
| `spaceId`             | string          | yes      | 所属 Space。                                                                                    |
| `desiredSnapshotId`   | string          | yes      | target の DesiredSnapshot。                                                                     |
| `operationPlanDigest` | sha256          | yes      | 本 entry を含む OperationPlan の digest。                                                       |
| `stage`               | enum            | yes      | WAL stage 8 値のいずれか。                                                                      |
| `idempotencyKey`      | string          | yes      | 4-tuple の idempotency key。                                                                    |
| `desiredGeneration`   | integer         | yes      | target DesiredSnapshot の generation。                                                          |
| `approvedEffects`     | `array<object>` | yes      | closed enum による approved effect record 群。                                                  |
| `actualEffects`       | `array<object>` | no       | closed enum による actual effect record 群。 stage が `commit-acked` 以降に遷移した時点で記録。 |
| `generatedObjectIds`  | `array<string>` | no       | 当 operation が生成した Object id 群。                                                          |
| `errorCode`           | enum            | no       | closed lifecycle error code。 failure stage で付与。                                            |
| `timestamp`           | timestamp       | yes      | stage 遷移時刻。                                                                                |

Persistence: compaction まで保持 (詳細は
[Journal Compaction](/reference/journal-compaction))。
`(spaceId, journalId, timestamp)` および `(idempotencyKey)` で index。

Immutability: 各 entry は append-only。 stage 遷移は新 entry の追記で表現し、
既存 entry を in place で更新することはない。 replay は entry stream を畳み込ん
で operation 状態を復元する。

## PublicOperationJournalEntry

`POST /v1/deployments` の現在の public deploy route が記録する WAL stage
record。 `takosumi_operation_journal_entries` で実装される。

本 record は内部 `JournalEntry` よりも意図的に狭い: public OperationPlan の
preview から導出され、 `applyV2` / `destroyV2` provider 呼び出し前後の stage
進行を記録する。 public entrypoint に対し durable な replay 証跡と effect-digest
不一致検出を提供するが、 full recovery mode 選択や provider fencing token
はまだ実装していない。

| Field                 | Type      | Required | Notes                                                                                                        |
| --------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`                  | string    | yes      | 行識別子。                                                                                                   |
| `spaceId`             | string    | yes      | public deploy の Space / tenant scope。                                                                      |
| `deploymentName`      | string    | no       | manifest metadata 由来の deployment 名。                                                                     |
| `operationPlanDigest` | sha256    | yes      | 決定的に算出される public OperationPlan preview digest。                                                     |
| `journalEntryId`      | string    | yes      | WAL idempotency tuple で使用する operation id。                                                              |
| `operationId`         | string    | yes      | 同じ operation 識別子。 クエリ利便性のため重複保持。                                                         |
| `phase`               | enum      | yes      | 現状 `apply` / `destroy`。 full enum は lifecycle phase も予約。                                             |
| `stage`               | enum      | yes      | `prepare` / `pre-commit` / `commit` / `post-commit` / `observe` / `finalize` / `abort` / `skip` のいずれか。 |
| `operationKind`       | string    | yes      | public operation kind (例: `create` / `delete`)。                                                            |
| `resourceName`        | string    | no       | manifest 上の resource 名。                                                                                  |
| `providerId`          | string    | no       | manifest が選択した provider id。                                                                            |
| `effectDigest`        | sha256    | yes      | canonical public WAL effect payload の digest。                                                              |
| `effect`              | object    | yes      | idempotent replay 比較に用いる canonical effect payload。                                                    |
| `status`              | enum      | yes      | `recorded` / `succeeded` / `failed` / `skipped`。                                                            |
| `createdAt`           | timestamp | yes      | stage 追記時刻。                                                                                             |

Persistence: full journal compaction policy が有効になるまでは public deploy
record と同一の policy で保持。 `(spaceId, operationPlanDigest)` /
`(spaceId, deploymentName)` / `createdAt` で index。

Mutation rule: `(spaceId, operationPlanDigest, journalEntryId, stage)` 単位で
append-only。 同一 tuple を同一 `effectDigest` で再 append するのは idempotent。
異なる digest での再 append は route の stage 進行前に hard-fail する。

## TakosumiDeploymentRecord

CLI surface (`POST /v1/deployments` および `takosumi status`) 向けの public
deploy record。 `takosumi_deployments` で実装される。

| Field              | Type            | Required | Notes                                                                  |
| ------------------ | --------------- | -------- | ---------------------------------------------------------------------- |
| `id`               | string          | yes      | 代理行 id。                                                            |
| `tenantId`         | string          | yes      | public deploy tenant / Space scope。                                   |
| `name`             | string          | yes      | manifest metadata 由来の deployment 名。                               |
| `manifest`         | object          | yes      | 提出された manifest JSON。 kernel は installer metadata を追加しない。 |
| `appliedResources` | `array<object>` | yes      | 直近成功 apply の handle / output。                                    |
| `status`           | enum            | yes      | `applied` / `destroyed` / `failed`。                                   |
| `createdAt`        | timestamp       | yes      | 初回挿入時刻。                                                         |
| `updatedAt`        | timestamp       | yes      | 直近の apply / destroy / failure 更新時刻。                            |

Persistence: operator 削除または record GC まで保持。 `(tenantId, name)`
unique、 `(tenantId)`、 `(status)` で index。

Mutation rule: `(tenantId, name)` で upsert。 destroy は行を残し
`status = destroyed` を設定して `appliedResources` を空にし、 status / audit
read が継続できるようにする。

## PublicDeployIdempotencyRecord

public deploy CLI surface (`POST /v1/deployments`) の replay cache。 write が
深い OperationJournal model に入る前段で `X-Idempotency-Key` を支える storage
level の backing。

| Field            | Type      | Required | Notes                                  |
| ---------------- | --------- | -------- | -------------------------------------- |
| `id`             | string    | yes      | 行識別子。                             |
| `tenantId`       | string    | yes      | public deploy tenant / Space scope。   |
| `idempotencyKey` | string    | yes      | caller が指定する operation key。      |
| `requestDigest`  | sha256    | yes      | 実 request body bytes の digest。      |
| `responseStatus` | integer   | yes      | 初回 JSON response の HTTP status。    |
| `responseBody`   | object    | yes      | replay に使う初回 JSON response body。 |
| `createdAt`      | timestamp | yes      | 初回観測時刻。                         |

Persistence: 少なくとも public deploy の retry window まで保持。
`(tenantId, idempotencyKey)` unique と `(createdAt)` で index (後者は retention
sweep 用)。

Mutation rule: first writer wins。 同一 key かつ同一 `requestDigest` の後続
request は格納済 response を replay する。 同一 key で異なる digest は
`failed_precondition` で拒否する。

## PublicDeployLeaseLock

public deploy CLI surface 向けの cross-process lease 行。
`takosumi_deploy_locks` で実装される。

| Field         | Type      | Required | Notes                                              |
| ------------- | --------- | -------- | -------------------------------------------------- |
| `tenantId`    | string    | yes      | public deploy tenant / Space scope。               |
| `name`        | string    | yes      | deployment 名。                                    |
| `ownerToken`  | string    | yes      | acquire 時に発行される opaque holder token。       |
| `lockedUntil` | timestamp | yes      | lease 期限。 これを過ぎると他 pod が引き継ぎ可能。 |
| `createdAt`   | timestamp | yes      | 現行行の初回 acquire 時刻。                        |
| `updatedAt`   | timestamp | yes      | 直近の acquire / renewal 時刻。                    |

Persistence: public deploy の apply / destroy lock を保持している間のみ存在。
primary key は `(tenantId, name)`。 expiry 確認用に `(lockedUntil)` を index。

Mutation rule: acquire は新規 insert または expire 済 行の引き継ぎを atomic に
行う。 heartbeat は一致する `ownerToken` に対して `lockedUntil` を延長する。
release は一致する `ownerToken` のみを削除する。

## RevokeDebt

世界側で clear 観測がまだ取れていない revocation を追跡する。 canonical schema、
reason / status enum、 aging window、 Multi-Space ownership rule の正本は
[RevokeDebt Model](/reference/revoke-debt) 参照。

| Field                 | Type      | Required | Notes                                                                                                                                   |
| --------------------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | string    | yes      | RevokeDebt 識別子 (`revoke-debt:<ulid>`)。                                                                                              |
| `sourceKey`           | sha256    | yes      | enqueue 用 idempotency key。 owner Space / reason / generated object / WAL ソース tuple から導出。                                      |
| `generatedObjectId`   | string    | yes      | owner generated object id。 形式は `generated:...`。                                                                                    |
| `reason`              | enum      | yes      | closed enum (`external-revoke` / `link-revoke` / `activation-rollback` / `approval-invalidated`、 `cross-space-share-expired` は予約)。 |
| `status`              | enum      | yes      | 3 値の closed enum (`open` / `operator-action-required` / `cleared`)。                                                                  |
| `originatingSpaceId`  | string    | yes      | generated object を materialize した Space。 `ownerSpaceId` と一致する場合あり。                                                        |
| `deploymentName`      | string    | no       | debt が `/v1/deployments` 由来のときの public deploy deployment 名。                                                                    |
| `operationPlanDigest` | sha256    | no       | debt を生んだ WAL OperationPlan digest。                                                                                                |
| `journalEntryId`      | string    | no       | debt を生んだ WAL entry id。                                                                                                            |
| `operationId`         | string    | no       | debt を生んだ operation id。                                                                                                            |
| `resourceName`        | string    | no       | debt が resource-scoped の場合の manifest resource 名。                                                                                 |
| `providerId`          | string    | no       | resource-scoped debt に紐づく provider id。                                                                                             |
| `retryPolicy`         | object    | yes      | retry policy parameter (interval / attempts / backoff)。 owner が tune 可能。                                                           |
| `retryAttempts`       | integer   | yes      | 本 debt に対する cleanup retry 試行回数。                                                                                               |
| `lastRetryAt`         | timestamp | no       | 直近の cleanup retry 試行時刻。                                                                                                         |
| `nextRetryAt`         | timestamp | no       | policy 上算出可能な場合の次回 retry 予定時刻。                                                                                          |
| `lastRetryError`      | object    | no       | 直近 retry 失敗の structured detail。                                                                                                   |
| `detail`              | object    | no       | 起源固有の structured detail。                                                                                                          |
| `createdAt`           | timestamp | yes      | debt 初回生成時刻。                                                                                                                     |
| `statusUpdatedAt`     | timestamp | yes      | 直近の status 遷移時刻。 `open` の間は aging window をこの値から評価する。                                                              |
| `agedAt`              | timestamp | no       | 自動 aging 遷移時刻 (`open` → `operator-action-required`)。                                                                             |
| `clearedAt`           | timestamp | no       | terminal clear 時刻 (`status = cleared`)。                                                                                              |

Persistence: `status` が `cleared` でない間に加え、
[Compliance Retention](/reference/compliance-retention) 規定の cleared 後
retention window まで保持。 実装テーブルは `takosumi_revoke_debts`、 key は
`id`、 `sourceKey` は unique。 `(ownerSpaceId, status)` /
`(ownerSpaceId, deploymentName)` / `(ownerSpaceId, operationPlanDigest)` /
`(ownerSpaceId, status, nextRetryAt)` / `createdAt` で index。

Multi-Space ownership rule: import 側 Space (consumer) が owner で、 export 側
Space は read-only mirror を得る (mirror は storage を持たず、 status 変更は
owner のみ可能)。

Immutability: status 遷移ごとに audit log に entry を append する。 live
RevokeDebt record 自体は `status` / retry metadata / `statusUpdatedAt` /
`agedAt` / `clearedAt` を in place 更新する。

## Approval

risk を伴う plan に対して発行された approval を記録する。

| Field                          | Type            | Required | Notes                                                                                   |
| ------------------------------ | --------------- | -------- | --------------------------------------------------------------------------------------- |
| `id`                           | string          | yes      | Approval 識別子。                                                                       |
| `spaceId`                      | string          | yes      | 所属 Space。                                                                            |
| `desiredSnapshotDigest`        | sha256          | yes      | approval が対象とする DesiredSnapshot の digest。                                       |
| `operationPlanDigest`          | sha256          | yes      | OperationPlan の digest。                                                               |
| `riskItemIds`                  | `array<string>` | yes      | approval が対象とする closed risk enum 値。                                             |
| `approvedEffects`              | `array<object>` | yes      | closed effect enum で表現された approved effect 群。                                    |
| `effectDetailsDigest`          | sha256          | yes      | per-effect detail payload の digest。                                                   |
| `predictedActualEffectsDigest` | sha256          | yes      | predicted actual-effects payload の digest。                                            |
| `actor`                        | string          | yes      | 承認 actor の identity。                                                                |
| `policyVersion`                | string          | yes      | 発行時点で active な policy version。                                                   |
| `expiresAt`                    | timestamp       | yes      | 失効時刻。                                                                              |
| `status`                       | enum            | yes      | `pending` / `approved` / `denied` / `expired` / `invalidated` / `consumed` のいずれか。 |

Persistence: approval を参照する journal が replay 可能な間に加え、 設定された
audit retention window まで保持。 `(spaceId, status)` と `(operationPlanDigest)`
で index。

Immutability: status 遷移は audit log に append-only。 高速 lookup のため live
record は `status` を in place 更新する。 Approval は policy / risk / approval /
error model における 6 種類の invalidation trigger を担う。

install や deploy ではこのテーブルを必須としない。 consumer contract は
operator-owned namespace export だけに依存してよい。

| Field                | Type            | Required | Notes                                                                  |
| -------------------- | --------------- | -------- | ---------------------------------------------------------------------- |
| `id`                 | string          | yes      | Share 識別子。                                                         |
| `fromSpaceId`        | string          | yes      | producer Space。                                                       |
| `toSpaceId`          | string          | yes      | consumer Space。                                                       |
| `exportPath`         | string          | yes      | export された namespace path。                                         |
| `exportSnapshotId`   | string          | yes      | producer 側 export の Snapshot。                                       |
| `allowedAccess`      | enum            | yes      | access mode (read / read-write / admin / invoke-only / observe-only)。 |
| `expiresAt`          | timestamp       | no       | 任意の hard expiry。                                                   |
| `policyDecisionRefs` | `array<string>` | yes      | share を統治する policy decision 群。                                  |

Persistence: `lifecycleState` が `revoked` 以外の間に加え、 audit retention
window まで保持。 `(fromSpaceId, toSpaceId, lifecycleState)` と `(exportPath)`
で index。

Immutability: lifecycle 遷移は audit log に append-only。 live record は
`lifecycleState` と `policyDecisionRefs` を in place 更新する。

## ObservationSet

ある時点における Space の observed fact をまとめた bundle。

| Field               | Type            | Required | Notes                                 |
| ------------------- | --------------- | -------- | ------------------------------------- |
| `id`                | string          | yes      | observation set 識別子。              |
| `spaceId`           | string          | yes      | 所属 Space。                          |
| `desiredSnapshotId` | string          | yes      | 比較対象の DesiredSnapshot。          |
| `observedAt`        | timestamp       | yes      | 観測時刻。                            |
| `observations`      | `array<object>` | yes      | object 単位の observation record 群。 |

Persistence: 対応する DriftIndex が live な間に加え、 設定された observation
retention まで保持。 `(spaceId, observedAt)` で index。

Immutability: ObservationSet は immutable。

## DriftIndex

DesiredSnapshot と ObservationSet から計算される drift 状態。

| Field               | Type            | Required | Notes                           |
| ------------------- | --------------- | -------- | ------------------------------- |
| `id`                | string          | yes      | drift index 識別子。            |
| `spaceId`           | string          | yes      | 所属 Space。                    |
| `desiredSnapshotId` | string          | yes      | 比較の DesiredSnapshot 側。     |
| `observationSetId`  | string          | yes      | 比較の ObservationSet 側。      |
| `driftEntries`      | `array<object>` | yes      | object 単位の drift record 群。 |
| `computedAt`        | timestamp       | yes      | 計算時刻。                      |

Persistence: drift が open または未解消の間は保持。 `(spaceId, computedAt)` で
index。

Immutability: DriftIndex は immutable。 新たな drift 計算は新 DriftIndex を
生む。

## ExternalParticipant

export を consume したり envelope に署名する外部参加者。 現状の v1 storage は
install / deploy 用途では本 record を必須としない。

| Field             | Type            | Required | Notes                                                |
| ----------------- | --------------- | -------- | ---------------------------------------------------- |
| `id`              | string          | yes      | `external-participant:<id>` form.                    |
| `spaceVisibility` | `array<string>` | yes      | spaceId list operator が visibility を grant した先. |
| `declaredExports` | `array<object>` | yes      | participant が publish 可能な export path 一覧.      |
| `publicKey`       | string          | yes      | ed25519 公開鍵 (signature verify 用).                |
| `verifiedAt`      | timestamp       | yes      | 最新 verification 完了時刻.                          |
| `expiresAt`       | timestamp       | no       | optional expiry, 経過後は revocation 扱い.           |
| `revokedAt`       | timestamp       | no       | revocation 時刻 (status:revoked).                    |

Persistence: `revokedAt` が null の間、 または audit retention で要求される間
保持。 `(id, spaceVisibility)` で index。 Immutability: in place で mutate
可能なのは `spaceVisibility` / `verifiedAt` / `revokedAt` のみ。

## Connector

DataAsset accept 経路を gate する、 operator が install する connector record。

| Field                 | Type            | Required | Notes                                           |
| --------------------- | --------------- | -------- | ----------------------------------------------- |
| `id`                  | string          | yes      | `connector:<id>` form, operator-installed.      |
| `acceptedKinds`       | `array<enum>`   | yes      | DataAsset kind subset (5値の closed enum から). |
| `spaceVisibility`     | `array<string>` | yes      | spaceId list operator policy 制御.              |
| `signingExpectations` | enum            | yes      | `none` / `optional` / `required`.               |
| `envelopeVersion`     | string          | yes      | 現状 `v1` のみ.                                 |
| `installedAt`         | timestamp       | yes      | 初回 install.                                   |
| `revokedAt`           | timestamp       | no       | revocation 時刻.                                |

Persistence: `revokedAt` が null の間は保持。 `(id)` で index。 Immutability:
operator のみ mutate 可能。

See also: [Connector Contract](/reference/connector-contract).

## AuditLogEvent

append-only な audit chain の単一 entry。

| Field       | Type      | Required | Notes                                               |
| ----------- | --------- | -------- | --------------------------------------------------- |
| `eventId`   | string    | yes      | `event:<ulid>` form.                                |
| `ts`        | timestamp | yes      | wall clock at event creation.                       |
| `spaceId`   | string    | no       | 該当 Space (cross-Space audit は null).             |
| `actor`     | string    | yes      | `operator` / `kernel` / `runtime-agent` / `system`. |
| `eventType` | enum      | yes      | audit-events.md の closed enum 値.                  |
| `severity`  | enum      | yes      | `debug` / `info` / `warn` / `error`.                |
| `payload`   | object    | yes      | event-type 固有の field map.                        |
| `prevHash`  | string    | yes      | 前 event の hash (chain integrity).                 |
| `hash`      | string    | yes      | 当 event の hash.                                   |

Persistence: compliance regime ごとの retention window まで保持 (詳細は
[Compliance Retention](/reference/compliance-retention))。
`(spaceId, ts, actor, eventType)` で index。 Immutability: append-only、
mutation は不可。

See also: [Audit Events](/reference/audit-events).

## CatalogRelease Publisher Key

CatalogRelease descriptor の verify に用いる operator enrollment 済 Ed25519 鍵。

| Field             | Type      | Required | Notes                         |
| ----------------- | --------- | -------- | ----------------------------- |
| `keyId`           | string    | yes      | publisher key 識別子。        |
| `publisherId`     | string    | yes      | trusted publisher owner。     |
| `publicKeyBase64` | string    | yes      | raw Ed25519 公開鍵 (base64)。 |
| `status`          | enum      | yes      | `active` / `revoked`。        |
| `enrolledAt`      | timestamp | yes      | enrollment 完了時刻。         |
| `revokedAt`       | timestamp | no       | revoke 完了時刻。             |
| `reason`          | string    | no       | operator 記入の理由。         |

Persistence: operator trust root。 `(publisherId)` と `(status)` で index。

## CatalogRelease Descriptor

Space が adopt する署名付き descriptor 本体。

| Field                | Type      | Required | Notes                                        |
| -------------------- | --------- | -------- | -------------------------------------------- |
| `releaseId`          | string    | yes      | CatalogRelease id。                          |
| `publisherId`        | string    | yes      | descriptor 署名 publisher。                  |
| `descriptorDigest`   | sha256    | yes      | canonical payload の sha256。                |
| `descriptor`         | object    | yes      | pin を含む署名付き descriptor 本体。         |
| `signatureAlgorithm` | string    | yes      | `Ed25519`。                                  |
| `signatureKeyId`     | string    | yes      | verification に用いる鍵。                    |
| `signatureValue`     | string    | yes      | canonical payload に対する base64 署名。     |
| `createdAt`          | timestamp | yes      | descriptor 作成時刻。                        |
| `activatedAt`        | timestamp | no       | publisher activation 時刻 (供給される場合)。 |

Persistence: 当 release を参照する adoption がある間は immutable に保持。
`(publisherId)` / `(descriptorDigest)` / `(createdAt)` で index。

## CatalogReleaseAdoption

catalog release に対する Space 単位の adoption record。

| Field                         | Type      | Required | Notes                                |
| ----------------------------- | --------- | -------- | ------------------------------------ |
| `id`                          | string    | yes      | adoption record id。                 |
| `catalogReleaseId`            | string    | yes      | adopt した release id。              |
| `spaceId`                     | string    | yes      | adoption 対象 Space。                |
| `publisherId`                 | string    | yes      | descriptor publisher。               |
| `publisherKeyId`              | string    | yes      | adoption に使った publisher key id。 |
| `descriptorDigest`            | sha256    | yes      | sha256 catalog descriptor digest。   |
| `adoptedAt`                   | timestamp | yes      | adoption 完了時刻。                  |
| `rotatedFromCatalogReleaseId` | string    | no       | rotation 元 release。                |
| `verification`                | object    | yes      | verifiedAt / algorithm / digest。    |

Persistence: resolution が当 release を参照する間に加え、 audit retention window
まで保持。 `(spaceId, adoptedAt)` / `(catalogReleaseId)` / `(publisherKeyId)` で
index。 Immutability: operator のみ append 可能。

See also: [Catalog Release Trust](/reference/catalog-release-trust).

## ImplementationRegistry

provider 実装の operator 管理 registry。

| Field                 | Type            | Required | Notes                                              |
| --------------------- | --------------- | -------- | -------------------------------------------------- |
| `id`                  | string          | yes      | `implementation:<id>` 形式。                       |
| `providerKind`        | string          | yes      | namespace 付き provider id (例: `@takos/aws-s3`)。 |
| `acceptedShapes`      | `array<string>` | yes      | `shape@version` の一覧。                           |
| `signingExpectations` | enum            | yes      | `none` / `optional` / `required`。                 |
| `publicKey`           | string          | no       | 任意。 署名付き実装の verify 用。                  |
| `installedAt`         | timestamp       | yes      | install 時刻。                                     |
| `revokedAt`           | timestamp       | no       | revocation 時刻。                                  |

Persistence: `revokedAt` が null の間は保持。 `(id, providerKind)` で index。
Immutability: operator のみ mutate 可能。

See also:
[Provider Implementation Contract](/reference/provider-implementation-contract).

## LockRecord

kernel pod が保持する cross-process lock lease record。

| Field            | Type      | Required | Notes                               |
| ---------------- | --------- | -------- | ----------------------------------- |
| `lockId`         | string    | yes      | scope + key の合成 ID.              |
| `holderId`       | string    | yes      | kernel pod id (UUID).               |
| `acquiredAt`     | timestamp | yes      | acquisition 時刻.                   |
| `leaseExpiresAt` | timestamp | yes      | monotonic-derived expiry.           |
| `epoch`          | integer   | yes      | 取得 epoch (recovery で increment). |

Persistence: lease expire 後に削除可。 `(lockId)` で index。 Immutability: in
place で mutate 可能なのは `leaseExpiresAt` / heartbeat 更新のみ。

See also: [Cross-Process Locks](/reference/cross-process-locks).

## SecretPartitionReference

secret partition への Space 単位の暗号化参照。 raw な secret material は本
record に embed されない。

| Field           | Type      | Required | Notes                                                                     |
| --------------- | --------- | -------- | ------------------------------------------------------------------------- |
| `partitionTag`  | string    | yes      | `global` / `aws` / `gcp` / `cloudflare` / `azure` / `k8s` / `selfhosted`. |
| `spaceId`       | string    | yes      | 所属 Space.                                                               |
| `keyGeneration` | integer   | yes      | rotation generation.                                                      |
| `createdAt`     | timestamp | yes      | 初回 reference 生成時刻.                                                  |
| `rotatedAt`     | timestamp | no       | rotation 時刻.                                                            |

Persistence: 無期限に保持 (rotation 履歴は audit に依存)。
`(spaceId, partitionTag)` で index。 Immutability: generation は append-only。
注: raw secret value は本 record に **絶対に含まれない** (reference のみ)。

See also: [Secret Partitions](/reference/secret-partitions).

## Account-plane identity records

Organization、 Membership、 RoleAssignment、 account API key、 AuthProvider の
record は現在の takosumi kernel storage schema には含まれない。 これらは
operator account plane (reference 実装は `takosumi-cloud/` の Takosumi Accounts)
が所有する。 kernel storage が扱うのは deploy record、 journal、 provider
observation、 artifact、 lock、 quota signal、 operator / runtime credential
のみである。

## TrialAttribute

Space に付与される trial 固有 metadata。

| Field              | Type      | Required | Notes                                                                   |
| ------------------ | --------- | -------- | ----------------------------------------------------------------------- |
| `spaceId`          | string    | yes      | 所属 Space。 primary key。                                              |
| `trial`            | boolean   | yes      | attribute が存在する間は常に `true`。                                   |
| `trialExpiresAt`   | timestamp | yes      | trial 失効時刻。                                                        |
| `trialQuotaTierId` | string    | yes      | trial 中に適用される QuotaTier。                                        |
| `trialOrigin`      | enum      | yes      | closed origin enum (例: `self-service` / `operator-grant` / `import`)。 |

Persistence: Space が trial 状態の間は保持。 conversion 時に削除、 cleanup 時に
Space と共に削除される。 `(trialExpiresAt)` で index。

Immutability: `trialExpiresAt` と `trialQuotaTierId` は trial 延長 flow で in
place 更新可能 (遷移時に audit event 発行)。 `spaceId` / `trial` / `trialOrigin`
は immutable。

See also: [Trial Spaces](/reference/trial-spaces).

## ProvisioningSession

進行中の Space provisioning 試行を追跡する。

| Field          | Type      | Required | Notes                                                                                                        |
| -------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`           | string    | yes      | `provisioning-session:<ulid>` 形式。                                                                         |
| `spaceId`      | string    | yes      | target Space。                                                                                               |
| `status`       | enum      | yes      | closed provisioning status のいずれか (例: `pending` / `running` / `completed` / `failed` / `rolled-back`)。 |
| `currentStage` | enum      | yes      | closed provisioning stage のいずれか。                                                                       |
| `startedAt`    | timestamp | yes      | session 開始時刻。                                                                                           |
| `completedAt`  | timestamp | no       | `status` が `completed` / `failed` / `rolled-back` のときの終端時刻。                                        |
| `error`        | object    | no       | failure 時の closed error envelope (`errorCode` / `message` / `stage`)。                                     |

Persistence: `status` が非終端の間に加え、 terminal 後は audit retention window
まで保持。 `(spaceId, status)` と `(startedAt)` で index。

Immutability: `status` / `currentStage` / `completedAt` / `error` は in place
更新可能 (遷移時に audit event 発行)。 他 field は immutable。

See also: [Tenant Provisioning](/reference/tenant-provisioning).

## ExportJob

Space export 要求を追跡する。

| Field                  | Type      | Required | Notes                                                                   |
| ---------------------- | --------- | -------- | ----------------------------------------------------------------------- |
| `id`                   | string    | yes      | `export-job:<ulid>` 形式。                                              |
| `spaceId`              | string    | yes      | source Space。                                                          |
| `mode`                 | enum      | yes      | closed export mode (例: `full` / `metadata-only` / `audit-only`)。      |
| `status`               | enum      | yes      | closed export status (`pending` / `running` / `completed` / `failed`)。 |
| `artifactSha256`       | sha256    | no       | `status` が `completed` のときの export artifact digest。               |
| `downloadUrlExpiresAt` | timestamp | no       | 発行された pre-signed download URL の失効時刻。                         |
| `requestedAt`          | timestamp | yes      | 要求時刻。                                                              |
| `completedAt`          | timestamp | no       | `status` が `completed` または `failed` のときの終端時刻。              |

Persistence: artifact が download 可能な間に加え、 audit retention window まで
保持。 `(spaceId, requestedAt)` と `(status)` で index。

Immutability: `status` / `artifactSha256` / `downloadUrlExpiresAt` /
`completedAt` は in place 更新可能 (遷移時に audit event 発行)。 他 field は
immutable。

See also: [Tenant Export / Deletion](/reference/tenant-export-deletion).

## QuotaTier

operator が管理する quota tier 定義。

| Field                | Type      | Required | Notes                                                                                                                                        |
| -------------------- | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tierId`             | string    | yes      | `quota-tier:<id>` 形式。 primary key。                                                                                                       |
| `dimensions`         | object    | yes      | closed dimension map: `deploymentCount` / `artifactStorageBytes` / `journalVolumeBytes` / `approvalPendingCount` / `spaceExportShareCount`。 |
| `rateLimitOverrides` | object    | no       | 任意。 closed rate-limit dimension を key とする上書き。                                                                                     |
| `createdAt`          | timestamp | yes      | 登録時刻。                                                                                                                                   |

Persistence: tier を参照する Space がある間に加え、 audit retention window まで
保持。 `(tierId)` で index。

Immutability: `dimensions` と `rateLimitOverrides` は in place 更新可能 (更新時
に audit event 発行)。 `tierId` / `createdAt` は immutable。

See also: [Quota Tiers](/reference/quota-tiers).

## CostAttributionConfig

Space 単位の cost attribution 設定。

| Field         | Type      | Required | Notes                                                                                                                                 |
| ------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `spaceId`     | string    | yes      | 所属 Space。 primary key。                                                                                                            |
| `attribution` | object    | yes      | closed key attribution map (cost-center / project / environment / owner-actor)。 値は operator が制御する文字列。 secret は含まない。 |
| `updatedAt`   | timestamp | yes      | 直近更新時刻。                                                                                                                        |

Persistence: Space が存在する間に加え、 audit retention window まで保持。
`(spaceId)` で index。

Immutability: `attribution` / `updatedAt` は in place 更新可能 (更新時に audit
event 発行)。 `spaceId` は immutable。

See also: [Cost Attribution](/reference/cost-attribution).

## SLAThreshold

operator が登録する SLA threshold 定義。

| Field          | Type      | Required    | Notes                                          |
| -------------- | --------- | ----------- | ---------------------------------------------- |
| `id`           | string    | yes         | `sla-threshold:<ulid>` 形式。                  |
| `dimension`    | enum      | yes         | closed v1 SLA dimension のいずれか。           |
| `comparator`   | enum      | yes         | `gt` / `gte` / `lt` / `lte` のいずれか。       |
| `value`        | number    | yes         | 閾値。                                         |
| `scope`        | enum      | yes         | `kernel-global` / `org` / `space` のいずれか。 |
| `scopeId`      | string    | conditional | `scope` が `org` または `space` のとき必須。   |
| `registeredAt` | timestamp | yes         | 登録時刻。                                     |

Persistence: threshold が active な間に加え、 audit retention window まで保持。
`(dimension, scope, scopeId)` で index。

Immutability: `comparator` と `value` は in place 更新可能 (遷移時に audit event
発行)。 他 field は immutable。

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## SLAObservation

append-only な点 SLA 観測。

| Field       | Type      | Required    | Notes                                          |
| ----------- | --------- | ----------- | ---------------------------------------------- |
| `id`        | string    | yes         | `sla-observation:<ulid>` 形式。                |
| `dimension` | enum      | yes         | closed v1 SLA dimension のいずれか。           |
| `scope`     | enum      | yes         | `kernel-global` / `org` / `space` のいずれか。 |
| `scopeId`   | string    | conditional | `scope` が `org` または `space` のとき必須。   |
| `value`     | number    | yes         | `ts` 時点の観測値。                            |
| `ts`        | timestamp | yes         | 観測時刻。                                     |

Persistence: observation retention window まで保持 (詳細は
[Observation Retention](/reference/observation-retention))。
`(dimension, scope, scopeId, ts)` で index。

Immutability: append-only。 mutation は不可。

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## Incident

operator または auto-detection が open する incident record。

| Field                  | Type            | Required | Notes                                                                                       |
| ---------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`                   | string          | yes      | `incident:<ulid>` 形式。                                                                    |
| `title`                | string          | yes      | 人間可読サマリ。                                                                            |
| `state`                | enum            | yes      | closed incident state のいずれか (`detected` / `acknowledged` / `mitigated` / `resolved`)。 |
| `severity`             | enum            | yes      | closed incident severity のいずれか。                                                       |
| `origin`               | enum            | yes      | `auto-detection` / `operator` / `customer-report` のいずれか。                              |
| `affectedSpaceIds`     | `array<string>` | yes      | 影響を受けた Space。 空でもよい。                                                           |
| `affectedOrgIds`       | `array<string>` | yes      | 影響を受けた Organization。 空でもよい。                                                    |
| `detectedAt`           | timestamp       | yes      | 検知時刻。                                                                                  |
| `acknowledgedAt`       | timestamp       | no       | acknowledge 時刻。                                                                          |
| `mitigatedAt`          | timestamp       | no       | mitigation 時刻。                                                                           |
| `resolvedAt`           | timestamp       | no       | resolution 時刻。                                                                           |
| `rootCause`            | string          | no       | operator が記入するサマリ。 resolution 時に記録。                                           |
| `relatedAuditEventIds` | `array<string>` | yes      | incident timeline の anchor となる audit event。                                            |

Persistence: `state` が `resolved` 以外の間は無期限に保持し、 resolution 後は
audit retention window まで保持。 `(state, severity, detectedAt)` で index。

Immutability: `state` / `severity` / `acknowledgedAt` / `mitigatedAt` /
`resolvedAt` / `rootCause` / `relatedAuditEventIds` は in place 更新可能 (遷移
時に audit event 発行)。 他 field は immutable。

See also: [Incident Model](/reference/incident-model).

## SupportImpersonationGrant

support actor が Space 内で impersonate するための approved または pending な
grant。

| Field            | Type      | Required | Notes                                                                               |
| ---------------- | --------- | -------- | ----------------------------------------------------------------------------------- |
| `id`             | string    | yes      | `support-impersonation-grant:<ulid>` 形式。                                         |
| `supportActorId` | string    | yes      | support staff actor identity。                                                      |
| `spaceId`        | string    | yes      | target Space。                                                                      |
| `requestedAt`    | timestamp | yes      | 要求時刻。                                                                          |
| `approvedAt`     | timestamp | no       | 承認時刻。 pending の間は null。                                                    |
| `scope`          | enum      | yes      | `read` / `read-write` のいずれか。                                                  |
| `status`         | enum      | yes      | closed grant status (`pending` / `approved` / `rejected` / `revoked` / `expired`)。 |
| `expiresAt`      | timestamp | no       | 任意の失効時刻。                                                                    |
| `revokedAt`      | timestamp | no       | revocation 時刻。 `status` が `revoked` でない限り null。                           |

Persistence: `status` が非終端の間に加え、 audit retention window まで保持。
`(supportActorId, status)` と `(spaceId, status)` で index。

Immutability: `status` / `approvedAt` / `expiresAt` / `revokedAt` は in place
更新可能 (遷移時に audit event 発行)。 他 field は immutable。

See also: [Support Impersonation](/reference/support-impersonation).

## SupportImpersonationSession

approved grant の下で open または close された support impersonation session。

| Field              | Type      | Required | Notes                                                            |
| ------------------ | --------- | -------- | ---------------------------------------------------------------- |
| `id`               | string    | yes      | `support-impersonation-session:<ulid>` 形式。                    |
| `grantId`          | string    | yes      | 由来 SupportImpersonationGrant。                                 |
| `openedAt`         | timestamp | yes      | session 開始時刻。                                               |
| `endedAt`          | timestamp | no       | session 終了時刻。 open の間は null。                            |
| `sessionTokenHash` | string    | yes      | session bearer token の Argon2id hash。 平文は決して保存しない。 |
| `acceptScope`      | enum      | yes      | `read` / `read-write` のいずれか。 grant scope に bound される。 |

Persistence: session が open の間に加え、 audit retention window まで保持。
`(grantId)` と `(openedAt)` で index。

Immutability: `endedAt` は in place 更新可能。 他 field は immutable。
`read-write` session 内で行われる write action は本 record の mutation ではなく
audit event として記録する。

See also: [Support Impersonation](/reference/support-impersonation).

## NotificationSignal

pull のみで受け取る notification record。

| Field               | Type            | Required    | Notes                                           |
| ------------------- | --------------- | ----------- | ----------------------------------------------- |
| `id`                | string          | yes         | `notification:<ulid>` 形式。                    |
| `category`          | enum            | yes         | closed v1 notification category のいずれか。    |
| `scope`             | enum            | yes         | `kernel-global` / `org` / `space` のいずれか。  |
| `scopeId`           | string          | conditional | `scope` が `org` または `space` のとき必須。    |
| `payload`           | object          | yes         | category 固有の payload。 secret は redact 済。 |
| `recipientActorIds` | `array<string>` | yes         | signal を pull できる actor 群。                |
| `emittedAt`         | timestamp       | yes         | 発出時刻。                                      |
| `acknowledgedAt`    | timestamp       | no          | recipient が acknowledge した時刻。             |

Persistence: 未 acknowledge の間に加え、 audit retention window まで保持。
`(scope, scopeId, emittedAt)` と `(recipientActorIds)` で index。

Immutability: `acknowledgedAt` は in place 更新可能 (遷移時に audit event
発行)。 他 field は immutable。

See also: [Notification Emission](/reference/notification-emission).

## ZoneAttribute

Space / Object / DataAsset / Connector record に付与される zone attribute
model。 single-region な zone preference を表現する。 attribute は独立テーブル
ではなく layered overlay であり、 host record 上に以下の field として
materialize される:

| Host record | Field            | Type   | Required | Notes                                                                                                                |
| ----------- | ---------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| Space       | `defaultZone`    | string | yes      | Space の default zone 識別子。 Space 内のすべての Object / DataAsset は、 自身で宣言しない限りこの zone を継承する。 |
| Object      | `zone`           | string | yes      | 当 Object に materialize された zone。 作成時は Space `defaultZone` から継承するが、 作成時に override 可能。        |
| DataAsset   | `zonePreference` | string | no       | 宣言された zone preference。 bind 時に connector の zone 制約に対して解決する。                                      |
| Connector   | `zonePreference` | string | no       | connector 実装に対して operator が宣言する zone preference。                                                         |

Persistence: 各 field は host record と co-persist され、 host の persistence /
retention rule を継承する。 独立した ZoneAttribute テーブルは存在しない。

Indexing: Space では `(spaceId, defaultZone)`、 Object では `(spaceId, zone)`、
DataAsset と Connector では存在時に `(zonePreference)` で index。

Immutability: Space の `defaultZone` は in place 更新可能 (遷移時に audit event
発行)。 Object `zone` は Object 作成後は immutable。 zone 移動は Object の
置き換えで行う。 DataAsset / Connector の `zonePreference` は operator が in
place 更新可能。

Relationship: Object の zone は Space `defaultZone` から解決される。 DataAsset
binding は Space `defaultZone` と Connector `zonePreference` の zone 互換性を
要求する。 cross-zone link は cross-zone link policy が統治する (詳細は
[Zone Selection](/reference/zone-selection))。

See also: [Zone Selection](/reference/zone-selection).

## Workflow-Extension Records

kernel は Trigger / TriggerRegistration / HookBinding / StepResult / cron /
webhook / declarable-hook の record を生成・予約・永続化しない。 workflow / cron
/ hook の state は manifest deploy engine の上に重ねる product (例:
`takosumi-git`) に属する。 詳細は
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
を参照。

## See also

- [Actor / Organization Model](/reference/actor-organization-model)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export / Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)

## Implementation freedom

kernel 実装に許される自由:

- 上記 record class の一部を単一の物理 store に纏めて永続化してよい。
- `planDigest` が算出・検証可能である限り、 OperationPlan を本体保存せず
  JournalEntry stream から materialize してよい。
- 上記論理 field が照会可能である限り、 ObservationSet と DriftIndex を単一 物理
  store に統合してよい。
- 同等の query pattern を満たす index で、 推奨 index を置き換えてよい。

kernel 実装に許されない事項:

- immutable な snapshot record を in place で mutate すること。
- [Journal Compaction](/reference/journal-compaction) の retention rule を
  満たすために必要な field を drop すること。
- secret 値を inline で永続化すること。 secret は参照のみで、 embed しない
  (詳細は [Audit Events](/reference/audit-events))。

## 関連 architecture note

- `reference/architecture/snapshot-model` — immutable snapshot 分類。
- `reference/architecture/operation-plan-write-ahead-journal-model` — WAL stage
  enum と idempotency tuple。
- `reference/architecture/observation-drift-revokedebt-model` — observation /
  drift / RevokeDebt のセマンティクス。
- `reference/architecture/policy-risk-approval-error-model` — Approval
  invalidation trigger と risk enum。

## 関連ページ

- [Journal Compaction](/reference/journal-compaction)
- [Audit Events](/reference/audit-events)
- [Lifecycle Protocol](/reference/lifecycle)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export / Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)
