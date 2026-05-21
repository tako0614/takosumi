# Observability スタックの所有 {#observability-stack-ownership}

Takosumi kernel は signal の形状と emission を所有します。Prometheus、
OpenTelemetry Collector、Grafana、log backend、paging provider などの運用 stack
は operator が所有します。

## Kernel-owned signals

| Signal | Kernel の責務 |
| --- | --- |
| Readiness | `/livez` / `/readyz` / `/status/summary` の response shape。 |
| Metrics | metric 名、label、unit、`/metrics`、OTLP metric export。 |
| Traces | HTTP server / WAL / provider operation / runtime-agent RPC span。 |
| Logs | request id propagation、JSON request log envelope、redaction rule。 |
| Audit | audit event envelope、hash chain、retention / replication primitive。 |
| Drift / RevokeDebt | drift detection と cleanup debt の signal。 |

kernel は alert rule、paging routing、public status page、customer comms、
commercial credit policy を所有しません。

## Minimal self-host topology

```text
takosumi-api /metrics  -> Prometheus -> Grafana
takosumi stdout/stderr -> log collector -> log backend
OTLP export            -> OpenTelemetry Collector
audit_events           -> SQL + optional immutable archive
```

## SLI starting points

これらは operator が alert policy を作るための出発点です。kernel が hard-code
する SLO ではありません。

| SLI | Measurement | Initial target |
| --- | --- | --- |
| Deploy success rate | successful apply operations / all apply operations | >= 99% over 30 days |
| Apply latency p95 | p95 apply duration | < 60s |
| Rollback latency p95 | p95 rollback duration | < 30s |
| API 5xx-free ratio | non-5xx HTTP requests / all HTTP requests | >= 99.9% |
| Audit chain health | hash-chain verification failures | 0 |

deploy 量が少ない環境では minimum event count を併用し、1 件の失敗で不要に page
しないよう調整してください。

## Bootstrap checklist

1. `TAKOSUMI_METRICS_SCRAPE_TOKEN` を設定し、private Prometheus identity から
   `/metrics` を scrape する。
2. OTLP を使う場合は `TAKOSUMI_OTLP_METRICS_ENDPOINT` /
   `TAKOSUMI_OTLP_TRACES_ENDPOINT` を設定する。
3. log collector 側で JSON request log を取り込み、secret / token を index し
   ない redaction policy を置く。
4. production では audit replication と hash-chain verification を運用手順に
   入れる。
5. operator-owned alert rule と on-call routing を設定する。

## 非対象

Takosumi kernel は Prometheus server、Grafana instance、Loki stack、
OpenTelemetry Collector、paging integration、public status page を同梱しません。
operator distribution が package することはできますが、kernel docs の対象外です。

## 関連ページ

- [Telemetry / Metrics](./telemetry-metrics.md)
- [Logging Conventions](./logging-conventions.md)
- [Audit Events](./audit-events.md)
- [Drift Detection](./drift-detection.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Self-host Notes](../operator/self-host.md)
