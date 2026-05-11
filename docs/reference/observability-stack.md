# Observability Stack Ownership

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Telemetry / Metrics](/reference/telemetry-metrics),
> [Logging Conventions](/reference/logging-conventions),
> [SLA Breach Detection](/reference/sla-breach-detection),
> [Incident Model](/reference/incident-model),
> [Self-hosting Operator Guide](/operator/self-host)

This page is the v1 ownership decision for Takosumi observability. It separates
the kernel-owned signal contract from the operator-owned monitoring stack, then
defines the SLI / SLO targets that bundled dashboards and alert policies use.

::: info Current implementation status The kernel currently exports readiness
probes, audit events, JSON HTTP request logs, Prometheus metrics, native OTLP
metric push, SLA breach events, and the bundled deploy Grafana dashboard. Native
OTLP HTTP server spans, WAL-backed provider operation spans, runtime-agent loop
spans, and internal RPC client spans are implemented. Operators can correlate
HTTP logs, traces, metrics, audit events, and deploy records through
`requestId`, `correlationId`, `spaceId`, `groupId`, and deployment identifiers.
:::

## Ownership Decision

Takosumi kernel owns the **shape and emission** of signals:

| Signal               | Kernel responsibility                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Readiness            | `/livez`, `/readyz`, `/status/summary` semantics and response shape                                                   |
| Metrics              | v1 metric names, labels, units, `/metrics`, and OTLP metric export                                                    |
| Traces               | HTTP server / provider / runtime-agent / internal RPC span emission, `traceparent` propagation, and OTLP trace export |
| Logs                 | HTTP request id propagation, JSON request log envelope, and redaction rules                                           |
| Audit                | tamper-evident audit event chain, retention policy controls, and replication primitives                               |
| SLA breach detection | threshold evaluation, state transitions, audit / outbox / notification signal publish                                 |
| Dashboard artifact   | versioned Grafana JSON under `deploy/observability/grafana/`                                                          |

Takosumi kernel does **not** own the operator's collector, long-term backend,
paging provider, public status page, incident comms, or commercial SLA credit
calculation.

## Managed vs Self-hosted

The same signal contract is used in both operating modes.

| Concern                      | Self-hosted operator owns                                      | Managed distribution owns                                            |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Prometheus scrape            | scrape target, token distribution, retention, label relabeling | platform Prometheus or compatible managed metrics backend            |
| OTLP metrics                 | collector endpoint, auth headers, retry / queue policy         | collector fleet, tenant routing, remote write, exporter credentials  |
| OTLP traces                  | collector endpoint, auth headers, sampling / retention policy  | collector fleet, tenant routing, trace backend, exporter credentials |
| Logs                         | stdout / stderr collector, retention, search index             | log pipeline, retention regime, customer support access controls     |
| Grafana dashboards           | import, datasource binding, folder / RBAC                      | dashboard provisioning, tenant foldering, release migration          |
| Alerting                     | alert rules, paging integration, on-call schedule              | managed alert rules, paging provider, escalation and status workflow |
| Audit replication            | external immutable store and consistency verification          | regulated archive backend, proof export, auditor access workflow     |
| Customer-facing status / SLA | status page, credit policy, customer messaging                 | branded status surface, customer comms, invoice / credit integration |

Self-hosted installs should treat the bundled dashboard and PromQL below as the
supported starting point, not as a complete incident-management product. Managed
distributions may add richer labels and routing in their collector, but must not
change the kernel metric names or labels defined in
[Telemetry / Metrics](/reference/telemetry-metrics).

## Reference Topologies

Self-hosted minimal topology:

```text
takosumi-api /metrics  -> Prometheus -> Grafana
takosumi stdout/stderr -> log collector -> log backend
ObservabilitySink      -> OTLP collector -> metrics / traces backend
audit_events           -> SQL + optional immutable external replication
```

Managed topology:

```text
takosumi kernel signals -> managed collector layer -> tenant metrics/log/audit backends
SLA breach events       -> notification + incident workflow
Grafana dashboard JSON  -> provisioned dashboard template
```

