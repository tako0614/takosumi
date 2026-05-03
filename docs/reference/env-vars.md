# Environment Variables

Takosumi の各 process が読む `TAKOSUMI_*` 環境変数のカタログです。 全項目は
`packages/` 配下の実装位置と対応しており、`grep` の結果から起こしています。

各表は **read-by** 列にソースの `file:line` を記載しています — 振る舞いを
最終確認するときはコードを直接見てください。

## Kernel (`takosumi-{api,worker,router,log-worker}`)

manifest を受けて apply pipeline / state DB / worker を回す process。 cloud
SDK は呼ばず、`TAKOSUMI_AGENT_URL` 経由で runtime-agent に lifecycle を
委譲します。

| Env                                      | Read by                                                  | 用途                                                                                | Default / 状態                          |
| ---------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| `TAKOSUMI_DATABASE_URL`                  | `packages/kernel/src/index.ts:180`, `:237`, `:286`, `:369`, `:581`; `adapters/storage/encryption.ts:63`; `cli/src/commands/migrate.ts:31` | Boot 時に SQL state を解決する primary URL。 未設定だと in-memory にフォールバック | (unset)                                 |
| `TAKOSUMI_PRODUCTION_DATABASE_URL`       | `packages/kernel/src/index.ts:182`; `adapters/storage/encryption.ts:65`; `cli/src/commands/migrate.ts:38` | `TAKOSUMI_ENVIRONMENT=production` 時の優先 URL                                  | (unset)                                 |
| `TAKOSUMI_STAGING_DATABASE_URL`          | `packages/kernel/src/index.ts:184`; `adapters/storage/encryption.ts:68`; `cli/src/commands/migrate.ts:33` | `TAKOSUMI_ENVIRONMENT=staging` 時の優先 URL                                     | (unset)                                 |
| `TAKOSUMI_DB_AUTO_MIGRATE`               | `packages/kernel/src/index.ts:172`                       | Boot 時に DB migrations を自動適用するか。 未設定: prod/staging=true、local/dev=false | (env-driven)                            |
| `TAKOSUMI_ENVIRONMENT`                   | `packages/kernel/src/config/runtime.ts:197`; `index.ts:169` | runtime environment selector (`local`/`development`/`test`/`staging`/`production`) | `local`                                 |
| `TAKOSUMI_DEV_MODE`                      | `packages/kernel/src/config/runtime.ts:205`              | `allowUnsafeProductionDefaults` flag (boolean: 1/true/yes/on/enabled)              | `false`                                 |
| `TAKOSUMI_PAAS_PROCESS_ROLE`             | `packages/kernel/src/config/runtime.ts:68`               | Process role 選択 (`takosumi-api` / `takosumi-worker` / `takosumi-router` / `takosumi-runtime-agent` / `takosumi-log-worker`) | `takosumi-api`     |
| `TAKOSUMI_PROCESS_ROLE`                  | `packages/kernel/src/config/runtime.ts:69`               | `TAKOSUMI_PAAS_PROCESS_ROLE` の alias (両方セットすると同値必須)                  | `takosumi-api`                          |
| `TAKOSUMI_DEPLOY_TOKEN`                  | `packages/kernel/src/api/deploy_public_routes.ts:146`; `bootstrap.ts:84`; `bootstrap/registry_setup.ts:83` | `POST /v1/deployments` / artifact endpoint の Bearer token. 未設定だと public deploy ルートは無効 | (unset → routes off) |
| `TAKOSUMI_INTERNAL_SERVICE_SECRET`       | `packages/kernel/src/api/internal_routes.ts:88`; `api/app.ts:628`; `bootstrap/readiness.ts:66` | internal control-plane RPC の Bearer token. production では必須              | (unset)                                 |
| `TAKOSUMI_PUBLIC_BASE_URL`               | `packages/kernel/src/bootstrap/registry_setup.ts:82`     | artifact store が presigned URL を組み立てる際の base URL. 未設定だと artifact route が無効化 | (unset)                |
| `TAKOSUMI_PUBLIC_ROUTES_ENABLED`         | `packages/kernel/src/config/runtime.ts:221`              | `/v1/deployments` 等の public route を有効化 (boolean)                            | `false`                                 |
| `TAKOSUMI_AGENT_URL`                     | `packages/kernel/src/bootstrap/agent_detection.ts:26`; `cli/src/commands/server.ts:28` | kernel が runtime-agent を呼ぶ base URL。未設定なら kernel は embedded agent を起動 | (unset → embed)         |
| `TAKOSUMI_AGENT_TOKEN`                   | `packages/kernel/src/bootstrap/agent_detection.ts:27`    | runtime-agent との Bearer token                                                   | (unset)                                 |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`          | `packages/kernel/src/bootstrap.ts:85`; `bootstrap/registry_setup.ts:84` | artifact store からの fetch 用に発行する read-only token                          | (unset)                                 |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`            | `packages/kernel/src/bootstrap.ts:87`                    | 単一 artifact の最大 byte サイズ                                                   | provider 既定                           |
| `TAKOSUMI_AUDIT_RETENTION_DAYS`          | `packages/kernel/src/index.ts:232`; `services/audit-replication/policy.ts:98` | audit log retention 上書き (days)                                          | regime に従う                           |
| `TAKOSUMI_AUDIT_RETENTION_REGIME`        | `packages/kernel/src/index.ts:233`; `services/audit-replication/policy.ts:90` | audit retention regime (`default`/`pci-dss`/`hipaa`/`sox`/`regulated`)     | `default`                               |
| `TAKOSUMI_AUDIT_DELETE_AFTER_ARCHIVE`    | `packages/kernel/src/services/audit-replication/policy.ts:105` | archive 後に local row を削除するか (boolean)                                | regime に従う                           |
| `TAKOSUMI_AUDIT_ARCHIVE_GRACE_DAYS`      | `packages/kernel/src/services/audit-replication/policy.ts:107` | archive 後 delete までの猶予日数                                              | regime に従う                           |
| `TAKOSUMI_AUDIT_REPLICATION_KIND`        | `packages/kernel/src/services/audit-replication/external_log.ts:423` | replication sink 種別 (`s3` / `stdout`)                                  | (replication off)                       |
| `TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET`   | `packages/kernel/src/services/audit-replication/external_log.ts:440` | S3 sink: bucket 名                                                            | (unset)                                 |
| `TAKOSUMI_AUDIT_REPLICATION_S3_PREFIX`   | `packages/kernel/src/services/audit-replication/external_log.ts:466` | S3 sink: object key prefix                                                    | (unset)                                 |
| `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_MODE` | `packages/kernel/src/services/audit-replication/external_log.ts:454` | S3 Object Lock retention mode                                            | `COMPLIANCE`                            |
| `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_DAYS` | `packages/kernel/src/services/audit-replication/external_log.ts:459` | S3 Object Lock retention 日数                                            | (unset)                                 |
| `TAKOSUMI_OBSERVATION_RETENTION_DISABLE` | `packages/kernel/src/index.ts:283`                       | observation retention worker を OFF にする (boolean)                              | `false`                                 |
| `TAKOSUMI_OBSERVATION_RETENTION_RECENT_DAYS` | `packages/kernel/src/index.ts:291`                   | recent observation 保持日数                                                       | provider 既定                           |
| `TAKOSUMI_OBSERVATION_RETENTION_ARCHIVE_CAP_DAYS` | `packages/kernel/src/index.ts:294`              | archive cap 日数                                                                  | provider 既定                           |
| `TAKOSUMI_PAAS_WORKER_HEARTBEAT_FILE`    | `packages/kernel/src/index.ts:447`                       | worker daemon が touch する heartbeat ファイル path                              | (unset)                                 |
| `TAKOSUMI_PAAS_WORKER_POLL_INTERVAL_MS`  | `packages/kernel/src/index.ts:450`                       | worker poll loop 間隔 (ms)                                                       | `250`                                   |
| `TAKOSUMI_APPLY_QUEUE`                   | `packages/kernel/src/bootstrap/worker_daemon.ts:56`      | apply worker が消費する queue 名                                                  | provider 既定                           |
| `TAKOSUMI_WORKER_POLL_INTERVAL_MS`       | `packages/kernel/src/bootstrap/worker_daemon.ts:59`      | apply worker daemon の poll 間隔 (ms)                                             | provider 既定                           |
| `TAKOSUMI_WORKER_VISIBILITY_TIMEOUT_MS`  | `packages/kernel/src/bootstrap/worker_daemon.ts:63`      | message visibility timeout (ms)                                                   | provider 既定                           |
| `TAKOSUMI_OUTBOX_DISPATCH_LIMIT`         | `packages/kernel/src/bootstrap/worker_daemon.ts:115`     | outbox dispatcher の per-tick batch limit                                         | provider 既定                           |
| `TAKOSUMI_DEFAULT_APP_DISTRIBUTION_JSON` | `packages/kernel/src/...`                                | bootstrap 時に投入する default distribution の inline JSON                        | (unset)                                 |

