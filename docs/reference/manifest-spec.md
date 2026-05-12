# マニフェストリファレンス

このページは takosumi kernel が受け取る **compiled manifest** の正本仕様です。
`.takosumi/manifest.yml` は `takosumi-git` が所有する authoring convention
であり、 kernel に届く前に compiled manifest へ変換されます。

| ファイル                 | 用途                                                                          | 渡し先                                   |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `.takosumi/app.yml`      | InstallableApp v1。install UI / binding / permission preview / upgrade policy | `takosumi-git` と operator account plane |
| `.takosumi/manifest.yml` | authoring compute manifest。Shape resource / compile-time extension           | takosumi-git / installer compiler        |
| compiled manifest        | closed Shape manifest。`workflowRef` / installer placeholder strip 済み       | takosumi kernel `POST /v1/deployments`   |

`.takosumi/app.yml` は kernel に渡しません。`.takosumi/manifest.yml` は
`takosumi-git` が compile し、`workflowRef` を strip します。`install apply`
では operator account plane が所有する AppInstallation の materialization result
で `${bindings.*}` / `${secrets.*}` / `${installation.*}` を解決し、deploy
request build 後も installer-only placeholder が残る場合は kernel request
の前に失敗します。

このページの **deploy** は kernel `POST /v1/deployments` への apply
操作を指します。 **install** は operator account plane の AppInstallation ledger
lifecycle であり、 owner / billing / binding / grant / launch token
を扱います。kernel direct deploy は AppInstallation を作らない unmanaged
deployment です。

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
| `resources`  | yes      | array                   | portable Shape resources                              |

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
[Provider Resolution](./provider-resolution.md) を参照してください。

### Workflow ref resolution {#workflow-ref}

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
`takosumi-git install apply` は operator account plane が所有する
AppInstallation の materialization result で supported placeholder
を解決し、deploy request build 後も installer-only placeholder
が残っている場合は kernel request の前に reject します。kernel に送る compiled
Shape manifest には残してはいけません。

| installer-only family       | 解決元                         | 例                             |
| --------------------------- | ------------------------------ | ------------------------------ |
| `${params.<key>}`           | Install API request params     | `${params.domain}`             |
| `${installation.<key>}`     | AppInstallation record         | `${installation.id}`           |
| `${artifacts.<name>.<key>}` | takosumi-git workflow artifact | `${artifacts.api.image}`       |
| `${bindings.<name>.<key>}`  | AppBinding resolved config     | `${bindings.auth.clientId}`    |
| `${secrets.<name>.<key>}`   | AppBinding secret refs         | `${secrets.auth.clientSecret}` |

`${env.*}` は kernel resolver ではありません。使う場合は operator-owned manifest
generation で concrete value にしてから deploy します。

`${bindings.*}` is reserved for AppBinding materialization and must be absent
before the kernel sees the manifest. Current `takosumi-git` does not silently
substitute unresolved installer-only placeholders; it fails before
`POST /v1/deployments`.

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
- `${ref:...}` / `${secret-ref:...}` が存在しない resource output を参照する

validation order は本ページの **Envelope** / **Resources** / **Compile-time
placeholders** section が正本です (kernel 実装は順に: envelope schema → resource
entry schema → unknown installer-only placeholder の reject → `${ref:...}` /
`${secret-ref:...}` resolution check)。
