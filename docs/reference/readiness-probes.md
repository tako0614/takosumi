# Readiness Probes

## `/readyz` semantic

`/readyz` は Takosumi control plane が installer / internal lifecycle request と runtime-agent dispatch を受け付けられるかを boolean 通知する endpoint。workload の public ingress readiness は Exposure health / provider observation 側で扱い、 `/readyz` の対象ではありません。

| State       | HTTP                      | 条件                       |
| ----------- | ------------------------- | -------------------------- |
| `ready`     | `200 OK`                  | `checks` がすべて成功      |
| `not-ready` | `503 Service Unavailable` | 1 つ以上の `checks` が失敗 |
| `booting`   | `503 Service Unavailable` | 起動中 check のみが未完了  |

response body には `checks` object が含まれます。 `200` は body をそのまま返し、 `503` は Takosumi HTTP API のエラーレスポンスに probe result を `error.details` として埋めて返します。

`503` 時の `error.code` は `readiness_probe_failed` ([Reference Route Inventory](./service-http-api.md))。

## Current operator visibility

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
    "implementationBindings": { "selected": 1, "strict": true },
    "internalApiSecret": "configured"
  }
}
```

`takosumi-worker` role では `checks.workerDaemon` も入ります。失敗 check は `{ "ok": false, "error": "<message>" }` になり、 top-level result に `reason` が追加されます。

`not-ready` 時は `503` で次のエラーレスポンス:

```json
{
  "error": {
    "code": "readiness_probe_failed",
    "message": "internalApiSecret: TAKOSUMI_INTERNAL_API_SECRET is required",
    "requestId": "req_01HX...",
    "details": {
      "ok": false,
      "state": "not-ready",
      "service": "takosumi",
      "role": "takosumi-api",
      "checkedAt": "2026-05-05T01:23:45.000Z",
      "checks": {
        "role": "takosumi-api",
        "storage": "ok",
        "implementationBindings": { "selected": 0, "strict": false },
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

`/readyz` は readiness のみ。 Takosumi liveness は `/livez` で扱います。

| Endpoint  | 役割                                 | 失敗時の supervisor 期待動作                               |
| --------- | ------------------------------------ | ---------------------------------------------------------- |
| `/readyz` | control-plane request を受けてよいか | operator ingress / load balancer から外す (process は維持) |
| `/livez`  | process が生存しているか             | process を再起動                                           |

::: warning
`/readyz` を liveness 用途に使うと依存 port の transient failure で Takosumi が無限再起動 loop に陥るため禁止。 supervisor の liveness probe は必ず `/livez`。
:::

## Reference implementation checks

`createTakosumiService()` が `/readyz` を mount し、 request ごとに lightweight check を実行します:

- `role`: runtime config role と process role の一致
- `storage`: storage adapter transaction の成功
- `implementationBindings`: selected binding status。Takosumi reference 実装では reference adapter count と strict mode を implementation detail として表示する
- `internalApiSecret`: `takosumi-api` / `takosumi-runtime-agent` role では `TAKOSUMI_INTERNAL_API_SECRET` が設定されていること
- `workerDaemon`: `takosumi-worker` role では worker daemon が起動済 + 初回 tick 完了。起動済だが初回 tick 前は `state: "booting"`

`/readyz` の current wire contract は `checks` object と `readiness_probe_failed` エラーレスポンスです。Port-level observation worker / flap suppression / boot timeout code / `ports[]` は operator-facing design model として扱います。

> port-level readiness 判定は依存 port の DAG を bottom-up 評価する design model です。現在の `/readyz` output には `ports[]` を出さず、公開互換性は `checks` object に限定します。cycle は不変条件として禁止。

### Port-level Design Model

port-level readiness model では、 Takosumi control-plane process 起動時に次の順序で port を bring up します。この節は operator / contributor 向けの設計語彙です。

```
storage
  └─> lock-store
        └─> secret-partition
              └─> implementation-bootstrap
                    └─> runtime-agent-registry
                          └─> control-plane-listener
```

各 port は直前 port が ready に達するまで待機し、自身の ready criterion を満たしたら次 port を起こします。

| Port                       | ready criterion                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `storage`                  | SQL ping (`SELECT 1`) 成功 / migration version が compat range 内                     |
| `lock-store`               | lock store backend に書き込み + 読み戻し成功                                          |
| `secret-partition`         | global / tag-specific master passphrase resolver の derive 成功                       |
| `implementation-bootstrap` | operator-provided adapter / PlatformService resolver set の parse と重複検査が成功   |
| `runtime-agent-registry`   | embedded agent (有る場合) の self-enrollment 成功 / external agent registry sync 完了 |
| `control-plane-listener`   | Takosumi API listener bind + TLS handshake (有効な場合) 成功                          |

port-level 実装では `control-plane-listener` が ready になった時点で `/readyz` が `200` を返し、Takosumi control-plane endpoint が operator ingress / load balancer に組み込まれます。

### Edge semantics

- parent port が `not-ready` に陥ると child は全て `not-ready` (cascade)
- parent が transient に flap した場合、後述の flap detection で短期遷移を suppress
- cycle は invariant として禁止。新 port 追加は `CONVENTIONS.md` §6 RFC で DAG 配置を明示

port-level readiness では observation worker が各 port 状態を定期更新します。現行は request 時 inline checks のみで、次の env / worker semantics は未公開 contract です:

- default observation interval: `10s` (env `TAKOSUMI_READINESS_INTERVAL_MS` で tuning)
- 各 observation は `(port, status, lastCheckedAt, lastError)` を記録
- `/readyz` は直近 observation を反映するだけで自身は I/O を起こさない (cheap)

### Flap detection

短期 transient による flap (1 周期 fail で次 ok) は `/readyz` に伝播させません:

- 連続 fail >= 2 で `not-ready` (default。 env `TAKOSUMI_READINESS_FAIL_THRESHOLD` 調整可)
- 連続 ok >= 1 で `ready` 復帰

threshold は 1 以上の整数。 `0` 指定でも `1` に clamp。

### `lastCheckedAt` staleness

最新 observation から `3 * interval` を超えても観測が来ない port は `stale` として `/readyz` 上 `not-ready` に倒します (observation worker deadlock の安全弁)。

port-level readiness model では各 port bring up に max wait を持たせます。現行 `/readyz` は request-time inline checks を返します。次の timeout table は port-level design model の値です。

| Port                       | max wait | 超過時 error code                       |
| -------------------------- | -------- | --------------------------------------- |
| `storage`                  | `30s`    | `boot_timeout_storage`                  |
| `lock-store`               | `30s`    | `boot_timeout_lock_store`               |
| `secret-partition`         | `15s`    | `boot_timeout_secret_partition`         |
| `implementation-bootstrap` | `30s`    | `boot_timeout_implementation_bootstrap` |
| `runtime-agent-registry`   | `60s`    | `boot_timeout_runtime_agent`            |
| `control-plane-listener`   | `15s`    | `boot_timeout_control_plane_listener`   |

operator は env (`TAKOSUMI_BOOT_TIMEOUT_<PORT>_MS`) で max wait を伸ばせますが、 MTTR が悪化するため default 近傍推奨。

boot timeout で Takosumi exit する時、 exit code `1` を返し、 stderr に失敗 port と最終 `lastError` を書き出します。

Steady state failure cascade:

- `storage` 失敗→全下流 `not-ready` (storage 復旧で自動回復)
- `lock-store` 失敗→ mutation 系 endpoint は `cross_process_lock_busy` で fail-closed、 `/readyz` は `not-ready`
- `secret-partition` 失敗 (master passphrase derive 失敗) → implementation-bootstrap 以下が cascade
- `implementation-bootstrap` 失敗 (binding set parse / duplicate provider / alias 解決設定不正) → runtime-agent-registry 以下 cascade。 dispatch 停止
- `runtime-agent-registry` 失敗→ control-plane-listener が `not-ready`
- `control-plane-listener` 失敗→ Takosumi control-plane endpoint が operator ingress / load balancer から外れる

不変条件:

- DAG に cycle は無い。 boot 時 DAG validator が cycle 検出すれば即 fail-closed (`readiness_dag_cycle_detected`)
- 依存方向は単方向 (parent → child)。 child の状態は parent に伝搬しない

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operator-boundaries.md` — readiness DAG が Takosumi / runtime-agent / control-plane-listener の trust 境界に沿う rationale
- `docs/reference/architecture/execution-lifecycle.md` — readiness と lifecycle phase の interplay、boot recovery 経路の選定背景
- `docs/reference/architecture/operational-hardening-checklist.md` — readiness を運用 signal として活用する checklist

## 関連ページ

- [Reference Takosumi Route Inventory](./service-http-api.md)
- [Lifecycle Protocol](./lifecycle.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Schema Evolution](./migration-upgrade.md)
