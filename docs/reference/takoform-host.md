# Takoform integration

Takoform provider の endpoint、token、space を Takosumi に向けると、portable な
Resource 宣言を通常の Resource lifecycle で扱えます。Takoform provider は IaC から
Takosumi API を呼ぶ client であり、Cloudflare、AWS、その他の backend を直接選びません。
配置先と実装は Takosumi endpoint の設定に従います。

Takosumi に Terraform / OpenTofu provider 実装や第二の state authority はありません。
provider、標準 Form、provider release は独立した Takoform project が所有します。

## Provider の接続

provider に必要な接続情報は Takosumi host の origin と control-plane credential です。

```hcl
provider "takoform" {
  endpoint = "https://app.takosumi.com"
  token    = var.takoform_token
  space    = var.takosumi_space
}
```

同じ値は次の環境変数でも渡せます。

```sh
export TAKOFORM_ENDPOINT=https://app.takosumi.com
export TAKOFORM_TOKEN='...'
export TAKOFORM_SPACE='space_...'
```

- `TAKOFORM_ENDPOINT`: `/.well-known/takoform` を公開する host origin
- `TAKOFORM_TOKEN`: Resource / Interface 宣言を操作できる bearer
- `TAKOFORM_SPACE`: Resource / Interface の既定 Space。各 resource で上書き可能

token を HCL、state、Interface document、出力へ書き込みません。provider の bearer
は IaC control-plane 用であり、デプロイされた application が Interface の実体へ
アクセスする credential として再利用しません。

## Discovery

provider は設定された origin の次の文書だけを起点にします。

```http
GET /.well-known/takoform
```

Takosumi は概ね次を返します。

```json
{
  "protocols": ["takoform.host-api@v1alpha1"],
  "api_versions": ["forms.takoform.com/v1alpha1"],
  "features": {
    "service_forms": true,
    "exact_form_ref": true,
    "optimistic_concurrency": true,
    "idempotent_lifecycle": true,
    "interface_declarations": true,
    "interface_declaration_writes": true
  },
  "endpoints": {
    "api": "https://app.takosumi.com/apis/forms.takoform.com/v1alpha1",
    "forms": "https://app.takosumi.com/apis/forms.takoform.com/v1alpha1/forms",
    "interfaces": "https://app.takosumi.com/apis/forms.takoform.com/v1alpha1/interfaces"
  }
}
```

client は広告された same-origin URL をそのまま使います。別 origin、非 HTTPS
(loopback 開発環境を除く)、未対応 `api_versions` は fail closed です。

## Resource API

API base は `/apis/forms.takoform.com/v1alpha1` です。

| Method   | Path                               | 用途                           |
| -------- | ---------------------------------- | ------------------------------ |
| `GET`    | `/forms`                           | exact Form availability        |
| `POST`   | `/resources/preview`               | desired Resource の plan       |
| `PUT`    | `/resources/{kind}/{name}`         | reviewed plan の apply         |
| `GET`    | `/resources/{kind}/{name}`         | canonical portable state       |
| `POST`   | `/resources/{kind}/{name}/import`  | native object の import        |
| `POST`   | `/resources/{kind}/{name}/observe` | read-only drift observation    |
| `POST`   | `/resources/{kind}/{name}/refresh` | backend state と公開出力の更新 |
| `DELETE` | `/resources/{kind}/{name}`         | Resource の削除                |

Resource は `apiVersion/kind/form/metadata/spec/status` envelope を使います。
`form` は definition と package の完全一致 identity です。

```json
{
  "apiVersion": "forms.takoform.com/v1alpha1",
  "kind": "ObjectBucket",
  "form": {
    "formRef": {
      "apiVersion": "forms.takoform.com/v1alpha1",
      "kind": "ObjectBucket",
      "definitionVersion": "0.2.0",
      "schemaDigest": "sha256:..."
    },
    "packageDigest": "sha256:..."
  },
  "metadata": {
    "name": "assets",
    "space": "space_...",
    "resourceVersion": "3"
  },
  "spec": {
    "name": "assets"
  }
}
```

create は `If-None-Match: *`、既存 Resource の mutation は
`If-Match: "<resourceVersion>"` を使います。apply、import、observe、refresh、
delete は deterministic `Idempotency-Key` が必須です。response の ETag と
`metadata.resourceVersion` は一致します。

