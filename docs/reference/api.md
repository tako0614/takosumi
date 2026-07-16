# Takosumi API

Takosumi API は、Git を正とする情報源（source of truth）とした OpenTofu control plane と
Resource Shape API を公開する API です。Workspace / Capsule / Run などの用語は
[用語集](./glossary.md) を参照してください。

この API は、Cloudflare / AWS / Kubernetes などの API をすべてまとめた互換 API
ではありません。外部インフラには既存 provider / standard API を使います。
Takosumi が managed capacity として提供するサービスは provider-neutral な Resource
Shape で定義し、その lifecycle は `/v1/resources` Deploy API が一元管理します。

## 基本方針

```text
外部 resource に標準 API / OpenTofu provider がある:
  plain Stack flow でその surface を使う。

Takosumi/operator が managed service を提供する:
  provider-neutral な Takosumi Resource Shape として定義し、Deploy API で管理する。

一回限りの不足:
  generic-env ProviderConnection と通常の OpenTofu module で扱う。
```

`takosumi/takosumi` provider は、この API の任意の typed client です。provider がベンダーの
API を直接呼ぶことはなく、backend を選ぶこともありません。provider は preview / apply /
delete / status を Deploy API に送り、Takosumi endpoint が Resolver / Adapter /
TargetPool / Policy に基づいて処理します。provider は service catalog、価格、lifecycle
state の正本ではありません。

## Discovery

すべての Takosumi endpoint は、次の discovery endpoint を公開します。

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

`takosumi/takosumi` provider、CLI、dashboard は、edition 名ではなく
capability を参照します。

例を示します。

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

Resource Shape API の object は、Kubernetes 風の形式に揃えています。

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

`spec` はあるべき状態 (desired state)、`status` は Takosumi が観測した状態です。
secret の値は `spec`、`status`、OpenTofu state、ログ、監査記録のいずれにも保存しません。

## Authentication

API client は endpoint の設定に応じて session cookie または bearer token を使います。

```http
Authorization: Bearer <token>
```

どの Takosumi endpoint も、operator が有効化した session / bearer token 方式を
capability として公開します。Takosumi Cloud の API key は、Takosumi Accounts の
personal access token です。S3-compatible endpoint のように標準 protocol 自体が
署名方式を持つ場合は、その protocol の署名を使います。

## OpenTofu Stack API

Stack API は plain OpenTofu / Terraform module を Git から実行します。
この flow では既存 provider をそのまま使います。

stock composition はすべての正しい provider source に provider-neutral な
`opentofu-default` 実行経路を使います。operator は provider 名を routing authority に
せず、別の capability profile を明示選択できます。Takosumi が把握している provider
だけを「対応済み」として特別扱いする仕組みはありません。Credential Recipe は
env/file 設定を簡単にする補助情報であり、実行許可リストではありません。Recipe が
ない provider も generic env/file の ProviderConnection を作れば実行できます。

`providerConfig` と `moduleInputDefaults` は endpoint、region、通常の module
default のための非 secret metadata です。credential らしい field は拒否されます。
token / password / private key などは ProviderConnection の write-only
`values` / `files` に保存し、Credential Recipe 経由で一時注入します。

provider cache / mirror があれば `tofu init` はそれを利用し、なければ通常の
OpenTofu registry 経路を利用します。mirror を必須にする場合は operator policy
として明示します。

代表的な操作は次のとおりです。

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

Operator が用意した組み込みの設定補助 (credential recipe) は、次の session API から
確認できます。

```http
GET /api/v1/credential-recipes
```

Run は `plan` / `apply` / `destroy` / `refresh` / `output` の操作を持つ単一の
記録エントリです。Plan / Apply / Destroy を別のエンティティにはしません。

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

repository の `public_endpoint` projection が managed hostname を使う場合、Capsule
作成時に割り当て方を選べます。省略時は `scoped` です。値は OpenTofu 変数を
置き換える別経路ではなく、同じ `subdomain` / `url` / `routePattern` 変数を確定する
control-plane policy です。

```json
{
  "managedPublicHostname": { "mode": "vanity" }
}
```

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>` で枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` をそのまま使い、Workspace の変更不可な
owner account の有限枠を1つ消費します。どちらも hostname 単位で
first-come-first-served に予約します。

