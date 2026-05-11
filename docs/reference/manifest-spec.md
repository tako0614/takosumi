# マニフェストリファレンス

このページは takosumi kernel が受け取る **compiled manifest** の正本仕様です。
`.takosumi/manifest.yml` は `takosumi-git` が所有する authoring convention
であり、 kernel に届く前に compiled manifest へ変換されます。

| ファイル                 | 用途                                                                          | 渡し先                                 |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------- |
| `.takosumi/app.yml`      | InstallableApp v1。install UI / binding / permission preview / upgrade policy | `takosumi-git` と Takosumi Accounts    |
| `.takosumi/manifest.yml` | authoring compute manifest。Shape resource / compile-time extension           | takosumi-git / installer compiler      |
| compiled manifest        | closed Shape manifest。`workflowRef` / installer placeholder strip 済み       | takosumi kernel `POST /v1/deployments` |

`.takosumi/app.yml` は kernel に渡しません。`.takosumi/manifest.yml` は
`takosumi-git` が compile し、`workflowRef` を strip します。`install apply`
では Takosumi Accounts が所有する AppInstallation の materialization result で
`${bindings.*}` / `${secrets.*}` / `${installation.*}` を解決し、deploy request
build 後も installer-only placeholder が残る場合は kernel request
の前に失敗します。

このページの **deploy** は kernel `POST /v1/deployments` への apply
操作を指します。 **install** は Takosumi Accounts の AppInstallation ledger
lifecycle であり、 owner / billing / binding / grant / launch token
を扱います。kernel direct deploy は AppInstallation を作らない unmanaged
deployment です。

旧 `components` / `routes` / `bindings` / `publications` / `environments` /
`policy` AppSpec surface は current compiled Shape manifest ではありません。新規
docs / app は `apiVersion: "1.0"` + `kind: Manifest` + `resources[]` の Shape
model で書きます。旧語彙へのリンクは本ページ末尾の migration anchor に残して
います。

## Envelope

Takosumi v1 manifest は closed envelope です。top-level field は次の集合だけを
受理します。

```text
@context | apiVersion | kind | namespace | metadata | resources
```

`apiVersion` と `kind` は必須で、値は固定です。

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
  labels:
    tier: demo
resources: []
```

| field        | required | type                    | 説明                                                  |
| ------------ | -------- | ----------------------- | ----------------------------------------------------- |
| `@context`   | no       | string / object / array | JSON-LD tooling 用 hint。deploy decision には使わない |
| `apiVersion` | yes      | `"1.0"`                 | v1 manifest schema version                            |
| `kind`       | yes      | `"Manifest"`            | v1 manifest kind                                      |
| `namespace`  | no       | string                  | Space-scoped namespace hint                           |
| `metadata`   | no       | object                  | `name` / `labels` / kernel audit metadata             |
| `resources`  | no       | array                   | portable Shape resources                              |

`resources[]` が無い manifest、または resource が 0 件になる manifest は reject
されます。`template` は current kernel public contract ではありません。必要なら
installer/compiler layer が deploy 前に `resources[]` へ展開します。

## Canonical minimal manifest {#canonical-minimal-manifest}

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello-worker
resources:
  - shape: worker@v1
    name: web
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:0123456789abcdef
      compatibilityDate: "2026-05-09"
      routes:
        - hello.example.com/*
```

Container service の例:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: api
resources:
  - shape: database-postgres@v1
    name: db
    spec:
      version: "16"
      size: small

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate" # optional placement hint
    spec:
      image: ghcr.io/example/api@sha256:0123456789abcdef
      port: 8080
      scale: { min: 1, max: 3 }
      env:
        DATABASE_URL: ${ref:db.connectionString}
