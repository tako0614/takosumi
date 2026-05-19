# SLA Breach Detection

> このページでわかること: SLA 違反の検知条件とアラートの仕組み。

v1 SLA breach detection surface を定義する。 kernel は closed な latency /
throughput / error の dimension 集合を rolling window 上で計測し、 各 dimension
を operator が供給する閾値に対して評価し、 dimension が breach
に入ったり出たりするたびに audit event を発行する。 kernel
はサービスクレジット計算、ステータスページ描画、顧客コミュニケーション path
の所有を行わない。

::: info Current kernel primitive `SlaBreachDetectionService` が v1 threshold
evaluator、hysteresis state machine、event publish path を実装する。 caller は
threshold record と rolling-window observation を供給する。 service は
transition event を kernel outbox に publish し、observability sink を通じて
audit event を append し、 notification adapter が供給されていれば
`sla-breach-detected` の operator notification signal を emit する。 :::

## SLA dimensions (closed v1 set)

v1 計測集合は closed。 dimension 追加は `CONVENTIONS.md` §6 RFC を要する。

| Dimension                   | Source                                            | Notes                                                               |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `apply-latency-p50`         | `takosumi_apply_duration_seconds`                 | Median apply latency over the window.                               |
| `apply-latency-p95`         | `takosumi_apply_duration_seconds`                 | 95th percentile.                                                    |
| `apply-latency-p99`         | `takosumi_apply_duration_seconds`                 | 99th percentile.                                                    |
| `activation-latency`        | activation pipeline                               | Time from `desired-recorded` to `activation-snapshot-created`.      |
| `wal-stage-duration`        | [WAL Stages](/reference/wal-stages)               | One observation per stage; emitted per stage independently.         |
| `drift-detection-latency`   | [Drift Detection](/reference/drift-detection)     | Time from drift cause to `drift-detected`.                          |
| `revoke-debt-aging`         | [RevokeDebt](/reference/revoke-debt)              | Median age between `revoke-debt-created` and `revoke-debt-cleared`. |
| `readiness-up-ratio`        | [Readiness Probes](/reference/readiness-probes)   | Fraction of probe samples reporting `ok`.                           |
| `rate-limit-throttle-ratio` | [Quota / Rate Limit](/reference/quota-rate-limit) | Ratio of 429-rejected requests to total requests.                   |
| `error-rate-5xx`            | HTTP edge                                         | Ratio of HTTP 5xx responses to total responses.                     |
| `error-rate-4xx`            | HTTP edge                                         | Ratio of HTTP 4xx responses to total responses.                     |

各 dimension は、対応する telemetry metric を既に発行している kernel HTTP edge
または worker boundary で観測される
([Telemetry / Metrics](/reference/telemetry-metrics) 参照)。 breach detection
は同じ観測を再利用する。並行する計測 path は導入しない。

## Measurement window

すべての dimension は rolling window 上で評価される。

- Default window length: 5 minutes.
- `TAKOSUMI_SLA_WINDOW_SECONDS` (allowed range: 60–3600, integer seconds) で
  operator が tune できる。
- 30 秒の sub-window が sliding aggregation bucket を作る。 評価は sub-window
  境界の終端で走る。
- すべての window は [Time / Clock Model](/reference/time-clock-model) の kernel
  monotonic clock に align するので、 successive window が overlap したり clock
  skew で sample を落としたりしない。

dimension 単位の上書きは `TAKOSUMI_SLA_WINDOW_SECONDS_<DIMENSION>`
(大文字、ダッシュをアンダースコアに変換) で許可される。 高ボリュームの dimension
には長い window、 低トラフィックの dimension には短い window を設定したい
operator は、それぞれ独立に設定する。

## Threshold and breach criterion

閾値は **operator が供給する**。 kernel に組み込みの閾値は無い。 閾値を 1
つも登録していない installation は breach event を発行しない。

`POST /api/internal/v1/sla/thresholds`

```json
{
  "dimension": "apply-latency-p95",
  "comparator": "gt",
  "value": 5.0,
  "scope": "kernel-global",
  "windowSeconds": 300
}
```

- `comparator` は `gt`, `gte`, `lt`, `lte` のいずれか。kernel はこの closed set
  外の comparator を発明しない。
- `value` は非負の数。 unit は source metric に従う (latency なら秒、ratio
  なら比率)。
- `scope` は `kernel-global`, `space`, `org` のいずれか。 Space / org scope
  の閾値は追加で `targetId` を持つ。
- `windowSeconds` がこの閾値の default window を上書きする。

変更系 endpoint `PATCH` と `DELETE` は `thresholdId` を key にした同じ body
形を受け付ける。 kernel は閾値を [Storage Schema](/reference/storage-schema)
に整合する audit partition に永続化する。

## State machine and hysteresis

(dimension, scope, target) tuple ごとに state machine を持つ。

```text
ok → warning → breached → recovering → ok
```

Transitions:

- `ok → warning`: 1 sub-window observation が閾値を超えた。
- `warning → breached`: `TAKOSUMI_SLA_BREACH_CONSECUTIVE_WINDOWS` (default `2`)
  連続 sub-window で閾値超過。
