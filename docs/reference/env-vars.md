# 環境変数 {#environment-variables}

`TAKOSUMI_*` 環境変数の一覧。public Installer API に直接属する env は `TAKOSUMI_INSTALLER_TOKEN` です。その他は reference Takosumi server、 operator extension、runtime-agent、CLI の設定です。

## 優先順位

```text
1. CLI flag
2. process env
3. config file / inline operator config
4. built-in default
```

boolean は `1 / true / yes / on / enabled` を真、 `0 / false / no / off / disabled` を偽として扱います。それ以外は fail closed です。

## Reference Takosumi server

| Variable                       | Type    | Default | Required                       | 説明                                                                  |
| ------------------------------ | ------- | ------- | ------------------------------ | --------------------------------------------------------------------- |
| `TAKOSUMI_ENVIRONMENT`         | enum    | `local` | no                             | `local` / `development` / `test` / `staging` / `production`。         |
| `TAKOSUMI_DEV_MODE`            | boolean | `false` | no                             | dev 専用 unsafe defaults opt-out。production では使わない。           |
| `PORT`                         | number  | `8788`  | no                             | Takosumi HTTP server port。CLI は `takosumi server --port` で設定。   |
| `TAKOSUMI_PUBLIC_BASE_URL`     | URL     | unset   | asset routes 使用時            | asset URL synthesis 用の public base URL。                            |
| `TAKOSUMI_INSTALLER_TOKEN`     | secret  | unset   | public installer routes 使用時 | Installer API bearer。                                                |
| `TAKOSUMI_DEPLOY_TOKEN`        | secret  | unset   | asset write routes 使用時      | optional asset upload / write bearer。                                |
| `TAKOSUMI_INTERNAL_API_SECRET` | secret  | unset   | production                     | internal control-plane RPC bearer。                                   |
| `TAKOSUMI_AGENT_URL`           | URL     | unset   | remote agent topology          | runtime-agent base URL。unset 時は embedded execution role を使える。 |
| `TAKOSUMI_AGENT_TOKEN`         | secret  | unset   | remote agent topology          | runtime-agent call bearer。                                           |

## Platform service resolver

Reference Takosumi service が BindingSelection の PlatformService path を operator account-plane に問い合わせるための設定です。これは implementation wiring であり、Source grammar や Cloud 固有 path を service contract に追加するものではありません。

| Variable                                   | Type   | Default | Required                          | 説明                                                                |
| ------------------------------------------ | ------ | ------- | --------------------------------- | ------------------------------------------------------------------- |
| `TAKOSUMI_PLATFORM_SERVICE_RESOLVER_URL`   | URL    | unset   | platform service を解決する場合   | operator account-plane の resolver endpoint。POST JSON で呼び出す。 |
| `TAKOSUMI_PLATFORM_SERVICE_RESOLVER_TOKEN` | secret | unset   | resolver が bearer を要求する場合 | resolver endpoint に送る bearer token。                             |

## Storage and locks

| Variable                           | Type       | Default            | Required                | 説明                             |
| ---------------------------------- | ---------- | ------------------ | ----------------------- | -------------------------------- |
| `TAKOSUMI_DATABASE_URL`            | URL        | in-memory fallback | production              | primary state DB。               |
| `TAKOSUMI_STAGING_DATABASE_URL`    | URL        | unset              | staging                 | staging fallback DB URL。        |
| `TAKOSUMI_PRODUCTION_DATABASE_URL` | URL        | unset              | production              | production fallback DB URL。     |
| `TAKOSUMI_DB_AUTO_MIGRATE`         | boolean    | env-derived        | no                      | boot 時 migration 実行。         |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | secret     | unset              | production secret store | memory secret-store passphrase。 |
| `TAKOSUMI_SECRET_STORE_KEY`        | secret     | unset              | no                      | passphrase の代替 raw key。      |
| `TAKOSUMI_LOCK_LEASE_MS`           | integer ms | `30000`            | no                      | cross-process lock lease。       |
| `TAKOSUMI_LOCK_HEARTBEAT_MS`       | integer ms | `10000`            | no                      | lock heartbeat interval。        |

## Optional asset Routes

