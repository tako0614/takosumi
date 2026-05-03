# Quickstart — git clone から first deploy まで

このドキュメントは Takosumi で **manifest を 1 本書いて、selfhosted / AWS / GCP
/ Cloudflare / Azure / Kubernetes に deploy する** までの最短経路を示します。

Takosumi は 2 つのコンポーネントで構成されます:

- **kernel**: HTTP API、apply pipeline、state DB を管理。manifest を受けて
  resource lifecycle を orchestrate するが、cloud SDK は **直接呼ばない**
- **runtime-agent**: cloud REST API (SigV4 / OAuth) や local OS (`docker`,
  `systemd`, filesystem) と実際に通信する executor。**credential はここに
  だけ存在する**

dev では `takosumi server` 1 コマンドが両方を 1 process で立ち上げます。
production では別ホストでも同居でも OK。

---

## 1. CLI install

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

---

## 2. Local dev (zero-config)

embedded agent が自動起動するので env 設定は最小限:

```bash
export TAKOSUMI_DEV_MODE=1
takosumi server --port 8788 &
# stdout: "embedded runtime-agent listening at http://127.0.0.1:8789"
takosumi init my-app.yml --template selfhosted-single-vm
takosumi deploy my-app.yml
```

`TAKOSUMI_DEV_MODE=1` は dev 用の単一 opt-out flag。plaintext secret /
unencrypted DB / unsafe defaults を許可。production / staging では fail-closed。

local dev では agent と kernel が同 process なので、env に置いた cloud
credential はそのまま agent connector に届きます。

---

## 3. Self-hosted deploy (single VM、Docker / systemd)

template `selfhosted-single-vm@v1` は VM 上に systemd / docker / filesystem /
local Postgres / coredns で 1 台完結デプロイを構築します。

`my-app.yml`:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
template:
  ref: selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: ghcr.io/me/api:v1.0.0
    port: 8080
    domain: api.example.com
```

operator side (VM 上):

```bash
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_ENCRYPTION_KEY=$(openssl rand -base64 32)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)

# selfhosted connector の置き場 (任意、defaults あり)
export TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR=/etc/systemd/system

takosumi server --port 8788 &
takosumi deploy my-app.yml \
  --remote http://localhost:8788 \
  --token $TAKOSUMI_DEPLOY_TOKEN
```

deploy 完了後 (embedded agent が selfhost connector で実行):

- web service が systemd unit `takosumi-api.service` として常駐
- Postgres は `docker run postgres` で立ち上がる (local-docker connector)
- assets bucket は `/var/lib/takosumi/objects/assets/` に作成
- domain は coredns local zone に登録

---

## 4. Cloud deploy (AWS / GCP / Cloudflare / Azure / Kubernetes)

cloud credential を **agent host の env** に置きます。dev では同 process なので
そのまま `takosumi server` を起動した shell に export するだけ:

### AWS

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=ap-northeast-1
# optional: export AWS_SESSION_TOKEN=...
# optional Fargate / RDS / Route53 knobs:
# export TAKOSUMI_AWS_FARGATE_CLUSTER=my-cluster
# export TAKOSUMI_AWS_FARGATE_SUBNET_IDS=subnet-aaa,subnet-bbb
```

connector: `@takos/aws-fargate` / `@takos/aws-rds` / `@takos/aws-s3` /
`@takos/aws-route53`

### GCP

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_REGION=asia-northeast1
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

connector: `@takos/gcp-cloud-run` / `@takos/gcp-cloud-sql` / `@takos/gcp-gcs` /
`@takos/gcp-cloud-dns`

