# Quickstart — git clone から first deploy まで

> このページでわかること: manifest を書いて最初のデプロイを行うまでの最短手順。

kernel / runtime-agent の責務分離は
[Concepts § Architecture](/getting-started/concepts#architecture-kernel--runtime-agent)
を参照。 dev では `takosumi server` 1 コマンドが両方を 1 process で立ち上げる。

---

## 1. CLI install

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

---

## 2. Local authoring (zero-config)

source root に `.takosumi.yml` (= AppSpec) を置く。 public installer API は この
AppSpec を読み、 Installation を作り、 apply ごとに Deployment を記録する。

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.hello-worker
  name: hello-worker
components:
  web:
    kind: worker
    build:
      command: "npm run build"
      output: "dist/worker.js"
    spec:
      compatibilityDate: "2026-05-09"
      routes:
        - hello.local/*
```

```bash
takosumi install dry-run --space space_personal --source ./
takosumi install --space space_personal --source ./
```

remote kernel に投げる dev loop は次のように URL/token を明示する。

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788
takosumi server --port 8788 &
# stdout: "embedded runtime-agent listening at http://127.0.0.1:8789"
takosumi install --space space_personal --source ./
```

`TAKOSUMI_DEV_MODE=1` は dev 用の単一 opt-out flag。 plaintext secret /
unencrypted DB / unsafe defaults を許可する。 production / staging では
fail-closed。

dev server mode では agent と kernel が同 process なので、 env に置いた cloud
credential はそのまま agent connector に届く。

---

## 3. Cloud credential を env に置く

cloud credential は **agent host の env** に置く。 dev では同 process なので
`takosumi server` を起動した shell に export するだけ。

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

connector: `@takos/aws-{fargate,rds,s3,route53}`

### GCP

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_REGION=asia-northeast1
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

connector: `@takos/gcp-{cloud-run,cloud-sql,gcs,cloud-dns}`

### Cloudflare

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...   # custom-domain 使う場合
```

connector: `@takos/cloudflare-{container,r2,dns}`

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

## 4. CLI コマンドリファレンス

```
takosumi install <source>             # Installation 作成 + 初回 Deployment
takosumi install dry-run <source>     # 新規 install dry-run
takosumi deploy <installation-id>      # 既存 Installation に apply
takosumi deploy dry-run <installation-id>
takosumi rollback <installation-id> <deployment-id>
takosumi server [--port 8788]         # kernel + embedded agent 起動
                [--no-agent]          # embedded agent 抑止 (production)
                [--agent-port 8789]   # embedded agent の port 指定
takosumi runtime-agent serve          # standalone agent 起動 (multi-host)
                [--port 8789]
                [--token <token>]
                [--env-file <path>]
takosumi migrate                      # DB migrations
takosumi version
```

public contract は `.takosumi.yml` / Installation / Deployment と
`/v1/installations/*` の 5 endpoint。 workflow runner や webhook は kernel の
外で AppSpec source を渡す upstream automation として実装する。

---

## 5. troubleshooting

| 症状                                                                | 原因                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Refusing to start takosumi with plaintext secret storage`          | production mode で `TAKOSUMI_SECRET_STORE_PASSPHRASE` 未設定                                                         |
| `Refusing to start takosumi against an unencrypted database`        | production mode で DB at-rest encryption 未確認 (dev は `TAKOSUMI_DEV_MODE=1` で opt-out 可)                         |
| AppSpec schema error                                                | `.takosumi.yml` が AppSpec schema に合っていない                                                                     |
| 401 from `/v1/installations/*`                                      | `TAKOSUMI_INSTALLER_TOKEN` token mismatch                                                                            |
| `[takosumi-bootstrap] TAKOSUMI_AGENT_URL ... not set`               | `takosumi server --no-agent` を使ったが external agent の URL を export してない、または embedded agent の起動に失敗 |
| `runtime-agent /v1/lifecycle/apply failed: 404 connector_not_found` | agent host に該当 cloud の credential が無い → connector が register されてない                                      |
| `runtime-agent /v1/lifecycle/apply failed: 401`                     | agent と kernel で `TAKOSUMI_AGENT_TOKEN` が一致してない                                                             |

---

## 関連 docs

- [Manifest spec](/manifest)
- [Component Kind Catalog](/reference/component-kind-catalog)
- [Provider plugins](/reference/providers)
- [Self-host deploy](/operator/self-host) — VM 単機 / multi-host 分離 / artifact
  GC / fetch token
- [Operator bootstrap](/operator/bootstrap) — kernel ↔ agent 連携の詳細
