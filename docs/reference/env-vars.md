# Environment Variables

> このページでわかること: kernel が読む環境変数の一覧。

v1 で kernel が読み取る `TAKOSUMI_*` 環境変数のカタログです。 各 entry に消費
側、 parse 後の型、 既定値、 必須かどうか、 関連 spec concept を列挙します。

::: info 実装範囲 本ページは現行 boot 系と spec 上の契約の両方を列挙してい
ます。 role / environment / public-route / deploy-token / internal-secret /
database / artifact / plugin-selection / audit-retention / observation-retention
/ runtime-agent は kernel boot で確実に parse されます。 API key hashing / trial
cleanup / SLA window / support impersonation / auth-provider JSON / quota-tier
bootstrap などの domain 固有 entry は、 対応 route / worker が配線 されるまでは
spec 上の契約として扱います。 :::

## Precedence

すべての consumer で次の順序で値を解決します。

```text
1. process env                      # 最優先
2. 設定ファイル / inline operator config
3. built-in default                 # 最低
```

CLI が flag を提供する command では、 その flag が上記すべてを上書きします。 新
`TAKOSUMI_*` を追加するには `CONVENTIONS.md` §6 RFC が必須で、 ad-hoc な
追加は不可。

boolean 変数は `1 / true / yes / on / enabled` を真、
`0 / false / no / off / disabled` を偽と解釈。 それ以外は fail closed です。

## Kernel server

kernel の process role は
`takosumi-{api,worker,router,runtime-agent,log-worker}`。 role の選択は
`TAKOSUMI_PROCESS_ROLE` で行い、 以下の他の変数は注記が無い限り role
間で共有されます。

### Connectivity and identity

| Variable                         | Type      | Default                        | Required                                | Consumer                                                                                       | Spec concept            |
| -------------------------------- | --------- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `TAKOSUMI_PROCESS_ROLE`          | enum      | `takosumi-api`                 | yes (production)                        | kernel boot, bootstrap                                                                         | role selection          |
| `TAKOSUMI_ENVIRONMENT`           | enum      | `local`                        | no                                      | runtime config (`local` / `development` / `test` / `staging` / `production`)                   | OperatorBoundaries      |
| `TAKOSUMI_DEV_MODE`              | boolean   | `false`                        | no                                      | runtime config; gates `allowUnsafeProductionDefaults`                                          | OperatorBoundaries      |
| `TAKOSUMI_LISTEN_ADDR`           | host:port | `0.0.0.0:8788`                 | no                                      | kernel HTTP server bind                                                                        | n/a                     |
| `TAKOSUMI_PUBLIC_BASE_URL`       | URL       | unset                          | yes when artifact routes are on         | artifact route enablement, presigned URL synthesis                                             | DataAsset Model         |
| `TAKOSUMI_PUBLIC_ROUTES_ENABLED` | boolean   | `false`                        | no                                      | enables `/api/public/v1/*`; CLI deploy `/v1/deployments` is enabled by `TAKOSUMI_DEPLOY_TOKEN` | public API host         |
| `TAKOSUMI_DEPLOY_TOKEN`          | secret    | unset                          | yes for public deploy / artifact routes | bearer for `POST /v1/deployments`, artifact write endpoints                                    | OperatorBoundaries      |
| `TAKOSUMI_DEPLOY_SPACE_ID`       | string    | `takosumi-deploy`              | no                                      | public deploy tenant / Space scope for the single deploy bearer                                | Space Model             |
| `TAKOSUMI_INTERNAL_API_SECRET`   | secret    | unset                          | yes in production                       | bearer for the internal control-plane RPC                                                      | OperatorBoundaries      |
| `TAKOSUMI_AGENT_URL`             | URL       | unset (kernel embeds an agent) | no                                      | runtime-agent base URL the kernel posts to                                                     | runtime-agent lifecycle |
| `TAKOSUMI_AGENT_TOKEN`           | secret    | unset                          | yes when `TAKOSUMI_AGENT_URL` is set    | bearer for runtime-agent calls                                                                 | runtime-agent lifecycle |

