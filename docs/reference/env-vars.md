# Environment Variables

> Stability: stable Audience: operator See also:
> [Secret Partitions](/reference/secret-partitions),
> [CLI Reference](/reference/cli),
> [DataAsset Policy](/reference/data-asset-policy)

This page is the v1 catalog of `TAKOSUMI_*` environment variables. Each entry
lists the consuming target, the type the value is parsed as, the default,
whether the variable is required, and the spec concept it relates to.

::: info Current implementation scope This catalog includes both current boot
workers are not mounted yet. Current kernel boot code definitely parses the role
/ environment / public-route / deploy-token / internal-secret / database /
artifact / plugin-selection / audit-retention / observation-retention /
runtime-agent variables documented below. Domain-specific rows such as API key
hashing, trial cleanup, SLA windows, support impersonation, auth-provider JSON,
and quota-tier bootstrap are spec contracts until their corresponding service
routes or workers are wired. :::

## Precedence

Across every consumer, values are resolved in this order:

```text
1. process env                      # highest precedence
2. configuration file / inline operator config
3. built-in default                 # lowest precedence
```

A flag passed on a CLI command always overrides every source above when the
command exposes the flag. Adding a new `TAKOSUMI_*` variable requires the
`CONVENTIONS.md` §6 RFC; ad-hoc variables are not allowed.

Boolean variables accept `1 / true / yes / on / enabled` as truthy and
`0 / false / no / off / disabled` as falsy. Anything else fails closed.

## Kernel server

The kernel process roles are
`takosumi-{api,worker,router,runtime-agent,log-worker}`. Selection between roles
is driven by `TAKOSUMI_PAAS_PROCESS_ROLE`; every other variable below is shared
across roles unless noted.

### Connectivity and identity

| Variable                         | Type      | Default                        | Required                                | Consumer                                                                                       | Spec concept            |
| -------------------------------- | --------- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `TAKOSUMI_PAAS_PROCESS_ROLE`     | enum      | `takosumi-api`                 | yes (production)                        | kernel boot, bootstrap                                                                         | role selection          |
| `TAKOSUMI_PROCESS_ROLE`          | enum      | `takosumi-api`                 | no                                      | alias of `TAKOSUMI_PAAS_PROCESS_ROLE`; if both are set they must match                         | role selection          |
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
| `TAKOSUMI_DB_URL`                  | URL             | unset                                          | no                                         | shared alias for the active environment's database URL                                         | OperationJournal persistence |
| `TAKOSUMI_DATABASE_URL`            | URL             | unset (in-memory fallback)                     | yes (production)                           | primary state DB; resolved when no env-specific override matches                               | OperationJournal persistence |
| `TAKOSUMI_STAGING_DATABASE_URL`    | URL             | unset                                          | yes when `TAKOSUMI_ENVIRONMENT=staging`    | preferred URL for staging                                                                      | OperationJournal persistence |
| `TAKOSUMI_PRODUCTION_DATABASE_URL` | URL             | unset                                          | yes when `TAKOSUMI_ENVIRONMENT=production` | preferred URL for production                                                                   | OperationJournal persistence |
| `TAKOSUMI_DB_AUTO_MIGRATE`         | boolean         | `true` (prod / staging), `false` (local / dev) | no                                         | apply migrations at boot                                                                       | n/a                          |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`    | secret          | unset                                          | yes when runtime-agent is remote           | read-only bearer for artifact GET / HEAD                                                       | DataAsset Model              |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`      | bytes (integer) | `52428800` (50 MiB)                            | no                                         | global upload cap; registered artifact kind `maxSize` may override it                          | DataAsset Model              |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | secret          | unset                                          | yes when memory secret-store is selected   | passphrase for the in-memory secret partition; partition-scoped suffixes (`_<NAME>`) supported | Secret isolation invariant   |
| `TAKOSUMI_SECRET_STORE_KEY`        | secret          | unset                                          | no                                         | raw key alternative to the passphrase                                                          | Secret isolation invariant   |
| `TAKOSUMI_SECRET_ENCRYPTION_KEY`   | secret          | unset                                          | no                                         | additional alias of `TAKOSUMI_SECRET_STORE_KEY`                                                | Secret isolation invariant   |
| `TAKOSUMI_LOCK_LEASE_MS`           | integer (ms)    | `30000`                                        | no                                         | cross-process lock lease window                                                                | Cross-Process Locks          |
| `TAKOSUMI_LOCK_HEARTBEAT_MS`       | integer (ms)    | `10000`                                        | no                                         | cross-process lock heartbeat interval                                                          | Cross-Process Locks          |

### Boot timeouts

The kernel boot pipeline waits for each substrate to become ready before
transitioning to `serving`. Each timeout below caps the wait window for one boot
stage.

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

