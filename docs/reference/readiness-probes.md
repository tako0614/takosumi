# Readiness Probes

> Stability: stable
> Audience: operator
> See also: [Kernel HTTP API](/reference/kernel-http-api), [Lifecycle Protocol](/reference/lifecycle), [Cross-Process Locks](/reference/cross-process-locks), [Migration / Upgrade](/reference/migration-upgrade)

Takosumi v1 における readiness probe (`/readyz`) の正式仕様。kernel が
依存する port の dependency DAG、observation propagation、boot timeout、
failure cascade、operator から見える JSON response shape を定義する。
liveness probe との分離もここで明示する。

## `/readyz` semantic

`/readyz` は kernel が「現時点で deploy traffic / lifecycle dispatch を
受け付けられるか」を boolean として通知する HTTP endpoint である。

| Status     | HTTP        | 条件                                                  |
| ---------- | ----------- | ----------------------------------------------------- |
| ready      | `200 OK`    | 全依存 port が ready                                  |
| not ready  | `503 Service Unavailable` | 1 つでも依存 port が not ready             |
| booting    | `503 Service Unavailable` | bootstrap 進行中 (boot timeout 内)         |

response body (詳細は後述) には各依存 port の状態が含まれる。`200` を
返した時点でも individual port の `lastError` が null でない瞬間が
ありうるため、operator dashboard は body を読む前提で運用する。

`503` 時には `error.code = "readiness_probe_failed"` を返す。kernel HTTP API
の error envelope と整合する ([Kernel HTTP API](/reference/kernel-http-api))。

## Dependency DAG

readiness 判定は依存 port の有向非巡回グラフ (DAG) を bottom-up に評価
する。cycle は不変条件として禁止。

### Bootstrap order

kernel pod 起動時、以下の順序で port を bring up する。

```
storage
  └─> lock-store
        └─> secret-partition
              └─> catalog-release
                    └─> runtime-agent-registry
                          └─> public-listener
```

各 port は **直前 port が ready** に達するまで待機し、自身の ready
criterion を満たしたら次 port を起こす。

| Port                       | ready criterion                                                  |
| -------------------------- | ---------------------------------------------------------------- |
| `storage`                  | SQL ping (`SELECT 1`) 成功 / migration version が compat range 内 |
| `lock-store`               | lock store backend に書き込み + 読み戻し成功                     |
| `secret-partition`         | global / cloud-specific master passphrase resolver の derive 成功 |
| `catalog-release`          | 直近 active CatalogRelease の signature verify 成功              |
| `runtime-agent-registry`   | embedded agent (有る場合) の self-enrollment 成功 / external agent registry sync 完了 |
| `public-listener`          | TCP listener bind + TLS handshake (有効な場合) 成功              |

`public-listener` が ready になった時点で `/readyz` が `200` を返し、load
balancer に組み込まれる。

### Edge semantics

- 依存 port (parent) が `not ready` に陥ると、その下流 (child) はすべて
  `not ready` 扱い (cascade)
- 依存 port (parent) が transient に flap した場合、後述の flap detection
  で短期遷移を suppress する
- cycle は invariant として禁止。新 port を増やすときは
  `CONVENTIONS.md` §6 の RFC で DAG への配置を明示する

## Observation propagation

各 port の状態は observation worker が定期更新する。

- default observation interval: `10s` (env `TAKOSUMI_READINESS_INTERVAL_MS`
  で tuning 可能)
- 各 observation は `(port, status, lastCheckedAt, lastError)` を記録
- `/readyz` は **直近 observation を反映** するだけで、自身は I/O を
  起こさない (probe response は cheap)

### Flap detection

短期 transient による flap (1 観測周期だけ fail で次は成功) は
`/readyz` に伝播させない。具体的には:

- 連続 fail 回数 `>= 2` で `not ready` 判定 (default。env
  `TAKOSUMI_READINESS_FAIL_THRESHOLD` で調整可能)
- 連続 ok 回数 `>= 1` で `ready` 復帰

threshold は `1` 以上の整数に限る。`0` を指定しても `1` に clamp される。

### `lastCheckedAt` staleness