### State and storage

| Variable                           | Type            | Default                                        | Required                                   | Consumer                                                                                       | Spec concept                 |
| ---------------------------------- | --------------- | ---------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `TAKOSUMI_DATABASE_URL`            | URL             | unset (in-memory fallback)                     | yes (production)                           | primary state DB; resolved when no env-specific override matches                               | OperationJournal persistence |
| `TAKOSUMI_STAGING_DATABASE_URL`    | URL             | unset                                          | yes when `TAKOSUMI_ENVIRONMENT=staging`    | preferred URL for staging                                                                      | OperationJournal persistence |
| `TAKOSUMI_PRODUCTION_DATABASE_URL` | URL             | unset                                          | yes when `TAKOSUMI_ENVIRONMENT=production` | preferred URL for production                                                                   | OperationJournal persistence |
| `TAKOSUMI_DB_AUTO_MIGRATE`         | boolean         | `true` (prod / staging), `false` (local / dev) | no                                         | apply migrations at boot                                                                       | n/a                          |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`    | secret          | unset                                          | yes when runtime-agent is remote           | read-only bearer for artifact GET / HEAD                                                       | DataAsset Model              |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`      | bytes (integer) | `52428800` (50 MiB)                            | no                                         | global upload cap; registered artifact kind `maxSize` may override it                          | DataAsset Model              |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | secret          | unset                                          | yes when memory secret-store is selected   | passphrase for the in-memory secret partition; partition-scoped suffixes (`_<NAME>`) supported | Secret isolation invariant   |
| `TAKOSUMI_SECRET_STORE_KEY`        | secret          | unset                                          | no                                         | raw key alternative to the passphrase                                                          | Secret isolation invariant   |
| `TAKOSUMI_LOCK_LEASE_MS`           | integer (ms)    | `30000`                                        | no                                         | cross-process lock lease window                                                                | Cross-Process Locks          |
| `TAKOSUMI_LOCK_HEARTBEAT_MS`       | integer (ms)    | `10000`                                        | no                                         | cross-process lock heartbeat interval                                                          | Cross-Process Locks          |

### Boot timeouts

kernel boot pipeline は各 substrate が ready になるまで待ってから `serving`
に遷移します。 以下の各 timeout は 1 boot stage の待ち時間上限です。

| Variable                                           | Type              | Default | Required | Consumer                                        | Spec concept       |
| -------------------------------------------------- | ----------------- | ------- | -------- | ----------------------------------------------- | ------------------ |
| `TAKOSUMI_BOOT_TIMEOUT_STORAGE_SEC`                | integer (seconds) | `30`    | no       | kernel boot, storage substrate readiness        | Bootstrap protocol |
| `TAKOSUMI_BOOT_TIMEOUT_LOCK_STORE_SEC`             | integer (seconds) | `30`    | no       | kernel boot, lock store readiness               | Bootstrap protocol |
| `TAKOSUMI_BOOT_TIMEOUT_SECRET_PARTITION_SEC`       | integer (seconds) | `15`    | no       | kernel boot, secret partition readiness         | Bootstrap protocol |
| `TAKOSUMI_BOOT_TIMEOUT_PUBLIC_LISTENER_SEC`        | integer (seconds) | `15`    | no       | kernel boot, public listener bind readiness     | Bootstrap protocol |
| `TAKOSUMI_BOOT_TIMEOUT_CATALOG_RELEASE_SEC`        | integer (seconds) | `60`    | no       | kernel boot, catalog release adoption readiness | Bootstrap protocol |
| `TAKOSUMI_BOOT_TIMEOUT_RUNTIME_AGENT_REGISTRY_SEC` | integer (seconds) | `60`    | no       | kernel boot, runtime-agent registry readiness   | Bootstrap protocol |

### Audit replication and observation

