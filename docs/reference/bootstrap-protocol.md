# Bootstrap Protocol

> Stability: stable Audience: operator See also: [CLI](/reference/cli),
> [Environment Variables](/reference/env-vars),
> [Storage Schema](/reference/storage-schema),
> [Secret Partitions](/reference/secret-partitions),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Catalog Release Trust](/reference/catalog-release-trust),
> [Audit Events](/reference/audit-events),
> [Migration / Upgrade](/reference/migration-upgrade),
> [Readiness Probes](/reference/readiness-probes)

Takosumi kernel の **初回起動 (new install)** における bootstrap 手順の 正本。本
reference は new install のみを対象とし、既存 install の upgrade は
[Migration / Upgrade](/reference/migration-upgrade) が扱う。

Bootstrap は次を担う。

- Storage の schema migration を初期化状態まで進める
- Secret partition と master key を init する
- Cross-process lock store を init する
- Default operator account を発行し token を operator に渡す
- Initial CatalogRelease を adopt する
- Default Space (`space:default`) を生成する
- Audit chain の genesis event を書く
- Listener を open する

Bootstrap は kernel の **初回 1 回のみ** 実行される。完了後の再起動では audit
chain の genesis event を確認し、bootstrap 段階を skip する。

## Bootstrap stage 順序

| 順 | Stage                         | 失敗時挙動                  |
| -- | ----------------------------- | --------------------------- |
| 1  | storage-init                  | exit + supervisor restart   |
| 2  | secret-partition-init         | exit + supervisor restart   |
| 3  | lock-store-init               | exit + supervisor restart   |
| 4  | default-operator-account-init | exit (token 発行前で abort) |
| 5  | catalog-release-adopt         | exit + supervisor restart   |
| 6  | default-space-create          | exit + supervisor restart   |
| 7  | audit-genesis                 | exit + supervisor restart   |
| 8  | listener-open                 | exit + supervisor restart   |

各 stage 完了で audit event を書く (後述)。Stage 5–7 は単一の cross-process lock
下で直列化される (multi-pod bootstrap 参照)。

## Stage 1 — storage-init

Backing store (file / object store / DB) に対し schema migration を up
方向に走らせ、現行 kernel version の schema 版に揃える。

- Storage が空 (initial) の場合のみ bootstrap path に入る
- Storage に既存 data がある場合は bootstrap を **skip** し、Migration / Upgrade
  path に切り替わる ([Migration / Upgrade](/reference/migration-upgrade))
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
sealed envelope に保存する。Auto-generate は **explicit confirm flag**
(`TAKOSUMI_BOOTSTRAP_ALLOW_AUTO_KEY=1`) が ある場合のみ許可される。Default
は禁止。

詳細は [Secret Partitions](/reference/secret-partitions)。

## Stage 3 — lock-store-init

Cross-process lock backend を初期化する。Bootstrap lock 自身もここで
初めて取得される。

- Default backend は kernel storage backend と同じ
- Operator が `TAKOSUMI_LOCK_BACKEND` で別 store を指定可能
- 初期化後 `bootstrap` 名義で TTL 60s の lock を取得し、stage 5–7 を serialize
  する

詳細は [Cross-Process Locks](/reference/cross-process-locks)。

## Stage 4 — default-operator-account-init

Bootstrap 完了後に operator が kernel を操作するための初期 credential
を発行する。

- Account id: `operator:bootstrap` (固定)
- Token は 32 byte ランダム + Base64URL encoding
- Token の **平文** は kernel stdout に **1 度だけ** 出力する
- Token hash のみが storage に永続化される
- 既に default operator account が存在する場合は bootstrap 全体が abort される
  (re-init 防止)

CLI 経由 (`takosumi init`) で起動すると、token は CLI 側にも copy される ので
scrolloff 後の取り戻しも可能。HTTP server を直接起動した場合は stdout のみ。

## Stage 5 — catalog-release-adopt

Initial CatalogRelease を adopt する。

優先順:

1. `--catalog <path>` flag (`takosumi init`) で operator-supplied CatalogRelease
   を渡す
2. `TAKOSUMI_BOOTSTRAP_CATALOG_PATH` env で同様に渡す
3. Embedded default catalog (kernel binary に内蔵)

Operator-supplied の場合、signature 検証は
[Catalog Release Trust](/reference/catalog-release-trust) に従う。 検証失敗で
stage abort。

Embedded default catalog は kernel build 時の signing key で署名済。 Trust
anchor として default key が enrolled される。

## Stage 6 — default-space-create

Default Space `space:default` を生成する。

- Operator が `--no-default-space` で opt out 可能
- Opt out の場合 stage 6 は skip され、operator が後で internal Space API または
  operator automation で Space を作成する必要がある。Current public `takosumi`
  CLI は `space create` command を公開していない。
- Generate された Space は initial CatalogRelease に bind される
- Default Space の name policy は permissive (operator 後で締める)

