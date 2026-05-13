# SLA Breach Detection

> このページでわかること: SLA 違反の検知条件とアラートの仕組み。

本リファレンスは v1 の SLA breach detection surface を定義する。kernel は closed
な latency / throughput / error の dimension 集合を rolling window 上で
計測し、各 dimension を operator が供給する閾値に対して評価し、dimension が
breach に入ったり出たりするたびに audit event を発行する。kernel はサービス
クレジット計算、ステータスページ描画、顧客コミュニケーション path の所有を
行わない。

::: info Current kernel primitive `SlaBreachDetectionService` implements the v1
threshold evaluator, hysteresis state machine, and event publish path. Callers
provide threshold records and rolling-window observations; the service publishes
transition events to the kernel outbox, appends audit events through the
observability sink, and emits an operator notification signal for
`sla-breach-detected` when a notification adapter is supplied. :::

## SLA dimensions (closed v1 set)

v1 の計測集合は closed である。dimension の追加は `CONVENTIONS.md` §6 RFC を
要する。

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
([Telemetry / Metrics](/reference/telemetry-metrics) 参照)。breach detection
は同じ観測を再利用する。並行する計測 path は導入しない。

## Measurement window

すべての dimension は rolling window 上で評価される。

- Default window length: 5 minutes.
- Operator-tunable through `TAKOSUMI_SLA_WINDOW_SECONDS` (allowed range:
  60–3600, integer seconds).
- Sub-windows of 30 seconds form the sliding aggregation buckets; evaluation
  runs at the end of every sub-window boundary.
- All windows align to the kernel monotonic clock declared in
  [Time / Clock Model](/reference/time-clock-model) so that successive windows
  do not overlap or drop samples on clock skew.

dimension 単位の上書きは `TAKOSUMI_SLA_WINDOW_SECONDS_<DIMENSION>` (大文字、
ダッシュをアンダースコアに変換) で許可される。高ボリュームの dimension には 長い
window、低トラフィックの dimension には短い window を設定したい operator
は、それぞれ独立に設定する。

## Threshold and breach criterion

閾値は **operator が供給する**。kernel に組み込みの閾値は無い。閾値を 1 つも
登録していない installation は breach event を発行しない。

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

- `comparator` is one of `gt`, `gte`, `lt`, `lte`. The kernel does not invent
  comparators outside this closed set.
- `value` is a non-negative number; the unit follows the source metric (seconds
  for latency, ratio for ratios).
- `scope` is one of `kernel-global`, `space`, `org`. Space- or org- scoped
  thresholds carry an additional `targetId` field.
- `windowSeconds` overrides the default window for this threshold.

変更系エンドポイント `PATCH` と `DELETE` は `thresholdId` を key にした同じ body
形を受け付ける。kernel は閾値を [Storage Schema](/reference/storage-schema)
に整合する audit partition に永続化する。

## State machine and hysteresis

(dimension, scope, target) tuple ごとに state machine を持つ。

```text
ok → warning → breached → recovering → ok
```

Transitions:

- `ok → warning` when the observation exceeds the threshold for one sub-window.
- `warning → breached` when the observation exceeds the threshold for
  `TAKOSUMI_SLA_BREACH_CONSECUTIVE_WINDOWS` (default `2`) consecutive
  sub-windows.
- `breached → recovering` when the observation returns under the threshold for
  one sub-window.
- `recovering → ok` when the observation stays under the threshold for
  `TAKOSUMI_SLA_RECOVERY_CONSECUTIVE_WINDOWS` (default `3`) consecutive
  sub-windows.

`warning` と `recovering` state は hysteresis を実装する: 単一の window 外
観測で dimension が `breached` に出入りすることはない。これにより audit 量と
下流ページングが予測可能に保たれる。

## Breach attribution

すべての state-change event は scope 情報を運び、下流 consumer が Space / org /
kernel-global の breach を見分けられるようにする。

- `scope: space` — payload carries `spaceId`. Indicates a tenant- visible breach
  attributable to a single Space's traffic shape or to a per-Space resource
  path.
- `scope: org` — payload carries `orgId` when an operator distribution exposes
  orgs.
- `scope: kernel-global` — payload carries no tenant ID. Indicates an
  operator-side root cause (storage, network, runtime-agent).

同じ dimension が同時に複数 scope で breach することはある。state machine は
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
を受け付ける。エンドポイントは read-mostly で state を変更しない。

## Audit events

state machine 遷移は closed enum の audit event を発行する
([Audit Events](/reference/audit-events) 参照)。

- `sla-breach-detected` — emitted on `warning → breached`. Payload carries
  `thresholdId`, `dimension`, `scope`, `targetId`, `windowSeconds`,
  `observation`, `comparator`, and `value`.
- `sla-warning-raised` — emitted on `ok → warning`. Same payload.
- `sla-recovering` — emitted on `breached → recovering`.
- `sla-recovered` — emitted on `recovering → ok`. Carries
  `breachDurationSeconds`.
- `sla-threshold-registered` / `sla-threshold-updated` / `sla-threshold-removed`
  — emitted on threshold mutation. Payload carries the threshold snapshot before
  and after.

kernel audit envelope の severity マッピングは current の `AuditSeverity` enum
を使う: `sla-warning-raised`、`sla-breach-detected`、`sla-recovering` は
`warning`、`sla-recovered` と閾値変更 event は `info`。operator は下流 alerting
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

閾値 record は SLAObservation record と並列に永続化され、quota カウンタと同じ
保持: read-mostly、OperationJournal の外、明示削除まで保持。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: closed な計測集合、rolling
window 評価、state machine、閾値登録 API、audit 形。**商用 SLA workflow** —
任意通貨でのサービスクレジット計算、契約固有の例外、スケジュールメンテナンス
の除外、公開ステータスページ描画、顧客向け incident 報告、事後コミュニケー
ションテンプレート — は `takos-private/` のような operator distribution に住む。
kernel は detection と audit を同梱してそこで止まる。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that acts on breach signals.
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  apply pipeline that produces apply-latency observations.
- `docs/reference/architecture/exposure-activation-model.md` — activation
  pipeline that produces activation-latency observations.

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