| Variable                                          | Type            | Default                 | Required              | Consumer                                                     | Spec concept                    |
| ------------------------------------------------- | --------------- | ----------------------- | --------------------- | ------------------------------------------------------------ | ------------------------------- |
| `TAKOSUMI_AUDIT_RETENTION_REGIME`                 | enum            | `default`               | no                    | one of `default` / `pci-dss` / `hipaa` / `sox` / `regulated` | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_RETENTION_DAYS`                   | integer (days)  | regime-derived          | no                    | per-deployment retention override                            | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_DELETE_AFTER_ARCHIVE`             | boolean         | regime-derived          | no                    | delete local audit row once replication confirms archival    | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_ARCHIVE_GRACE_DAYS`               | integer (days)  | regime-derived          | no                    | grace window before delete-after-archive triggers            | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_REPLICATION_KIND`                 | enum            | unset (replication off) | no                    | one of `s3` / `stdout`                                       | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET`            | string          | unset                   | yes for the `s3` sink | bucket name                                                  | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_REPLICATION_S3_PREFIX`            | string          | unset                   | no                    | object key prefix                                            | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_MODE`    | enum            | `COMPLIANCE`            | no                    | S3 Object Lock retention mode (`GOVERNANCE` / `COMPLIANCE`)  | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_DAYS`    | integer (days)  | unset                   | no                    | S3 Object Lock retention window                              | Operational Hardening Checklist |
| `TAKOSUMI_AUDIT_CHAIN_ROTATION_INTERVAL_HOURS`    | integer (hours) | `24`                    | no                    | audit chain rotation interval (new chain segment cadence)    | Audit Events                    |
| `TAKOSUMI_OBSERVATION_RETENTION_DISABLE`          | boolean         | `false`                 | no                    | disables the observation retention worker                    | ObservationSet model            |
| `TAKOSUMI_OBSERVATION_RETENTION_RECENT_DAYS`      | integer (days)  | provider default        | no                    | window for recent ObservationSet rows                        | ObservationSet model            |
| `TAKOSUMI_OBSERVATION_RETENTION_ARCHIVE_CAP_DAYS` | integer (days)  | provider default        | no                    | cap for archived ObservationSet rows                         | ObservationSet model            |
| `TAKOSUMI_METRICS_SCRAPE_TOKEN`                   | string          | unset                   | no                    | enables and protects Prometheus `/metrics` on API role       | Telemetry / Metrics             |
| `TAKOSUMI_OTLP_METRICS_ENDPOINT`                  | URL             | unset                   | no                    | enables native OTLP/HTTP JSON metric export                  | Telemetry / Metrics             |
| `TAKOSUMI_OTLP_TRACES_ENDPOINT`                   | URL             | unset                   | no                    | enables native OTLP/HTTP JSON trace export                   | Telemetry / Metrics             |
| `TAKOSUMI_OTLP_HEADERS_JSON`                      | JSON object     | `{}`                    | no                    | extra headers sent to the OTLP collector                     | Telemetry / Metrics             |
| `TAKOSUMI_OTLP_SERVICE_NAME`                      | string          | `takosumi-kernel`       | no                    | OTLP `service.name` resource attribute                       | Telemetry / Metrics             |
| `TAKOSUMI_OTLP_FAIL_CLOSED`                       | boolean         | `false`                 | no                    | fail telemetry recording when collector export fails         | Telemetry / Metrics             |
| `TAKOSUMI_LOG_LEVEL`                              | enum            | `info`                  | no                    | minimum structured log level                                 | Logging Conventions             |
| `TAKOSUMI_LOG_FORMAT`                             | enum            | env-derived             | no                    | `json` / `text` log output policy                            | Logging Conventions             |
| `TAKOSUMI_HTTP_REQUEST_LOGS`                      | boolean         | env-derived             | no                    | enables JSON HTTP request logs outside staging / production  | Observability Stack             |

### Worker daemon