- `breached → recovering`: 1 sub-window 閾値を下回った。
- `recovering → ok`: `TAKOSUMI_SLA_RECOVERY_CONSECUTIVE_WINDOWS` (default `3`)
  連続 sub-window で閾値以下を維持。

`warning` と `recovering` は hysteresis を実装する: 単一 window 外観測で
dimension が `breached` に出入りすることはない。 これにより audit
量と下流ページングが予測可能に保たれる。

## Breach attribution

すべての state-change event は scope 情報を運び、 下流 consumer が Space / org /
kernel-global の breach を見分けられるようにする。

- `scope: space` — payload に `spaceId`。tenant 可視 breach (単一 Space の
  traffic shape または per-Space resource path 起因) を示す。
- `scope: org` — operator distribution が org を公開している場合に payload に
  `orgId`。
- `scope: kernel-global` — tenant ID を運ばない。operator 側根本原因
  (storage、network、runtime-agent) を示す。

同じ dimension が同時に複数 scope で breach することはある。 state machine は
(dimension, scope, target) ごとに独立。

## Reporting surface

`GET /api/internal/v1/sla`

```json
{
  "windowEnd": "2026-05-05T00:05:00.000Z",
  "dimensions": [
    {
      "dimension": "apply-latency-p95",
      "scope": "kernel-global",
      "state": "ok",
      "lastObservation": 1.42
    }
  ],
  "breaches": [
    {
      "thresholdId": "sla-threshold:01HZ...",
      "dimension": "apply-latency-p99",
      "scope": "space",
      "spaceId": "space:tenant-a",
      "state": "breached",
      "openedAt": "2026-05-05T00:01:30.000Z",
      "lastObservation": 8.7
    }
  ]
}
```

filter は `dimension`、`scope`、`spaceId`、`orgId`、`state` の query parameter
を受け付ける。 endpoint は read-mostly で state を変更しない。

## Audit events

state machine 遷移は closed enum の audit event を発行する
([Audit Events](/reference/audit-events) 参照)。

- `sla-breach-detected` — `warning → breached` で emit。 payload に
  `thresholdId`、`dimension`、`scope`、`targetId`、`windowSeconds`、`observation`、`comparator`、`value`
  を運ぶ。
- `sla-warning-raised` — `ok → warning` で emit。同じ payload。
- `sla-recovering` — `breached → recovering` で emit。
- `sla-recovered` — `recovering → ok` で emit。`breachDurationSeconds` を運ぶ。
- `sla-threshold-registered` / `sla-threshold-updated` / `sla-threshold-removed`
  — 閾値 mutation で emit。payload に変更前後の threshold snapshot。

kernel audit envelope の severity マッピングは現行の `AuditSeverity` enum
を使う: `sla-warning-raised`、`sla-breach-detected`、`sla-recovering` は
`warning`、`sla-recovered` と閾値変更 event は `info`。 operator は下流 alerting
層を通じてページングへエスカレートする。

## Storage

SLA state は [Storage Schema](/reference/storage-schema) に整合する専用 record
class として永続化される。

| Field         | Type      | Required | Notes                                         |
| ------------- | --------- | -------- | --------------------------------------------- |
| `id`          | string    | yes      | `sla-observation:<ULID>`.                     |
| `dimension`   | enum      | yes      | Closed v1 dimension.                          |
| `scope`       | enum      | yes      | `kernel-global` / `space` / `org`.            |
| `targetId`    | string    | no       | Required when scope is not kernel-global.     |
| `state`       | enum      | yes      | `ok` / `warning` / `breached` / `recovering`. |
| `enteredAt`   | timestamp | yes      | When the current state was entered.           |
| `observation` | number    | yes      | Most recent sub-window observation.           |
| `thresholdId` | string    | yes      | Reference to the active threshold.            |

閾値 record は SLAObservation record と並列に永続化され、 quota
カウンタと同じ保持: read-mostly、OperationJournal の外、明示削除まで保持。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: closed な計測集合、rolling
window 評価、state machine、閾値登録 API、audit 形。 **商用 SLA workflow** —
任意通貨でのサービスクレジット計算、契約固有の例外、
スケジュールメンテナンスの除外、 公開ステータスページ描画、 顧客向け incident
報告、 事後コミュニケーションテンプレート — は `takos-private/` のような
operator distribution に住む。 kernel は detection と audit
を同梱してそこで止まる。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — breach signal で動く
  operator policy 層。
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — apply-latency observation を生む apply pipeline。
- `docs/reference/architecture/namespace-export-model.md#exposure-activation-model`
  — activation-latency observation を生む activation pipeline。

## 関連ページ

- [Telemetry / Metrics](/reference/telemetry-metrics)
- [Audit Events](/reference/audit-events)
- [Storage Schema](/reference/storage-schema)
- [Readiness Probes](/reference/readiness-probes)
- [Quota / Rate Limit](/reference/quota-rate-limit)
- [Drift Detection](/reference/drift-detection)
- [RevokeDebt](/reference/revoke-debt)
- [Time / Clock Model](/reference/time-clock-model)
- [Environment Variables](/reference/env-vars)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Closed Enums](/reference/closed-enums)
