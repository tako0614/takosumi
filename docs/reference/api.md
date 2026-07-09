# Takosumi API

Takosumi API は、Git を source of truth にした OpenTofu control plane と
Resource Shape API を公開するための API です。

この API は Cloudflare / AWS / Kubernetes などの API を全部まとめた互換 API
ではありません。既存の industry-standard surface がある場合は、それを使います。
標準的な面がない durable service form だけを Takosumi が typed shape として定義します。

## 基本方針

```text
標準 API / protocol / OpenTofu provider がある:
  その surface を使う。

標準 surface がなく、繰り返し使う service form がある:
  Takosumi Resource Shape として定義する。

一回限りの不足:
  generic-env ProviderConnection と通常の OpenTofu module で扱う。
```

`takosumi/takosumi` provider はこの API の薄い client です。provider は vendor
API を直接呼ばず、backend も選びません。Resource API に preview / apply /
delete / status を送り、Takosumi endpoint が Resolver / Adapter / TargetPool /
Policy に基づいて処理します。

## Discovery

すべての Takosumi endpoint は discovery を公開します。

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

`takosumi/takosumi` provider、CLI、dashboard は edition 名ではなく
capability を見ます。

例:

```json
{
  "apiVersions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "resourceShapes": true,
    "opentofuRunner": true,
    "oidc": true,
    "compatS3": true,
    "compatCloudflareWorkers": false,
    "billing": false
  },
  "endpoints": {
    "api": "https://takosumi.example.com",
    "oidcIssuer": "https://takosumi.example.com"
  }
}
```

## 共通 object model

Resource Shape API の object は Kubernetes-style の形に寄せます。

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "EdgeWorker",
  "metadata": {
    "name": "api",
    "space": "prod",
    "managedBy": "opentofu",
    "labels": {
      "app": "example"
    }
  },
  "spec": {
    "name": "api",
    "source": {
      "artifactPath": "dist/worker.js"
    },
    "profiles": ["workers_bindings"]
  },
  "status": {
    "phase": "Ready",
    "observedGeneration": 3,
    "conditions": [
      {
        "type": "Ready",
        "status": "True"
      }
    ]
  }
}
```

`spec` は desired state、`status` は Takosumi が観測した状態です。secret
material は `spec`、`status`、OpenTofu state、logs、audit に保存しません。

## Authentication

API client は endpoint の設定に応じて session cookie または bearer token を使います。

```http
Authorization: Bearer <token>
```

任意の Takosumi endpoint は、operator が有効化した session / bearer token model を
capability として公開します。Takosumi Cloud の API key は Takosumi Accounts personal
access token です。S3-compatible endpoint のように標準 protocol 自体が署名方式を持つ
場合は、その protocol の署名を使います。

## OpenTofu Stack API

Stack API は plain OpenTofu / Terraform module を Git から実行します。
この flow では既存 provider をそのまま使います。

代表的な操作:

```http
POST   /v1/workspaces
GET    /v1/workspaces/{workspaceId}

POST   /v1/projects
GET    /v1/projects/{projectId}

POST   /v1/sources
GET    /v1/sources
GET    /v1/sources/{sourceId}
PATCH  /v1/sources/{sourceId}
POST   /v1/sources/{sourceId}/sync
GET    /v1/sources/{sourceId}/snapshots

POST   /v1/capsules
GET    /v1/capsules/{capsuleId}
PATCH  /v1/capsules/{capsuleId}

POST   /v1/provider-connections
GET    /v1/provider-connections
GET    /v1/provider-connections/{connectionId}
DELETE /v1/provider-connections/{connectionId}

POST   /v1/runs
GET    /v1/runs/{runId}
GET    /v1/runs/{runId}/logs
POST   /v1/runs/{runId}/approve
POST   /v1/runs/{runId}/cancel

GET    /v1/capsules/{capsuleId}/state-versions
GET    /v1/capsules/{capsuleId}/outputs
GET    /v1/audit-events
```

Run は `plan` / `apply` / `destroy` / `refresh` / `output` の operation を持つ単一
ledger entry です。Plan / Apply / Destroy を別 ledger entity にはしません。

Git checkout からビルドする Capsule は、作成時に任意の `sourceBuild` を指定できます。
これは Store metadata ではなく、ユーザーが明示的に承認する Capsule 設定です。

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

command は shell 文字列ではなく argv 配列です。working directory と output は
Git checkout 内の相対 path に限り、provider credential は build phase に渡しません。
指定しない場合は通常どおり、OpenTofu module が release artifact URL / digest、provider、
data source などから成果物を解決します。

Run には次を保存します。

```text
source snapshot
OpenTofu version
provider lock digest
ProviderBinding
injected env metadata, not values
plan/apply result
state version
outputs
logs
actor
audit evidence
```

`Source.defaultRef` は branch / tag / commit を受け取ります。`Source.autoSync`
を有効にすると、scheduler または source webhook が Git ref を同期し、解決された
commit を `SourceSnapshot` として保存します。active Capsule がその Source を追跡し、
現在 apply 済みの SourceSnapshot と新しい commit が異なる場合、Capsule は `stale`
になります。そこからは既存の Workspace update / RunGroup が reviewable plan を作り、
apply は通常の Run approval に従います。Takosumi が OpenTofu の外で app artifact
を決めたり取得したりはしません。

## Resource Shape API

Resource Shape API は `takosumi_*` provider resources、CLI、dashboard、Kubernetes
CRD などが使う typed Resource object API です。

Compatibility API は別の first-class surface です。標準 protocol / 既存 tool
との相性が良い場合は、compat API 自体を公開 surface として扱います。内部で
Resource / NativeResource / usage / audit へ正規化することはありますが、それは
bookkeeping であり、compat API が `takosumi` provider や Resource Shape API に
従属するという意味ではありません。

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
GET    /v1/resources/{kind}/{name}
DELETE /v1/resources/{kind}/{name}
GET    /v1/resources
GET    /v1/resources/{id}/events
POST   /v1/resources/{id}/refresh
POST   /v1/resources/{id}/import
```