| Variable                                   | Type         | Default             | Required | Consumer                                       | Spec concept               |
| ------------------------------------------ | ------------ | ------------------- | -------- | ---------------------------------------------- | -------------------------- |
| `TAKOSUMI_PAAS_WORKER_HEARTBEAT_FILE`      | path         | unset               | no       | path the worker daemon touches for liveness    | n/a                        |
| `TAKOSUMI_PAAS_WORKER_POLL_INTERVAL_MS`    | integer (ms) | `250`               | no       | worker poll loop interval                      | WAL stages                 |
| `TAKOSUMI_APPLY_QUEUE`                     | string       | provider default    | no       | queue name the apply worker consumes           | OperationJournal lifecycle |
| `TAKOSUMI_WORKER_POLL_INTERVAL_MS`         | integer (ms) | provider default    | no       | apply worker poll interval                     | OperationJournal lifecycle |
| `TAKOSUMI_WORKER_VISIBILITY_TIMEOUT_MS`    | integer (ms) | provider default    | no       | message visibility timeout for the apply queue | OperationJournal lifecycle |
| `TAKOSUMI_OUTBOX_DISPATCH_LIMIT`           | integer      | provider default    | no       | per-tick batch limit for the outbox dispatcher | OperationJournal lifecycle |
| `TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS` | integer (ms) | apply poll interval | no       | RevokeDebt cleanup worker cadence              | RevokeDebt                 |
| `TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT`       | integer      | `50`                | no       | per-owner-Space cleanup batch limit            | RevokeDebt                 |

### Plugin selectors

kernel は plugin port (`auth` / `coordination` / `notification` /
`operator-config` / `storage` / `source` / `provider` / `queue` /
`object-storage` / `kms` / `secret-store` / `router-config` / `observability` /
`runtime-agent`) ごとに Implementation を選択します。

| Variable                                                                                 | Type        | Default          | Required                            | Consumer                                                       | Spec concept       |
| ---------------------------------------------------------------------------------------- | ----------- | ---------------- | ----------------------------------- | -------------------------------------------------------------- | ------------------ |
| `TAKOSUMI_<PORT>_PLUGIN` / `TAKOSUMI_<PORT>_PLUGIN_ID`                                   | string      | unset            | yes per port (production / staging) | plugin id selector for the named port                          | OperatorBoundaries |
| `TAKOSUMI_KERNEL_PLUGIN_SELECTIONS` / `TAKOSUMI_KERNEL_PLUGIN_MAP`                       | JSON object | unset            | no                                  | bulk port-to-id map                                            | OperatorBoundaries |
| `TAKOSUMI_KERNEL_PLUGIN_CONFIG` / `TAKOSUMI_KERNEL_PLUGIN_CONFIG_JSON`                   | JSON object | `{}`             | no                                  | merged plugin configuration                                    | OperatorBoundaries |
| `TAKOSUMI_KERNEL_PLUGIN_MODULES`                                                         | CSV string  | unset            | no                                  | dynamic kernel plugin module specifiers (dev/reference only)   | OperatorBoundaries |
| `TAKOSUMI_TRUSTED_KERNEL_PLUGIN_MANIFESTS` / `TAKOSUMI_KERNEL_PLUGIN_REGISTRY_MANIFESTS` | JSON list   | unset            | no                                  | trusted plugin manifest list                                   | OperatorBoundaries |
| `TAKOSUMI_KERNEL_PLUGIN_TRUST_KEYS`                                                      | JSON list   | unset            | no                                  | trust public keys for plugin manifests                         | OperatorBoundaries |
| `TAKOSUMI_KERNEL_PLUGIN_INSTALL_POLICY`                                                  | JSON object | unset            | no                                  | trusted install policy object                                  | OperatorBoundaries |
| `TAKOSUMI_REGISTRY_TRUST_ROOTS_JSON`                                                     | JSON object | provider default | no                                  | registry trust roots                                           | OperatorBoundaries |
| `TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES`                                          | boolean     | `false`          | no                                  | enables the dynamic kernel plugin loader                       | OperatorBoundaries |
| `TAKOSUMI_ENABLE_REFERENCE_KERNEL_PLUGIN_LOADER`                                         | boolean     | `false`          | no                                  | enables the reference plugin loader                            | OperatorBoundaries |
| `TAKOSUMI_ENABLE_DENO_DEPLOY_PROVIDER`                                                   | boolean     | `false`          | no                                  | opt-in registration of the Deno Deploy provider in stock boots | n/a                |