### Kernel plugin selection / supply chain

`TAKOSUMI_*_PLUGIN` / `TAKOSUMI_*_PLUGIN_ID` ファミリーは I/O port ごとに
plugin を選択するための selector です。 全項目は
`packages/kernel/src/config/runtime.ts` の `PORT_ENV_KEYS` で集約されています
(`auth` / `coordination` / `notification` / `operator-config` / `storage` /
`source` / `provider` / `queue` / `object-storage` / `kms` / `secret-store` /
`router-config` / `observability` / `runtime-agent`)。

| Env                                      | Read by                                          | 用途                                                                  | Default                  |
| ---------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------ |
| `TAKOSUMI_<PORT>_PLUGIN` / `_PLUGIN_ID`  | `packages/kernel/src/config/runtime.ts:97-139`   | port 別の plugin id (e.g. `TAKOSUMI_STORAGE_PLUGIN`)                  | port ごとに必須 (prod/staging) |
| `TAKOSUMI_KERNEL_PLUGIN_SELECTIONS` / `TAKOSUMI_KERNEL_PLUGIN_MAP` | `runtime.ts:258`         | 全 port の selection を JSON で一括指定                                | (unset)                  |
| `TAKOSUMI_KERNEL_PLUGIN_CONFIG` / `_JSON` | `packages/kernel/src/config/runtime.ts:284`     | plugin config 全体の JSON                                             | `{}`                     |
| `TAKOSUMI_KERNEL_PLUGIN_MODULES`         | `packages/kernel/src/plugins/loader.ts:34`       | dynamic kernel plugin module list                                     | (unset)                  |
| `TAKOSUMI_PAAS_PLUGIN_MODULES`           | `packages/kernel/src/plugins/loader.ts:35`       | `TAKOSUMI_KERNEL_PLUGIN_MODULES` の legacy alias                     | (unset)                  |
| `TAKOSUMI_TRUSTED_KERNEL_PLUGIN_MANIFESTS` | `packages/kernel/src/plugins/loader.ts:58`     | trusted plugin manifest list                                          | (unset)                  |
| `TAKOSUMI_KERNEL_PLUGIN_REGISTRY_MANIFESTS` | `packages/kernel/src/plugins/loader.ts:59`    | 上記の追加 alias                                                      | (unset)                  |
| `TAKOSUMI_KERNEL_PLUGIN_TRUST_KEYS`      | `packages/kernel/src/plugins/loader.ts:71`       | manifest 検証用 trust 公開鍵                                          | (unset)                  |
| `TAKOSUMI_KERNEL_PLUGIN_INSTALL_POLICY`  | `packages/kernel/src/plugins/loader.ts:75`       | plugin install policy (`require-signed` 等)                           | provider 既定            |
| `TAKOSUMI_REGISTRY_TRUST_ROOTS_JSON`     | `packages/kernel/src/...`                        | registry trust root JSON                                              | provider 既定            |
| `TAKOSUMI_ENABLE_DYNAMIC_KERNEL_PLUGIN_MODULES` | `packages/kernel/src/plugins/loader.ts:92` | dynamic kernel plugin loader を有効化 (boolean)                      | `false`                  |
| `TAKOSUMI_ENABLE_REFERENCE_KERNEL_PLUGIN_LOADER` | `packages/kernel/src/plugins/loader.ts:93` | reference plugin loader を有効化 (boolean)                            | `false`                  |

