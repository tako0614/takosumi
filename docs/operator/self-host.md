# Self-host Notes

production で takosumi を self-host する operator が **deploy 前に知って
おくべき** 振る舞いを集めたページです。 quickstart は
[Getting Started](/getting-started/quickstart) を見てください。 ここでは
**コードを読まないと気づかない gotcha** を中心に列挙します。

---

## Production checklist

::: warning 必須項目 production deploy で以下のいずれかが欠けると、kernel の
boot 時 fail-closed か silent な persistence loss / plaintext secret
に直結します。 :::

| 項目                                                                  | 値                                           | これが無いとどうなるか                                                             |
| --------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `TAKOSUMI_DATABASE_URL` (or `_PRODUCTION_*`)                          | Postgres URL                                 | deployment record store が in-memory に fall back、再起動で消える                  |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | 32+ byte 高 entropy 文字列                   | `environment: production` で `SecretEncryptionConfigurationError` を投げて起動拒否 |
| `TAKOSUMI_DEPLOY_TOKEN`                                               | `openssl rand -hex 32`                       | `POST /v1/deployments` が無効化、CLI が 401                                        |
| `TAKOSUMI_DEPLOY_SPACE_ID`                                            | `space:<org-or-env>`                         | 未設定時は `takosumi-deploy` scope に集約される                                    |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`                                       | `openssl rand -hex 32` (deploy とは別 token) | agent host 側に upload / delete 権限が漏れる                                       |
| `TAKOSUMI_DEV_MODE`                                                   | **unset** にする                             | placeholder secret crypto / unencrypted DB が許可される                            |
| `TAKOSUMI_ENVIRONMENT=production`                                     | (literal)                                    | これで `STRICT_RUNTIME_KERNEL_PORTS` が enforce される                             |

各 env の意味は [Environment Variables](/reference/env-vars) を参照。

---

## In-memory fallback の警告 (dev mode)

kernel は production / staging で adapter port が 1 つでも未 wire だと boot
時に拒否します (`STRICT_RUNTIME_KERNEL_PORTS` enforcement、source:
`packages/kernel/src/app_context.ts`)。

local / dev では拒否せず、 **in-memory adapter に黙って fall back** します。
このとき kernel は次の警告を 1 回だけ stdout に吐きます:

```
[takosumi-bootstrap] dev mode is using in-memory fallbacks for: \
  storage, secret-store, queue, ... \
  — set TAKOSUMI_* env adapters or pass `adapters` explicitly to persist \
  state across restarts. Set TAKOSUMI_LOG_LEVEL=warn to suppress this notice.
```

::: warning 見落とすと operator が `TAKOSUMI_DATABASE_URL` を export
し忘れたまま `takosumi server` を local 起動すると、CLI からの deploy
は成功するように見えますが、kernel を再起動した瞬間に **deployment record
が空になります**。production に 押し上げる前にこの warning
が出ていないことを必ず確認してください。 :::

`TAKOSUMI_LOG_LEVEL=warn` (or `error`) で suppress 可能ですが、本番手前の
staging では suppress しないことを推奨します。

該当 port は `auth` / `coordination` / `notification` / `operator-config` /
`storage` / `source` / `provider` / `queue` / `object-storage` / `kms` /
`secret-store` / `router-config` / `observability` / `runtime-agent`。

---

## Selfhost connector の restart-survival

`@takos/selfhost-docker-compose` / `@takos/selfhost-postgres` /
`@takos/selfhost-systemd` の 3 connector は **runtime-agent restart 後でも
deployment 状態を再構成できる** よう作られています (since takosumi-runtime-agent
0.7.0)。

| connector                        | source of truth                           | describe() の挙動                                            |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `@takos/selfhost-docker-compose` | `docker inspect <handle>`                 | `NetworkSettings.Ports` / `Config.Env` から outputs を再構築 |
| `@takos/selfhost-postgres`       | `docker inspect <handle>`                 | container 状態を直接 query                                   |
| `@takos/selfhost-systemd`        | on-disk unit file + `systemctl is-active` | unit ファイルの marker から host port を復元                 |

connector 内部の in-memory descriptor map は **write-through cache 扱い**
で、source of truth は OS 側 (docker daemon / systemd) です。 つまり
runtime-agent process を restart しても、describe() は host から live 状態を
query して正しい outputs を返します。

**port allocator** は restart 後の port collision を 50 回まで retry で
回避します (docker が "address already in use" を返す状態に対応):

```
PORT_RETRY_LIMIT = 50  // packages/runtime-agent/src/connectors/selfhost/{docker_compose,local_docker_postgres}.ts
```

::: warning systemd の hand-written unit `@takos/selfhost-systemd` が render
する unit ファイルには `# X-Takos-HostPort=<n>` / `# X-Takos-InternalPort=<n>`
の marker が 入ります。 operator が手で書いた unit ファイルにこの marker
が無いと、 describe() は status だけを返して outputs (URL / port)
を空で返します。 :::

