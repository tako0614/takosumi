# Self-host Notes

> このページでわかること: Takosumi をセルフホストする際の注意点と前提条件。

quickstart は [Getting Started](/getting-started/quickstart) を参照。
ここではコードを読まないと気づかない gotcha を中心に列挙する。

---

## Production checklist

::: warning 必須項目 production deploy で以下のいずれかが欠けると、 kernel の
boot 時 fail-closed か silent な persistence loss / plaintext secret
に直結する。 :::

| 項目                                                                  | 値                                           | これが無いとどうなるか                                                             |
| --------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `TAKOSUMI_DATABASE_URL` (or `_PRODUCTION_*`)                          | Postgres URL                                 | deployment record store が in-memory に fall back、再起動で消える                  |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | 32+ byte 高 entropy 文字列                   | `environment: production` で `SecretEncryptionConfigurationError` を投げて起動拒否 |
| `TAKOSUMI_INSTALLER_TOKEN`                                            | `openssl rand -hex 32`                       | `/v1/installations/*` が無効化、CLI が 401                                         |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`                                       | `openssl rand -hex 32` (deploy とは別 token) | agent host 側に upload / delete 権限が漏れる                                       |
| `TAKOSUMI_DEV_MODE`                                                   | **unset** にする                             | unsafe secret crypto / unencrypted DB が許可される                                 |
| `TAKOSUMI_ENVIRONMENT=production`                                     | (literal)                                    | これで `STRICT_RUNTIME_KERNEL_PORTS` が enforce される                             |

各 env の意味は [Environment Variables](/reference/env-vars) 参照。

---

## Single VM (selfhost connector)

VM 1 台に systemd / docker / filesystem / local Postgres / coredns
で完結デプロイを構築する例。 source root に置く public manifest は
`.takosumi.yml` (= AppSpec)。

`.takosumi.yml`:

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.my-app
  name: my-app
components:
  db:
    kind: postgres
    spec:
      version: "16"
    publish:
      - com.example.my-app.db
  api:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes: ["/api/*"]
    listen:
      com.example.my-app.db:
        as: env
        prefix: DATABASE_
    publish:
      - com.example.my-app.api
  api-domain:
    kind: custom-domain
    spec:
      name: api.example.com
    listen:
      com.example.my-app.api:
        as: target
```

operator side (VM 上):

```bash
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

# selfhosted connector の置き場 (任意、defaults あり)
export TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR=/etc/systemd/system

takosumi server --port 8788 &
takosumi install --space space_personal --source . \
  --remote http://localhost:8788 \
  --token $TAKOSUMI_INSTALLER_TOKEN
```

deploy 完了後 (embedded agent が selfhost connector で実行):

- web service が docker compose service として常駐
- Postgres は `docker run postgres` で立ち上がる (local-docker-postgres
  connector)
- assets bucket は `/var/lib/takosumi/objects/assets/` に作成
- domain は coredns local zone に登録

---

## Production: kernel と agent を分離

multi-host setup や credential 隔離が必要な場合、 agent を別 host で立てて
kernel から HTTP で叩く。

### Agent host (cloud credential を持つ host)

```bash
# AWS / GCP / Cloudflare / Azure / k8s の env を set
export AWS_ACCESS_KEY_ID=... AWS_REGION=...

takosumi runtime-agent serve --port 8789 --token mytoken
# stdout:
#   takosumi runtime-agent listening at http://127.0.0.1:8789
#     TAKOSUMI_AGENT_URL=http://127.0.0.1:8789
#     TAKOSUMI_AGENT_TOKEN=mytoken
```

`--env-file ./agent.env` で dotenv ファイルから env を流し込むこともできる。

### Kernel host (credential を持たない)

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://prod-db.internal/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

# agent への接続情報
export TAKOSUMI_AGENT_URL=https://agent.internal:8789
export TAKOSUMI_AGENT_TOKEN=mytoken

# 監査の external replication sink
export TAKOSUMI_AUDIT_REPLICATION_KIND=s3
export TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET=my-audit-logs
export TAKOSUMI_AUDIT_RETENTION_DAYS=365

