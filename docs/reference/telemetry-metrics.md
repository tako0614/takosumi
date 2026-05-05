# Telemetry / Metrics

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Logging Conventions](/reference/logging-conventions),
> [Time / Clock Model](/reference/time-clock-model),
> [Audit Events](/reference/audit-events),
> [Quota / Rate Limit](/reference/quota-rate-limit),
> [Environment Variables](/reference/env-vars)

This page is the v1 contract for telemetry export from a Takosumi installation.
It defines the export protocols the kernel speaks, the metric naming convention,
the closed v1 metric set operators rely on, trace export and span attributes,
sampling, cardinality controls, authentication for the export surface, and the
schema versioning rule.

::: info Current implementation status The metric schemas, observability sink
records, Prometheus `/metrics` HTTP route, and OTLP/HTTP JSON metric exporter
are current service contracts. The bootstrap path mounts `/metrics` on the API
role when `TAKOSUMI_METRICS_SCRAPE_TOKEN` is set, and wraps the configured
`ObservabilitySink` with native OTLP metric export when
`TAKOSUMI_OTLP_METRICS_ENDPOINT` or standard `OTEL_EXPORTER_OTLP_*` endpoint env
vars are set. OTLP traces remain a design target; the current native exporter
emits metrics only. :::

## Export protocols

The design target exports telemetry through two protocols at the same time.

- **OpenTelemetry / OTLP (primary)** — push-based OTLP/HTTP JSON exporter for
  metrics, plus the design target for traces and optional logs. The kernel
  exports metrics whenever `TAKOSUMI_OTLP_METRICS_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set. OTLP is the protocol operators wire into a collector when they need
  remote attribute enrichment or a vendor-neutral telemetry ingress.
- **Prometheus pull endpoint (secondary)** — `/metrics` endpoint on the kernel
  HTTP server, scraped by Prometheus or a Prometheus-compatible agent. The
  endpoint exposes recorded `ObservabilitySink` metric events in Prometheus text
  format and carries no trace data.

OTLP and Prometheus are not alternatives. Operators can run both: `/metrics`
serves pull-based local scraping, while the OTLP wrapper mirrors recorded metric
events to the configured collector.

The OTLP metric exporter reads the following kernel environment:

```text
TAKOSUMI_OTLP_METRICS_ENDPOINT        URL of the collector /v1/metrics endpoint
TAKOSUMI_OTLP_HEADERS_JSON            extra headers (JSON object)
TAKOSUMI_OTLP_SERVICE_NAME            OTLP service.name (default takosumi-kernel)
TAKOSUMI_OTLP_FAIL_CLOSED             fail metric recording when export fails
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT   standard OTEL metrics endpoint fallback
OTEL_EXPORTER_OTLP_ENDPOINT           standard OTEL base endpoint fallback
OTEL_EXPORTER_OTLP_HEADERS            standard comma-separated OTEL headers
OTEL_SERVICE_NAME                     standard service.name fallback
```

Adding a new transport variable requires the `CONVENTIONS.md` §6 RFC.

## Metric naming

Every Takosumi metric name follows the same shape:

```text
takosumi_<subsystem>_<metric>_<unit>

example: takosumi_apply_duration_seconds
```

- `<subsystem>` is a closed lowercase identifier (`apply`, `wal`, `revoke_debt`,
  `approval`, `drift`, `artifact`, `journal`, `lock`, `runtime_agent`, `http`,
  `rate_limit`, `quota`, `secret_partition`).
- `<metric>` is a short descriptor: `duration`, `count`, `bytes`, `ratio`,
  `age`.
- `<unit>` is the SI / Prometheus-canonical unit (`seconds`, `bytes`, `ratio`)
  or omitted when the metric is dimensionless count.

Histograms carry the `_seconds` suffix. Counters use `_count` (monotonic) or
`_total` only when the OTLP `Sum` semantic requires it. Gauges carry no suffix
beyond the unit.

## v1 closed metric set

The v1 metric set is **closed**. Operators may rely on these names, labels, and
types without coordination. New metrics go through the `CONVENTIONS.md` §6 RFC.

| Metric                                           | Type      | Labels                     |
| ------------------------------------------------ | --------- | -------------------------- |
| `takosumi_apply_duration_seconds`                | histogram | `spaceId`, `operationKind` |
| `takosumi_activate_duration_seconds`             | histogram | `spaceId`, `operationKind` |
| `takosumi_wal_stage_duration_seconds`            | histogram | `stage`                    |
| `takosumi_revoke_debt_count`                     | gauge     | `spaceId`, `status`        |
| `takosumi_approval_pending_count`                | gauge     | `spaceId`                  |
| `takosumi_drift_detected_count`                  | counter   | `spaceId`, `severity`      |
| `takosumi_artifact_storage_bytes`                | gauge     | `spaceId`                  |
| `takosumi_journal_compaction_duration_seconds`   | histogram | (none)                     |
| `takosumi_lock_acquire_duration_seconds`         | histogram | `lockKind`                 |
| `takosumi_runtime_agent_lease_count`             | gauge     | (none)                     |
| `takosumi_http_request_duration_seconds`         | histogram | `route`, `status`          |
| `takosumi_rate_limit_throttle_count`             | counter   | `route`                    |
| `takosumi_quota_usage_ratio`                     | gauge     | `spaceId`, `dimension`     |
| `takosumi_secret_partition_rotation_age_seconds` | gauge     | `partition`                |

The current OTLP metric exporter mirrors each recorded histogram event as one
delta histogram datapoint. Prometheus exposition folds recorded histogram events
into explicit buckets
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
0.5, 1, 2.5, 5, 10, 30]` seconds.

