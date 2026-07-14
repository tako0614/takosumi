# Deploy-Control API

Last updated: 2026-07-13

この API は、Takosumi OSS における OpenTofu/Terraform execution を制御します。既存の
provider をそのまま実行します。public な compatibility profile は、Resource Shape model に
写像される別の capability-versioned surface であり、隠れた deploy-control gateway route
ではありません。

## Public Surface

OSS の deploy-control surface は、次を中心にしています。

```text
Workspace
Project
Capsule
Source
ProviderConnection
ProviderBinding
Secret
Run
StateVersion
Output
Interface
InterfaceBinding
AuditEvent
```

呼び出し側の契約は Capsule-driven plan Run です。client は Capsule を作成または選択し、
ProviderBinding で provider を紐づけ、`plan` Run を作成し、保存された plan の結果を確認して
から、その保存済みの plan/state context に対して `apply` または `destroy` Run を承認します。

## Minimal API Shape

```text
POST   /projects
GET    /projects/:id

POST   /capsules
GET    /capsules/:id
PATCH  /capsules/:id

POST   /connections
GET    /connections
GET    /connections/:id
DELETE /connections/:id

POST   /runs
GET    /runs/:id
GET    /runs/:id/logs
POST   /runs/:id/approve
POST   /runs/:id/cancel

GET    /state/:capsule_id/versions
GET    /capsules/:capsule_id/outputs

POST   /v1/interfaces
GET    /v1/interfaces
GET    /v1/interfaces/:id
PATCH  /v1/interfaces/:id
DELETE /v1/interfaces/:id

POST   /v1/interfaces/:id/bindings
GET    /v1/interfaces/:id/bindings
GET    /v1/interfaces/:id/bindings/:bindingId
DELETE /v1/interfaces/:id/bindings/:bindingId

POST   /secrets
GET    /audit
```

## Output と Runtime Interface

成功した apply の後、Takosumi は `tofu output -json` から通常の root module Output を
StateVersion / Output ledger に記録します。Output 名と値のshapeはmoduleが所有し、
Takosumi固有の予約名、nested schema、runtime宣言、認証情報を要求しません。

deployed runtimeをMCP、HTTP、file handlerなどとして公開するときは、service-sideの
`Interface`を作ります。`Interface.spec`は、consumerが解釈する`type` / `version`、任意の
non-secret JSON `document`、公開範囲を表す`access`を持ちます。動的なpublic値は
`inputs`で明示的に接続します。

```json
{
  "workspaceId": "ws_1",
  "name": "researchTools",
  "ownerRef": { "kind": "Capsule", "id": "cap_1" },
  "spec": {
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": {
      "transport": "streamable-http",
      "display": { "title": "Research tools" }
    },
    "inputs": {
      "endpoint": {
        "source": "capsule_output",
        "capsuleId": "cap_1",
        "outputName": "mcp_url"
      }
    },
    "access": {
      "visibility": "workspace",
      "resourceUriInput": "endpoint"
    }
  }
}
```

input sourceは`literal` / `capsule_output` / `resource_output`です。OutputまたはResource
output内の一部を使う場合はRFC 6901 JSON Pointerも指定できます。Takosumiは値を
`status.resolvedInputs`へ解決し、元のRun / StateVersion / Output digestまたはResource
generationをprovenanceとして記録します。OpenTofuまたは明示mappingでsensitiveとされた
Outputと、利用不能な値はruntime inputとして解決しません。Output名自体はopaqueです。

consumerの利用権限は`InterfaceBinding`で明示します。BindingはPrincipal、
ServiceAccount、Capsule、Resourceのいずれか、permission、credential delivery方式を
持ちます。credential値自体はInterface、Binding、Output、state、Run、log、auditに
保存せず、対応するissuer/materializerが認可済みinvocationにだけ渡します。未対応の
delivery方式はfail closedで`NotReady`になります。