takosumi migrate
takosumi server --no-agent --port 8788 &
```

`--no-agent` で kernel の embedded agent spawn を抑止する (production では agent
を別途立てるので不要)。

### Credential 境界

- kernel は `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN` のみ持つ。
- AWS / GCP / etc の credential は agent host にのみ存在する。
- kernel が compromised しても cloud credential は漏れない。
- multi-tenant では cloud account ごとに agent を分離可能。

---

## Artifact storage hygiene

`takosumi artifact push` でアップロードした blob は object storage に
content-addressed (`sha256:...`) で残る。 operator が定期的に GC を回すことで、
destroy された deployment が pin していた artifact をまとめて回収できる。

```bash
takosumi artifact gc --dry-run    # delete 対象を確認
takosumi artifact gc              # 実削除
```

GC は kernel 側で persistent な Deployment artifact reference を mark+sweep し、
どの Deployment からも参照されていない blob だけを削除する。 Idempotent なので
何度 call しても害はない。

### Upload size cap

`POST /v1/artifacts` は現状 multipart body 全体を kernel プロセス memory に
buffer してから object storage に書き込む。 50MB+ の JS bundle や Lambda zip
を素直に upload すると kernel の RAM 圧迫の原因になるため、 1 アップロードの
body size に hard cap がかかっている。

| Env / Option                             | Default             | 説明                                               |
| ---------------------------------------- | ------------------- | -------------------------------------------------- |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`            | `52428800` (50 MiB) | kernel boot 時に env から読まれる upload byte 上限 |
| `RegisterArtifactRoutesOptions.maxBytes` | (env と同じ既定)    | embedded host で programmatic に override 可能     |

cap を超えた場合は `413 Payload Too Large` (`error.code: "resource_exhausted"`)
で拒否される。 `Content-Length` header が cap より大きい場合は body
を読まずに即時 413 を返すため、 hostile client が任意の body を送りつけて kernel
を OOM させる経路を塞ぐ。

> 50 MiB を超える artifact (大きい bundle / zip / OCI layer) を流したい場合、
> `TAKOSUMI_ARTIFACT_MAX_BYTES` を引き上げて RAM を確保するか、 R2 / S3 / GCS
> 等の external object-storage backend を kernel の `objectStorage` adapter
> に配線して presigned upload で直接 backend に書き込むのが推奨。
> `ObjectStoragePort` interface は同じなので adapter を切り替えるだけで済む。

### Read-only artifact fetch token (agent ↔ kernel scope separation)

production deploy で kernel と runtime-agent を別 host に分離している場合、
agent host が compromised しても artifact upload / delete / GC
を許さないように、 read-only な artifact fetch token を別途発行できる。

```bash
# kernel host (deploy token と read-only fetch token を両方発行)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_ARTIFACT_FETCH_TOKEN=$(openssl rand -hex 32)
```

- `TAKOSUMI_DEPLOY_TOKEN` は `takosumi artifact push` / `takosumi artifact gc`
  等の artifact write 系を許可する token。 Installation / Deployment API は
  `TAKOSUMI_INSTALLER_TOKEN` を使う。
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を agent host に渡すと、 connector は GET /
  HEAD `/v1/artifacts/:hash` で blob を fetch できるが、 POST (upload) / DELETE
  / GC は kernel 側で 401 になる。
- agent host は artifact 取得 URL に対して fetch token のみ持てば十分で、 deploy
  token を保持する必要は無い。

`TAKOSUMI_PUBLIC_BASE_URL` と組み合わせて kernel が runtime-agent に渡す
artifact-store locator は、 fetch token が set されていればそちらを優先する (set
されていなければ deploy token を渡す)。

---

## In-memory fallback の警告 (dev mode)

kernel は production / staging で adapter port が 1 つでも未 wire だと boot
時に拒否する (`STRICT_RUNTIME_KERNEL_PORTS` enforcement、source:
`packages/kernel/src/app_context.ts`)。

local / dev では拒否せず、 in-memory adapter に黙って fall back する。 このとき
kernel は次の警告を 1 回だけ stdout に吐く:

```
[takosumi-bootstrap] dev mode is using in-memory fallbacks for: \
  storage, secret-store, queue, ... \
  — set TAKOSUMI_* env adapters or pass `adapters` explicitly to persist \
  state across restarts. Set TAKOSUMI_LOG_LEVEL=warn to suppress this notice.
```