The kernel selects an Implementation per plugin port (`auth`, `coordination`,
`notification`, `operator-config`, `storage`, `source`, `provider`, `queue`,
`object-storage`, `kms`, `secret-store`, `router-config`, `observability`,
`runtime-agent`).

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

The kernel does not support marketplace URL/package selectors or remote plugin
install. Operator packaging may provide plugin modules, but marketplace

### Deploy Credentials

Account-plane auth providers and user API keys are owned by Takosumi Accounts.
The kernel only owns operator deploy/artifact credentials and runtime-agent
credentials.

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

The `takosumi` CLI reads its own variables and resolves a remote URL, token, and
config-file path from them. See [CLI Reference](/reference/cli) for the full
resolution order.

| Variable                | Type   | Default                  | Required                                | Consumer                                                            | Spec concept            |
| ----------------------- | ------ | ------------------------ | --------------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| `TAKOSUMI_REMOTE_URL`   | URL    | unset                    | yes for remote-only commands            | base URL of the kernel HTTP server                                  | n/a                     |
| `TAKOSUMI_DEPLOY_TOKEN` | secret | unset                    | yes for deploy and artifact subcommands | bearer for `/v1/deployments` and `/v1/artifacts/*`                  | DataAsset Model         |
| `TAKOSUMI_TOKEN`        | secret | unset                    | no                                      | generic token alias; warns once and prefers `TAKOSUMI_DEPLOY_TOKEN` | n/a                     |
| `TAKOSUMI_AGENT_URL`    | URL    | unset                    | yes for `runtime-agent list / verify`   | runtime-agent base URL                                              | runtime-agent lifecycle |
| `TAKOSUMI_AGENT_TOKEN`  | secret | unset                    | yes when `TAKOSUMI_AGENT_URL` is set    | bearer for runtime-agent calls                                      | runtime-agent lifecycle |
| `TAKOSUMI_CONFIG_FILE`  | path   | `~/.takosumi/config.yml` | no                                      | override path for the CLI config file                               | n/a                     |

## Runtime-Agent

The runtime-agent process holds cloud SDK credentials. Cloud credentials are
read from each SDK's standard variables (for example `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDFLARE_API_TOKEN`, `AZURE_*`); they are
not part of the Takosumi catalog and must never live on the kernel host.

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

The runtime-agent enrolment flow uses the agent token: the operator provisions a
token on the agent host (env or random), the kernel host is configured with the
same token through `TAKOSUMI_AGENT_URL` plus `TAKOSUMI_AGENT_TOKEN`, and the
kernel verifies the agent's `GET /v1/health` before posting any lifecycle
envelope.

## Stale selector keys

A small set of variable names is rejected at boot and must be migrated before
the kernel will start. The rejected names span pre-v1 plugin selector layouts
(`*_BACKEND`, `*_ADAPTER`, and the earlier bootstrap adapter family). The
current shape is `TAKOSUMI_<PORT>_PLUGIN`; existing deployments migrate by
translating each rejected name into the corresponding `_PLUGIN` selector and
re-running boot. A successful boot is sufficient migration; there is no
intermediate compatibility layer.

The closed list of rejected names is:

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

If any of these are present, `loadRuntimeConfig` raises a diagnostic tagged
`stale_runtime_selector` and refuses to start.

## Host placement

The variables above belong on different hosts; mixing them on a single host
weakens the OperatorBoundaries trust model.

- Kernel host: state and storage variables, deploy / internal tokens, artifact
  policy variables, plugin selectors, audit and observation retention controls,
  the runtime-agent URL and bearer.
- Runtime-Agent host: the agent bearer, every `TAKOSUMI_KUBERNETES_*` and
  `TAKOSUMI_SELFHOSTED_*` variable, and the cloud SDK credentials. The deploy
  bearer and the internal control-plane secret never leave the kernel host.
- CLI host (operator workstation, CI): the remote URL, the deploy bearer,
  optionally the runtime-agent URL and bearer, and `TAKOSUMI_CONFIG_FILE` when a
  non-default config path is in use.

## Related

- Reference: [CLI](/reference/cli),
  [DataAsset Kinds](/reference/artifact-kinds),
  [DataAsset Policy](/reference/data-asset-policy),
  [Secret Partitions](/reference/secret-partitions),
  [Migration / Upgrade](/reference/migration-upgrade),
  [Compliance Retention](/reference/compliance-retention),
  [Observation Retention](/reference/observation-retention)

## See also

- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export & Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [Zone Selection](/reference/zone-selection)
- [API Key Management](/reference/api-key-management) — migration stub
- [Auth Providers](/reference/auth-providers) — migration stub
- [RBAC Policy](/reference/rbac-policy) — migration stub
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Kernel HTTP API](/reference/kernel-http-api)