Principalの`oauth2` deliveryは、credentialを含まない絶対HTTPS resource URI、host issuer、
およびInterface ownerがそのhostnameを所有することのhost-side証明が揃った場合だけReadyです。
literalやOutputのURLだけでは所有権にもOAuth audience authorityにもなりません。

Outputが変化すると、そのOutputを明示参照するInterfaceだけが新revisionへ解決されます。
Workspace全体のplan/applyやconsumer Capsuleの再applyは起動しません。OpenTofu間の
値接続が必要な場合は、明示的なCapsule Dependencyまたは`terraform_remote_state`を
通常のOpenTofu integrationとして使います。

## Provider Connections

ProviderConnection の作成は、credential metadata と暗号化された secret 参照を保存します。
Run は ProviderBinding を ProviderConnection に解決し、CredentialRecipe を評価して、
一時的な env/file の材料だけを runner に注入します。

Operator が管理する capacity は、明示的な service-side の契約です。public な managed
ProviderConnection は opaque な `managedProviderProfile` を宣言し、それを受け取る platform
extension 側も全く同じ profile を宣言します。Run-scoped な token audience の検証はこの
profile を使います。Takosumi は `providerConfig.base_url`、request の host/path、provider
address から権限を導出しません。profile が欠落・不一致の場合は利用不可となり、OSS は固定の
profile catalog を定義しません。`providerConfig` は、通常の non-secret な provider-block
JSON のままです。

OSS における provider resolution の status は次のとおりです。

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

response には、生の secret、secret 参照、内部の resolver ID、一時的な credential、
生成された credential file を含めてはいけません。

## Runs

Run は次を記録します。

```text
source snapshot
tool version
provider lock digest
provider bindings
injected env metadata, not values
plan result
apply result
logs
outputs
state version
actor
timestamps
audit evidence
```

Secret は、log や診断情報が保存される前に redact されます。

## Release Activation Seam

Takosumi OSS は、provider `apply` で materialize された infrastructure/state と、
service-side InstallConfig に宣言された Capsule lifecycle action の結果を 1 つの reviewed
Run boundary として扱います。lifecycle action は Plan と一緒に pin され、Git manifest、
repository metadata、OpenTofu Output からは発見しません。

宣言がない場合、provider `apply` の成功だけで Run は成功します。`post_apply` action が
宣言されている場合は、host が generic release activator を注入し、その action が terminal
`succeeded` を返すことが Capsule runtime readiness の必須条件です。

この seam は意図的に汎用的です。

```text
OpenTofu apply
  -> provider-applied StateVersion / Output を構築
  -> declared post_apply action (host-injected activator)
  -> atomic ledger commit:
       succeeded => Run succeeded + Capsule active
       otherwise => StateVersion / Output retained + Run failed + Capsule error
  -> Interface blueprint は succeeded の場合だけ Ready 化
```

Operator の webhook activator は、provider credential、runner env、sensitive な
OpenTofu output を一切受け取りません。Runner activator は、apply/destroy と同じ reviewed
ProviderBinding set から発行された、dispatch-scoped の ProviderConnection /
CredentialRecipe の材料だけを受け取ります。secret らしい output 名や値は、どちらの hook の
前でも filter されます。`succeeded` 以外 (`pending` / `skipped` / `failed`、activator
未設定、例外) はすべて fail-closed です。provider-applied StateVersion / Output と実際の
provider apply に対する usage / billing capture は保持しますが、Run は
`capsule_lifecycle_action_failed` で failed、Capsule は error になり、Interface blueprint は
Ready になりません。Plan は applied 済みとして消費されるため、同じ Plan を再実行せず、
新しい plan を review して apply することが generic recovery です。

`pre_destroy` action は provider destroy より前に実行し、terminal `succeeded` 以外では
`runner.destroy` を呼びません。activator が呼ばれた後の失敗は runtime safety を Unknown
として扱い、activator 未設定など mutation 前の失敗では現在の pinned runtime を再評価します。