```

## Resources

`resources[]` の各 entry は `ManifestResource` です。

```ts
interface ManifestResource {
  readonly shape: string;
  readonly name: string;
  readonly provider?: string;
  readonly spec: JsonValue;
  readonly requires?: readonly string[];
  readonly metadata?: JsonObject;
}
```

| field      | required | 説明                                                             |
| ---------- | -------- | ---------------------------------------------------------------- |
| `shape`    | yes      | portable resource contract。例 `web-service@v1` / `worker@v1`    |
| `name`     | yes      | manifest 内で一意の resource 名                                  |
| `provider` | no       | optional provider placement hint。例 `@takos/cloudflare-workers` |
| `spec`     | yes      | shape 固有 spec。shape validator が検証する                      |
| `requires` | no       | provider capability requirement                                  |
| `metadata` | no       | resource-level metadata / audit pin                              |

`shape` が semantic contract です。`provider` は authoring intent / placement
hint であり、Shape-only model の必須 key ではありません。指定された場合は
catalog / provider registry に対する constraint として検証され、provider が
shape を実装して いない、または `requires[]` を満たせない場合は reject
されます。省略された場合は operator policy / provider registry が deploy plan
上の resolved provider を決め、 Deployment evidence に記録します。 provider
resolution の入力、出力、失敗条件、audit evidence は
[Provider Resolution](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/provider-resolution.md)
を参照してください。

`workflowRef` は takosumi-git の authoring extension です。kernel manifest
仕様の field ではありません。`.takosumi/manifest.yml` 内では resource
に併記できますが、`takosumi-git push` / `install apply` が workflow
を実行し、artifact URI を `workflowRef.target` (省略時 `spec.image`)
に書き込んでから `workflowRef` を strip します。kernel が受け取る manifest
resource entry に `workflowRef` は存在してはいけません。

worker bundle の authoring 例:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: docs
resources:
  - shape: worker@v1
    name: web
    spec:
      artifact:
        kind: js-bundle
        hash: PLACEHOLDER
      compatibilityDate: "2026-05-09"
    workflowRef:
      file: build.yml
      job: build-worker
      artifact: bundle
      target: spec.artifact.hash
```

## Resource references

kernel が解決する resource 間参照は `${ref:...}` と `${secret-ref:...}`
だけです。

| syntax                             | 意味                               |
| ---------------------------------- | ---------------------------------- |
| `${ref:<resource>.<field>}`        | non-secret output field を埋め込む |
| `${secret-ref:<resource>.<field>}` | secret reference URI を埋め込む    |

```yaml
resources:
  - shape: database-postgres@v1
    name: db
    spec: { version: "16", size: small }

  - shape: web-service@v1
    name: api
    spec:
      image: ghcr.io/example/api@sha256:0123456789abcdef
      port: 8080
      scale: { min: 1, max: 3 }
      env:
        DATABASE_URL: ${ref:db.connectionString}
        DB_PASSWORD: ${secret-ref:db.passwordSecretRef}
```

参照は dependency edge を作ります。kernel は cycle を reject し、topological
order で provider apply を実行します。

## Templates

`template` is not a current kernel manifest field. Historical clients used it as
an authoring macro, but current deploy callers must submit the expanded
`resources[]` form. New docs / apps should treat template expansion as an
installer/compiler concern, not as `POST /v1/deployments` input.

## Compile-time placeholders {#compile-time-placeholders}

Installable App Model の `.takosumi/manifest.yml` は、installer / account plane
が materialize する reserved placeholder syntax を持ちます。current
`takosumi-git install apply` は Takosumi Accounts が所有する AppInstallation の
materialization result で supported placeholder を解決し、deploy request build
後も installer-only placeholder が残っている場合は kernel request の前に reject
します。kernel に送る compiled Shape manifest には残してはいけません。

| installer-only family          | 解決元                                | 例                             |
| ------------------------------ | ------------------------------------- | ------------------------------ |
| `${params.<key>}`              | Install API request params            | `${params.domain}`             |
| `${installation.<key>}`        | AppInstallation record                | `${installation.id}`           |
| `${artifacts.<name>.<key>}`    | takosumi-git workflow artifact        | `${artifacts.api.image}`       |
| `${bindings.<name>.<key>}`     | AppBinding resolved config            | `${bindings.auth.clientId}`    |
| `${secrets.<name>.<key>}`      | AppBinding secret refs                | `${secrets.auth.clientSecret}` |
| `${refs.<name>.outputs.<key>}` | legacy Takos app compiler placeholder | `${refs.db.outputs.url}`       |