managed hostname reservation と vanity slot は Capsule lifetime に属します。成功した
Capsule destroy で解放し、個別 route の削除では解放しません。ユーザー所有 custom
domain はこの mode ではなく別の verified-domain lifecycle を使います。Takosumi Cloud
では verification / certificate lifecycle が未実装のため Planned であり、Cloud
managed route への要求は安全側に停止します。これは通常の OpenTofu URL/route 変数を
BYOC provider に渡すことまで禁止するものではありません。

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

明示的な更新確認では、先に Source を同期し、その要求が生成した変更不可の
`SourceSnapshot` を compatibility check と plan に固定します。既存の古い snapshot を
「最新」として流用してはいけません。session API では次の intent を使えます。

```http
POST /api/v1/sources/{sourceId}/sync
Content-Type: application/json

{ "intent": "manual_plan" }
```

`observe` (省略時) は webhook / scheduler の観測用で、Capsule が opt-in
していれば auto-update を評価できます。`manual_plan` はユーザーが確認する plan
のための同期で、その sync 自体から別の auto-update plan/apply を開始しません。
クライアントは返された SourceSyncRun が `succeeded` になり、その Run の
`sourceSnapshotId` が一覧に現れてから compatibility check と plan を続けます。

## Deploy API / Resource Shape API

`/v1/resources` は provider-neutral な managed Resource の Deploy API です。
preview / apply / observe / refresh / import / delete と、canonical Resource、
ResolutionLock、NativeResource、Run、status、Output、audit の唯一の lifecycle authority
です。`takosumi_*` provider resources、CLI、dashboard、Kubernetes CRD、control-plane
compatibility handler はこの API の client です。

multi-tenant platform の session / personal access token / service token / OAuth
token 経路では、request の `space` は検証済み Workspace id と同じでなければなりません。
platform worker は query、top-level body、`metadata.space` のすべてを照合してから internal
actor へ変換し、異なる Space は `403` で拒否します。Core は暗黙の
Space-to-Workspace mapping を作りません。別 Space を管理できるのは direct
deploy-control bearer を持つ operator 経路、または将来の明示的に検証された mapping
だけです。

