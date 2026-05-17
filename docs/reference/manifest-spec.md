# マニフェストリファレンス

> このページでわかること: kernel が受け取る compiled manifest の全 field 仕様。

`.takosumi/manifest.yml` は `takosumi-git` 所有の authoring convention で、
kernel に届く前に compiled manifest に変換されます。

| ファイル                 | 用途                                                                          | 渡し先                                   |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `.takosumi/app.yml`      | InstallableApp v1。install UI / binding / permission preview / upgrade policy | `takosumi-git` と operator account plane |
| `.takosumi/manifest.yml` | authoring compute manifest。Shape resource / compile-time extension           | takosumi-git / installer compiler        |
| compiled manifest        | closed Shape manifest。`workflowRef` / installer placeholder strip 済み       | takosumi kernel `POST /v1/deployments`   |

`.takosumi/app.yml` は kernel に渡しません。 `.takosumi/manifest.yml` は
`takosumi-git` が compile して `workflowRef` を strip します。 `install apply`
では operator account plane 所有の AppInstallation の materialization result で
`${bindings.*}` / `${secrets.*}` / `${installation.*}` を解決し、 deploy request
build 後に installer-only placeholder が残れば kernel request 前に失敗します。

用語: 本ページの **deploy** は kernel `POST /v1/deployments` への apply 操作。
**install** は operator account plane の AppInstallation ledger lifecycle で、
owner / billing / binding / grant / launch token を扱います。 kernel direct
deploy は AppInstallation を作らない unmanaged deployment です。

## Envelope

closed envelope。 top-level field は次の集合のみ受理:

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

`resources[]` 不在 / 0 件は reject。 `template` は current kernel public
contract ではありません。 必要なら installer/compiler 層が deploy 前に
`resources[]` に展開します。

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

`shape` が semantic contract。 `provider` は authoring intent / placement hint
で Shape-only model の必須 key ではありません。 指定時は catalog / provider
registry に対する constraint として検証され、 provider が shape 未実装 /
`requires[]` 未充足なら reject。 省略時は operator policy / provider registry が
resolved provider を決め Deployment evidence に記録します。 入力 / 出力 /
失敗条件 / audit evidence は [Provider Resolution](./provider-resolution.md)
参照。

### Workflow ref resolution {#workflow-ref}

`workflowRef` は takosumi-git の authoring extension で kernel manifest 仕様 の
field ではありません。 `.takosumi/manifest.yml` 内では resource に併記でき
ますが、 `takosumi-git push` / `install apply` が workflow を実行し、 artifact
URI を `workflowRef.target` (省略時 `spec.image`) に書込んでから `workflowRef`
を strip します。 kernel が受け取る manifest resource entry に `workflowRef`
が存在してはいけません。

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

参照は dependency edge を作ります。 kernel は cycle を reject し、 topological
order で provider apply を実行します。

## Templates

`template` is not a current kernel manifest field. Historical clients used it as
an authoring macro, but current deploy callers must submit the expanded
`resources[]` form. New docs / apps should treat template expansion as an
installer/compiler concern, not as `POST /v1/deployments` input.

## Compile-time placeholders {#compile-time-placeholders}

Installable App Model の `.takosumi/manifest.yml` は installer / account plane
が materialize する reserved placeholder syntax を持ちます。
`takosumi-git
install apply` は AppInstallation の materialization result
で解決し、 deploy request build 後も installer-only placeholder が残れば kernel
request 前に reject します。 kernel に送る compiled Shape manifest
には残してはいけません。

| installer-only family       | 解決元                         | 例                             |
| --------------------------- | ------------------------------ | ------------------------------ |
| `${params.<key>}`           | Install API request params     | `${params.domain}`             |
| `${installation.<key>}`     | AppInstallation record         | `${installation.id}`           |
| `${artifacts.<name>.<key>}` | takosumi-git workflow artifact | `${artifacts.api.image}`       |
| `${bindings.<name>.<key>}`  | AppBinding resolved config     | `${bindings.auth.clientId}`    |
| `${secrets.<name>.<key>}`   | AppBinding secret refs         | `${secrets.auth.clientSecret}` |

`${env.*}` は kernel resolver ではありません。 使うなら operator-owned manifest
generation で concrete value 化してから deploy します。

`${bindings.*}` は AppBinding materialization 用予約で、 kernel が manifest を
見る前に absent でなければなりません。 `takosumi-git` は unresolved
installer-only placeholder を silent 置換せず、 `POST /v1/deployments` 前に fail
します。

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
placeholders** section に従います (kernel 実装は: envelope schema → resource
entry schema → unknown installer-only placeholder reject → `${ref:...}` /
`${secret-ref:...}` resolution check の順)。