---

## Cross-process apply lock

`POST /v1/deployments` は **per-(tenant, name) lock** で同 deployment への並行
apply を直列化しています。

| backend        | 保証                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| **SQL-backed** | `takosumi_deploy_locks` の lease row で複数 kernel pod 間の同 key apply/destroy を fence |
| **In-memory**  | per-(tenant, name) Promise chain で同 process 内の race だけを防ぐ。dev / test 専用      |

SQL backend は `TAKOSUMI_DATABASE_URL` (または `DATABASE_URL`) を設定した boot
path で選択されます。migration `20260430000022_takosumi_deploy_locks.sql` と
`20260430000023_takosumi_operation_journal_entries.sql` が必要です。

source:
`packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts`

lock acquire は `locked_until > now()` の既存 holder がいる間は待ちます。holder
pod が落ちた場合は lease expiry 後に別 pod が取得できます。release は
`owner_token` が一致する row だけを消すため、stale holder が takeover 後の row
を削除することはありません。

timing は以下で調整できます。

- `TAKOSUMI_LOCK_LEASE_MS` — lease window。default `30000`。
- `TAKOSUMI_LOCK_HEARTBEAT_MS` — renewal interval。default は lease / 3 (`30000`
  の場合 `10000`)。

::: warning この lock は現在の public deploy route 用の apply fence です。 apply
/ destroy は `takosumi_operation_journal_entries` に public OperationPlan WAL
stage を記録しますが、下流 provider へ fencing token を渡す full OperationPlan /
WAL protocol では ありません。pod freeze 等で holder が lease
失効後も処理を続けると、外部 provider side effect までは lock
だけで取り消せません。 長時間 apply/destroy を行う provider では lease
を最大実行時間より十分長くするか、 single-writer apply tier を使ってください。
:::

詳細は [Lifecycle Protocol](/reference/lifecycle) のロック節も参照。

---

## Multi-tenancy の現状制限

公開 deploy route (`POST /v1/deployments`) は **shared bearer token**
モデルです。

- token は `TAKOSUMI_DEPLOY_TOKEN` の **1 つだけ**。
- `tenant_id` / `spaceId` は `TAKOSUMI_DEPLOY_SPACE_ID` で設定する。未設定時は
  `"takosumi-deploy"`。
- 1 つの token を共有する operator 同士は同じ public deploy scope を共有します。

::: warning 複数 operator / org 環境 独立した namespace が必要な場合は **kernel
instance を分離する** か、 `TAKOSUMI_DEPLOY_TOKEN` と `TAKOSUMI_DEPLOY_SPACE_ID`
を strict に運用 (1 org = 1 kernel / deploy scope) してください。 public route
は当面 single-token scope です。 :::

deployment record の tenant 列は将来の multi-tenant 拡張のため SQL schema
には存在しますが、route 側ではまだ bearer ごとの actor-resolved Space routing
は行いません。

---

## Secret encryption

Takosumi の `MemoryEncryptedSecretStore` は **AES-GCM** で seal / open します
(source: `packages/kernel/src/adapters/secret-store/memory.ts`)。

key は **cloud partition 別** に独立に派生されます:

