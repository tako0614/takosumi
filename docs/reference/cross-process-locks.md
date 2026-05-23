# Cross-Process Locks

> このページでわかること: cross-process lock の v1 仕様 — acquisition /
> heartbeat / TTL / recovery / deadlock 予防 / SQL backed store 必須化。

複数 kernel pod が並走する production 配置でも特定 resource 群への mutation を
直列化する protocol を定義する。

## Use cases

cross-process lock が要求される resource は v1 で固定列挙される。 新しい lock
scope を増やすには `CONVENTIONS.md` §6 の RFC を要する。

| Lock scope                             | 用途                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `group-head:<spaceId>:<group>`         | GroupHead update のシリアライズ (canary / shadow / rollout)       |
| `activation-snapshot:<spaceId>`        | ActivationSnapshot update のシリアライズ                          |
| `generated-credential:<spaceId>:<ns>`  | generated credential mutation の Space-local serialization        |
| `namespace-registry:<spaceId>`         | Namespace registry writes (namespace export 設定の追加 / 削除)    |
| `operator-implementation-config:<id>`  | operator implementation config / Space visibility assignment      |
| `operation-plan:<spaceId>:<digest>`    | 同一 OperationPlan に対する apply / activate / destroy / rollback |
| `installer:<spaceId>:<installationId>` | installer apply / rollback fence                                  |
| `secret-partition:<spaceId>:<tag>`     | secret partition rotation                                         |

read path は **lock-free**。observe / status / describe は直近 commit 済みの
world view から read-only で動く。

## Lock entry shape

各 lock entry は SQL store (or 同等の strongly consistent store) に以下の field
構造で保存される。

| Field            | 型             | 内容                                                                      |
| ---------------- | -------------- | ------------------------------------------------------------------------- |
| `lockId`         | string         | scope 名 + key (上表の表記)                                               |
| `holderId`       | string         | 取得した kernel pod の identity (`hostname` + `pid` + UUID)               |
| `acquiredAt`     | timestamp (ms) | 初回 acquisition 時刻                                                     |
| `leaseExpiresAt` | timestamp (ms) | 現在の lease 失効予定時刻                                                 |
| `lastHeartbeat`  | timestamp (ms) | 直近 heartbeat 受領時刻                                                   |
| `epoch`          | integer        | acquire 〜 release で 1 増える sequence。stale claim 検出用               |
| `intent`         | enum           | `apply` / `activate` / `destroy` / `rollback` / `rotate` / `share-mutate` |

`epoch` は lock store 側が atomic increment する。 新規 holder は epoch を
読み戻し、 heartbeat / release ですべて自分の epoch を提示する。 epoch が
合わない claim は fail-closed で reject される。

> Implementation note: installer apply / rollback は同一 Installation の
> mutation を直列化する fence として lock store を使う。 `takosumi_deploy_locks`
> は compact installer lock table で、`(tenant_id,
> name)` を primary key
> とし、 `owner_token` と `locked_until` で lease を管理 する。 release は
> `owner_token` 一致時だけ row を削除するため、 lease takeover 後の新 holder を
> stale holder が消すことはできない。 side-effecting stage 自体 は
> `takosumi_operation_journal_entries` に記録されるが、 この apply lock はまだ
> provider fencing token を下流へ渡さない。

## Acquisition protocol

acquire は以下の SQL 相当 atomic transaction で行う。

1. `SELECT lockId, holderId, leaseExpiresAt, epoch FROM locks WHERE lockId = ? FOR UPDATE`
2. row が無い、 または `leaseExpiresAt <= now()` なら `INSERT` / `UPDATE` で
   自分を holder に書き込み、 `epoch` を 1 増やす
3. row があり `leaseExpiresAt > now()` なら **fail-closed** で
   `cross_process_lock_busy` を返す
4. transaction commit

acquire 成功後、 kernel は heartbeat を回し、 `try { ... } finally { release }`
で release を保証する。 release は `holderId` と `epoch` の両方が一致する場合
だけ row を消す。

installer lock は同じ Installation への concurrent apply / rollback
を直列化する。 lease が取れるまで poll / wait する。 full lifecycle operation
lock は上記の fail-closed busy semantics に従う。

## Heartbeat

holder は lease の **半分以下** の周期で heartbeat する。

- default lease: `30s`
- default heartbeat interval: `10s` (lease/3。 lease/2 でなく lease/3 にするのは
  1 回失敗しても直後 heartbeat で救済する余裕のため)
- operator は env / config で tuning 可能 (`TAKOSUMI_LOCK_LEASE_MS`,
  `TAKOSUMI_LOCK_HEARTBEAT_MS`)

heartbeat は以下を atomic に行う:

```
UPDATE locks
SET leaseExpiresAt = now() + leaseMs, lastHeartbeat = now()
WHERE lockId = ? AND holderId = ? AND epoch = ?
```

返り行数が 0 の場合 (lock を別 holder が claim 済み)、 kernel は in-flight
operation を `cross_process_lock_lost` で fail-closed させ、 当該 OperationPlan
を recovery 経路に渡す。

installer compact lock は `locked_until` を holder token 条件で renew する
lease。 下流 provider へ fencing token は渡さない。 長時間の operation では
`TAKOSUMI_LOCK_LEASE_MS` / `TAKOSUMI_LOCK_HEARTBEAT_MS` を provider 実行時間
に合わせて調整する。