### Stale selector keys

下記は **kernel が起動を拒否する** 旧 selector です
(`packages/kernel/src/config/runtime.ts:141-179`)。 現代の selector
(`TAKOSUMI_*_PLUGIN`) に書き換えてください:

`TAKOSUMI_STORAGE_BACKEND` / `TAKOSUMI_STORAGE_ADAPTER` /
`TAKOSUMI_PROVIDER` / `TAKOSUMI_PROVIDER_ADAPTER` /
`TAKOSUMI_QUEUE_BACKEND` / `TAKOSUMI_QUEUE_ADAPTER` /
`TAKOSUMI_OBJECT_STORAGE_BACKEND` / `TAKOSUMI_OBJECT_STORAGE_ADAPTER` /
`TAKOSUMI_SOURCE` / `TAKOSUMI_SOURCE_ADAPTER` /
`TAKOSUMI_KMS_BACKEND` / `TAKOSUMI_KMS_ADAPTER` /
`TAKOSUMI_SECRET_STORE_BACKEND` / `TAKOSUMI_SECRET_STORE_ADAPTER` /
`TAKOSUMI_REDIS_URL` / `TAKOSUMI_S3_ENDPOINT` / `TAKOSUMI_S3_BUCKET` /
`TAKOSUMI_OBJECT_STORAGE_URL` / `TAKOSUMI_LOCAL_DOCKER_NETWORK` /
`TAKOSUMI_KMS_PROVIDER` / `TAKOSUMI_KMS_KEY_ID` / `TAKOSUMI_KMS_KEY_VERSION` /
`TAKOSUMI_SECRET_STORE_PROVIDER` / `TAKOSUMI_SECRET_STORE_NAMESPACE` /
`TAKOSUMI_BOOTSTRAP_*_ADAPTER`.