| Variable                              | Type          | Default    | Required              | 説明                                                        |
| ------------------------------------- | ------------- | ---------- | --------------------- | ----------------------------------------------------------- |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`       | secret        | unset      | remote agent topology | optional asset GET / HEAD read bearer。                     |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`         | bytes         | `52428800` | no                    | optional asset upload cap。operator metadata が上書き可能。 |
| `TAKOSUMI_ARTIFACT_GC_GRACE_DAYS`     | integer days  | `7`        | no                    | optional asset GC sweep grace window。                      |
| `TAKOSUMI_ARTIFACT_GC_PERIODIC_HOURS` | integer hours | `24`       | no                    | periodic asset GC cadence。`0` で off。                     |

## Boot timeouts

| Variable                                           | Type    | Default | Required | 説明                                                               |
| -------------------------------------------------- | ------- | ------- | -------- | ------------------------------------------------------------------ |
| `TAKOSUMI_BOOT_TIMEOUT_STORAGE_SEC`                | seconds | `30`    | no       | storage readiness timeout。                                        |
| `TAKOSUMI_BOOT_TIMEOUT_LOCK_STORE_SEC`             | seconds | `30`    | no       | lock store readiness timeout。                                     |
| `TAKOSUMI_BOOT_TIMEOUT_SECRET_PARTITION_SEC`       | seconds | `15`    | no       | secret partition readiness timeout。                               |
| `TAKOSUMI_BOOT_TIMEOUT_PUBLIC_LISTENER_SEC`        | seconds | `15`    | no       | service control-plane listener bind timeout (historical env name)。 |
| `TAKOSUMI_BOOT_TIMEOUT_PLUGIN_BOOTSTRAP_SEC`       | seconds | `60`    | no       | binding bootstrap timeout (historical env name)。                  |
| `TAKOSUMI_BOOT_TIMEOUT_RUNTIME_AGENT_REGISTRY_SEC` | seconds | `60`    | no       | runtime-agent registry timeout。                                   |

## Observability

| Variable                               | Type         | Default           | Required    | 説明                                                       |
| -------------------------------------- | ------------ | ----------------- | ----------- | ---------------------------------------------------------- |
| `TAKOSUMI_METRICS_SCRAPE_TOKEN`        | secret       | unset             | no          | `/metrics` を有効化して bearer で保護する。                |
| `TAKOSUMI_OTLP_METRICS_ENDPOINT`       | URL          | unset             | no          | OTLP/HTTP metric export endpoint。                         |
| `TAKOSUMI_OTLP_TRACES_ENDPOINT`        | URL          | unset             | no          | OTLP/HTTP trace export endpoint。                          |
| `TAKOSUMI_OTLP_HEADERS_JSON`           | JSON object  | `{}`              | no          | OTLP export extra headers。                                |
| `TAKOSUMI_OTLP_SERVICE_NAME`           | string       | `takosumi-service` | no          | OTLP `service.name`。                                      |
| `TAKOSUMI_OTLP_FAIL_CLOSED`            | boolean      | `false`           | no          | collector export failure を recording failure として扱う。 |
| `TAKOSUMI_LOG_LEVEL`                   | enum         | `info`            | no          | structured log minimum level。                             |
| `TAKOSUMI_LOG_FORMAT`                  | enum         | env-derived       | no          | `json` / `text`。                                          |
| `TAKOSUMI_HTTP_REQUEST_LOGS`           | boolean      | env-derived       | no          | JSON HTTP request logs。                                   |
| `TAKOSUMI_AUDIT_RETENTION_DAYS`        | integer days | regime-derived    | no          | audit retention override。                                 |
| `TAKOSUMI_AUDIT_REPLICATION_KIND`      | enum         | unset             | no          | audit replication sink。                                   |
| `TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET` | string       | unset             | sink 使用時 | audit replication S3 bucket。                              |

## Worker daemon

`TAKOSUMI_PAAS_WORKER_*` は historical prefix。