kernel は marketplace URL / package selector や remote plugin install を
サポートしません。 operator packaging が plugin module
を持ち込むのは可能ですが、 marketplace 機構は持ちません。

### Deploy Credentials

account plane の auth provider と user API key は Takosumi Accounts が所有 し、
kernel は operator の deploy / artifact credential と runtime-agent credential
のみを所有します。

### Tenant Lifecycle

| Variable                                    | Type              | Default | Required | Consumer                                                                 | Spec concept             |
| ------------------------------------------- | ----------------- | ------- | -------- | ------------------------------------------------------------------------ | ------------------------ |
| `TAKOSUMI_TRIAL_EXPIRY_WARN_SECONDS`        | integer (seconds) | `86400` | no       | kernel server; window before trial expiry to emit warning notification   | Trial Spaces             |
| `TAKOSUMI_TRIAL_FROZEN_GRACE_SECONDS`       | integer (seconds) | `86400` | no       | kernel server; grace window after trial freeze before automatic cleanup  | Trial Spaces             |
| `TAKOSUMI_TRIAL_AUTO_CLEANUP_DISABLE`       | boolean           | `false` | no       | kernel server; disables the trial auto-cleanup worker                    | Trial Spaces             |
| `TAKOSUMI_TRIAL_DEFAULT_QUOTA_TIER_ID`      | string            | unset   | no       | kernel server; default quota tier assigned to new trial Spaces           | Trial Spaces             |
| `TAKOSUMI_QUOTA_TIER_BOOTSTRAP_REQUIRED`    | boolean           | `true`  | no       | kernel server; refuses boot when no quota tier catalog row is present    | Quota Tiers              |
| `TAKOSUMI_SPACE_DELETE_CONFIRM_TTL_SECONDS` | integer (seconds) | `600`   | no       | kernel server; lifetime of `confirmCode` issued for `DELETE /spaces/:id` | Tenant Export & Deletion |
| `TAKOSUMI_SPACE_SOFT_DELETE_RETENTION_DAYS` | integer (days)    | `30`    | no       | kernel server; retention window before soft-deleted Space is purged      | Tenant Export & Deletion |
| `TAKOSUMI_EXPORT_DOWNLOAD_URL_TTL_SECONDS`  | integer (seconds) | `3600`  | no       | kernel server; TTL of presigned export download URLs                     | Tenant Export            |
| `TAKOSUMI_EXPORT_MAX_CONCURRENT_PER_SPACE`  | integer           | `1`     | no       | kernel server; max concurrent export jobs per Space                      | Tenant Export            |

### PaaS Operations

| Variable                                   | Type              | Default | Required | Consumer                                                                         | Spec concept          |
| ------------------------------------------ | ----------------- | ------- | -------- | -------------------------------------------------------------------------------- | --------------------- |
| `TAKOSUMI_SLA_WINDOW_SECONDS`              | integer (seconds) | `300`   | no       | kernel server; rolling window granularity for SLA breach detection               | SLA Breach Detection  |
| `TAKOSUMI_SUPPORT_SESSION_TTL_SECONDS`     | integer (seconds) | `3600`  | no       | kernel server; default TTL for accepted support impersonation sessions           | Support Impersonation |
| `TAKOSUMI_SUPPORT_SESSION_MAX_TTL_SECONDS` | integer (seconds) | `86400` | no       | kernel server; upper bound on support session TTL accepted from operator request | Support Impersonation |
| `TAKOSUMI_TELEMETRY_ATTRIBUTION_PROMOTE`   | string list (CSV) | unset   | no       | telemetry exporters; cost attribution labels promoted to first-class metric tags | Cost Attribution      |