::: warning
これらが set されていると `loadRuntimeConfig` が
`stale_runtime_selector` 診断付きで例外を投げます。
:::

### Secret store passphrase

`packages/kernel/src/adapters/secret-store/memory.ts:69-79` で読まれます。
partition 別に `_<NAME>` suffix を付けることで切り替え可能 (例:
`TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`)。

| Env                                | 用途                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | memory secret-store の暗号化 passphrase                       |
| `TAKOSUMI_SECRET_STORE_KEY`        | passphrase の代替: 直接 raw key                                |
| `TAKOSUMI_SECRET_ENCRYPTION_KEY`   | 上記の追加 alias                                              |

## Runtime-agent (`takosumi-runtime-agent`)

cloud SDK / OS 操作を実行する data plane process。 起動 token を除いて
`TAKOSUMI_*` env はほぼ持たず、cloud credential は **各 SDK の標準 env**
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` /
`GOOGLE_APPLICATION_CREDENTIALS` / `CLOUDFLARE_API_TOKEN` /
`AZURE_*` 等) を直接読みます。

| Env                                       | Read by                                                         | 用途                                                                                | Default     |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| `TAKOSUMI_AGENT_TOKEN`                    | `packages/cli/src/commands/runtime_agent.ts:26`                 | agent HTTP server の Bearer token                                                  | random      |
| `TAKOSUMI_KUBERNETES_API_SERVER_URL`      | `packages/runtime-agent/src/embed.ts:104`                       | k8s connector: API server URL                                                       | (unset)     |
| `TAKOSUMI_KUBERNETES_BEARER_TOKEN`        | `packages/runtime-agent/src/embed.ts:105`                       | k8s connector: bearer token                                                         | (unset)     |
| `TAKOSUMI_KUBERNETES_NAMESPACE`           | `packages/runtime-agent/src/embed.ts:109`                       | k8s connector: 作業 namespace                                                       | `takosumi`  |
| `TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT`   | `packages/runtime-agent/src/embed.ts:113`                       | filesystem object-store backend の root path                                       | (unset)     |
| `TAKOSUMI_SELFHOSTED_DOCKER_SOCKET`       | `packages/runtime-agent/src/embed.ts:114`                       | docker connector の socket path                                                     | (unset)     |
| `TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR`    | `packages/runtime-agent/src/embed.ts:115`                       | systemd connector の unit dir                                                       | (unset)     |
| `TAKOSUMI_SELFHOSTED_OBJECT_STORE_ENDPOINT` | `packages/runtime-agent/src/embed.ts:116`                     | minio / S3-compatible local endpoint                                                | (unset)     |
| `TAKOSUMI_SELFHOSTED_COREDNS_FILE`        | `packages/runtime-agent/src/embed.ts:117`                       | coredns 設定ファイル path                                                           | (unset)     |
| `TAKOSUMI_SELFHOSTED_POSTGRES_HOST`       | `packages/runtime-agent/src/embed.ts:118`                       | self-hosted postgres host                                                           | (unset)     |

::: tip Cloud credential
agent は `TAKOSUMI_*` ではなく **各 SDK の標準 env** から credential を読みます
(`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS`、`CLOUDFLARE_API_TOKEN`、
`AZURE_*` 等)。 credential は kernel host には絶対に置かず、agent host
だけに置くようにしてください。
:::

## CLI (`takosumi`)

`packages/cli/src/config.ts` と各 subcommand が読む env です。 全項目は
[CLI Reference の Resolution order](/reference/cli) で説明している通りに
解決されます。

| Env                       | Read by                                                | 用途                                                                              | Default / 状態                                  |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `TAKOSUMI_REMOTE_URL`     | `packages/cli/src/config.ts:122`                       | `--remote` の env fallback                                                        | (unset)                                         |
| `TAKOSUMI_TOKEN`          | `packages/cli/src/config.ts:146`                       | generic auth token (warns: prefer `TAKOSUMI_DEPLOY_TOKEN`)                       | (unset)                                         |
| `TAKOSUMI_DEPLOY_TOKEN`   | `packages/cli/src/config.ts:148`                       | deploy / artifact endpoint 用の Bearer token                                      | (unset)                                         |
| `TAKOSUMI_AGENT_URL`      | `packages/cli/src/commands/runtime_agent.ts:52`, `:112` | `runtime-agent list / verify` の `--url` env fallback                            | (unset)                                         |
| `TAKOSUMI_AGENT_TOKEN`    | `packages/cli/src/commands/runtime_agent.ts:26`, `:53`, `:113` | `runtime-agent` 系コマンドの Bearer token env fallback                       | (unset)                                         |
| `TAKOSUMI_CONFIG_FILE`    | `packages/cli/src/config.ts:112`                       | `~/.takosumi/config.yml` の override path                                         | `~/.takosumi/config.yml`                        |
| `TAKOSUMI_KERNEL_URL`     | `packages/cli/src/config.ts:125`                       | **deprecated** alias of `TAKOSUMI_REMOTE_URL` (1 度だけ stderr に warn を出して resolve) | deprecated                              |

## どの host にどれを置くか

self-host operator 向けの目安:

- **kernel host**:
  - DB / token: `TAKOSUMI_DATABASE_URL` (またはその env-specific 派生),
    `TAKOSUMI_DEPLOY_TOKEN`, `TAKOSUMI_INTERNAL_SERVICE_SECRET`
  - public / artifact 関連: `TAKOSUMI_PUBLIC_BASE_URL`,
    `TAKOSUMI_PUBLIC_ROUTES_ENABLED`, `TAKOSUMI_ARTIFACT_FETCH_TOKEN`,
    `TAKOSUMI_ARTIFACT_MAX_BYTES`
  - agent への接続: `TAKOSUMI_AGENT_URL`, `TAKOSUMI_AGENT_TOKEN`
  - role / env / plugins: `TAKOSUMI_ENVIRONMENT`,
    `TAKOSUMI_PAAS_PROCESS_ROLE`, `TAKOSUMI_*_PLUGIN`,
    `TAKOSUMI_KERNEL_PLUGIN_*`
  - audit / observation 制御: `TAKOSUMI_AUDIT_*`, `TAKOSUMI_OBSERVATION_*`
- **runtime-agent host**:
  - Takosumi が読む: `TAKOSUMI_AGENT_TOKEN`, `TAKOSUMI_KUBERNETES_*`,
    `TAKOSUMI_SELFHOSTED_*`
  - cloud SDK が読む (Takosumi 外): `AWS_*`,
    `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDFLARE_API_TOKEN`, `AZURE_*` 等
- **CLI host (operator workstation / CI)**:
  - `TAKOSUMI_REMOTE_URL`, `TAKOSUMI_DEPLOY_TOKEN` (または config file),
    必要なら `TAKOSUMI_AGENT_URL` / `TAKOSUMI_AGENT_TOKEN`
  - `TAKOSUMI_KERNEL_URL` は使わず `TAKOSUMI_REMOTE_URL` に移行する

## 関連

- [CLI Reference](/reference/cli) — `--remote` / `--token` の解決順、config file
- [Operator Bootstrap](/operator/bootstrap) — `createTakosumiProductionProviders` の wire-in
- [Quickstart](/getting-started/quickstart) — env をどの順番でセットすればよいか
