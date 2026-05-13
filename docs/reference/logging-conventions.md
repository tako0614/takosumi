# Logging Conventions

> このページでわかること: kernel のログ出力規約と structured logging の形式。

本ページは、すべての Takosumi process (kernel、runtime-agent、CLI、in-process
plugin) のログ発行に関する v1 contract である。行フォーマット、必須フィールド、
禁止フィールド、closed な log-level enum とその意味境界、出力 sink、redaction
ルール、audit log との関係、trace 相関、operator 向けの設定キーを定義する。

::: info Current implementation status The kernel HTTP request correlation
middleware is current: API responses echo `x-request-id` and `x-correlation-id`,
or generate `req_<uuid>` when neither header is supplied. In staging and
production, and in other environments when `TAKOSUMI_HTTP_REQUEST_LOGS=true`,
the bootstrap path emits one JSON request log line with `requestId`,
`correlationId`, `trace_id`, `span_id`, route, status, and duration. Public
deploy metrics also carry the inbound request and correlation ids. Trace id /
span id enrichment for non-HTTP logs remains the broader target contract. :::

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

| Field       | Type   | Notes                                                           |
| ----------- | ------ | --------------------------------------------------------------- |
| `ts`        | string | RFC 3339 UTC, millisecond precision (see Time / Clock Model).   |
| `level`     | string | Closed enum: `debug`, `info`, `warn`, `error`, `fatal`.         |
| `msg`       | string | Human-readable summary of the event. Imperative, present tense. |
| `subsystem` | string | Closed enum: `kernel`, `runtime-agent`, `cli`, `plugin`.        |

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
  [Secret Partitions](/reference/secret-partitions) for the redaction surface).
  Lines that need PII for debugging carry a digest, not the value.

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
- Rotation is the sink's responsibility, not the kernel's. The kernel produces
  an unbounded stream; sinks rotate.
- The kernel does not write to files. A v1 deployment that needs file output
  configures its container runtime to redirect stdout to a file outside the
  kernel.

## Relationship to audit events

log と audit event は異なる保証を持つ別の surface である。

- **Audit events** are tamper-evident, hash-chained, indexed,
  retention-governed, and consumed for compliance evidence. Their taxonomy is
  closed and lives in [Audit Events](/reference/audit-events).
- **Logs** are operator debugging surface. They are not hash-chained, not
  retention-governed, and not part of the closed audit taxonomy. They may carry
  richer context than the corresponding audit event but never replace it.

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
- **plugin** — every line carries `pluginId` and `port` (the plugin port name
  from the closed plugin port set).

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
- `reference/architecture/observation-drift-revokedebt-model` — relationship
  between observation logs and the RevokeDebt taxonomy.
- `reference/architecture/policy-risk-approval-error-model` — error / fatal
  mapping to the closed DomainErrorCode enum.

## 関連ページ

- [Telemetry / Metrics](/reference/telemetry-metrics)
- [Audit Events](/reference/audit-events)
- [Time / Clock Model](/reference/time-clock-model)
- [Secret Partitions](/reference/secret-partitions)
- [Environment Variables](/reference/env-vars)
