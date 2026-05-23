# Logging Conventions

> このページでわかること: Takosumi 全 process (kernel / runtime-agent / CLI /
> reference adapter) のログ発行 v1 contract。 行フォーマット、 必須 /
> 禁止フィールド、 log-level enum、 出力 sink、 redaction、 audit との関係、
> trace 相関、 operator 設定キーを定める。

::: info Current implementation status

kernel HTTP request correlation middleware は current:

- API response は `x-request-id` と `x-correlation-id` を echo。
  どちらも無ければ `req_<uuid>` を生成。
- staging / production と `TAKOSUMI_HTTP_REQUEST_LOGS=true` の他環境では、
  bootstrap path が `requestId` / `correlationId` / `trace_id` / `span_id` /
  route / status / duration を持つ JSON request log を 1 行 emit。
- installer / artifact metrics も inbound request / correlation id を carry。
- 非 HTTP log への trace id / span id enrichment は今後の target contract。

:::

## Line format

Every log line is a single JSON object on a single line, terminated by `\n`. No
multi-line log lines, no plaintext fallback in production, no embedded null
bytes.

```text
{"ts":"2026-05-05T10:00:00.123Z","level":"info","subsystem":"kernel","msg":"apply started","spaceId":"sp_01H...","operationId":"op_01H..."}
```

kernel は process 終了を跨いでログ行を buffer しない。kernel が shutdown を ack
する前にすべての行が flush される。

## Required fields

Every line carries the following fields.

| Field       | Type   | Notes                                                                                                       |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `ts`        | string | RFC 3339 UTC, millisecond precision (see Time / Clock Model).                                               |
| `level`     | string | Closed enum: `debug`, `info`, `warn`, `error`, `fatal`.                                                     |
| `msg`       | string | Human-readable summary of the event. Imperative, present tense.                                             |
| `subsystem` | string | Closed enum: `kernel`, `runtime-agent`, `cli`, `plugin`. `plugin` is the reference adapter subsystem value. |

In addition, lines carry **at least one** of the following correlation fields
whenever the line is associated with an operation:

| Field         | When present                                     |
| ------------- | ------------------------------------------------ |
| `requestId`   | Lines emitted within an HTTP request handler.    |
| `operationId` | Lines emitted while processing an OperationPlan. |
| `eventId`     | Lines emitted alongside an audit event write.    |
| `spaceId`     | Lines that operate within a single Space.        |

A line without any of the four correlation fields is permitted only at boot,
shutdown, and global periodic worker tick.

## Forbidden fields

次のものはログ出力に決して現れてはならない。

- **Raw secret values.** A line that would otherwise carry a secret carries the
  secret reference (`secret://<partition>/<key>`) instead. The kernel's log
  writer enforces this at emit time using the active secret-partition redaction
  set.
- **Raw PII values.** Email, IP, actor names, and similar PII are redacted
  according to the active compliance regime (see
  [Secret Partitions](./secret-partitions.md) for the redaction surface). Lines
  that need PII for debugging carry a digest, not the value.

A line whose canonical bytes match a redaction substring is rejected at emit
time and surfaces as a `severity: warn` line with `level: warn`,
`msg: "log redaction triggered"`, and the offending field name. The original
line is dropped.

## Log-level boundaries

level enum は closed。隣接 level 間の意味境界は normative。level を誤適用する
ことは kernel 実装バグである。

- **debug** — operator verbose troubleshooting only. Off by default in
  production. Examples: per-stage trace inside `commit`, per-row storage
  queries, per-message poll loop ticks.
- **info** — lifecycle events that an operator expects to see in steady-state
  production. Examples: `apply started`, `apply completed`, `share activated`,
  `lock acquired`, `compaction started`. The installation produces a steady,
  low-rate stream of `info` lines.
- **warn** — anomalies that do not block progress but require operator attention
  soon. Examples: drift detected, approval near expiry, quota near limit, clock
  skew within tolerance, transition warning used.
- **error** — operation failures that block a single operation but do not block
  the kernel. Examples: operation failed, external system rejected, RevokeDebt
  created, runtime-agent unreachable for a single operation.
- **fatal** — kernel cannot proceed. Examples: storage unreachable, audit-store
  integrity failure, signature verification failure, lock leak detected, secret
  partition unrecoverable. A `fatal` line is followed by orderly process exit.

## Output sink

kernel はログを **stdout** に書く (`error` と `fatal` は **stderr**)。kernel
自身はログを rotate / 圧縮 / 出荷しない。