::: warning 見落とすと operator が `TAKOSUMI_DATABASE_URL` を export
し忘れたまま `takosumi server` を local 起動すると、 CLI からの deploy
は成功するように見えるが、 kernel を再起動した瞬間に deployment record
が空になる。 production に押し上げる前にこの warning
が出ていないことを必ず確認すること。 :::

`TAKOSUMI_LOG_LEVEL=warn` (or `error`) で suppress 可能だが、 本番手前の staging
では suppress しないことを推奨する。

該当 port は `auth` / `coordination` / `notification` / `operator-config` /
`storage` / `source` / `provider` / `queue` / `object-storage` / `kms` /
`secret-store` / `router-config` / `observability` / `runtime-agent`。

---

## Selfhost connector の restart-survival

`@takos/selfhost-docker-compose` / `@takos/selfhost-postgres` /
`@takos/selfhost-systemd` の 3 connector は runtime-agent restart 後でも
deployment 状態を再構成できるよう作られている (since takosumi-runtime-agent
0.7.0)。

| connector                        | source of truth                           | describe() の挙動                                            |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `@takos/selfhost-docker-compose` | `docker inspect <handle>`                 | `NetworkSettings.Ports` / `Config.Env` から outputs を再構築 |
| `@takos/selfhost-postgres`       | `docker inspect <handle>`                 | container 状態を直接 query                                   |
| `@takos/selfhost-systemd`        | on-disk unit file + `systemctl is-active` | unit ファイルの marker から host port を復元                 |

connector 内部の in-memory descriptor map は write-through cache 扱いで、 source
of truth は OS 側 (docker daemon / systemd)。 runtime-agent process を restart
しても、 describe() は host から live 状態を query して正しい outputs を返す。

port allocator は restart 後の port collision を 50 回まで retry で回避する
(docker が "address already in use" を返す状態に対応):

```
PORT_RETRY_LIMIT = 50  // packages/runtime-agent/src/connectors/selfhost/{docker_compose,local_docker_postgres}.ts
```

::: warning systemd の hand-written unit `@takos/selfhost-systemd` が render
する unit ファイルには `# X-Takos-HostPort=<n>` / `# X-Takos-InternalPort=<n>`
の marker が入る。 operator が手で書いた unit ファイルにこの marker が無いと、
describe() は status だけを返して outputs (URL / port) を空で返す。 :::

---

## Cross-process apply lock

installer apply は **per-(Space, Installation) lock** で同じ Installation への
並行 apply を直列化する。

| backend        | 保証                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| **SQL-backed** | lease row で複数 kernel pod 間の同じ Installation apply / rollback を fence       |
| **In-memory**  | per-Installation Promise chain で同 process 内の race だけを防ぐ。dev / test 専用 |

SQL backend は `TAKOSUMI_DATABASE_URL` (または `DATABASE_URL`) を設定した boot
path で選択される。 installer lifecycle の永続化 migration が必要。

lock acquire は `locked_until > now()` の既存 holder がいる間は待つ。 holder pod
が落ちた場合は lease expiry 後に別 pod が取得できる。 release は `owner_token`
が一致する row だけを消すため、 stale holder が takeover 後の row
を削除することはない。

timing は次で調整できる:

- `TAKOSUMI_LOCK_LEASE_MS` — lease window。 default `30000`。
- `TAKOSUMI_LOCK_HEARTBEAT_MS` — renewal interval。 default は lease / 3
  (`30000` の場合 `10000`)。

::: warning lock scope この lock は installer apply / rollback の同一
Installation fence。 下流 provider へ fencing token を渡す full OperationPlan /
WAL protocol ではない。 pod freeze 等で holder が lease 失効後も処理を続けると、
外部 provider side effect までは lock だけで取り消せない。 長時間 apply を行う
provider では lease を最大実行時間より十分長くするか、 single-writer apply tier
を使うこと。 :::

ロック詳細は [Lifecycle Protocol](/reference/lifecycle) も参照。

---

## Multi-tenancy の境界

public installer route (`/v1/installations/*`) は `TAKOSUMI_INSTALLER_TOKEN` の
bearer で認証する。 Space / actor の解決は token issuer (= Takosumi Accounts)
の責務。

- token は installer API 用 (`TAKOSUMI_INSTALLER_TOKEN`) と artifact write 用
  (`TAKOSUMI_DEPLOY_TOKEN`) を分ける。