### Zone Configuration

| Variable                          | Type              | Default              | Required | Consumer                                                                                         | Spec concept   |
| --------------------------------- | ----------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------ | -------------- |
| `TAKOSUMI_ZONES_AVAILABLE`        | string list (CSV) | unset (empty)        | no       | kernel server; closed list of zone ids selectable from manifests                                 | Zone Selection |
| `TAKOSUMI_ZONE_DEFAULT`           | string            | unset                | no       | kernel server; zone applied when a Space provisioning request omits `zone`                       | Zone Selection |
| `TAKOSUMI_CROSS_ZONE_LINK_POLICY` | enum              | `allow-with-warning` | no       | kernel server; one of `allow` / `allow-with-warning` / `deny` for cross-zone resource references | Zone Selection |

## CLI

`takosumi` CLI は以下の変数を読み、 remote URL / token / config file path を
解決します。 解決順序は [CLI Reference](/reference/cli) を参照。

| Variable                | Type   | Default                  | Required                                | Consumer                                           | Spec concept            |
| ----------------------- | ------ | ------------------------ | --------------------------------------- | -------------------------------------------------- | ----------------------- |
| `TAKOSUMI_REMOTE_URL`   | URL    | unset                    | yes for remote-only commands            | base URL of the kernel HTTP server                 | n/a                     |
| `TAKOSUMI_DEPLOY_TOKEN` | secret | unset                    | yes for deploy and artifact subcommands | bearer for `/v1/deployments` and `/v1/artifacts/*` | DataAsset Model         |
| `TAKOSUMI_AGENT_URL`    | URL    | unset                    | yes for `runtime-agent list / verify`   | runtime-agent base URL                             | runtime-agent lifecycle |
| `TAKOSUMI_AGENT_TOKEN`  | secret | unset                    | yes when `TAKOSUMI_AGENT_URL` is set    | bearer for runtime-agent calls                     | runtime-agent lifecycle |
| `TAKOSUMI_CONFIG_FILE`  | path   | `~/.takosumi/config.yml` | no                                      | override path for the CLI config file              | n/a                     |

## Runtime-Agent

runtime-agent プロセスは cloud SDK の credential を保持します。 cloud credential
は各 SDK の標準変数 (例: `AWS_*`、 `GOOGLE_APPLICATION_CREDENTIALS`、
`CLOUDFLARE_API_TOKEN`、 `AZURE_*`) から 読み込み、 Takosumi catalog
の対象外です。 kernel host には絶対に置きませ ん。