- 12-factor: the operator's container runtime captures stdout / stderr and
  forwards to a structured collector (Loki, Fluentd, OpenSearch, CloudWatch,
  etc.).
- Rotation belongs to the sink. The kernel produces an unbounded stream; sinks
  rotate.
- File output is configured by the operator's container runtime by redirecting
  stdout / stderr.

## Relationship to audit events

log と audit event は異なる保証を持つ別の surface である。

- **Audit events** are tamper-evident, hash-chained, indexed,
  retention-governed, and consumed for compliance evidence. Their taxonomy is
  closed and lives in [Audit Events](./audit-events.md).
- **Logs** are operator debugging surface. They may carry richer context than
  the corresponding audit event but never replace it.

監査可能な kernel の決定は必ず最初に audit event を生成し、対応するログ行は
情報目的である。incident を調査する operator は `operationId` や `eventId` を
通じてログから audit event に pivot する。

## Trace correlation

相関 middleware が emit する各 kernel HTTP request ログには、アクティブな
request span の `trace_id` と `span_id` フィールドが含まれる。これらは OTLP の
hex 文字列形式を使うため、sink は追加エンコードなしにログを trace と紐付け
られる。

```text
"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"
```

アクティブな span の外で emit されるログは空文字列を出すのではなくフィールド
自体を省略する。

## Operator configuration

kernel は次のログ関連環境変数を読む。

| Variable                     | Type | Default                                  | Notes                                                                                          |
| ---------------------------- | ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `TAKOSUMI_LOG_LEVEL`         | enum | `info`                                   | Closed enum `debug` / `info` / `warn` / `error` / `fatal`. Lines below this level are dropped. |
| `TAKOSUMI_LOG_FORMAT`        | enum | `json` (production) / `text` (local)     | Closed enum `json` / `text`. Production deployments require `json`.                            |
| `TAKOSUMI_HTTP_REQUEST_LOGS` | bool | `true` in staging/production, else false | Enables JSON kernel HTTP request logs outside managed environments when set to `true`.         |

In `production` and `staging`, `TAKOSUMI_LOG_FORMAT=text` is rejected at boot.
Text output is permitted only in `local` and `development`.

CLI は自身のログ発行に同じ環境変数を読む。CLI 行は `subsystem: cli` を持つ。
runtime-agent も同じ環境変数を読み、`subsystem: runtime-agent` を発行する。

## Per-subsystem conventions

共有 envelope に加えて、各 subsystem は次の狭い追加規則に従う。

- **kernel** — every line that crosses an HTTP boundary carries `route` (the
  matched route template, never the resolved URL) and `status` (the HTTP status
  code as an integer).
- **runtime-agent** — every line carries `agentId` and, when an external
  connector is in scope, `connector` (a short identifier such as `kubernetes`,
  `docker`, `cloudflare`, never a credential).
- **cli** — every line carries `command` (the dotted CLI command path, e.g.
  `deploy.run`, `audit.verify`) and `argvDigest` (a digest of the post-redaction
  argument vector, never the raw argv).
- **plugin** — every line emitted by operator-attached reference adapter code
  carries `pluginId` and, when relevant, the resolved kind URI / connector id.

これらのフィールドは付加的: HTTP `requestId` を既に持つ行も、kernel から発行
される際は `route` と `status` を持つ。

## Sampling

ログは sample されない。kernel が emit すると決めた `info` 以上の行はすべて sink
に書かれる。sampling があるなら collector の責務であり、ingest 後に適用 される。

暴走 debug 出力が sink を埋め尽くさないよう、`debug` 行は kernel 内で per-
subsystem の rate limit を受けうる。limiter は超過分の `debug` 行を黙って drop
し、drop 数を `takosumi_log_debug_dropped_count` で公開する。

## Related architecture notes

- `reference/architecture/operator-boundaries` — placement of the log sink in
  the operator trust model and the redaction trust boundary.
- `reference/drift-detection` — relationship between observation logs and the
  RevokeDebt taxonomy.
- `reference/architecture/policy-risk-approval-error-model` — error / fatal
  mapping to the closed DomainErrorCode enum.

## 関連ページ

- [Telemetry / Metrics](./telemetry-metrics.md)
- [Audit Events](./audit-events.md)
- [Time / Clock Model](./time-clock-model.md)
- [Secret Partitions](./secret-partitions.md)
- [Environment Variables](./env-vars.md)
