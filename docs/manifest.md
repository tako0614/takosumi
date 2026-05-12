# Manifest (Shape Model)

このページは **Shape + optional Provider hint** model における current kernel
manifest envelope の書き方をまとめます。 `resources[]` で portable な
[Shape](/reference/shapes) resource を declarative に並べ、`${ref:...}` syntax
で resource 間の output を配線します。top-level `template` は retired authoring
shorthand であり、current kernel public deploy API には渡しません。必要な
expansion は installer/compiler layer で済ませてから `POST /v1/deployments`
に送ります。

Takosumi v1 の manifest envelope は **closed shape** で、top-level は
`@context / apiVersion / kind / namespace / metadata / resources`
のみを受理します。 `@context` は optional な JSON-LD
context、`apiVersion: "1.0"` と `kind: Manifest` は固定値で、いずれも
required。未知の top-level field を含む manifest は kernel の schema phase で
reject されます ([Manifest Validation](/reference/manifest-validation))。
本ページと [Manifest Validation](/reference/manifest-validation) が v1 envelope
の canonical source です。

## Envelope 概観

```yaml
@context: "https://takosumi.com/contexts/manifest-v1.jsonld" # optional
apiVersion: "1.0" # required (kernel が validate する固定値)
kind: Manifest # required (上記同様、固定値)
metadata:
  name: my-app # 論理 app 名 (deployment record の name に使われる)
  labels: { tier: demo } # optional string labels
resources: # required: portable Shape resources
  - shape: object-store@v1
    name: assets
    provider: "@takos/cloudflare-r2"
    requires: [presigned-urls]
    spec: { name: app-assets }
```

`apiVersion` と `kind` は **required** で、値もそれぞれ `"1.0"` / `Manifest`
固定。これら 2 field を欠いた manifest は kernel (`POST /v1/deployments`) と CLI
local mode の両方で **400 / envelope rejected** されます。`1.0` は manifest
contract の major version です。

`@context` は manifest を JSON-LD document として扱うための optional field
です。 推奨値は `https://takosumi.com/contexts/manifest-v1.jsonld`。kernel は
`@context` を deploy decision の入力として解釈せず、descriptor closure 側の
JSON-LD と同じく external tooling / marketplace indexing / catalog publishing
のための semantic hint として保持します。

`template` を使う tool は kernel request 前に expanded `resources[]` へ compile
してください。kernel public contract は `resources[]` です。

`namespace` は manifest-local / Space-scoped namespace の hint です。
operator-owned capability (OIDC / billing / dashboard / deploy API など) は
manifest top-level field ではなく namespace export / account API で接続します。
kernel manifest には operator account-plane dependency を書きません。

## Project layout は `takosumi-git` の責務

Takosumi kernel / CLI は **manifest deploy engine 専念** の方針 (AGENTS.md)
で、`takosumi deploy <path>` には manifest path を必ず明示します。
`.takosumi/manifest.yml` のような repository-local project layout convention や
`.takosumi/workflows/` 配下の workflow definition は、kernel ではなく上位
sibling product [`takosumi-git`](https://github.com/tako0614/takosumi-git)
が提供します。 `takosumi-git` が git push / webhook を受けて build pipeline
を回し、生成した manifest を `POST /v1/deployments` (本 kernel) に投下します。

3rd party software が独自 UI を持つ場合も同じで、最終的に manifest body を
`POST /v1/deployments` に送ることで kernel と接続します。

## `resources[]` field

各 entry は contract の `ManifestResource`:

```ts
interface ManifestResource {
  readonly shape: string; // "object-store@v1" 等
  readonly name: string; // resource 論理名 (manifest scope)
  readonly provider?: string; // optional provider placement hint e.g. "@takos/aws-s3"
  readonly spec: JsonValue; // shape の Spec 型に validate される
  readonly requires?: readonly string[]; // capability requirement
  readonly metadata?: JsonObject;
}
```

- `name` は manifest 内で unique。`${ref:<name>.<field>}` で参照されます。
- `spec` は `<shape>.validateSpec` で validate (`shape: object-store@v1` なら
  `ObjectStoreShape.validateSpec`)。
- `provider` が指定された場合、その provider の `implements` が `shape`
  と一致しない と manifest reject。省略時は operator policy / provider registry
  が resolved provider を決め、Deployment evidence に記録する。

## `${ref:...}` / `${secret-ref:...}` syntax {#ref-syntax}

resource 間の配線は **string interpolation** で行います。kernel が DAG 解決後に
`RefResolver` で展開します。

```yaml
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    spec: { version: "16", size: small }

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:0123...
      port: 8080
      scale: { min: 1, max: 3 }
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
        DB_PASSWORD: ${secret-ref:db.passwordSecretRef}
```

Syntax 仕様 (cf.
[`manifest-resource.ts`](https://github.com/takos-jp/takosumi/blob/main/src/sdk/manifest.ts)
/ contract `parseRef` / `extractRefs`):

| 記法                           | 意味                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `${ref:<name>.<field>}`        | 別 resource の **non-secret** output field を埋め込む |
| `${secret-ref:<name>.<field>}` | secret reference URI (`secret://...`) を埋め込む      |

- `<name>` / `<field>` は `[A-Za-z_][\w-]*` パターン。
- `<field>` が当該 Shape の `outputFields` に含まれていなければ reject。
- 1 文字列内に複数 `${ref:...}` を混在可能。string concatenation 用途も OK。

## Capability `requires`

`resources[].requires` は **そのリソースに対する capability 要件** です。
provider が declare している `capabilities` が `requires` を superset で
満たさないと selection で reject されます。

```yaml
resources:
  - shape: object-store@v1
    name: assets
    provider: "@takos/cloudflare-r2"
    requires: [presigned-urls, multipart-upload] # 通る
    spec: { name: app-assets }

  - shape: object-store@v1
    name: archive
    provider: "@takos/cloudflare-r2"
    requires: [
      versioning,
    ] # cloudflare-r2 は versioning を declare していない → reject
    spec: { name: app-archive }
```

検証は contract `capabilitySubsetIssues(required, provided, path)` (cf.
[provider-plugin.ts](https://github.com/takos-jp/takosumi/blob/main/src/operator/client_registry.ts))
で行われます。

## DAG / topological apply order

`${ref:...}` は **依存 edge** を作ります。kernel は manifest を topological sort
して以下の順で adapter を呼びます:

1. **DAG build** — `extractRefsFromValue(spec)` で各 resource の参照先を抽出。
2. **Cycle detection** — 自己ループ / 相互参照を検出した場合は reject。
3. **Apply phase (topological order)** — 各 resource の resolved provider の
   `apply(spec, ctx)` を順に実行。 `ctx.refResolver.resolve(...)` は既に apply
   済み resource の outputs を 返します。
4. **Status phase** — apply 後に各 resource の `status(handle, ctx)` で確認。
5. **Rollback on failure** — apply phase で失敗した時点までに作られた resource
   は **逆順** に `destroy(handle, ctx)` されます (best effort)。
