# Logging Conventions

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Telemetry / Metrics](/reference/telemetry-metrics),
> [Audit Events](/reference/audit-events),
> [Time / Clock Model](/reference/time-clock-model),
> [Secret Partitions](/reference/secret-partitions),
> [Environment Variables](/reference/env-vars)

This page is the v1 contract for log emission across every Takosumi process:
kernel, runtime-agent, CLI, and in-process plugins. It defines the line format,
the required fields, the forbidden fields, the closed log-level enum and its
semantic boundaries, the output sink, redaction rules, the relationship to the
audit log, trace correlation, and the operator-facing configuration knobs.

::: info Current implementation status The kernel HTTP request correlation
middleware is current: API responses echo `x-request-id` and `x-correlation-id`,
or generate `req_<uuid>` when neither header is supplied. In staging and
production, and in other environments when `TAKOSUMI_HTTP_REQUEST_LOGS=true`,
the bootstrap path emits one JSON request log line with `requestId`,
`correlationId`, route, status, and duration. Public deploy metrics also carry
the inbound request and correlation ids. OTLP trace id / span id log enrichment
remains a target contract until native trace export is implemented. :::

## Line format

Every log line is a single JSON object on a single line, terminated by `\n`. No
multi-line log lines, no plaintext fallback in production, no embedded null
bytes.

```text
{"ts":"2026-05-05T10:00:00.123Z","level":"info","subsystem":"kernel","msg":"apply started","spaceId":"sp_01H...","operationId":"op_01H..."}
```

The kernel does not buffer log lines across process exit; every line is flushed
before the kernel acknowledges shutdown.

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

The following must never appear in log output.

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

The level enum is closed. The semantic boundary between adjacent levels is
normative; misapplying a level is a kernel implementation bug.

- **debug** — operator verbose troubleshooting only. Off by default in
  production. Examples: per-stage trace inside `commit`, per-row storage
  queries, per-message poll loop ticks.
- **info** — lifecycle events that an operator expects to see in steady-state
  production. Examples: `apply started`, `apply completed`, `share activated`,
  `lock acquired`, `compaction started`. The installation produces a steady,
  low-rate stream of `info` lines.
- **warn** — anomalies that do not block progress but require operator attention
  soon. Examples: drift detected, approval near expiry, quota near limit, clock
  skew within tolerance, deprecation warning used.
- **error** — operation failures that block a single operation but do not block
  the kernel. Examples: operation failed, external system rejected, RevokeDebt
  created, runtime-agent unreachable for a single operation.
- **fatal** — kernel cannot proceed. Examples: storage unreachable, audit-store
  integrity failure, signature verification failure, lock leak detected, secret
  partition unrecoverable. A `fatal` line is followed by orderly process exit.

## Output sink

The kernel writes logs to **stdout** (or **stderr** for `error` and `fatal`).
The kernel does not rotate, compress, or ship logs itself.

- 12-factor: the operator's container runtime captures stdout / stderr and
  forwards to a structured collector (Loki, Fluentd, OpenSearch, CloudWatch,
  etc.).
- Rotation is the sink's responsibility, not the kernel's. The kernel produces
  an unbounded stream; sinks rotate.
- The kernel does not write to files. A v1 deployment that needs file output
  configures its container runtime to redirect stdout to a file outside the
  kernel.

## Relationship to audit events

Logs and audit events are different surfaces with different guarantees.

- **Audit events** are tamper-evident, hash-chained, indexed,
  retention-governed, and consumed for compliance evidence. Their taxonomy is
  closed and lives in [Audit Events](/reference/audit-events).
- **Logs** are operator debugging surface. They are not hash-chained, not
  retention-governed, and not part of the closed audit taxonomy. They may carry
  richer context than the corresponding audit event but never replace it.

A kernel decision that is auditable always produces an audit event first; the
corresponding log line is informational. Operators investigating an incident
pivot from logs to audit events via `operationId` or `eventId`.

## Trace correlation

When OTLP is enabled, every log line emitted within an active span carries
`trace_id` and `span_id` fields. The fields use the OTLP hex-string form so a
sink can stitch logs to traces without further encoding.

```text
"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"
```

When OTLP is disabled the fields are omitted, not emitted as empty strings.

## Operator configuration

The kernel reads these log-related environment variables.

| Variable                     | Type | Default                                  | Notes                                                                                          |
| ---------------------------- | ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `TAKOSUMI_LOG_LEVEL`         | enum | `info`                                   | Closed enum `debug` / `info` / `warn` / `error` / `fatal`. Lines below this level are dropped. |
| `TAKOSUMI_LOG_FORMAT`        | enum | `json` (production) / `text` (local)     | Closed enum `json` / `text`. Production deployments require `json`.                            |
| `TAKOSUMI_HTTP_REQUEST_LOGS` | bool | `true` in staging/production, else false | Enables JSON kernel HTTP request logs outside managed environments when set to `true`.         |

In `production` and `staging`, `TAKOSUMI_LOG_FORMAT=text` is rejected at boot.
Text output is permitted only in `local` and `development`.

The CLI reads the same variables for its own log emission. CLI lines carry
`subsystem: cli`. The runtime-agent reads the same variables and emits
`subsystem: runtime-agent`.

## Per-subsystem conventions

Beyond the shared envelope, each subsystem follows narrow extra rules.

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

These fields are additive: a line that already carries an HTTP `requestId` still
carries `route` and `status` when the line is emitted from the kernel.

## Sampling

Logs are not sampled. Every `info` and higher line that the kernel decides to
emit is written to the sink. Sampling, if any, is the collector's
responsibility, applied after ingestion.

`debug` lines may be subject to per-subsystem rate limits inside the kernel to
prevent runaway debug output from drowning the sink. The limiter drops surplus
`debug` lines silently and exposes the drop count via
`takosumi_log_debug_dropped_count`.

## Related architecture notes

- `reference/architecture/operator-boundaries` — placement of the log sink in
  the operator trust model and the redaction trust boundary.
- `reference/architecture/observation-drift-revokedebt-model` — relationship
  between observation logs and the RevokeDebt taxonomy.
- `reference/architecture/policy-risk-approval-error-model` — error / fatal
  mapping to the closed DomainErrorCode enum.
