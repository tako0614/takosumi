# Observability Stack Ownership

> このページでわかること: observability stack の所有モデルと推奨構成。

Takosumi の observability に関する v1 の所有モデルです。 kernel が所有する
signal contract と、 operator が所有する monitoring stack を分け、 同梱
dashboard / alert policy が用いる SLI / SLO を定義します。

::: info 実装状況 kernel は readiness probe、 audit event、 JSON HTTP request
log、 Prometheus metric、 native OTLP metric push、 SLA breach event、 同梱
deploy Grafana dashboard を提供。 native OTLP の HTTP server span、 WAL 連携の
provider operation span、 runtime-agent loop span、 internal RPC client span
も実装済み。 operator は `requestId` / `correlationId` / `spaceId` / `groupId` /
deployment identifier で HTTP log / trace / metric / audit event / deploy record
を相関できます。 :::

## 所有モデル

Takosumi kernel は signal の **形状と emission** を所有します。

| Signal               | kernel の責務                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Readiness            | `/livez` / `/readyz` / `/status/summary` の semantics と response shape                                      |
| Metrics              | v1 の metric 名 / label / unit、 `/metrics`、 OTLP metric export                                             |
| Traces               | HTTP server / provider / runtime-agent / internal RPC span emission、 `traceparent` 伝播、 OTLP trace export |
| Logs                 | HTTP request id 伝播、 JSON request log envelope、 redaction rule                                            |
| Audit                | tamper-evident な audit event chain、 retention policy、 replication primitive                               |
| SLA breach detection | threshold 評価、 state 遷移、 audit / outbox / notification signal publish                                   |
| Dashboard artifact   | `deploy/observability/grafana/` 配下の versioned Grafana JSON                                                |

kernel は operator の collector、 long-term backend、 paging provider、 public
status page、 incident communication、 商用 SLA credit 計算を **所有
しません**。

## Managed と Self-hosted

両モードで同じ signal contract を使います。

| 関心事                       | Self-hosted operator の所有                             | Managed distribution の所有                                            |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Prometheus scrape            | scrape target、 token 配布、 retention、 label relabel  | platform Prometheus 互換 managed metrics backend                       |
| OTLP metrics                 | collector endpoint、 auth header、 retry / queue policy | collector fleet、 tenant routing、 remote write、 exporter credential  |
| OTLP traces                  | collector endpoint、 auth header、 sampling / retention | collector fleet、 tenant routing、 trace backend、 exporter credential |
| Logs                         | stdout / stderr collector、 retention、 search index    | log pipeline、 retention regime、 customer support access              |
| Grafana dashboards           | import、 datasource 紐付け、 folder / RBAC              | dashboard provisioning、 tenant foldering、 release migration          |
| Alerting                     | alert rule、 paging integration、 on-call schedule      | managed alert rule、 paging provider、 escalation / status flow        |
| Audit replication            | 外部 immutable store と整合性検証                       | 規制対応 archive backend、 proof export、 auditor access flow          |
| Customer-facing status / SLA | status page、 credit policy、 顧客コミュニケーション    | branded status、 customer comms、 invoice / credit 連携                |

self-hosted の install では、 同梱 dashboard と下記 PromQL を出発点として
扱ってください (完成された incident 管理製品ではありません)。 managed
distribution は collector で label / routing を拡張できますが、
[Telemetry / Metrics](/reference/telemetry-metrics) で定義した kernel metric
名と label は変更しません。

## 参照 topology

self-hosted の最小構成:

```text
takosumi-api /metrics  -> Prometheus -> Grafana
takosumi stdout/stderr -> log collector -> log backend
ObservabilitySink      -> OTLP collector -> metrics / traces backend
audit_events           -> SQL + 任意の外部 immutable replication
```

managed の構成:

```text
takosumi kernel signals -> managed collector layer -> tenant metrics/log/audit backends
SLA breach events       -> notification + incident workflow
Grafana dashboard JSON  -> provisioned dashboard template
```

collector layer は region / cluster / pod / environment などの resource
attribute を追加できますが、 kernel 所有の v1 metric series に高 cardinality の
label を追加してはいけません。

## SLI / SLO 目標

GA 評価時の operator SLO の既定値です (kernel が hard-code する挙動ではな く、
product 目標として提示します)。

