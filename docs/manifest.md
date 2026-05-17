# Manifest (Shape Model)

> このページでわかること: Takosumi kernel manifest の書き方と resources[]
> の構造。

`resources[]` に portable な [Shape](/reference/shapes) resource
を並べ、`${ref:...}` で配線する。 authoring shorthand は installer/compiler
layer で展開してから `POST /v1/deployments` に送る。

Takosumi v1 の envelope は **closed shape**。 top-level は
`@context / apiVersion / kind / namespace / metadata / resources` のみ受理し、
未知 field を含む manifest は schema phase で reject される。 詳細仕様は
[Manifest Validation](/reference/manifest-validation) と本ページが canonical
source。

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

### Required field

- `apiVersion` は `"1.0"` 固定。欠けると kernel / CLI local mode の両方で **400
  / envelope rejected**。
- `kind` は `Manifest` 固定。
- `1.0` は manifest contract の major version。

### Optional field

- `@context` は JSON-LD document として扱うための semantic hint。推奨値は
  `https://takosumi.com/contexts/manifest-v1.jsonld`。kernel は deploy decision
  には使わず、 external tooling / marketplace indexing 用に保持する。
- `namespace` は manifest-local / Space-scoped namespace の hint。
- `template` を使う tool は kernel request 前に expanded `resources[]` へ
  compile すること。kernel public contract は `resources[]`。

operator-owned capability (OIDC / billing / dashboard / deploy API 等) は
manifest top-level field ではなく namespace export / account API で接続する。

## Project layout は `takosumi-git` の責務

Takosumi kernel / CLI は **manifest deploy engine 専念** の方針で、
`takosumi deploy <path>` には manifest path を必ず明示する。
`.takosumi/manifest.yml` / `.takosumi/workflows/` 等の repository-local
convention は sibling product
[`takosumi-git`](https://github.com/tako0614/takosumi-git) が提供する。

3rd party software が独自 UI を持つ場合も、 最終的に manifest body を
`POST /v1/deployments` に送って kernel と接続する。

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

- `name` は manifest 内で unique。`${ref:<name>.<field>}` で参照される。
- `spec` は `<shape>.validateSpec` で validate される (`shape: object-store@v1`
  なら `ObjectStoreShape.validateSpec`)。
- `provider` 指定時、その provider の `implements` が `shape` と不一致なら
  reject。省略時は operator policy / provider registry が resolved provider
  を決定し、Deployment evidence に記録する。

## `${ref:...}` / `${secret-ref:...}` syntax {#ref-syntax}

resource 間の配線は string interpolation。 kernel は DAG 解決後に `RefResolver`
で展開する。

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

| 記法                           | 意味                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `${ref:<name>.<field>}`        | 別 resource の **non-secret** output field を埋め込む |
| `${secret-ref:<name>.<field>}` | secret reference URI (`secret://...`) を埋め込む      |

- `<name>` / `<field>` は `[A-Za-z_][\w-]*` パターン。
- `<field>` が当該 Shape の `outputFields` に無ければ reject。
- 1 文字列内に複数 `${ref:...}` を混在可能 (string concatenation 用途も OK)。

仕様 source は
[`manifest-resource.ts`](https://github.com/takos-jp/takosumi/blob/main/src/sdk/manifest.ts)
/ contract `parseRef` / `extractRefs`。

## Capability `requires`

`resources[].requires` はそのリソースに対する capability 要件。 provider の
`capabilities` が `requires` の superset を満たさないと selection で reject
される。

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
[provider-plugin.ts](https://github.com/takos-jp/takosumi/blob/main/src/operator/client_registry.ts))。

## DAG / topological apply order {#dag}

`${ref:...}` は依存 edge を作る。 kernel は manifest を topological sort
して以下の順で adapter を呼ぶ:

1. **DAG build** — `extractRefsFromValue(spec)` で各 resource の参照先を抽出。
2. **Cycle detection** — 自己ループ / 相互参照を検出した場合は reject。
3. **Apply phase (topological order)** — 各 resource の resolved provider の
   `apply(spec, ctx)` を順に実行。 `ctx.refResolver.resolve(...)` は既に apply
   済み resource の outputs を返す。
4. **Status phase** — apply 後に各 resource の `status(handle, ctx)` で確認。
5. **Rollback on failure** — apply phase で失敗した時点までに作られた resource
   は逆順に `destroy(handle, ctx)` される (best effort)。