| Variable                                    | Type   | Default           | Required                         | Consumer                                                                | Spec concept            |
| ------------------------------------------- | ------ | ----------------- | -------------------------------- | ----------------------------------------------------------------------- | ----------------------- |
| `TAKOSUMI_AGENT_TOKEN`                      | secret | random when unset | yes in remote topology           | bearer for the runtime-agent HTTP server                                | runtime-agent lifecycle |
| `TAKOSUMI_KUBERNETES_API_SERVER_URL`        | URL    | unset             | yes for the Kubernetes connector | k8s API server URL                                                      | runtime-agent lifecycle |
| `TAKOSUMI_KUBERNETES_BEARER_TOKEN`          | secret | unset             | yes for the Kubernetes connector | k8s bearer token                                                        | runtime-agent lifecycle |
| `TAKOSUMI_KUBERNETES_NAMESPACE`             | string | `takosumi`        | no                               | working namespace for the Kubernetes connector                          | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT`     | path   | unset             | no                               | filesystem root for the self-hosted object-store backend                | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_DOCKER_SOCKET`         | path   | unset             | no                               | docker socket path for the docker connector                             | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR`      | path   | unset             | no                               | unit directory for the systemd connector                                | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_OBJECT_STORE_ENDPOINT` | URL    | unset             | no                               | minio / S3-compatible endpoint for the self-hosted object-store backend | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_COREDNS_FILE`          | path   | unset             | no                               | coredns configuration file path                                         | runtime-agent lifecycle |
| `TAKOSUMI_SELFHOSTED_POSTGRES_HOST`         | string | unset             | no                               | self-hosted postgres host                                               | runtime-agent lifecycle |

runtime-agent の enrolment フロー: operator が agent host に token (env 設定
または乱数生成) を渡し、 kernel host を `TAKOSUMI_AGENT_URL` +
`TAKOSUMI_AGENT_TOKEN` で同じ token に揃え、 kernel は lifecycle envelope を
送信する前に agent の `GET /v1/health` を検証します。

## 拒否される selector key

非 current plugin selector 形式 (`*_BACKEND` / `*_ADAPTER`、旧 bootstrap adapter
family) は boot 時に reject されます。 current 形式は `TAKOSUMI_<PORT>_PLUGIN`。
これらの key が存在する構成は起動拒否され、互換 layer はありません。

拒否される名前の閉じた一覧:

```text
TAKOSUMI_STORAGE_BACKEND
TAKOSUMI_STORAGE_ADAPTER
TAKOSUMI_PROVIDER
TAKOSUMI_PROVIDER_ADAPTER
TAKOSUMI_QUEUE_BACKEND
TAKOSUMI_QUEUE_ADAPTER
TAKOSUMI_OBJECT_STORAGE_BACKEND
TAKOSUMI_OBJECT_STORAGE_ADAPTER
TAKOSUMI_SOURCE
TAKOSUMI_SOURCE_ADAPTER
TAKOSUMI_KMS_BACKEND
TAKOSUMI_KMS_ADAPTER
TAKOSUMI_SECRET_STORE_BACKEND
TAKOSUMI_SECRET_STORE_ADAPTER
TAKOSUMI_REDIS_URL
TAKOSUMI_S3_ENDPOINT
TAKOSUMI_S3_BUCKET
TAKOSUMI_OBJECT_STORAGE_URL
TAKOSUMI_LOCAL_DOCKER_NETWORK
TAKOSUMI_KMS_PROVIDER
TAKOSUMI_KMS_KEY_ID
TAKOSUMI_KMS_KEY_VERSION
TAKOSUMI_SECRET_STORE_PROVIDER
TAKOSUMI_SECRET_STORE_NAMESPACE
TAKOSUMI_BOOTSTRAP_*_ADAPTER
```

これらが存在すると、 `loadRuntimeConfig` は `stale_runtime_selector` の
diagnostic を出して起動を拒否します。

## Host 配置

上記変数は host 役割ごとに分割します。 同一 host で混在させると
OperatorBoundaries trust model を弱めます。

- kernel host: state / storage 変数、 deploy / internal token、 artifact
  policy、 plugin selector、 audit / observation retention、 runtime-agent URL /
  bearer
- runtime-agent host: agent bearer、 `TAKOSUMI_KUBERNETES_*` /
  `TAKOSUMI_SELFHOSTED_*`、 cloud SDK credential。 deploy bearer と internal
  control-plane secret は kernel host から外に出さない
- CLI host (operator workstation、 CI): remote URL、 deploy bearer、 必要に
  応じて runtime-agent URL / bearer、 非デフォルト設定で `TAKOSUMI_CONFIG_FILE`

## 関連

- リファレンス: [CLI](/reference/cli)、
  [DataAsset Kinds](/reference/artifact-kinds)、
  [DataAsset Policy](/reference/data-asset-policy)、
  [Secret Partitions](/reference/secret-partitions)、
  [Schema Evolution](/reference/migration-upgrade)、
  [Compliance Retention](/reference/compliance-retention)、
  [Observation Retention](/reference/observation-retention)

## 関連ページ

- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export & Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [Zone Selection](/reference/zone-selection)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Kernel HTTP API](/reference/kernel-http-api)

## 関連ページ

- [Secret Partitions](/reference/secret-partitions)
- [CLI Reference](/reference/cli)
- [DataAsset Policy](/reference/data-asset-policy)