Capsule は、個々の post-apply コマンドに `executor = "runner"` または
`executor = "operator"` を指定できます。Runner コマンドは source snapshot に復元され、
`TAKOSUMI_OUTPUTS_JSON` のような non-secret な metadata に加え、reviewed run が
ProviderBinding を持っていた場合は dispatch-only の provider credential を受け取ります。
Operator コマンドは組み込みの runner activator では実行されず、runner sandbox の外側の
作業に対する credential boundary を持つ operator/Cloud release activator を host が
設定しない場合、その Run は直ちに fail-closed します。コマンドは、実行制約として `timeout_seconds` /
`timeoutSeconds` を宣言することもできます。これは Git manifest や OpenTofu Output ではなく、
引き続き service-side の InstallConfig 宣言です。Takosumi はコマンドの意味を解釈しませんが、
runner は container artifact のアップロードや provider-gap の設定のような、長時間かかる
app 所有の activation bridge に対して、宣言された timeout を強制します。

platform Worker は、次で汎用の webhook bridge を有効にできます。

```text
TAKOSUMI_RELEASE_ACTIVATOR_URL
TAKOSUMI_RELEASE_ACTIVATOR_TOKEN
```

URL は non-secret な operator 設定です。token は Worker secret です。本番の URL は
`https` である必要があります。`http` は、明示的な local substrate/dev mode でのみ許容
されます。webhook は、canonical な `workspaceId`、Capsule、StateVersion、Output、Run の
ledger 参照と、すでに filter 済みの non-sensitive な output を持つ
`takosumi.operator.release-activation@v2` の JSON payload を受け取ります。廃止済みの
Space / Installation / Deployment の別名は受け付けません。public な readiness の証跡は、
Workspace / Project / Capsule / StateVersion / Output の主張として表現されます。この
payload は operator が制御する bridge の契約であり、customer API surface ではありません。
次のいずれかを返す必要があります。

```json
{ "status": "skipped" }
{ "status": "pending", "message": "queued" }
{ "status": "succeeded", "healthUrl": "https://example.com/healthz" }
{ "status": "failed", "message": "publication failed" }
```

webhook の materializer は、製品固有の公開処理が置かれる場所です。Takosumi Core は、
SourceSnapshot の参照、non-sensitive な output、宣言された opaque な argv コマンドを
転送するだけです。それらのコマンドがデータベースを migrate するのか、artifact を公開する
のか、index を更新するのか、他の app 所有の activation タスクを行うのかを検査しません。
成功応答の URL は運用上の health evidence に限られます。launcher の URL や表示情報は
`interface.ui.surface` Interface と `InterfaceBinding` で別途宣言・認可し、activator 応答は
runtime surface の正本にも fallback にもなりません。

## Out Of Scope For Deploy-Control

Deploy-Control は OpenTofu execution の Run / state / output API です。
compatibility profile、managed Cloud resource、official billing の endpoint
family は Deploy-Control の責務ではありません。これらは別の capability として
document され、discovery で広告されます。

OSS Deploy-Control API は、公式 hosted Cloud endpoint family を直接公開しません。

```text
/compat/cloudflare/client/v4
/gateway/ai/v1
provider-compatible endpoint families
official managed resource backend controls
managed edge/storage/container resource APIs
official billing/quota/usage endpoints
```

Compatibility API framework 自体は Takosumi の一部です。
`compat.cloudflare.workers.v1`、`compat.s3.v1`、OpenAI-compatible AI endpoint
などの profile は scoped / versioned capability であり、Deploy-Control の hidden
route ではありません。

公式 hosted service で現在 document している Cloud endpoint family は
`compat.cloudflare.workers.v1`、`compat.s3.v1`、OpenAI-compatible AI Gateway です。
追加 endpoint family は、それぞれ compatibility matrix、auth model、usage
contract、fail-closed behavior を持つ別仕様として定義します。