## TTL recommendations

| Lock scope                         | lease 推奨 | heartbeat 推奨 | 備考                                             |
| ---------------------------------- | ---------- | -------------- | ------------------------------------------------ |
| `operation-plan:*`                 | `30s`      | `10s`          | apply / commit に時間がかかるなら lease を伸ばす |
| `activation-snapshot:*`            | `15s`      | `5s`           | 短時間の atomic write 用                         |
| `group-head:*`                     | `15s`      | `5s`           | rollout state machine の 1 step 単位             |
| `generated-credential:*`           | `30s`      | `10s`          | credential rotation 中は伸ばす                   |
| `namespace-registry:*`             | `15s`      | `5s`           | metadata write 用                                |
| `operator-implementation-config:*` | `30s`      | `10s`          | implementation config / Space visibility update  |
| `secret-partition:*`               | `120s`     | `30s`          | rotation は entry 数に応じて長期化               |

operator が伸ばす場合の上限は `5min`。 それを超えると recovery 経路が割に
合わなくなり、 kernel pod 突然死時の MTTR が悪化する。

## Recovery (lock holder の突然死)

holder kernel pod が `kill -9` 等で消えた場合、 heartbeat が止まり
`leaseExpiresAt` が経過する。 次の acquire 試行で **別 process が claim 可能**
になる。 claim した kernel は以下を行う。

1. lock entry の `holderId` / `epoch` から「前 holder が誰だったか」を確認
2. 前 holder の WAL を読み、 当該 lock scope に紐づく in-flight operation の
   現在 stage を判定
3. WAL stage に応じて recovery mode を選択 ([Lifecycle](./lifecycle.md) の
   `normal` / `continue` / `compensate` / `inspect`):
   - `prepare` で止まっていた → `normal` で resume (idempotency key で重複排除)
   - `commit` 半ばで止まっていた → `continue` で commit を最後まで進める
   - `commit` 完了 / `post-commit` 失敗 → `compensate` で `activation-rollback`
     RevokeDebt を発行
   - 状況不明 → `inspect` で差分 dump のみ

idempotency key は WAL の `(spaceId, operationPlanDigest, journalEntryId)` tuple
で、 再実行されても **副作用は重複しない** ことが保証される。

## SQL backed store requirement

production 配置 (kernel pod 数 >= 2) では SQL backed store が **必須**。

- `OperationPlanLockStore` の SQL 実装は `SELECT ... FOR UPDATE` および atomic
  `UPDATE ... WHERE epoch = ?` を使い、 cross-process serialization を保証する
- in-memory store は per-process Promise chain で直列化する。dev / unit test
  専用
- in-memory store を production で inject すると kernel boot 時に warning
  が出る。 warning を見逃さない運用が前提

複数 kernel pod が同 SQL store を share する constraint は読み取り
strict-consistent であること。 read replica や eventual consistent store
は不可。

## Lock 失効中の kernel 挙動

lock 失効が検出されると、 kernel は当該 lock scope の **mutation 系 operation
だけ** を pause / fail-closed する。 read path は影響を受けない。

| Path                              | lock 失効中の挙動                                                     |
| --------------------------------- | --------------------------------------------------------------------- |
| installer apply / rollback        | installer lease が空くまで wait。caller timeout / HTTP timeout が上限 |
| `POST /v1/lifecycle/activate`     | `cross_process_lock_busy` で 503                                      |
| `POST /v1/lifecycle/destroy`      | `cross_process_lock_busy` で 503                                      |
| `GET /v1/snapshots`               | 通常通り 200 (read path)                                              |
| `GET /v1/observe`                 | 通常通り 200 (observation worker は別 lock)                           |
| runtime-agent describe            | 通常通り 200 (read path、lock-free)                                   |
| existing traffic (already-active) | 影響なし (Exposure routing は world view を direct read)              |

clients (CLI / operator UI) は `cross_process_lock_busy` を retry-after hint
付きで受け取り、 exponential backoff で retry する。

## Deadlock prevention

複数 lock を同時に保持する operation は **lock acquisition 順序を spaceId
ascending → scope ascending → key ascending に固定** する。

例: 2 つの Space `space-a` / `space-b` を跨ぐ namespace export を更新する場合、
acquire 順は

```
namespace-registry:space-a → namespace-registry:space-b
```

逆順は禁止。 kernel core はこの順序を assertion で強制する。 誤順序の acquire は
`cross_process_lock_invariant_broken` で fail-closed する (kernel bug detector
として動く)。

current v1 で cross-Space lock を取る operation:

- operator implementation config visibility update (複数 Space の visibility
  を同時更新する場合)

それ以外の operation は **single Space 内で完結** するため、 deadlock の心配は
ない。

## Related architecture notes

- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — lock と WAL stage の interplay、 idempotency tuple の derivation
- `docs/reference/architecture/execution-lifecycle.md` — lock 失効時の recovery
  mode 選定 rationale
- `docs/reference/architecture/operator-boundaries.md` — lock store の trust
  境界、 SQL backed 必須化の判断

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Storage Schema](./storage-schema.md)
- [Readiness Probes](./readiness-probes.md)