`${env.*}` は kernel resolver ではありません。使う場合は operator-owned manifest
generation で concrete value にしてから deploy します。

`${bindings.*}` is reserved for AppBinding materialization and must be absent
before the kernel sees the manifest. Current `takosumi-git` does not silently
substitute unresolved installer-only placeholders; it fails before
`POST /v1/deployments`.

## Removed service import fields {#cross-instance-imports}

`services[]` / `imports[]` / `serviceResolvers[]` /
`metadata.takosumiServiceImports` / `${imports.*}` placeholders are removed.
Current compiled Shape manifests express resources only as Shape declarations.

Operator-owned capabilities such as OIDC, billing, dashboard, and deploy API are
published through Space-visible namespace exports (for example
`operator.identity.oidc` and `operator.billing.default`) and consumed through
account API / OIDC / BillingPort contracts. The kernel does not fetch signed
service descriptors or resolve endpoint roles.

## Validation

主な reject 条件:

- `apiVersion` が `"1.0"` ではない、または `kind` が `Manifest` ではない
- unknown top-level field がある
- `resources[]` が array ではない
- resource entry に必須 field (`shape` / `name` / `spec`) の欠落がある
- `provider` hint が指定されているが、provider registry / `requires[]`
  constraint を満たせない
- resource entry に `workflowRef` など compiled Shape manifest では未知の field
  が残っている
- `services[]` / `imports[]` / `serviceResolvers[]` が top-level に残っている
- `${ref:...}` / `${secret-ref:...}` が存在しない resource output を参照する
- `${imports.*}` placeholder が残っていると reject

validation order は takosumi kernel の
[Core Contract v1.0](/reference/manifest-spec) に従います。

## Legacy routes anchor {#_3-routes}

旧 AppSpec の `routes[]` section は current `.takosumi/manifest.yml` から削除
されました。HTTP ingress / domain / worker route は shape の `spec` または
`custom-domain@v1` resource で表現します。old docs からこの anchor に来た場合
は、[Resources](#resources) と [Official Descriptor Set v1](/reference/shapes)
を参照してください。

## Legacy bindings anchor {#_5-bindings}

旧 AppSpec の `bindings[]` section は current compiled Shape manifest ではありま
せん。install-time binding は `.takosumi/app.yml` の `identity.oidc@v1` /
`database.postgres@v1` / `object-store.s3-compatible@v1` など 6 種で宣言します。
current `takosumi-git` は unresolved `${bindings.*}` / `${secrets.*}` を kernel
へ流さず、deploy request build 後も残る場合は kernel request
前に失敗します。kernel 内の resource 間配線は `${ref:...}` / `${secret-ref:...}`
を使います。operator / account plane dependency は namespace export と account
API / BillingPort で扱います。

## Legacy environment merge anchor {#_7-1-merge-rules}

旧 AppSpec の `environments.<env>` deep merge rule は current
`.takosumi/manifest.yml` の正本仕様ではありません。環境差分は distribution
profile、Install API params、または operator-owned manifest generation で扱い
ます。compiled Shape manifest は apply 時点で具体化された closed envelope です。

## Migration note

rejected legacy form:

```yaml
name: my-app
components:
  web:
    contracts:
      runtime:
        ref: runtime.js-worker@v1
routes:
  - id: ui
    expose: { component: web, contract: http }
```

current form:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: worker@v1
    name: web
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:0123456789abcdef
      compatibilityDate: "2026-05-09"
```

## Related

- [App YAML Spec](https://github.com/tako0614/takosumi-git/blob/master/docs/reference/app-yml-spec.md)
  — install metadata / AppBinding / permissions
- [Binding Catalog](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/binding-catalog.md)
  — 6 種の installer-bound AppBinding catalog
- [Service Identifier Spec](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/service-identifier-spec.md)
  — legacy link; current spec は namespace path / namespace export
- [Core Contract v1.0](/reference/manifest-spec) — kernel-side Deployment model
- [Kernel HTTP API](/reference/kernel-http-api) — `POST /v1/deployments`