Takosumi は wire object を通常の Resource lifecycle に渡します。portable API 専用の
Resource、Run、state、audit、idempotency ledger は作りません。

## Interface の宣言

Interface は protocol-specific resource ではありません。IaC には opaque な JSON
document、その schema、portable input mapping だけを書きます。

```hcl
resource "takoform_interface" "runtime" {
  space         = var.takosumi_space
  resource_kind = "HttpService"
  resource_name = takoform_http_service.api.name
  name          = "example.runtime"
  version       = "1.0.0"

  document_json = jsonencode({
    endpoint = { "$input" = "endpoint" }
  })

  document_schema_json = jsonencode({
    type = "object"
  })

  inputs_json = jsonencode([{
    name    = "endpoint"
    source  = "output"
    pointer = "/url"
  }])

  resource_uri_input = "endpoint"
}
```

`mcp`、`openapi`、`grpc` などの専用 block や専用 kind は提供しません。document の
意味は author と consumer が所有し、Takoform と Takosumi は identity、schema、
data-only policy、Resource との対応だけを検証します。

Interface API は同じ versioned base にあります。

| Method   | Path                 | 用途                                 |
| -------- | -------------------- | ------------------------------------ |
| `GET`    | `/interfaces`        | visible declarations の一覧          |
| `GET`    | `/interfaces/{name}` | exact declaration の解決             |
| `PUT`    | `/interfaces/{name}` | generic declaration の create/update |
| `DELETE` | `/interfaces/{name}` | generic declaration の delete        |

query には `space`、`version`、`resourceKind`、`resourceName` を使います。write は
完全な identity が必須です。create は `If-None-Match: *`、update/delete は
`If-Match: "<resourceVersion>"` と deterministic `Idempotency-Key` で fence
されます。

一つの runtime declaration の identity は次です。

```text
(space, resource.kind, resource.name, interface.name, interface.version)
```

## Interface endpoint へのアクセス

provider は runtime endpoint への proxy ではありません。流れは次の通りです。

1. IaC が `takoform_interface` を Takosumi host に登録する。
2. Takosumi が canonical Resource の公開出力から `inputs` を解決する。
3. consumer が Takosumi の Interface discovery/read API から `document`、`values`、
   必要なら credential-free `resourceUri` を取得する。
4. consumer は解決済み application endpoint を直接呼ぶ。
5. 認証が必要なら、Takosumi が InterfaceBinding/OAuth/workload token 等の
   host-owned grant を短命で発行する。

application endpoint を環境変数へ複製して第二の source of truth にしません。
環境変数は provider が Takosumi control plane へ接続するための値に限定します。
runtime credential は Interface document、Terraform/OpenTofu state、Resource の
公開 outputs へ保存しません。

`resourceUri` は credential-free HTTPS audience です。それ自体は access grant
ではありません。Interface read も access grant ではなく、「何が存在するか」を
返すだけです。

## 認可境界

- provider bearer: Resource / Interface 宣言の control-plane mutation
- Resource adapter credential: Takosumi operator が保持し、provider へ返さない
- InterfaceBinding / runtime token: consumer と Resource の関係に対して host が発行
- application credential: Interface の public document や IaC state に含めない

この分離により、IaC の credential が application へ漏れず、application token が
provider state に残らず、provider が特定 cloud や protocol の authority を持ちません。

## Compatibility

旧 flat `/takoform/v0` Resource envelope は canonical endpoint ではなく、current host
では広告も mount もしません。既存の Takosumi `/v1/resources` は dashboard、CLI、
operator 管理用の Takosumi API として残りますが、Takoform provider は discovery
で広告された versioned API だけを使います。

## Verification

Takosumi の black-box conformance runner は discovery、exact Form availability、
config fixture rejection、preview、apply、idempotent replay、read、digest
substitution rejection、refresh、optional import、delete と、canonical
`/v1` Resource/audit parity を検証します。出力は portable conformance report
であり、signed admission artifact や release candidate は生成しません。
Takoform provider 側は同じ wire contract、mutation fence、response identity、
same-origin discovery、Interface CRUD を独立して検証します。