control-plane Compatibility API は、対応範囲の request を typed Resource request へ
変換してこの Deploy API を呼びます。独自の lifecycle row、resolver decision、backend
selection を持ちません。data-plane Compatibility API は Ready な canonical Resource と
認可済み Interface / NativeResource evidence を解決してから backend へ到達します。

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
POST   /v1/resources/{kind}/{name}/import
GET    /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources/{kind}/{name}/events?space={spaceId}&limit={1..100}&cursor={opaque}
POST   /v1/resources/{kind}/{name}/observe?space={spaceId}
POST   /v1/resources/{kind}/{name}/refresh?space={spaceId}
DELETE /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources?space={spaceId}&limit={1..100}&cursor={opaque}
```

OSS の preview は価格を要求しません。commercial billing extension を有効にした Cloud
endpoint では、billable preview が versioned `ServiceOffering` / `PriceCatalog` に基づく
`DeploymentQuote` を返し、apply は `quoteId + quoteDigest` を必須とします。quote は Resource
spec digest、resolution fingerprint、offering/catalog version、SKU line items、currency、
estimated total micros、issued/expiry を固定します。Cloud は backend 作業前に reserve、Resource
成功後に capture、失敗/cancel 時に release し、rated UsageEvent と payment-provider invoice
line を照合します。wire field は versioned commercial extension contract で広告し、OSS の
Resource object に Cloud-only field を埋め込みません。

Resource一覧は`createdAt`とResource idによるkeyset paginationです。最終ページ
以外では`nextCursor`を返すため、clientは内容を解釈せず次の`cursor`へそのまま
渡します。`limit`省略時は100件、最大も100件です。

`observe` は保存済み `ResolutionLock` の Target / implementation をそのまま使う
read-only drift check です。OpenTofu-backed Resource では apply 不能な
`drift_check` Run を作り、plugin-backed Resource では adapter の `observe` action を
呼びます。観測結果は CAS fence 付きで `Drifted` / `Reconciling` / `Degraded`
condition に反映され、観測中に apply / delete が進んだ場合は古い結果で Resource を
上書きしません。drift を見つけても自動 apply や Target の再選択は行わず、現在の
revision と endpoint を固定したまま報告します。

platform worker の scheduled observation も同じ `observe` を使います。有効な
Resource Shape がある host では既定で有効になり、`Ready` かつ現 generation の
Resource だけを全 Space 横断の古い順に、bounded durable lease で重複なく観測します。
既定は1時間間隔、1 tick 最大8件、同時4件です。これは内部scheduler状態であり、
新しいpublic Resource台帳やauto-apply経路ではありません。operatorは頻度・batch・
並列数・lease、または機能自体を環境変数で調整できます。

`refresh` は同じ pinned Target / implementation に対して OpenTofu の
`plan -refresh-only` と保存済み plan の apply、または plugin の `refresh` action を
実行します。native provider resource を変更せず Resource-owned state / public Output
だけを更新し、成功時だけ affected Interface の revision を再解決します。実行中は
CAS claim で通常 apply/delete と直列化し、失敗時は Resource を `Failed`、Interface を
`Unknown` に固定します。refresh-only plan の drift changes は resource 作成・更新課金
として扱わず、runner usage だけを別に記録します。

`import` は既存 backend resource を Takosumi の Resource ledger へ取り込みます。request
body は通常の Resource object と top-level の `nativeId` を含みます。Target の
implementation は plugin、または明示的な `moduleImportAddress`（child module 内の
`resource_type.name`）を宣言している必要があります。OpenTofu-backed import は生成 root
へ `import` block を追加し、通常の `Run` として plan します。plan JSON が
`change.importing` をちょうど1件含み、create/update/delete を一切含まない場合だけ保存済み
plan を apply し、Resource-owned state / Output / NativeResource を公開します。plugin-backed
import も read-only inventory lookup に限ります。失敗した未公開 record は backend delete を
呼ばずに削除できます。`nativeId` は credential ではなく provider-native identifier であり、
secret を渡してはいけません。

Resource event は `/events` から新しい順の keyset page として取得できます。これは
共有 Activity / Run audit ledger を `space + resourceId` で絞った non-secret projection
であり、別の Resource state や Run 台帳ではありません。Resource record の削除後も
監査履歴は取得できます。`metadata` は phase、generation、identifier、count だけを持ち、
credential、raw error、spec、state、Output value は公開しません。

Resource Shape API は現在の Service Form host compatibility surface であり、typed shape を前提にします。
採用済み target の exact FormRef / Form Package / FormActivation は additive migration 後も同じ Resource / Run /
state / audit ledger へ解決され、別 API authority を作りません。通常 interface として
`takosumi_resource { type, spec }` のような全部入り resource は公開しません。

現在の v1alpha1 public shape:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
SQLDatabase
ContainerService
VectorIndex
DurableWorkflow
StatefulActorNamespace
Schedule
```

Takos のような複合 product も、専用の `takosumi_takos` resource ではなく、
この汎用 shape の合成として表します。例えば `takos-worker` は `EdgeWorker`、
workspace/control DB は `SQLDatabase`、file/workspace object は `ObjectBucket`、
agent job / event は `Queue`、`takos-agent` は `ContainerService` です。別途
install する `takos-git` は自身の generic service topology を持ちます。足りない
service form が出た場合だけ、同じ prior-art gate を通して新しい typed shape を追加します。

`EdgeWorker` や `ContainerService` のような消費側 shape は `connections`
で他の shape への非 secret 接続を宣言できます。ここに置けるのは resource
reference、permissions、projection kind だけです。credential や実際の binding
生成は Credential / ProviderConnection / adapter 側が扱います。
HCL では `connection` は予約語なので、provider surface は `connections = [...]`
です。

`ObjectBucket` があっても、data-plane は S3-compatible API を使います。
`spec.storageClass` は新規 object の provider-neutral な既定 class で、exact value は
`standard` / `infrequent_access` です。省略時は `standard` に正規化します。
`infrequent_access` は TargetPool が `storage_class_infrequent_access` capability を
公開するときだけ解決でき、未対応時は backend 呼び出し前に失敗します。既存 object の
class を暗黙に変更する selector ではありません。Takosumi provider では同じ入力を
`storage_class` として公開します。
`AI Gateway` は provider resource ではなく OpenAI-compatible endpoint と env/secret
projection として扱います。