- AppSpec に Space / tenant / org は書かない。 install context / token claims が
  Space を決める。
- 複数 org / operator を扱う場合は token issuer と kernel instance の境界を
  operator policy として明確に分離する。

::: warning 複数 operator / org 環境 独立した namespace が必要な場合は kernel
instance か token issuer の boundary を分離すること。 AppSpec field で namespace
を切り替える public API は無い。 :::

---

## Secret encryption

Takosumi の `MemoryEncryptedSecretStore` は **AES-GCM** で seal / open する
(source: `packages/kernel/src/adapters/secret-store/memory.ts`)。

key は cloud partition 別に独立に派生される:

| partition    | env override (推奨)                            |
| ------------ | ---------------------------------------------- |
| `global`     | `TAKOSUMI_SECRET_STORE_PASSPHRASE` (or `_KEY`) |
| `aws`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`         |
| `gcp`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_GCP`         |
| `cloudflare` | `TAKOSUMI_SECRET_STORE_PASSPHRASE_CLOUDFLARE`  |
| `k8s`        | `TAKOSUMI_SECRET_STORE_PASSPHRASE_K8S`         |
| `selfhosted` | `TAKOSUMI_SECRET_STORE_PASSPHRASE_SELFHOSTED`  |

partition の override が無ければ `global` passphrase に partition label を mix
した HKDF-style salt から派生される。 そのため AWS partition の secret
を漏らしても他 cloud の ciphertext は復号できない。

`additionalData (AAD)` に partition label が bind されているため、 payload の
partition tag を swap すると open() が失敗する。

### Key rotation

`SecretRotationPolicy` を put 時に渡すと metadata に保存され、
`rotationStatus()` で `active` / `due` / `expired` を計算できる。

```ts
{ intervalDays: 90, gracePeriodDays: 30 }
// 90 days で due, 120 days で expired
```

cap が来た secret を rotate するのは operator の責任 (interval を過ぎても自動で
seal されない)。 operator は `rotationStatus()` を監視して新 version を put
し直すこと。

`runVersionGc()` は keep-latest-N + last-accessed-N-days で旧 version を GC する
(defaults: keepLatest=5, accessedWithinDays=90)。

---

## Observability の現状

Takosumi が公式に export している observability surface は以下のみ:

| Surface              | 用途                                        |
| -------------------- | ------------------------------------------- |
| `/livez`             | process が生きているか (cheap liveness)     |
| `/readyz`            | DB / queue / agent ready の readiness probe |
| `/status/summary`    | application-level の health summary         |
| `audit_events` table | tamper-evident hash-chain audit log         |

source: `packages/kernel/src/api/readiness_routes.ts`

### Audit chain

`audit_events` table には `sequence` / `previous_hash` / `current_hash`
が記録され、 各行は前行の hash を embed する。 row が改竄されると chain
verification が fail する (source:
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
  を設定した `takosumi-api` role で提供される。
- OTLP/HTTP JSON metrics export は `TAKOSUMI_OTLP_METRICS_ENDPOINT` または
  standard `OTEL_EXPORTER_OTLP_*` env で有効化される。

external 観測が必要な場合の選択肢:

- `TAKOSUMI_AUDIT_REPLICATION_KIND=s3` で audit log を S3 に replicate (Object
  Lock + retention 対応)。
- `/metrics` と `/readyz` を外部 monitoring から scrape。
- OTLP metrics を collector に push。
- `deploy/observability/grafana/takosumi-deploy-overview.json` を Grafana に
  import し、 deploy success rate / apply latency / rollback rate を監視。
- [Observability Stack](/reference/observability-stack) の SLI / SLO table を
  alert rules と on-call routing の初期 contract として使う。
- application logs を Deno stdout から拾う。

native trace exporter は target contract。 :::

---

## 関連ページ

- [Operator Bootstrap](/operator/bootstrap) — provider plugin の wire 手順
- [Environment Variables](/reference/env-vars) — `TAKOSUMI_*` 一覧
- [Lifecycle Protocol](/reference/lifecycle) — apply / destroy / lock 詳細
- [Kernel HTTP API](/reference/kernel-http-api) — installer / artifact /
  internal API
- [Version Alignment](/operator/upgrade) — package alignment
