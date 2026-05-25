# Reference Kernel Bootstrap Protocol

reference Takosumi kernel implementation の new install (初回起動) bootstrap
手順をまとめる。本ページは new install 専用。既存 install の upgrade は
[Schema Evolution](./migration-upgrade.md) を参照。

Kernel bootstrap が担うこと:

- kernel storage の schema migration を初期化状態まで進める
- secret partition と master key を init する
- cross-process lock store を init する
- reference operator credential を発行し token を operator に渡す
- operator implementation binding / kind alias / connector inventory を確認する
- audit chain の genesis event を書く
- listener を open する

Bootstrap は reference kernel の **初回 1 回のみ** 実行される。operator account
plane が必要とする Default Space などの account-plane records は operator
bootstrap が作成し、kernel には scoped installer context / policy snapshot
として渡される。完了後の再起動では audit chain の genesis event を確認して
kernel bootstrap stage を skip する。

## Bootstrap stage 順序

| 順 | Stage                              | 失敗時挙動                  |
| -- | ---------------------------------- | --------------------------- |
| 1  | storage-init                       | exit + supervisor restart   |
| 2  | secret-partition-init              | exit + supervisor restart   |
| 3  | lock-store-init                    | exit + supervisor restart   |
| 4  | bootstrap-operator-credential-init | exit (token 発行前で abort) |
| 5  | operator-implementation-load       | exit + supervisor restart   |
| 6  | audit-genesis                      | exit + supervisor restart   |
| 7  | listener-open                      | exit + supervisor restart   |

各 stage 完了で audit event を書く (後述)。Stage 4–7 は単一の cross-process lock
下で直列化される (multi-pod bootstrap 参照)。

## Stage 1 — storage-init

Backing store (file / object store / DB) に対し schema migration を up
方向に走らせ、現行 kernel version の schema 版に揃える。

- Storage が空 (initial) の場合のみ bootstrap path に入る
- Storage に既存 data がある場合は bootstrap を **skip** し、Schema Evolution
  path に切り替わる ([Schema Evolution](./migration-upgrade.md))
- Schema migration は idempotent な up step で構成される

## Stage 2 — secret-partition-init

Master key を解決する。

| Source                          | 優先 | 用途                                     |
| ------------------------------- | ---- | ---------------------------------------- |
| `TAKOSUMI_MASTER_KEY` env       | 1    | Operator 既知 key を inject する場合     |
| `TAKOSUMI_MASTER_KEY_FILE` path | 2    | mounted file 経由                        |
| Cloud KMS handle                | 3    | KMS-managed key (env で handle 指定)     |
| Auto-generate                   | 4    | None of the above。生成 + storage 永続化 |

Auto-generate の場合、kernel は 256-bit ランダム値を生成し、 secret partition の
sealed envelope に保存する。 Auto-generate は **explicit confirm flag**
(`TAKOSUMI_BOOTSTRAP_ALLOW_AUTO_KEY=1`) がある場合のみ許可される。Default
は禁止。

詳細は [Secret Partitions](./secret-partitions.md)。

## Stage 3 — lock-store-init

Cross-process lock backend を初期化する。 Bootstrap lock
自身もここで初めて取得される。

- Default backend は kernel storage backend と同じ
- Operator が `TAKOSUMI_LOCK_BACKEND` で別 store を指定可能
- 初期化後 `bootstrap` 名義で TTL 60s の lock を取得し、stage 4–7 を serialize
  する

詳細は [Cross-Process Locks](./cross-process-locks.md)。

## Stage 4 — bootstrap-operator-credential-init

Bootstrap 完了後に operator が kernel を操作するための初期 credential
を発行する。

- Account id: `operator:bootstrap` (固定)
- Token は 32 byte ランダム + Base64URL encoding
- Token の **平文** は kernel stdout に **1 度だけ** 出力する
- Token hash のみが storage に永続化される
- 既に bootstrap operator credential が存在する場合は stage 4 を skip し、 token
  平文は再出力しない (re-init 防止)

将来 operator bootstrap CLI を追加する場合は、token を CLI 側にも copy して
scrolloff 後に取り戻せるようにしてよい。現在の public `takosumi` CLI は AppSpec
deploy engine であり、operator bootstrap は operator distribution の init flow
として扱う。

## Stage 5 — operator-implementation-load

operator distribution が kernel 起動時に渡した `kindAliases`、implementation
binding、runtime-agent connector inventory を検証する。

- production / staging では selected implementation が 1 つ以上必要
- short alias は operator-provided `kindAliases` にあるものだけ解決される
- 同じ kind URI を複数 reference adapter が提供し、operator profile / Space
  policy でも一意に選べない場合は stage abort

operator distribution が通常の TypeScript module として provider package を
import し、reference kernel では reference adapter array (`plugins` option) に渡
す。詳細は [Reference Adapter Loading](./plugin-loading.md)。

## Stage 6 — audit-genesis