## Target / Credential / Policy API

Resource Shape の backend は HCL に直接書かせず、TargetPool / Policy /
capability evidence / ResolutionLock で決めます。
これは operator/advanced API です。通常の deploy UX は service form、必要な入力、
価格、preview、apply だけを表示し、TargetPool / Policy / Adapter を要求しません。
`/v1/capabilities.adapters` は既知 key (`opentofu`, `aws`, `cloudflare`,
`kubernetes`, `vm`, `takosumi_native`) に加えて operator-defined adapter
token を boolean key として返せます。これは既存 typed shape の実装先を増やす
ための拡張であり、新しい `takosumi_*` HCL resource type を runtime に生やす
仕組みではありません。新しい shape は schema/API/provider release が必要です。

```http
PUT    /v1/target-pools/{name}
GET    /v1/target-pools/{name}?space={spaceId}
GET    /v1/target-pools?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/target-pools/{name}?space={spaceId}

PUT    /v1/space-policies/{name}
GET    /v1/space-policies/{name}?space={spaceId}
GET    /v1/space-policies?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/space-policies/{name}?space={spaceId}
```

operator が既定 pool を bootstrap するときは、同じ PUT に
`If-None-Match: *` を付けると atomic create-only になります。作成は `201`、同じ
Space/name が既にあれば `412 target_pool_exists` で、既存の capability evidence を
上書きしません。header なしの PUT は明示的な create/update です。

Targetは独立した未実装の`/v1/targets` resourceではなく、現在はTargetPoolの
`spec.targets[]`にoperatorが完全なcapability evidenceとして宣言します。Resource
Shape flowのSpacePolicyは同じSpace-scoped endpointで保存・取得・一覧・削除します。

provider 実行 credential はOpenTofu Stack flowの Provider Connection と Credential Recipe が所有します。
Recipe の `authModes` key と `preRun.type` は operator/provider が公開する open token で、
Core は `static` / `oidc` / cloud vendor などの固定 taxonomy を持ちません。
secret value は write-only で、Run 時だけ recipe に従って env/file に materialize されます。

## OIDC / workload identity

Takosumi Accounts は登録済み OIDC client のための標準 issuer surface を公開します。

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
GET  /oauth/authorize
POST /oauth/token
```

独立した ServiceAccount / workload federation API は現在の public surface にはありません。
AWS / GCP / Kubernetes ごとの固定 route や credential kind も Core には追加しません。
将来の workload identity は、汎用 OIDC principal、Resource Credential / Policy、または
Credential Recipe の明示的 pre-run action として設計し、実装・discovery が揃ってから公開します。
Operator / Cloud はその汎用 seam に Enterprise SSO、SCIM、商用 audit export を追加できます。

Capsule が公開する OIDC client は `installExperience.oidc_client.scopes`
で必要な scope を宣言できます。`openid` は必須です。Accounts が発行する
`capsules:read` / `capsules:write` access token は単一 Workspace に束縛され、
canonical Capsule ledger の参照と Interface 呼び出しは scope と Workspace を両方検証します。`offline_access` を
許可した client は refresh token を受け取れますが、token の実体は利用側の
secret store に暗号化保存し、OpenTofu state や Output に保存しません。

## Compatibility API

Compatibility API は標準 protocol / API の scoped facade です。control-plane profile
は Deploy API の translation client、data-plane profile は canonical Ready Resource
への認可済み access surface です。独立した resource ledger や backend ではありません。

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

control-plane compat、typed `takosumi_*` resource、dashboard、CLI は、公開 protocol
こそ異なっても同じ Resource desired state と Deploy API lifecycle に収束します。
data-plane profile は既存 Resource を暗黙作成せず、Ready な Resource を解決します。
表現できない操作は互換のように成功させず、compatibility matrix で範囲を明示して
安全側に停止します。

managed hostname を作る compatibility route / script-subdomain write は source
Workspace と source Capsule のコンテキストを必須とし、Capsule Run と同じ OSS hostname
予約管理を使います。Cloud extension の KV / Durable Object などの
routing / activation state は hostname 所有権の正とする情報ではありません。route-level
DELETE はその state だけを削除し、Capsule lifetime に属する reservation を解放しません。

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

secret の値、一時的な credential、内部 adapter の credential は error に含めません。

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