| SLI                        | Measurement                                                                                                                                                        | Target                | Primary owner             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------- |
| Deploy success rate        | `sum(rate(takosumi_deploy_operation_count{operationKind="apply",status="succeeded"}[5m])) / sum(rate(takosumi_deploy_operation_count{operationKind="apply"}[5m]))` | >= 99% over 30 days   | operator alerting         |
| Apply latency p95          | `histogram_quantile(0.95, sum(rate(takosumi_apply_duration_seconds_bucket{operationKind="apply"}[5m])) by (le))`                                                   | < 60s over 30 days    | kernel + provider owner   |
| Rollback rate              | `sum(rate(takosumi_deploy_operation_count{operationKind="rollback"}[5m])) / sum(rate(takosumi_deploy_operation_count{operationKind="apply"}[5m]))`                 | < 2% over 7 days      | release / deploy operator |
| Rollback latency p95       | `histogram_quantile(0.95, sum(rate(takosumi_rollback_duration_seconds_bucket{operationKind="rollback"}[5m])) by (le))`                                             | < 30s over 30 days    | kernel + provider owner   |
| API 5xx-free request ratio | `sum(rate(takosumi_http_request_duration_seconds_count{status!~"5.."}[5m])) / sum(rate(takosumi_http_request_duration_seconds_count[5m]))`                         | >= 99.9% over 30 days | kernel API operator       |
| Failed deploy MTTD         | time from failed deploy metric / SLA observation to alert receipt                                                                                                  | < 5 minutes           | alerting owner            |
| Restore MTTR               | time from incident acknowledgement to successful mitigation / rollback                                                                                             | < 30 minutes          | on-call owner             |

deploy 量が少ない環境では burn rate window と minimum event count を併用し、
quiet な staging で 1 件失敗しただけで page しないよう調整してください。

## Alert policy

既定の alert policy:

| 条件                                       | Severity | アクション                                       |
| ------------------------------------------ | -------- | ------------------------------------------------ |
| deploy 成功率が 30 分連続で目標未達        | warning  | deploy operator に通知。 provider failure を調査 |
| deploy 成功率が 2 時間連続で目標未達       | critical | on-call を page。 incident を起票 / 紐付け       |
| apply latency p95 が 30 分連続で目標超え   | warning  | provider latency / artifact fetch 経路を調査     |
| API 5xx-free ratio が 10 分連続で目標未達  | critical | kernel API owner を page                         |
| medium 以上の severity の SLA breach event | warning  | notification signal と incident flow に流す      |
| audit chain verification 失敗              | critical | deploy 自動化を停止。 証拠保全。 即時 page       |

kernel は signal を emit するだけで、 alert rule の install、 paging routing、
silence、 escalation policy、 事後レビューは operator が所有しま す。

## ブートストラップ手順

self-hosted operator が production traffic を受ける前に行う設定:

1. `TAKOSUMI_METRICS_SCRAPE_TOKEN` を設定し、 private Prometheus identity か ら
   `/metrics` を scrape する
2. OTLP collector を使う場合は `TAKOSUMI_OTLP_METRICS_ENDPOINT` /
   `TAKOSUMI_OTLP_TRACES_ENDPOINT`、 または標準の `OTEL_EXPORTER_OTLP_*` を
   設定する
3. `deploy/observability/grafana/takosumi-deploy-overview.json` を import し、
   `${DS_PROMETHEUS}` datasource を紐付ける
4. ローカルで log 収集が必要な non-managed 環境では
   `TAKOSUMI_HTTP_REQUEST_LOGS=true` で JSON HTTP request log を有効化
5. 規制対象環境では production deploy 受入前に audit replication を設定
6. SLI / SLO 表の alert rule を install し、 on-call policy に紐付ける

## 非対象

kernel は Prometheus server / Grafana instance / Loki stack / OpenTelemetry
Collector / PagerDuty integration / public status page / SLA credit calculator
を同梱しません。 distribution layer がこれらを package することは可能ですが、
汎用 Takosumi kernel の対象外です。

## 関連ページ

- [Telemetry / Metrics](/reference/telemetry-metrics)
- [Logging Conventions](/reference/logging-conventions)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Self-hosting Operator Guide](/operator/self-host)