`takosumi_wal_stage_duration_seconds` carries the `stage` label drawn from the
8-value WAL stage enum: `prepare`, `pre-commit`, `commit`, `post-commit`,
`observe`, `finalize`, `abort`, `skip`.

`takosumi_revoke_debt_count` carries the closed RevokeDebt `status` enum, and
`takosumi_quota_usage_ratio` carries the closed quota `dimension` enum.

## Trace export

The kernel emits OTLP traces for every operation that crosses an external
boundary. Every span carries the same attribute set:

```text
takosumi.space_id          spaceId
takosumi.operation_id      operationId
takosumi.operation_kind    closed enum
takosumi.wal_stage         WAL stage
takosumi.idempotency_key   idempotency tuple digest
takosumi.agent_id          runtime-agent identity (if applicable)
```

Span names are stable across versions and follow the form
`takosumi.<subsystem>.<verb>` (`takosumi.apply.execute`,
`takosumi.runtime_agent.describe`).

Trace exemplars on histogram metrics carry `trace_id` and `span_id`, allowing
the operator to pivot from a slow histogram bucket directly into the offending
trace in their backend of choice.

## Sampling

Sampling is **head-based** by default and operator-tunable.

- The default head sampler keeps `1.0` (100%) of traces in `local` and
  `development`, and a configurable ratio in `staging` and `production`
  (`TAKOSUMI_OTLP_TRACE_SAMPLE_RATIO`, default `0.05`).
- Operations whose terminal status is an error are **always sampled**. The
  kernel forces the sampling decision to `RECORD_AND_SAMPLED` before exporting
  an operation that ends with `operation-failed` or `compensation-completed`.
- Tail sampling, if any, is the operator's collector-side concern. The kernel
  does not implement tail sampling.

## Cardinality

High-cardinality labels are forbidden in the v1 closed set.

- `deploymentId`, `operationId`, `journalEntryId`, and similar per-event
  identifiers never appear as labels. They appear as span attributes or exemplar
  fields, never as time-series identity.
- `spaceId` is permitted as a label. Operators with a large number of Spaces (in
  v1, the rule of thumb is `> 1000`) configure their collector to aggregate
  `spaceId` away before storage.
- Free-form labels (operator names, hostnames, region) are not added by the
  kernel. Operators wanting them inject through the OTLP collector at the
  resource attribute layer.

## Authentication

Both export surfaces require authentication.

- The OTLP exporter authenticates to the collector via headers configured in
  `TAKOSUMI_OTLP_HEADERS_JSON` or `OTEL_EXPORTER_OTLP_HEADERS`.
- The current Prometheus `/metrics` endpoint requires a scrape token via
  `Authorization: Bearer <TAKOSUMI_METRICS_SCRAPE_TOKEN>`. Unauthenticated
  scrapes are rejected with `401`. The endpoint is intended for in-cluster
  scrape from a known Prometheus identity, not for internet exposure.

## Resource attributes

Every OTLP export carries a stable resource attribute set so the collector can
route by installation and role.

```text
service.name              "takosumi"
service.namespace         operator-set
service.instance.id       pod / process identifier
takosumi.role             takosumi-{api,worker,router,runtime-agent,log-worker}
takosumi.environment      local | development | test | staging | production
takosumi.release          kernel package version
```

Resource attributes appear once per export batch, not on each metric point.
Operators add deployment-specific attributes (region, cluster) through the OTLP
collector's resource processor; the kernel does not read region or cluster from
its own environment.

## Pull endpoint contract

The Prometheus `/metrics` endpoint guarantees the following.

- Response status `200` whenever the kernel HTTP server is up.
- Content type `text/plain; version=0.0.4`.
- One scrape returns a consistent snapshot of metric events held by the
  configured `ObservabilitySink`.
- The endpoint surfaces no metric whose labels would push cardinality above the
  v1 closed set above.

A scrape that arrives during kernel shutdown returns `503` with
`Retry-After: 1`.

## Schema versioning

The metric set, label set, and span attribute set above are the **v1 closed
schema**. A consumer that wires dashboards or alerts against the v1 names is
contractually safe across patch and minor versions.

- Renames go through the `CONVENTIONS.md` §6 RFC and announce a deprecation
  window.
- New metrics added under the RFC are allowed; consumers that ignore unknown
  metrics keep working.
- Removed metrics are not allowed within v1.

## Related design notes

- `design/observation-drift-revokedebt-model` — derivation of the drift, debt,
  and observation gauges.
- `design/operation-plan-write-ahead-journal-model` — WAL stage histogram label
  rationale.
- `design/operator-boundaries` — placement of the export surface inside the
  kernel host trust boundary.
