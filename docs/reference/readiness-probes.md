# Readiness Probes

> このページでわかること: `/readyz` の現行 response shape と、port-level
> readiness design model。

## 実装スコープ

`createPaaSApp()` が `/readyz` を mount し、 request ごとに lightweight check
を実行します:

- `role`: runtime config role と process role の一致
- `storage`: storage adapter transaction の成功
- `plugins`: reference kernel adapter array status。production / staging で 1
  つ以上あること
- `internalApiSecret`: `takosumi-api` / `takosumi-runtime-agent` role では
  `TAKOSUMI_INTERNAL_API_SECRET` が設定されていること
- `workerDaemon`: `takosumi-worker` role では worker daemon が起動済 + 初回 tick
  完了。 起動済だが初回 tick 前は `state: "booting"`

`/readyz` の current wire contract は `checks` object と
`readiness_probe_failed` error envelope です。Port-level observation worker /
flap suppression / boot timeout code / `ports[]` は operator-facing design model
として 扱います。

## `/readyz` semantic

`/readyz` は kernel が deploy traffic / lifecycle dispatch を受け付けられるか を
boolean 通知する endpoint。

| Status    | HTTP                      | 条件                       |
| --------- | ------------------------- | -------------------------- |
| ready     | `200 OK`                  | `checks` がすべて成功      |
| not ready | `503 Service Unavailable` | 1 つ以上の `checks` が失敗 |
| booting   | `503 Service Unavailable` | 起動中 check のみが未完了  |

response body には `checks` object が含まれます。 `200` は body をそのまま返
し、 `503` は kernel HTTP API error envelope に probe result を `error.details`
として埋めて返します。

`503` 時の `error.code` は `readiness_probe_failed`
([Kernel HTTP API](./kernel-http-api.md))。

> port-level readiness 判定は依存 port の DAG を bottom-up 評価する design model
> です。現在の `/readyz` output には `ports[]` を出さず、公開互換性は `checks`
> object に限定します。cycle は不変条件として禁止。

### Port-level Design Model

port-level readiness model では、 kernel pod 起動時に次の順序で port を bring up
します。この節は operator / contributor 向けの設計語彙です。

```
storage
  └─> lock-store
        └─> secret-partition
              └─> implementation-bootstrap
                    └─> runtime-agent-registry
                          └─> public-listener
```

各 port は直前 port が ready に達するまで待機し、 自身の ready criterion を
満たしたら次 port を起こします。

| Port                       | ready criterion                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `storage`                  | SQL ping (`SELECT 1`) 成功 / migration version が compat range 内                     |
| `lock-store`               | lock store backend に書き込み + 読み戻し成功                                          |
| `secret-partition`         | global / cloud-specific master passphrase resolver の derive 成功                     |
| `implementation-bootstrap` | operator-provided `kindAliases` / reference adapter array の parse と重複検査が成功   |
| `runtime-agent-registry`   | embedded agent (有る場合) の self-enrollment 成功 / external agent registry sync 完了 |
| `public-listener`          | TCP listener bind + TLS handshake (有効な場合) 成功                                   |

port-level 実装では `public-listener` が ready になった時点で `/readyz` が `200`
を返し load balancer に組み込まれます。

### Edge semantics

- parent port が `not ready` に陥ると child は全て `not ready` (cascade)
- parent が transient に flap した場合、 後述の flap detection で短期遷移を
  suppress
- cycle は invariant として禁止。 新 port 追加は `CONVENTIONS.md` §6 RFC で DAG
  配置を明示

port-level readiness では observation worker が各 port 状態を定期更新します。
現行は request 時 inline checks のみで、 次の env / worker semantics は未公開
contract です:

- default observation interval: `10s` (env `TAKOSUMI_READINESS_INTERVAL_MS` で
  tuning)
- 各 observation は `(port, status, lastCheckedAt, lastError)` を記録
- `/readyz` は直近 observation を反映するだけで自身は I/O を起こさない (cheap)

### Flap detection

短期 transient による flap (1 周期 fail で次 ok) は `/readyz` に伝播させませ ん:

- 連続 fail >= 2 で `not ready` (default。 env
  `TAKOSUMI_READINESS_FAIL_THRESHOLD` 調整可)
- 連続 ok >= 1 で `ready` 復帰

threshold は 1 以上の整数。 `0` 指定でも `1` に clamp。

### `lastCheckedAt` staleness

最新 observation から `3 * interval` を超えても観測が来ない port は `stale`
として `/readyz` 上 `not ready` に倒します (observation worker deadlock の
安全弁)。