Audit chain の最初の event を書く。 Genesis event は親 hash を `null`
とする唯一の entry で、後続の audit chain はすべてこれを root とする hash chain
で連鎖する。

書かれる event:

```text
kernel-bootstrap-started
storage-initialized
secret-partition-initialized
lock-store-initialized
bootstrap-operator-credential-created
operator-implementations-loaded
kernel-bootstrap-completed
```

各 event は kernel buildVersion / schemaVersion / hostname / pid を含む。 Event
schema は [Audit Events](./audit-events.md) に従う。

## Stage 7 — listener-open

Installer API / internal control / runtime-agent control / discovery ports を
operator profile の role 設定に従って open する。Bootstrap 完了前は `/readyz` は
503 を返し続ける。

`/livez` は stage 1 完了から 200 を返す (process alive)。

## Bootstrap timeout

各 stage には timeout が設定されている。

| Stage                              | Default timeout |
| ---------------------------------- | --------------- |
| storage-init                       | 120s            |
| secret-partition-init              | 30s             |
| lock-store-init                    | 30s             |
| bootstrap-operator-credential-init | 5s              |
| operator-implementation-load       | 30s             |
| audit-genesis                      | 5s              |
| listener-open                      | 10s             |

Timeout 超過は当該 stage を abort し、process exit code 71
(`bootstrap-stage-timeout`)。 Supervisor が再起動するが、partial
状態が残っている場合は次回起動で recovery path に入る (idempotency 参照)。

## Idempotency

Bootstrap は再起動で重複実行されない。

- Stage 6 の `kernel-bootstrap-completed` event が audit chain に存在すれば
  bootstrap は **skip** される
- 中途 abort された install (例えば stage 5 で失敗し再起動) では、 audit chain
  に `kernel-bootstrap-completed` が無いので bootstrap が再走する
- Stage 1–5 は個別に idempotent: storage migration は up step が再走しても
  no-op、 secret partition は既存 envelope を尊重、 lock store は既存 row を
  upsert、 bootstrap operator credential / operator implementation evidence は
  existence check で skip

## CLI Exposure

public な `takosumi` CLI は AppSpec deploy engine であり、この bootstrap
protocol を **実行しない**。 bootstrap は現在、 kernel 起動 / operator
管理のデプロイ自動化 / 内部サービスによって駆動される。

現行 public CLI surface は [CLI](./cli.md) に文書化されている。

将来 operator 向け bootstrap CLI が追加される場合は、サポートされる operator
workflow として文書化する前に、本リファレンスを正確なコマンド / flag / exit code
/ test と共に更新しなければならない。

## Multi-pod bootstrap

複数 kernel pod が同時に起動する deployment では、 bootstrap は **1 pod
のみが実行** する。

- 各 pod は stage 3 後に `bootstrap` lock の取得を試みる
- Lock を取得した pod が stage 4–7 を実行
- Lock を取れなかった pod は genesis event の出現まで poll する (poll 間隔 1s,
  max 10 min)
- Genesis event を観測した pod は stage 7 (listener-open) に進む
- 10 min の timeout を超えた pod は exit code 75 (`bootstrap-wait-timeout`) で
  abort

Lock holder pod が途中 crash した場合、 TTL 60s 経過後に他 pod が lock
を引き継ぐ。引き継いだ pod は stage 4 から再走する (idempotency 保証下で no-op
or 続行)。

## Bootstrap audit events

| Event id                                | Stage  |
| --------------------------------------- | ------ |
| `kernel-bootstrap-started`              | 1 開始 |
| `storage-initialized`                   | 1 完了 |
| `secret-partition-initialized`          | 2 完了 |
| `lock-store-initialized`                | 3 完了 |
| `bootstrap-operator-credential-created` | 4 完了 |
| `operator-implementations-loaded`       | 5 完了 |
| `kernel-bootstrap-completed`            | 7 完了 |

`kernel-bootstrap-completed` の payload に bootstrap 完了 wall clock / duration
を含める。

## Bootstrap と Schema Evolution の関係

| 状況                          | 走る path                       |
| ----------------------------- | ------------------------------- |
| Storage が完全に空            | bootstrap                       |
| Genesis event あり、新 kernel | upgrade                         |
| Genesis event なし、partial   | bootstrap (idempotent recovery) |

Bootstrap は **new install 専用**。 Schema migration の cross-version
semantics、 kernel ↔ runtime-agent skew、 rollback gate は
[Schema Evolution](./migration-upgrade.md) で扱う。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md`
- `docs/reference/architecture/snapshot-model.md`
- `docs/reference/architecture/space-model.md`
- `docs/reference/architecture/operational-hardening-checklist.md`

## 関連ページ

- [CLI](./cli.md)
- [Environment Variables](./env-vars.md)
- [Storage Schema](./storage-schema.md)
- [Secret Partitions](./secret-partitions.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Audit Events](./audit-events.md)
- [Schema Evolution](./migration-upgrade.md)
- [Readiness Probes](./readiness-probes.md)