### Cloudflare

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...   # custom-domain 使う場合
```

connector: `@takos/cloudflare-container` / `@takos/cloudflare-r2` /
`@takos/cloudflare-dns`

### Azure

```bash
export AZURE_SUBSCRIPTION_ID=...
export AZURE_RESOURCE_GROUP=my-rg
export AZURE_LOCATION=eastus
export AZURE_BEARER_TOKEN=$(az account get-access-token --query accessToken -o tsv)
```

connector: `@takos/azure-container-apps`

### Kubernetes (k3s 等)

```bash
export TAKOSUMI_KUBERNETES_API_SERVER_URL=https://k8s.example/
export TAKOSUMI_KUBERNETES_BEARER_TOKEN=$(cat /var/run/secrets/.../token)
export TAKOSUMI_KUBERNETES_NAMESPACE=takosumi
```

connector: `@takos/kubernetes-deployment`

---

## 5. Production: kernel と agent を分離

multi-host setup や credential 隔離が必要な場合、agent を別 host で立てて kernel
から HTTP で叩きます:

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

`--env-file ./agent.env` で dotenv ファイルから env を流し込むこともできます。

### Kernel host (credential を持たない)

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://prod-db.internal/takosumi
export TAKOSUMI_ENCRYPTION_KEY=$(openssl rand -base64 32)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)

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

`--no-agent` で kernel の embedded agent spawn を抑止 (production では agent
を別途立てるので不要)。

### credential 境界

- kernel は `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN` のみ持つ
- AWS / GCP / etc の credential は **agent host にのみ存在**
- kernel が compromised しても cloud credential は漏れない
- multi-tenant では cloud account ごとに agent を分離可能

---

## 6. CLI コマンドリファレンス

```
takosumi deploy <manifest>            # apply (local mode in-process / remote mode HTTP)
takosumi destroy <manifest>           # 逆順 destroy
takosumi status [<name>]              # 現在の resource state
takosumi plan <manifest>              # dry-run
takosumi server [--port 8788]         # kernel + embedded agent 起動
                [--no-agent]          # embedded agent 抑止 (production)
                [--agent-port 8789]   # embedded agent の port 指定
takosumi runtime-agent serve          # standalone agent 起動 (multi-host)
                [--port 8789]
                [--token <token>]
                [--env-file <path>]
takosumi migrate                      # DB migrations
takosumi init [--template ...]        # manifest scaffold
takosumi version
```

---

## 7. troubleshooting

| 症状                                                                | 原因                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Refusing to start takosumi with plaintext secret storage`          | production mode で `TAKOSUMI_ENCRYPTION_KEY` 未設定                                                                  |
| `Refusing to start takosumi against an unencrypted database`        | production mode で DB at-rest encryption 未確認 (dev は `TAKOSUMI_DEV_MODE=1` で opt-out 可)                         |
| `manifest.resources[] is required`                                  | `template:` 指定なしで `resources:[]` も空                                                                           |
| 401 from `/v1/deployments`                                          | `TAKOSUMI_DEPLOY_TOKEN` 未設定 or token mismatch                                                                     |
| `[takosumi-bootstrap] TAKOSUMI_AGENT_URL ... not set`               | `takosumi server --no-agent` を使ったが external agent の URL を export してない、または embedded agent の起動に失敗 |
| `runtime-agent /v1/lifecycle/apply failed: 404 connector_not_found` | agent host に該当 cloud の credential が無い → connector が register されてない                                      |
| `runtime-agent /v1/lifecycle/apply failed: 401`                     | agent と kernel で `TAKOSUMI_AGENT_TOKEN` が一致してない                                                             |

### Deprecated provider IDs

0.10 から、Takosumi が ship する provider id はすべて `@takos/<cloud>-<service>`
形式に namespace 化されました。 二つの operator plugin が同じ bare id を再
register してしまう last-write-wins 衝突を避けるためです。

| 旧 (deprecated)        | 新 (recommended)                 |
| ---------------------- | -------------------------------- |
| `aws-s3`               | `@takos/aws-s3`                  |
| `aws-fargate`          | `@takos/aws-fargate`             |
| `aws-rds`              | `@takos/aws-rds`                 |
| `route53`              | `@takos/aws-route53`             |
| `gcp-gcs`              | `@takos/gcp-gcs`                 |
| `cloud-run`            | `@takos/gcp-cloud-run`           |
| `cloud-sql`            | `@takos/gcp-cloud-sql`           |
| `cloud-dns`            | `@takos/gcp-cloud-dns`           |
| `cloudflare-r2`        | `@takos/cloudflare-r2`           |
| `cloudflare-container` | `@takos/cloudflare-container`    |
| `cloudflare-workers`   | `@takos/cloudflare-workers`      |
| `cloudflare-dns`       | `@takos/cloudflare-dns`          |
| `azure-container-apps` | `@takos/azure-container-apps`    |
| `k3s-deployment`       | `@takos/kubernetes-deployment`   |
| `deno-deploy`          | `@takos/deno-deploy`             |
| `filesystem`           | `@takos/selfhost-filesystem`     |
| `minio`                | `@takos/selfhost-minio`          |
| `docker-compose`       | `@takos/selfhost-docker-compose` |
| `systemd-unit`         | `@takos/selfhost-systemd`        |
| `local-docker`         | `@takos/selfhost-postgres`       |
| `coredns-local`        | `@takos/selfhost-coredns`        |