| Variable                                   | Type       | Default             | Required | 説明                                 |
| ------------------------------------------ | ---------- | ------------------- | -------- | ------------------------------------ |
| `TAKOSUMI_PAAS_WORKER_HEARTBEAT_FILE`      | path       | unset               | no       | worker daemon liveness file。        |
| `TAKOSUMI_PAAS_WORKER_POLL_INTERVAL_MS`    | integer ms | `250`               | no       | worker poll loop interval。          |
| `TAKOSUMI_APPLY_QUEUE`                     | string     | provider default    | no       | apply worker queue name。            |
| `TAKOSUMI_WORKER_POLL_INTERVAL_MS`         | integer ms | provider default    | no       | apply worker poll interval。         |
| `TAKOSUMI_WORKER_VISIBILITY_TIMEOUT_MS`    | integer ms | provider default    | no       | apply queue visibility timeout。     |
| `TAKOSUMI_OUTBOX_DISPATCH_LIMIT`           | integer    | provider default    | no       | outbox dispatcher batch limit。      |
| `TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS` | integer ms | apply poll interval | no       | CleanupBacklog cleanup cadence。     |
| `TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT`       | integer    | `50`                | no       | CleanupBacklog cleanup batch limit。 |

## CLI

| Variable                   | Type   | Default                  | Required             | 説明                          |
| -------------------------- | ------ | ------------------------ | -------------------- | ----------------------------- |
| `TAKOSUMI_REMOTE_URL`      | URL    | unset                    | remote commands      | Takosumi HTTP server URL。    |
| `TAKOSUMI_INSTALLER_TOKEN` | secret | unset                    | installer commands   | installer bearer。            |
| `TAKOSUMI_DEPLOY_TOKEN`    | secret | unset                    | asset write commands | optional asset write bearer。 |
| `TAKOSUMI_AGENT_URL`       | URL    | unset                    | agent commands       | runtime-agent URL。           |
| `TAKOSUMI_AGENT_TOKEN`     | secret | unset                    | agent commands       | runtime-agent bearer。        |
| `TAKOSUMI_CONFIG_FILE`     | path   | `~/.takosumi/config.yml` | no                   | CLI config file override。    |

## Runtime-Agent

runtime-agent process は cloud SDK credential を保持します。`AWS_*`、 `GOOGLE_APPLICATION_CREDENTIALS`、`CLOUDFLARE_API_TOKEN`、`AZURE_*` などの backend-specific env は runtime-agent host または native kind implementation 側で読み、 service host には置きません。

| Variable                                       | Type   | Default           | Required             | 説明                             |
| ---------------------------------------------- | ------ | ----------------- | -------------------- | -------------------------------- |
| `TAKOSUMI_AGENT_TOKEN`                         | secret | random when unset | remote topology      | runtime-agent HTTP bearer。      |
| `TAKOSUMI_KUBERNETES_API_SERVER_URL`           | URL    | unset             | Kubernetes connector | k8s API server URL。             |
| `TAKOSUMI_KUBERNETES_BEARER_TOKEN`             | secret | unset             | Kubernetes connector | k8s bearer token。               |
| `TAKOSUMI_KUBERNETES_NAMESPACE`                | string | `takosumi`        | no                   | k8s namespace。                  |
| `TAKOSUMI_LOCAL_ADAPTER_OBJECT_STORE_ROOT`     | path   | unset             | no                   | filesystem object-store root。   |
| `TAKOSUMI_LOCAL_ADAPTER_DOCKER_SOCKET`         | path   | unset             | no                   | docker socket path。             |
| `TAKOSUMI_LOCAL_ADAPTER_SYSTEMD_UNIT_DIR`      | path   | unset             | no                   | systemd unit directory。         |
| `TAKOSUMI_LOCAL_ADAPTER_OBJECT_STORE_ENDPOINT` | URL    | unset             | no                   | MinIO / S3-compatible endpoint。 |
| `TAKOSUMI_LOCAL_ADAPTER_COREDNS_FILE`          | path   | unset             | no                   | CoreDNS config path。            |
| `TAKOSUMI_LOCAL_ADAPTER_POSTGRES_HOST`         | string | unset             | no                   | Docker Postgres host。           |

## Binding Config

An operator using the Takosumi service passes a reference adapter array through the `plugins` option to `createTakosumiService({ plugins })`. adapter が必要とする credential / config は factory option か runtime-agent host env から読みます。implementation package の取得方法は operator distribution の責務です。

## 関連ページ

- [Operator Bootstrap](../operator/bootstrap.md)
- [Operator-managed 運用](../operator/operator-managed.md)
- [asset Policy](./data-asset-policy.md)
- [Secret Partitions](./secret-partitions.md)
- [Telemetry / Metrics](./telemetry-metrics.md)
- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)
