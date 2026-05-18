# Manifest Model

> このページでわかること: AppSpec (= `.takosumi.yml`) のデータモデルと component
> graph の構造、 AppSpec → Installation → Deployment の lifecycle。

AppSpec は closed な install surface である。 desired な portable component を
宣言するもので、 canonical state ではない。 Space、 actor、 catalog release、
policy、 quota、 credential、 approval、 journal state、 observation は AppSpec
ではなく install context から供給される。

Public v1 は `POST /v1/installations` 系 5 endpoint と `takosumi install` CLI が
実装する **Component + Kind** AppSpec モデルである。 authoring shorthand や
runtime 中間形式は存在せず、 kernel が読むのは `.takosumi.yml` そのものである。

## Allowed Public Fields

Root fields:

```text
apiVersion
kind
metadata
components
interfaces
permissions
```

`apiVersion` は必須で `"takosumi.dev/v1"` に固定。 `kind` は必須で `"App"` に
固定。 未知の top-level field は schema validation で失敗する (= warning
ではない)。

`metadata` fields:

```text
id
name
description
publisher
homepage
```

`components` の各 entry fields:

```text
kind | build | use | routes | spec | redirectPaths | scopes | name | target
```

`build` は AppSpec が許可する **唯一の build 概念** で、 `{ command, output }`
の最小 recipe のみ表現できる。 jobs / steps / matrix / triggers / pipeline は
持たない (= CI workflow ではない)。

`use` は component 間の構造的依存 edge。 文字列 interpolation (`${ref:...}` /
`${secret-ref:...}` / `${bindings.*}` 等) は v1 AppSpec では 廃止された。

## Space Context

`Space` は AppSpec の外にある。 同じ AppSpec が異なる Space で異なる resolve
結果になることがある。 namespace path、 catalog release 選択、 policy、 secret、
artifact、 approval、 journal、 observation は Space scope である。

```text
appspec + space:acme-prod -> production catalog / policy / quotas
appspec + space:acme-dev  -> development catalog / policy / quotas
```

public AppSpec は `space` / `tenant` / `org` / credential / namespace registry
の 構成 field を含んではならない。 これらは Installation context / operator 設定
であり、 authoring intent ではない。

## Components

各 `components` entry は 1 つの portable Component を宣言する。

```yaml
apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      class: standard
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - /
    use:
      db:
        env: DATABASE_URL
```

`kind` が semantic contract。 catalog 5 種いずれか。 provider plugin が apply
時に `kind` を解決する。 provider 選択 / 配置 / placement は AppSpec ではなく
operator policy / Space context が決める。

各 component の output (= apply 後の値) は kernel が persist し、 `use:` edge
が解決して依存 component に inject する。

## Use Edge Resolution

`use:` は component を node、 edge を依存関係とする DAG を作る。

```text
web --use:db--> db
web --use:auth-> auth
web --use:media-> media
```

kernel は cycle を reject し、 topological order で provider apply を実行する。
cycle 検出は graph DFS。

各 edge の semantics:

| sub-key     | 解決                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `env`       | 依存先 connection string / primary output を単一 env var に inject    |
| `envPrefix` | 依存先の全 output field を `${PREFIX}_*` で env に展開                |
| `mount`     | reserved mount point (例: `oidc`) に bind し、 関連 env 一式を inject |

## Installation lifecycle

AppSpec は唯一の入力。 そこから kernel が次の 3 段階を実行する。

```text
AppSpec (.takosumi.yml)
   ↓ POST /v1/installations
Installation (account + space + appId + currentDeployment + status)
   ↓ POST /v1/installations/{id}/deployments
Deployment (source.commit + manifestDigest + outputs + status + timestamps)
```

`Installation` は 1 つの Space に対して 1 つの App が入っている状態を表す。 所有
/ 課金 / 権限 / 現在状態の単位。

`Deployment` は 1 回の apply 結果。 source.commit、 manifestDigest、 component
ごとの build artifact、 provider が作った resource id を記録する。 履歴 / audit
/ rollback の単位。

## Provider Resolution

各 component の `kind` は provider plugin が materialize する。 provider 選択は
Space に bind された CatalogRelease に従う。

Provider responsibilities:

- `kind` 固有の input spec を validate
- target runtime (Cloudflare Workers / Node + Postgres / AWS Fargate 等) に
  対する provider operation を生成
- apply 後の output fields (`url` / `connectionString` / `bucket` 等) を返す

詳細: [Provider Resolution](../provider-resolution.md)。

## 削除された旧概念

| 旧概念                               | 新位置                                  |
| ------------------------------------ | --------------------------------------- |
| `.takosumi/app.yml` + `manifest.yml` | `.takosumi.yml` 1 file に統合           |
| `.takosumi/workflows/*`              | 廃止                                    |
| authoring/runtime 中間 manifest      | 単一 AppSpec モデル、 compile step なし |
| retired authoring extension          | `component.build` の最小 recipe         |
| `${ref:...}` / `${secret-ref:...}`   | `use:` edge                             |
| `${bindings.*}` / `${secrets.*}`     | `use:` edge                             |
| Plan / Snapshot / Preview entity     | dry-run response (entity 化されない)    |
| DeploymentPlan / DeploymentSnapshot  | Deployment record の outputs に統合     |

## 関連ページ

- [AppSpec](../app-spec.md)
- [Component Kind Catalog](../component-kind-catalog.md)
- [Installer API](../installer-api.md)
- [Architecture: Kernel](./kernel.md)
- [Provider Resolution](../provider-resolution.md)