## Stage 7 — audit-genesis

Audit chain の最初の event を書く。Genesis event は親 hash を `null` と
する唯一の entry で、後続の audit chain はすべてこれを root とする hash chain
で連鎖する。

書かれる event:

```text
kernel-bootstrap-started
storage-initialized
secret-partition-initialized
lock-store-initialized
default-operator-account-created
catalog-release-adopted
default-space-created               (opt out 時は省略)
kernel-bootstrap-completed
```

各 event は kernel buildVersion / schemaVersion / hostname / pid を 含む。Event
schema は [Audit Events](/reference/audit-events) に従う。

## Stage 8 — listener-open

Public deploy / internal control / runtime-agent / discovery ports を open
する。Bootstrap 完了前は `/readyz` は 503 を返し続ける。

`/livez` は stage 1 完了から 200 を返す (process alive)。

## Bootstrap timeout

各 stage には timeout が設定されている。

| Stage                         | Default timeout |
| ----------------------------- | --------------- |
| storage-init                  | 120s            |
| secret-partition-init         | 30s             |
| lock-store-init               | 30s             |
| default-operator-account-init | 5s              |
| catalog-release-adopt         | 60s             |
| default-space-create          | 5s              |
| audit-genesis                 | 5s              |
| listener-open                 | 10s             |

Timeout 超過は当該 stage を abort し、process exit code 71
(`bootstrap-stage-timeout`)。Supervisor が再起動するが、partial 状態
が残っている場合は次回起動で recovery path に入る (idempotency 参照)。

## Idempotency

Bootstrap は再起動で重複実行されない。

- Stage 7 の `kernel-bootstrap-completed` event が audit chain に 存在すれば
  bootstrap は **skip** される
- 中途 abort された install (例えば stage 5 で失敗し再起動) では、 audit chain
  に `kernel-bootstrap-completed` がないので bootstrap が 再走する
- Stage 1–6 は個別に idempotent (storage migration は up step が再走 しても
  no-op、secret partition は既存 envelope を尊重、lock store は既存 row を
  upsert、default operator account / catalog release / default space は
  existence check で skip)

## CLI Exposure

Current `takosumi init` scaffolds a Manifest file; it does **not** run this
bootstrap protocol. Bootstrap is currently driven by kernel startup /
operator-managed deployment automation and internal services.

The current public CLI surface is documented in [CLI](/reference/cli). It has
`takosumi init [<output>] [--template <name>]` only.

If a future operator bootstrap CLI is added, this reference must be updated with
the exact command, flags, exit codes, and tests before documenting it as a
supported operator workflow.

## Multi-pod bootstrap

複数 kernel pod が同時に起動する deployment では、bootstrap は **1 pod
のみが実行**する。

- 各 pod は stage 3 後に `bootstrap` lock の取得を試みる
- Lock を取得した pod が stage 4–7 を実行
- Lock を取れなかった pod は genesis event の出現まで poll する (poll 間隔 1s,
  max 10 min)
- Genesis event を観測した pod は stage 8 (listener-open) に進む
- 10 min の timeout を超えた pod は exit code 75 (`bootstrap-wait-timeout`) で
  abort

Lock holder pod が途中 crash した場合、TTL 60s 経過後に他 pod が lock
を引き継ぐ。引き継いだ pod は stage 4 から再走する (idempotency 保証下で no-op
or 続行)。

## Bootstrap audit events

| Event id                           | Stage                     |
| ---------------------------------- | ------------------------- |
| `kernel-bootstrap-started`         | 1 開始                    |
| `storage-initialized`              | 1 完了                    |
| `secret-partition-initialized`     | 2 完了                    |
| `lock-store-initialized`           | 3 完了                    |
| `default-operator-account-created` | 4 完了                    |
| `catalog-release-adopted`          | 5 完了                    |
| `default-space-created`            | 6 完了 (opt out 時は省略) |
| `kernel-bootstrap-completed`       | 7 完了                    |

`kernel-bootstrap-completed` の payload に bootstrap 完了 wall clock / duration
を含める。

## Bootstrap と Migration / Upgrade の関係

| 状況                          | 走る path                       |
| ----------------------------- | ------------------------------- |
| Storage が完全に空            | bootstrap                       |
| Genesis event あり、新 kernel | upgrade                         |
| Genesis event なし、partial   | bootstrap (idempotent recovery) |

Bootstrap は **new install 専用**。Schema migration の cross-version
semantics、kernel ↔ runtime-agent skew、rollback gate は
[Migration / Upgrade](/reference/migration-upgrade) で扱う。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md`
- `docs/reference/architecture/snapshot-model.md`
- `docs/reference/architecture/catalog-release-descriptor-model.md`
- `docs/reference/architecture/space-model.md`
- `docs/reference/architecture/operational-hardening-checklist.md`
