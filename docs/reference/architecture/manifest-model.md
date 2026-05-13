# Manifest Model

> このページでわかること: manifest のデータモデルと resource graph の構造。

manifest は closed な deploy surface である。desired な portable resource を
宣言するもので、canonical state ではない。Space、tenant、actor、catalog
release、 policy、quota、credential、approval、journal
state、observation、GroupHead は manifest ではなく deploy context
から供給される。

Public v1 は `POST /v1/deployments` と `takosumi deploy` が実装する **Shape +
Provider** manifest モデルである。Authoring 用の shorthand は installer /
compiler 層に属し、kernel に届く前に展開される。

## Allowed Public Fields

Root fields:

```text
apiVersion
kind
metadata
resources
```

`apiVersion` は必須で `"1.0"` に固定。`kind` は必須で `Manifest` に固定。未知の
top-level field は schema validation で失敗する。警告ではない。

`metadata` fields:

```text
name
labels
```

`resources[]` entry fields:

```text
shape
name
provider
spec
requires
metadata
```

`spec` は target shape 固有で、選ばれた Shape の `validateSpec` で validate
される。`spec` の外側の未知 envelope field は validation で失敗する。

## Space Context

`Space` は manifest の外にある。同じ manifest が異なる Space で異なる resolve
結果になることがある。namespace path、catalog release 選択、policy、secret、
artifact、approval、journal、observation、GroupHead は Space scope である。

```text
manifest + space:acme-prod -> production catalog / policy / quotas
manifest + space:acme-dev  -> development catalog / policy / quotas
```

public manifest は `space`、`tenant`、`org`、credential、namespace registry の
構成 field を含んではならない。これらは deployment context / operator 設定で
あり、authoring intent ではない。

## Resources

各 `resources[]` entry は 1 つの portable Shape resource を宣言する。

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    requires: [automated-backups]
    spec:
      version: "16"
      size: small

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:...
      port: 8080
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
```

規則:

- `shape` は portable contract を指す (`web-service@v1`、
  `database-postgres@v1`、`object-store@v1` 等)。
- `provider` はその Shape に対して選ばれた implementation を指す
  (`@takos/aws-fargate`、`@takos/cloudflare-workers`、自前 provider など)。
- `name` は manifest 内の resource identity で、`${ref:<name>.<field>}` の
  source namespace でもある。
- `requires` は capability の subset 要件である。provider の capability が
  superset でなければ validation はその resource を reject する。

## Templates

top-level の `template` は kernel manifest の field ではない。authoring macro
として template を使う場合は、`POST /v1/deployments` に到達する前に展開された
`resources[]` 形に変換しておく必要がある。operator が template / compiler 層
を保持する場合、それは `POST /v1/deployments` の前に走らせる。

## References

`spec` 値は reference token を使える。

```text
${ref:<resource>.<field>}
${secret-ref:<resource>.<field>}
```

参照は resource 間に依存 edge を作る。kernel は文法を validate し、DAG を構築
し、循環を reject し、トポロジカル順序で resource を適用する。`secret-ref` は
secret-reference output 用で、プレーン output には使ってはならない。

## Data Inputs

artifact は top-level manifest の authority ではない。Shape `spec` の入力値で
あり、Shape / provider contract と artifact policy に従う。

```yaml
resources:
  - shape: worker@v1
    name: worker
    provider: "@takos/cloudflare-workers"
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
```

ローカル path は未解決の authoring 入力である。remote kernel が apply する前に
content-addressed な artifact record にしておく必要がある。

## Manifest to Intent Graph

```text
metadata.name:
  Deployment record name inside the deploy context's Space

resources[].shape:
  Portable Shape contract intent

resources[].provider:
  Provider implementation selection intent

resources[].spec:
  Shape-specific desired input

resources[].requires:
  Capability constraint on provider selection

${ref:...} / ${secret-ref:...}:
  Link / dependency intent between resource outputs and inputs
```

OperationPlan と write-ahead journal のアーキテクチャはこの intent graph から
導出される。public deploy route では、`mode: "plan"` は journal を書かずに
決定的な OperationPlan preview (DesiredSnapshot digest、OperationPlan digest、
計画 operation、WAL idempotency tuple preview) を出す。`mode: "apply"` /
`mode: "destroy"` は内部で同じ public OperationPlan shape を導出し、public WAL
stage record を `takosumi_operation_journal_entries` に書く。永続化された public
deployment record は依然として `takosumi status` と destroy handle 解決で使う
互換ステータス / handle state を保持する。public recovery は現在、副作用なしの
`inspect`、same-digest を保証する `continue`、`activation-rollback` RevokeDebt
を open する `compensate` を支援する。Connector-native compensate は destroy
fallback と共に runtime-agent protocol で公開され、CatalogRelease の adopt /
署名検証は registry domain に実装されている。public apply / destroy WAL は adopt
済 release を fail-closed な pre/post-commit verification step として
呼び出す。catalog 宣言の実行可能 hook package、manual reopen、clearance、
connector backed cleanup、worker daemon スケジューリングは lifecycle primitive
として実装される。