Resource Shape API は typed shape を前提にします。通常 interface として
`takosumi_resource { type, spec }` のような全部入り resource は公開しません。

現在の v1alpha1 public shape:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
SQLDatabase
ContainerService
```

Takos のような複合 product も、専用の `takosumi_takos` resource ではなく、
この汎用 shape の合成として表します。例えば `takos-worker` は `EdgeWorker`、
workspace/control DB は `SQLDatabase`、file/workspace object は `ObjectBucket`、
agent job / event は `Queue`、`takos-git` / `takos-agent` は
`ContainerService` です。足りない service form が出た場合だけ、同じ prior-art
gate を通して新しい typed shape を追加します。

`EdgeWorker` や `ContainerService` のような consumer shape は `connections`
で他の shape への非 secret 接続を宣言できます。ここに置けるのは resource
reference、permissions、projection kind だけです。credential や実際の binding
materialization は Credential / ProviderConnection / adapter 側が扱います。
HCL では `connection` は予約語なので、provider surface は `connections = [...]`
です。

`ObjectBucket` があっても、data-plane は S3-compatible API を使います。
`AI Gateway` は provider resource ではなく OpenAI-compatible endpoint と env/secret
projection として扱います。

## Target / Credential / Policy API

Resource Shape の backend は HCL に直接書かせず、TargetPool / Policy /
capability evidence / ResolutionLock で決めます。
`/v1/capabilities.adapters` は既知 key (`opentofu`, `aws`, `cloudflare`,
`kubernetes`, `vm`, `takosumi_native`) に加えて operator-defined adapter
token を boolean key として返せます。これは既存 typed shape の実装先を増やす
ための拡張であり、新しい `takosumi_*` HCL resource type を runtime に生やす
仕組みではありません。新しい shape は schema/API/provider release が必要です。

```http
POST /v1/targets
GET  /v1/targets
PUT  /v1/targets/{targetId}

POST /v1/target-pools
GET  /v1/target-pools
PUT  /v1/target-pools/{targetPoolId}

POST /v1/credentials
GET  /v1/credentials
POST /v1/credentials/{credentialId}/rotate

POST /v1/policies
GET  /v1/policies
```

credential は `static` / `oidc` / `agent` / `managed` の mode を持てます。
secret value は write-only です。

## OIDC / workload identity

Takosumi は service account、runner、agent、外部 cloud federation のために OIDC
issuer を公開できます。

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
POST /oauth/token

POST /v1/identity/service-accounts
POST /v1/identity/tokens
POST /v1/identity/federation/aws
POST /v1/identity/federation/gcp
POST /v1/identity/federation/kubernetes
```

Operator / Cloud は Enterprise SSO、SCIM、商用 audit export などを追加できますが、
workload identity の core contract は標準 Takosumi 側にあります。

## Compatibility API

Compatibility API は標準 protocol / API の facade であり、独立した
Takosumi-managed feature surface です。plain Stack flow や typed Resource Shape
と横並びの入口であり、`takosumi` provider への従属 route ではありません。

```text
compat.s3.v1
  S3-compatible Object Storage data/control path

compat.oci.v1
  Artifact / ContainerImage lifecycle

compat.cloudevents.v1
  Queue / EventHandler event ingress

compat.kubernetes.crd.v1
  Kubernetes northbound API

compat.cloudflare.workers.v1
  scoped Workers-compatible import/deploy path
```

これは full AWS API や full Cloudflare API 互換を意味しません。範囲は capability と
compatibility matrix で明示します。

compat API、typed `takosumi_*` Resource Shape、S3-compatible API、
OpenAI-compatible API、Kubernetes CRD、CloudEvents などは、どれか一つを
正本にするのではなく、capability・既存 tool との相性・operator が有効化した
service form に応じて並列に使います。`takosumi` provider は、既存の普遍的な
provider / protocol が足りない service form を schema 付きで定義する入口です。
後から十分な普遍 provider / protocol / standard surface が成立した場合は、新規
利用ではそちらを優先します。Takosumi shape は import continuity、migration、
managed-target placement、policy、metering の価値が残る場合だけ使います。
表現できない operation は互換っぽく成功させず、compatibility matrix で範囲を
明示して fail closed します。

Takosumi Cloud 固有の endpoint 例は
[Cloud endpoints](https://app.takosumi.com/docs/endpoints) を見てください。

## Error shape

失敗 response は structured error を返します。

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "compat.cloudflare.workers.v1 is not enabled for this endpoint",
    "requestId": "req_123"
  }
}
```

secret value、temporary credential、internal adapter credential は error に含めません。

## Versioning

現在の API version は `takosumi.dev/v1alpha1` です。

```text
v1alpha1:
  破壊的変更あり。docs と conformance を同時更新する。

v1beta1:
  大枠固定。upgrade / conversion guidance 必須。

v1:
  後方互換を維持。field 削除なし。
```

OSS / Operator / Cloud の違いは API version ではなく capabilities で表します。
