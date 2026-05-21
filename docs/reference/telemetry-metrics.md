# テレメトリ / メトリクス {#telemetry--metrics}

> このページでわかること: telemetry export の v1 contract — protocol / 命名 /
> closed metric set / trace / sampling / 認証 / schema versioning。

::: info 実装状況 metric schema、 observability sink record、 Prometheus
`/metrics` HTTP route、 OTLP/HTTP JSON metric exporter、 kernel HTTP server
span、 provider operation span、 runtime-agent loop span、 internal RPC client
span は service contract として実装済み。 bootstrap path は
`TAKOSUMI_METRICS_SCRAPE_TOKEN` が設定されていれば API role に `/metrics` を
mount する。 `TAKOSUMI_OTLP_METRICS_ENDPOINT` / `TAKOSUMI_OTLP_TRACES_ENDPOINT`
または標準 `OTEL_EXPORTER_OTLP_*` endpoint env が設定されていれば、 構成済
`ObservabilitySink` を native OTLP metric / trace export で wrap する。 deploy
overview Grafana dashboard は
`deploy/observability/grafana/takosumi-deploy-overview.json` に公開済み。 :::

## エクスポートプロトコル {#export-protocol}

telemetry は 2 protocol で同時 export する。

### OpenTelemetry / OTLP (primary) {#opentelemetry--otlp-primary}

push 型の OTLP/HTTP JSON exporter。 metric / kernel HTTP server span / provider
apply / destroy operation span / runtime-agent loop span / internal RPC client
span を export する。

- metric export 起点: `TAKOSUMI_OTLP_METRICS_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
  のいずれかが設定されている
- trace export 起点: `TAKOSUMI_OTLP_TRACES_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
  のいずれかが設定されている
- collector で attribute 拡充や vendor-neutral telemetry ingress を行いたい
  operator はこちらを使う

### Prometheus pull endpoint (secondary) {#prometheus-pull-endpoint-secondary}

kernel HTTP server の `/metrics` を Prometheus 互換 agent が scrape する。
記録された `ObservabilitySink` metric event を Prometheus text format で公開する
(trace は含まない)。

OTLP と Prometheus は排他ではない。 両方運用できる。 `/metrics` は local pull
scrape 用、 OTLP wrapper は記録した metric / trace event を collector に mirror
する。

OTLP exporter が読む kernel 環境変数:

```text
TAKOSUMI_OTLP_METRICS_ENDPOINT        URL of the collector /v1/metrics endpoint
TAKOSUMI_OTLP_TRACES_ENDPOINT         URL of the collector /v1/traces endpoint
TAKOSUMI_OTLP_HEADERS_JSON            extra headers (JSON object)
TAKOSUMI_OTLP_SERVICE_NAME            OTLP service.name (default takosumi-kernel)
TAKOSUMI_OTLP_FAIL_CLOSED             fail telemetry recording when export fails
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT   standard OTEL metrics endpoint fallback
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT    standard OTEL traces endpoint fallback
OTEL_EXPORTER_OTLP_ENDPOINT           standard OTEL base endpoint fallback
OTEL_EXPORTER_OTLP_HEADERS            standard comma-separated OTEL headers
OTEL_SERVICE_NAME                     standard service.name fallback
```

新 transport 変数追加には `CONVENTIONS.md` §6 RFC が必須。

## Metric 命名

Takosumi metric 名は次の形に統一する。

```text
takosumi_<subsystem>_<metric>_<unit>

例: takosumi_apply_duration_seconds
```

- `<subsystem>`: 閉じた lowercase 識別子 (`apply` / `wal` / `revoke_debt` /
  `approval` / `drift` / `artifact` / `journal` / `lock` / `runtime_agent` /
  `http` / `rate_limit` / `quota` / `secret_partition`)
- `<metric>`: 短い記述子 (`duration` / `count` / `bytes` / `ratio` / `age`)
- `<unit>`: SI / Prometheus canonical unit (`seconds` / `bytes` / `ratio`)。
  無次元 count では省略

suffix rule:

- histogram → `_seconds`
- counter → monotonic な `_count`
- OTLP の `Sum` semantics が必要な場合のみ `_total`
- gauge は unit 以外の suffix を付けない

## v1 closed metric セット {#v1-closed-metric-set}

v1 metric set は **閉じ** ている。 operator は調整なしで名前 / label /
型を当てにできる。 新規 metric は `CONVENTIONS.md` §6 RFC を通す。

| Metric                                           | Type      | Labels                               |
| ------------------------------------------------ | --------- | ------------------------------------ |
| `takosumi_deploy_operation_count`                | counter   | `spaceId`, `operationKind`, `status` |
| `takosumi_apply_duration_seconds`                | histogram | `spaceId`, `operationKind`, `status` |
| `takosumi_rollback_duration_seconds`             | histogram | `spaceId`, `operationKind`, `status` |
| `takosumi_activate_duration_seconds`             | histogram | `spaceId`, `operationKind`           |
| `takosumi_wal_stage_duration_seconds`            | histogram | `stage`                              |
| `takosumi_revoke_debt_count`                     | gauge     | `spaceId`, `status`                  |
| `takosumi_approval_pending_count`                | gauge     | `spaceId`                            |
| `takosumi_drift_detected_count`                  | counter   | `spaceId`, `severity`                |
| `takosumi_artifact_storage_bytes`                | gauge     | `spaceId`                            |
| `takosumi_journal_compaction_duration_seconds`   | histogram | (none)                               |
| `takosumi_lock_acquire_duration_seconds`         | histogram | `lockKind`                           |
| `takosumi_runtime_agent_lease_count`             | gauge     | (none)                               |
| `takosumi_http_request_duration_seconds`         | histogram | `route`, `status`                    |
| `takosumi_rate_limit_throttle_count`             | counter   | `route`                              |
| `takosumi_quota_usage_ratio`                     | gauge     | `spaceId`, `dimension`               |
| `takosumi_secret_partition_rotation_age_seconds` | gauge     | `partition`                          |