旧 id は 0.10 / 0.11 では引き続き受け付けますが、次のような警告が kernel log に
出ます:

```
[takosumi-resolver] provider id "aws-fargate" is deprecated;
use "@takos/aws-fargate" — bare ids will be rejected in 0.12.
```

`@` で始まる id は変換されません。0.12 で旧 id 受け入れは削除されるので、
manifest の `provider:` 値を新形式に書き換えてください。

### Artifact storage hygiene

`takosumi artifact push` でアップロードした blob は object storage
にcontent-addressed (`sha256:...`) で残ります。 Operator が定期的に GC を回す
ことで、destroy された deployment が pin していた artifact をまとめて回収
できます:

```bash
takosumi artifact gc --dry-run    # delete 対象を確認
takosumi artifact gc              # 実削除
```

GC は kernel 側で persistent な `takosumi_deployments` record を mark+sweep
し、どの deployment record (status が `applied` でも `destroyed` でも) からも
参照されていない blob だけを削除します。 Idempotent なので何度 call しても
害はありません。

### Artifact upload size cap

`POST /v1/artifacts` は現状 multipart body 全体を kernel プロセス memory に
buffer してから object storage に書き込むため、 50MB+ の JS bundle や Lambda zip
を素直に upload すると kernel の RAM 圧迫の原因になります。 これを
ガードするため、 1 アップロードの body size に hard cap がかかっています:

| Env / Option                             | Default             | 説明                                               |
| ---------------------------------------- | ------------------- | -------------------------------------------------- |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`            | `52428800` (50 MiB) | kernel boot 時に env から読まれる upload byte 上限 |
| `RegisterArtifactRoutesOptions.maxBytes` | (env と同じ既定)    | embedded host で programmatic に override 可能     |

cap を超えた場合は `413 Payload Too Large` (`error.code:
"resource_exhausted"`)
で拒否されます。 `Content-Length` header が cap より大きい場合は body
を読まずに即時 413 を返すので、 hostile client が任意の body を送りつけて kernel
を OOM させる経路を塞ぎます。

> 50 MiB を超える artifact (大きい bundle / zip / OCI layer) を流したい場合、
> `TAKOSUMI_ARTIFACT_MAX_BYTES` を引き上げて RAM を確保するか、 R2 / S3 / GCS
> 等の external object-storage backend を kernel の `objectStorage` adapter に
> 配線して presigned upload で直接 backend に書き込むのが推奨です。
> `ObjectStoragePort` interface は同じなので adapter を切り替えるだけで済み
> ます。 完全な streaming-multipart parser の導入は future work です。

### Read-only artifact fetch token (agent ↔ kernel scope separation)

production deploy で `kernel <-> runtime-agent` を別 host に分離している場合、
agent host が compromised しても artifact upload / delete / GC を許さない
ように、 read-only な artifact fetch token を別途発行できます:

```bash
# kernel host (deploy token と read-only fetch token を両方発行)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_ARTIFACT_FETCH_TOKEN=$(openssl rand -hex 32)
```

- `TAKOSUMI_DEPLOY_TOKEN` は CLI からの `takosumi deploy` /
  `takosumi artifact push` / `takosumi artifact gc` 等の write 系を許可する
  full-power token。
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を agent host に渡すと、 agent の connector は
  GET / HEAD `/v1/artifacts/:hash` で blob を fetch できますが、 POST (upload) /
  DELETE / GC は kernel 側で 401 になります。
- agent host は artifact 取得 URL に対して fetch token のみ持てば十分で、 deploy
  token を保持する必要はありません。

`TAKOSUMI_PUBLIC_BASE_URL` と組み合わせて kernel が runtime-agent に渡す
artifact-store locator は、 fetch token が set されていればそちらを優先します
(set されていなければ後方互換で deploy token を渡します)。

---

## 関連 docs

- [Manifest spec](/manifest)
- [Shape catalog](/reference/shapes)
- [Provider plugins](/reference/providers)
- [Templates](/reference/templates)
- [Operator bootstrap](/operator/bootstrap) (kernel ↔ agent 連携の詳細)