| partition    | env override (推奨)                            |
| ------------ | ---------------------------------------------- |
| `global`     | `TAKOSUMI_SECRET_STORE_PASSPHRASE` (or `_KEY`) |
| `aws`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`         |
| `gcp`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_GCP`         |
| `cloudflare` | `TAKOSUMI_SECRET_STORE_PASSPHRASE_CLOUDFLARE`  |
| `k8s`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_K8S`         |
| `selfhosted` | `TAKOSUMI_SECRET_STORE_PASSPHRASE_SELFHOSTED`  |

partition の override が無ければ `global` passphrase に partition label を mix
した HKDF-style salt から派生されます。 そのため **AWS partition の secret
を漏らしても他 cloud の ciphertext は復号できません**。

`additionalData (AAD)` に partition label が bind されているため、payload の
partition tag を swap すると open() が失敗します。

### Key rotation

`SecretRotationPolicy` を put 時に渡すと metadata に保存され、
`rotationStatus()` で `active` / `due` / `expired` を計算できます。

```ts
{ intervalDays: 90, gracePeriodDays: 30 }
// 90 days で due, 120 days で expired
```

cap が来た secret を rotate するのは operator の責任です (interval を
過ぎても自動で seal されない)。 operator は `rotationStatus()` を 監視して新
version を put し直してください。

`runVersionGc()` は keep-latest-N + last-accessed-N-days で旧 version を GC
します (defaults: keepLatest=5, accessedWithinDays=90)。

---

## Observability の現状

Takosumi が公式に export している observability surface は以下のみです:

| Surface              | 用途                                        |
| -------------------- | ------------------------------------------- |
| `/livez`             | process が生きているか (cheap liveness)     |
| `/readyz`            | DB / queue / agent ready の readiness probe |
| `/status/summary`    | application-level の health summary         |
| `audit_events` table | tamper-evident hash-chain audit log         |

source: `packages/kernel/src/api/readiness_routes.ts`

### Audit chain

`audit_events` table には `sequence` / `previous_hash` / `current_hash` が
記録され、各行は前行の hash を embed します。 row が改竄されると chain
verification が fail します (source:
`packages/kernel/src/services/observability/audit_chain.ts`)。

```
row N    →   { sequence: N, previous_hash: H(N-1), current_hash: H(N) }
row N+1  →   { sequence: N+1, previous_hash: H(N),  current_hash: H(N+1) }
```

genesis hash は `AUDIT_CHAIN_GENESIS_HASH` 定数。 retention は
`TAKOSUMI_AUDIT_RETENTION_DAYS` / `_REGIME` で regulated profile (PCI / HIPAA /
SOX) を選択可能。

::: info Metrics export

- `/metrics` (Prometheus exposition) は `TAKOSUMI_METRICS_SCRAPE_TOKEN`
  を設定した `takosumi-api` role で提供される
- OTLP/HTTP JSON metrics export は `TAKOSUMI_OTLP_METRICS_ENDPOINT` または
  standard `OTEL_EXPORTER_OTLP_*` env で有効化される

external 観測が必要な場合の選択肢:

- `TAKOSUMI_AUDIT_REPLICATION_KIND=s3` で audit log を S3 に replicate (Object
  Lock + retention 対応)
- `/metrics` と `/readyz` を外部 monitoring から scrape
- OTLP metrics を collector に push する
- `deploy/observability/grafana/takosumi-deploy-overview.json` を Grafana に
  import し、deploy success rate / apply latency / rollback rate を監視する
- [Observability Stack](/reference/observability-stack) の SLI / SLO table を
  alert rules と on-call routing の初期 contract として使う
- application logs を Deno stdout から拾う

native trace exporter は target contract です。 :::

---

## 関連ページ

- [Operator Bootstrap](/operator/bootstrap) — provider plugin の wire 手順
- [Environment Variables](/reference/env-vars) — `TAKOSUMI_*` 一覧
- [Lifecycle Protocol](/reference/lifecycle) — apply / destroy / lock 詳細
- [Kernel HTTP API](/reference/kernel-http-api) — `/v1/deployments` 等の API
- [Upgrade](/operator/upgrade) — version bump 時の runbook