OTLP metric exporter は記録した histogram event を 1 delta datapoint として
mirror する。 Prometheus exposition は histogram event を bucket
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]` 秒に集約する。

label 詳細:

- `takosumi_wal_stage_duration_seconds` の `stage` label は 8 値 WAL stage enum
  (`prepare` / `pre-commit` / `commit` / `post-commit` / `observe` / `finalize`
  / `abort` / `skip`)。
- `takosumi_revoke_debt_count` は閉じた RevokeDebt `status` enum を label
  に持つ。
- `takosumi_quota_usage_ratio` は閉じた quota `dimension` enum を label に持つ。

deploy dashboard の query も v1 operator surface。 同梱 Grafana dashboard が使う
PromQL:

| Panel               | PromQL                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy success rate | `sum(rate(takosumi_deploy_operation_count{operationKind="apply",status="succeeded"}[5m])) / sum(rate(takosumi_deploy_operation_count{operationKind="apply"}[5m]))` |
| Apply latency p95   | `histogram_quantile(0.95, sum(rate(takosumi_apply_duration_seconds_bucket{operationKind="apply"}[5m])) by (le))`                                                   |
| Rollback rate       | `sum(rate(takosumi_deploy_operation_count{operationKind="rollback"}[5m]))`                                                                                         |

## トレースエクスポート {#trace-export}

OTLP trace は外部境界を跨ぐ全 operation で emit する。 対象は次の span。

- API request の HTTP server span
- WAL-backed `applyV2` / `destroyV2` の provider apply / destroy span
- runtime-agent の work execution span
- runtime agent / internal RPC call の client span

これらは native OTLP traces endpoint 経由で export される。 operation 単位 span
は次の attribute set を持つ。

```text
takosumi.space_id          spaceId
takosumi.operation_id      operationId
takosumi.operation_kind    closed enum
takosumi.wal_stage         WAL stage
takosumi.idempotency_key   idempotency tuple digest
takosumi.agent_id          runtime-agent identity (if applicable)
```

span 名は version 間で安定する。 形式は `takosumi.<subsystem>.<verb>` (例:
`takosumi.apply.execute`、 `takosumi.runtime_agent.describe`)。

histogram metric の trace exemplar は `trace_id` / `span_id` を持つ。 slow
bucket から該当 trace に直接 pivot できる。

## サンプリング {#sampling}

既定の sampling は **head-based**。 operator が調整できる。

- 既定 head sampler は `local` / `development` で `1.0` (100%)。 `staging` /
  `production` では設定可能比率 (`TAKOSUMI_OTLP_TRACE_SAMPLE_RATIO`、 既定
  `0.05`)
- 終了状態がエラーの operation は **常に sample** される。 kernel は
  `operation-failed` / `compensation-completed` で終わる operation を export
  する前に sampling decision を `RECORD_AND_SAMPLED` に強制する
- tail sampling は collector 側の関心事。 kernel は実装しない

## カーディナリティ {#cardinality}

v1 closed set では高 cardinality な label を禁止する。

- `deploymentId` / `operationId` / `journalEntryId` 等の per-event 識別子は
  label にしない。 span attribute や exemplar field として扱う
- `spaceId` は label として許可する。 Space 数が大きい場合 (v1 では目安として
  1000 超) は collector で storage 前に `spaceId` を aggregate する設定を行う
- operator 名 / hostname / region などの自由 label を kernel は追加しない。
  必要なら OTLP collector の resource attribute 層で注入する

## 認証

両 export surface とも認証必須。

- OTLP exporter は `TAKOSUMI_OTLP_HEADERS_JSON` または
  `OTEL_EXPORTER_OTLP_HEADERS` で設定した header で collector に対し認証する
- Prometheus `/metrics` は
  `Authorization: Bearer <TAKOSUMI_METRICS_SCRAPE_TOKEN>` で scrape token を
  要求する。 未認証 scrape は `401` で reject する。 既知 Prometheus identity
  から in-cluster scrape する想定で、 internet 公開は想定しない

## リソース属性 {#resource-attribute}

OTLP export には installation / role で routing できるよう安定した resource
attribute を付ける。

```text
service.name              "takosumi"
service.namespace         operator-set
service.instance.id       pod / process identifier
takosumi.role             takosumi-{api,worker,router,runtime-agent,log-worker}
takosumi.environment      local | development | test | staging | production
takosumi.release          kernel package version
```

resource attribute は export batch ごとに 1 回付く。 metric point ごとには
付かない。 region / cluster などは OTLP collector の resource processor で
operator 側が追加する。 kernel が region / cluster を自身の環境から
読み取ることはない。

## Pull エンドポイント契約 {#pull-endpoint-contract}

Prometheus `/metrics` の保証:

- kernel HTTP server 稼働中は `200` を返す
- content type は `text/plain; version=0.0.4`
- 1 scrape で `ObservabilitySink` が保持する metric event の一貫した snapshot
  を返す
- 上記 v1 closed set を超える cardinality の label を含む metric は露出しない

kernel shutdown 中の scrape は `Retry-After: 1` を付けて `503` を返す。

## スキーマバージョニング {#schema-versioning}

上記 metric set / label set / span attribute set は **v1 closed schema**
である。 v1 名で dashboard / alert を組む consumer は、 この current schema
と同じ release set で検証する。

- rename は `CONVENTIONS.md` §6 RFC を通す。 schema / implementation / dashboard
  docs / tests を同じ変更で更新する
- RFC に基づく新規 metric 追加は許可。 未知 metric を無視する consumer
  は動作する
- v1 中の削除は不可

## 関連 architecture notes

- `reference/drift-detection` — drift / debt
  / observation gauge の導出
- `reference/architecture/runtime-deployment-model#operation-plan--write-ahead-journal`
  — WAL stage histogram label の根拠
- `reference/architecture/operator-boundaries` — kernel host trust 境界に おける
  export surface の配置

## 関連ページ

- [Logging Conventions](./logging-conventions.md)
- [Observability Stack](./observability-stack.md)
- [Time / Clock Model](./time-clock-model.md)
- [Audit Events](./audit-events.md)
- [Environment Variables](./env-vars.md)