The collector layer may add resource attributes such as region, cluster, pod, or
environment. It must not add high-cardinality labels to the kernel-owned v1
metric series.

## SLI / SLO Targets

These targets are the default operator SLOs for GA readiness. They are product
targets, not hard-coded kernel behavior.

| SLI                        | Measurement                                                                                                                                                        | Target                | Primary owner             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------- |
| Deploy success rate        | `sum(rate(takosumi_deploy_operation_count{operationKind="apply",status="succeeded"}[5m])) / sum(rate(takosumi_deploy_operation_count{operationKind="apply"}[5m]))` | >= 99% over 30 days   | operator alerting         |
| Apply latency p95          | `histogram_quantile(0.95, sum(rate(takosumi_apply_duration_seconds_bucket{operationKind="apply"}[5m])) by (le))`                                                   | < 60s over 30 days    | kernel + provider owner   |
| Rollback rate              | `sum(rate(takosumi_deploy_operation_count{operationKind="rollback"}[5m])) / sum(rate(takosumi_deploy_operation_count{operationKind="apply"}[5m]))`                 | < 2% over 7 days      | release / deploy operator |
| Rollback latency p95       | `histogram_quantile(0.95, sum(rate(takosumi_rollback_duration_seconds_bucket{operationKind="rollback"}[5m])) by (le))`                                             | < 30s over 30 days    | kernel + provider owner   |
| API 5xx-free request ratio | `sum(rate(takosumi_http_request_duration_seconds_count{status!~"5.."}[5m])) / sum(rate(takosumi_http_request_duration_seconds_count[5m]))`                         | >= 99.9% over 30 days | kernel API operator       |
| Failed deploy MTTD         | time from failed deploy metric / SLA observation to alert receipt                                                                                                  | < 5 minutes           | alerting owner            |
| Restore MTTR               | time from incident acknowledgement to successful mitigation / rollback                                                                                             | < 30 minutes          | on-call owner             |

For installations with low deploy volume, success-rate alerts should use burn
rate windows and minimum event counts. A single failed deploy in a quiet staging
cluster should create a warning, not a page.

## Alert Policy

Default alert policy:

| Condition                                    | Severity | Action                                                      |
| -------------------------------------------- | -------- | ----------------------------------------------------------- |
| Deploy success rate below target for 30 min  | warning  | notify deploy operator; inspect provider failures           |
| Deploy success rate below target for 2 hours | critical | page on-call; open or attach to an incident                 |
| Apply latency p95 above target for 30 min    | warning  | inspect provider latency / artifact fetch path              |
| API 5xx-free ratio below target for 10 min   | critical | page kernel API owner                                       |
| SLA breach event with severity medium+       | warning  | route through notification signal and incident workflow     |
| Audit chain verification failure             | critical | stop deploy automation; preserve evidence; page immediately |

The kernel emits the signals. Operators own alert rule installation, paging
routing, silences, escalation policy, and post-incident review.

## Bootstrap Checklist

Self-hosted operators should wire the following before production traffic:

1. Set `TAKOSUMI_METRICS_SCRAPE_TOKEN` and scrape `/metrics` from a private
   Prometheus identity.
2. Set `TAKOSUMI_OTLP_METRICS_ENDPOINT`, `TAKOSUMI_OTLP_TRACES_ENDPOINT`, or
   standard `OTEL_EXPORTER_OTLP_*` variables when using an OTLP collector.
3. Import `deploy/observability/grafana/takosumi-deploy-overview.json` and bind
   its `${DS_PROMETHEUS}` datasource.
4. Enable JSON HTTP request logs in non-managed environments with
   `TAKOSUMI_HTTP_REQUEST_LOGS=true` when local log collection is required.
5. Configure audit replication for regulated environments before accepting
   production deploys.
6. Install alert rules from the SLI / SLO table and attach them to an on-call
   policy.

## Non-goals

The kernel does not ship a bundled Prometheus server, Grafana instance, Loki
stack, OpenTelemetry Collector, PagerDuty integration, public status page, or
SLA credit calculator. Distribution layers can package those components, but
they remain outside the generic Takosumi kernel.