最新 observation から `3 * interval` を超えても観測が来ない port は
`stale` として扱い、`/readyz` 上は `not ready` に倒す。observation worker
が deadlock した場合の安全弁として動く。

## Boot timeout

各 port の bring up には `max wait` がある。超過は kernel exit + supervisor
(systemd / docker / k8s) restart に委ねる。

| Port                     | max wait     | 超過時 error code                |
| ------------------------ | ------------ | -------------------------------- |
| `storage`                | `30s`        | `boot_timeout_storage`           |
| `lock-store`             | `30s`        | `boot_timeout_lock_store`        |
| `secret-partition`       | `15s`        | `boot_timeout_secret_partition`  |
| `catalog-release`        | `60s`        | `boot_timeout_catalog_release`   |
| `runtime-agent-registry` | `60s`        | `boot_timeout_runtime_agent`     |
| `public-listener`        | `15s`        | `boot_timeout_public_listener`   |

operator は env で max wait を伸ばせる (`TAKOSUMI_BOOT_TIMEOUT_<PORT>_MS`)
が、伸ばすとロード時の MTTR が悪化するため default に近い値を推奨。

boot timeout で kernel exit する時、kernel は exit code `1` を返し、stderr
に失敗 port と最終 `lastError` を書き出す。

## Failure propagation

steady state での failure cascade rule:

- `storage` 失敗 → 全下流 `not ready` (storage 復旧で自動回復)
- `lock-store` 失敗 → mutation 系 endpoint は `cross_process_lock_busy` で
  fail-closed、`/readyz` は `not ready`
- `secret-partition` 失敗 (master passphrase resolver の derive 失敗) →
  catalog-release 以下が cascade で `not ready`
- `catalog-release` 失敗 (signature verify 失敗) → runtime-agent-registry
  以下が cascade。dispatch を停止
- `runtime-agent-registry` 失敗 → public-listener が `not ready`
- `public-listener` 失敗 → kernel pod が load balancer から外れる

cascading failure 防止の不変条件:

- DAG に **cycle は無い**。kernel boot 時に DAG validator が cycle 検出
  すれば即 fail-closed する (`readiness_dag_cycle_detected`)
- 依存方向は単一向き (parent → child)。child の状態は parent に伝搬しない

## Operator visibility

`/readyz` の JSON response body は以下の shape:

```json
{
  "status": "ready",
  "ports": [
    {
      "name": "storage",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    },
    {
      "name": "lock-store",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    },
    {
      "name": "secret-partition",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    },
    {
      "name": "catalog-release",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    },
    {
      "name": "runtime-agent-registry",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    },
    {
      "name": "public-listener",
      "status": "ready",
      "lastCheckedAt": "2026-05-05T01:23:45.000Z",
      "lastError": null
    }
  ],
  "kernel": {
    "version": "1.0.0",
    "schema": { "current": "1.0", "supportedRange": ["1.0", "1.0"] }
  }
}
```

`status` は `ready` / `not-ready` / `booting` の closed enum。`ports` の
順序は DAG bottom-up (`storage` 先頭、`public-listener` 末尾)。

`not ready` 時は `503` で同形 body を返し、failing port の `status` /
`lastError` を埋める。クライアントは `lastError.code` を見て対処を決める。

## Liveness との分離

`/readyz` は **readiness のみ** を扱う。kernel の liveness は別 endpoint
(`/livez`) で扱い、本 reference の対象外である。

| Endpoint   | 役割                              | 失敗時の supervisor 期待動作            |
| ---------- | --------------------------------- | --------------------------------------- |
| `/readyz`  | traffic を受けてよいか             | load balancer から外す (process は維持)  |
| `/livez`   | process が生存しているか           | process を再起動                         |

`/readyz` を liveness 用途で使うと、依存 port の transient failure で
kernel が無限再起動 loop に陥るため禁止。supervisor の liveness probe は
必ず `/livez` を使う。

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/operator-boundaries.md` — readiness DAG が kernel core /
  runtime-agent / public-listener の trust 境界に沿う rationale
- `docs/design/execution-lifecycle.md` — readiness と lifecycle phase の
  interplay、boot recovery 経路の選定背景
- `docs/design/operational-hardening-checklist.md` — readiness を運用
  signal として活用する checklist
