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
kind | spec | build | publish | listen
```

`kind` は **短い alias** (= `worker`) または **完全な JSON-LD URI**
(= `https://takosumi.com/kinds/v1/worker`) の文字列。 alias は対応 JSON-LD の
`aliases[]` に登録された名前のみ受理し、 parse 段階で full URI に正規化する。

`build` は AppSpec が許可する **唯一の build 概念** で、 `{ command, output }`
の最小 recipe のみ表現できる。 jobs / steps / matrix / triggers / pipeline は
持たない (= CI workflow ではない)。

`publish` / `listen` は component 間接続の **唯一の表現** である。 `use:` edge
と文字列 interpolation (`${ref:...}` / `${secret-ref:...}` / `${bindings.*}`
等) は v1 AppSpec では廃止された。

## Space Context

`Space` は AppSpec の外にある。 同じ AppSpec が異なる Space で異なる resolve
結果になることがある。 namespace path、 catalog release 選択、 policy、 secret、
artifact、 approval、 journal、 observation は Space scope である。

```text
appspec + space:acme-prod -> production catalog / policy / quotas
appspec + space:acme-dev  -> development catalog / policy / quotas
```

public AppSpec は `space` / `tenant` / `org` / credential / namespace registry
の構成 field を含んではならない。 これらは Installation context / operator 設定
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
      version: "16"
      size: small
    publish:
      - com.example.notes.db

  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes: [/]
    listen:
      com.example.notes.db:
        as: env
        prefix: DB_
```

`kind` が semantic contract。 短 alias または完全 URI のいずれでもよい。
**materializer (= 実装層)** は operator 側 `createPaaSApp({ materializers: [...] })`
config で渡され、 manifest には現れない。 同じ kind URI に複数の materializer
実装が存在しうる (= Cloudflare 実装 / AWS Fargate 実装等)、 operator が 1 つを
選ぶ。 provider 選択 / 配置 / placement は AppSpec ではなく operator policy /
Space context が決める。

各 component の output (= apply 後の値) は kernel が persist し、 publish 宣言
された namespace path に material として register される。

## Namespace Pub/Sub Graph

`publish` / `listen` は component を node、 namespace path を edge label と
する DAG を作る。

```text
db ─publish─> com.example.notes.db ─listen──> web
media ─publish─> com.example.notes.media ─listen──> web
operator.identity.oidc ─(takosumi-cloud publish)──> web (listen)
```

kernel は publish → listen 解決時に cycle を reject し、 topological order で
materializer apply を実行する。 cycle 検出は graph DFS。

各 listen entry の semantics:

| sub-key  | 解決                                                                  |
| -------- | --------------------------------------------------------------------- |
| `as`     | listen shape (= `env` / `target` / `mount` 等、 kind JSON-LD 規定) |
| `prefix` | `as: env` で各 material field を `${PREFIX}_*` env var に展開      |
| `mount`  | kind 固有 anchor name (= 意味的 mount point)                       |

**Auto-namespacing**: component が `publish` を省略すると、 kernel が
`<app-id>.<component-name>` を自動 publish する。 sibling component の参照は
この path を `listen` するだけで完結する。

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
ごとの build artifact、 materializer が作った resource id を記録する。 履歴 /
audit / rollback の単位。

## Materializer Resolution

各 component の `kind` は **materializer** (= 実装層) が解決する。 materializer
は kind URI の registry に登録され、 operator が任意の形態 (= plugin object /
inline function / 別 package import) で提供する。 manifest 側からは特定 impl
を指定しない。

Materializer responsibilities:

- `kind` 固有の input spec を validate
- target runtime (Cloudflare Workers / Kubernetes / AWS Fargate 等) に
  対する provision を生成
- apply 後の output fields (`url` / `connectionString` / `bucket` 等) を返す
- kind JSON-LD が宣言した `publishes[]` material を namespace registry に
  register する

詳細: [Provider Resolution](../provider-resolution.md)。

## 削除された旧概念

| 旧概念                               | 新位置                                  |
| ------------------------------------ | --------------------------------------- |
| `.takosumi/app.yml` + `manifest.yml` | `.takosumi.yml` 1 file に統合           |
| `.takosumi/workflows/*`              | 廃止                                    |
| authoring/runtime 中間 manifest      | 単一 AppSpec モデル、 compile step なし |
| retired authoring extension          | `component.build` の最小 recipe         |
| `${ref:...}` / `${secret-ref:...}`   | `publish` / `listen`                    |
| `${bindings.*}` / `${secrets.*}`     | `publish` / `listen`                    |
| `use:` edge                          | `publish` / `listen` に統合             |
| `kind: oidc`                         | takosumi-cloud の OIDC namespace publish |
| `plugin:` in manifest                | materializer は operator config 側      |
| Plan / Snapshot / Preview entity     | dry-run response (entity 化されない)    |
| DeploymentPlan / DeploymentSnapshot  | Deployment record の outputs に統合     |

## 関連ページ

- [AppSpec](../app-spec.md)
- [Component Kind Catalog](../component-kind-catalog.md)
- [Installer API](../installer-api.md)
- [Architecture: Kernel](./kernel.md)
- [Provider Resolution](../provider-resolution.md)