port-level readiness model では各 port bring up に max wait を持たせます。 現行
`/readyz` は request-time inline checks を返します。次の timeout table は
port-level design model の値です。

| Port                       | max wait | 超過時 error code                       |
| -------------------------- | -------- | --------------------------------------- |
| `storage`                  | `30s`    | `boot_timeout_storage`                  |
| `lock-store`               | `30s`    | `boot_timeout_lock_store`               |
| `secret-partition`         | `15s`    | `boot_timeout_secret_partition`         |
| `implementation-bootstrap` | `30s`    | `boot_timeout_implementation_bootstrap` |
| `runtime-agent-registry`   | `60s`    | `boot_timeout_runtime_agent`            |
| `public-listener`          | `15s`    | `boot_timeout_public_listener`          |

operator は env (`TAKOSUMI_BOOT_TIMEOUT_<PORT>_MS`) で max wait を伸ばせます
が、 MTTR が悪化するため default 近傍推奨。

boot timeout で kernel exit する時、 exit code `1` を返し、 stderr に失敗 port
と最終 `lastError` を書き出します。

Steady state failure cascade:

- `storage` 失敗 → 全下流 `not ready` (storage 復旧で自動回復)
- `lock-store` 失敗 → mutation 系 endpoint は `cross_process_lock_busy` で
  fail-closed、 `/readyz` は `not ready`
- `secret-partition` 失敗 (master passphrase derive 失敗) →
  implementation-bootstrap 以 下が cascade
- `implementation-bootstrap` 失敗 (reference adapter array parse / duplicate
  provider / alias 解決設定不正) → runtime-agent-registry 以下 cascade。
  dispatch 停止
- `runtime-agent-registry` 失敗 → public-listener が `not ready`
- `public-listener` 失敗 → kernel pod が load balancer から外れる

不変条件:

- DAG に cycle は無い。 boot 時 DAG validator が cycle 検出すれば即 fail-closed
  (`readiness_dag_cycle_detected`)
- 依存方向は単方向 (parent → child)。 child の状態は parent に伝搬しない

## Current Operator visibility

`/readyz` `200` JSON response body:

```json
{
  "ok": true,
  "state": "ready",
  "service": "takosumi",
  "role": "takosumi-api",
  "checkedAt": "2026-05-05T01:23:45.000Z",
  "checks": {
    "role": "takosumi-api",
    "storage": "ok",
    "plugins": { "selected": 1, "strict": true },
    "internalApiSecret": "configured"
  }
}
```

`takosumi-worker` role では `checks.workerDaemon` も入ります。 失敗 check は
`{ "ok": false, "error": "<message>" }` になり、 top-level result に `reason`
が追加されます。

`not ready` 時は `503` で次の error envelope:

```json
{
  "error": {
    "code": "readiness_probe_failed",
    "message": "internalApiSecret: TAKOSUMI_INTERNAL_API_SECRET is required",
    "details": {
      "ok": false,
      "state": "not-ready",
      "service": "takosumi",
      "role": "takosumi-api",
      "checkedAt": "2026-05-05T01:23:45.000Z",
      "checks": {
        "role": "takosumi-api",
        "storage": "ok",
        "plugins": { "selected": 0, "strict": false },
        "internalApiSecret": {
          "ok": false,
          "error": "TAKOSUMI_INTERNAL_API_SECRET is required"
        }
      },
      "reason": "internalApiSecret: TAKOSUMI_INTERNAL_API_SECRET is required"
    }
  }
}
```

## Liveness との分離

`/readyz` は readiness のみ。 kernel liveness は `/livez` で扱い、 本 reference
の対象外です。

| Endpoint  | 役割                     | 失敗時の supervisor 期待動作            |
| --------- | ------------------------ | --------------------------------------- |
| `/readyz` | traffic を受けてよいか   | load balancer から外す (process は維持) |
| `/livez`  | process が生存しているか | process を再起動                        |

::: warning `/readyz` を liveness 用途に使うと依存 port の transient failure で
kernel が無限再起動 loop に陥るため禁止。 supervisor の liveness probe は 必ず
`/livez`。 :::

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operator-boundaries.md` — readiness DAG が kernel
  core / runtime-agent / public-listener の trust 境界に沿う rationale
- `docs/reference/architecture/execution-lifecycle.md` — readiness と lifecycle
  phase の interplay、boot recovery 経路の選定背景
- `docs/reference/architecture/operational-hardening-checklist.md` — readiness
  を運用 signal として活用する checklist

## 関連ページ

- [Kernel HTTP API](./kernel-http-api.md)
- [Lifecycle Protocol](./lifecycle.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Schema Evolution](./migration-upgrade.md)
