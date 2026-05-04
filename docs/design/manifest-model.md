# Manifest Model

manifest model は、ユーザーが「何を作りたいか」と「どの provider family で実現
したいか」を宣言する authoring layer である。kernel の正本 state ではない。
manifest は compile され、descriptor closure、resolved graph、Deployment desired
state へ進む。

## Core Abstractions

```text
contract = 何を作るか
provider = どこでどう作るか
component = manifest 上の deploy / manage 単位
bundle = 複数 component を生成する authoring abstraction
plugin = contract / provider / bundle / connector の供給元
lock = plugin 解決結果の再現性境界
kernel = 解決、検証、plan/apply、state 管理
```

## Manifest Envelope

次期 canonical manifest は `schemaVersion` と `components[]` を持つ。

```yaml
schemaVersion: 1

plugins:
  - id: takosumi/docker
    source: git+https://github.com/takos/takosumi-plugin-docker
    version: v1.0.0

components:
  - name: app
    contract: web-service@v1
    provider: takosumi/docker
    spec:
      image: ghcr.io/example/app:latest
      port: 3000

  - name: db
    contract: postgres@v1
    provider: takosumi/docker
    spec:
      version: "16"
      storage:
        size: 10Gi
```

`apiVersion` / `kind` / `resources[]` / `template:` は現行 shape model の
authoring surface であり、次期 canonical authoring では `schemaVersion` /
`components[]` / `use` / `with` へ寄せる。

## Component

`component` は manifest 上の基本 deploy / manage 単位である。compute に限定し
ない。

component として扱う例:

- web service
- worker
- container
- VM
- database
- object storage
- queue
- secret store
- DNS record
- custom domain
- TLS endpoint
- Kubernetes namespace
- systemd service
- docker compose stack
- Cloudflare Worker
- AWS ECS service
- runtime-agent connector

concrete component は `contract + provider + spec` で表す。

```yaml
components:
  - name: assets
    contract: object-store@v1
    provider: takosumi/cloudflare-r2
    spec:
      bucket: my-assets
      public: false
```

`name` は manifest 内の論理名、`contract` は plugin-defined contract、
`provider` はその contract を実装する concrete provider、`spec` は desired state
である。

## Contract

`contract` は「何を作るか」を表す。core は contract の意味を固定しない。
contract metadata を読み、validation、DAG、plan、provider selection に使う。

contract が持つべき情報:

- id / version
- spec schema
- output schema
- capability model
- reference validation rule
- lifecycle expectations
- secret output policy
- provider compatibility requirements

例:

```text
web-service@v1
postgres@v1
object-store@v1
custom-domain@v1
worker@v1
queue@v1
secret-store@v1
```

## Provider

`provider` は「どこでどう作るか」を表す。provider はできるだけ具体的にする。
`aws` のような巨大 provider より、`aws-s3` / `aws-rds` / `aws-ecs` のように
lifecycle と credential boundary が明確な単位を優先する。

provider が持つべき情報:

- id / version
- supported contracts
- provider capabilities
- plan / apply / destroy / status implementation
- credential boundary
- runtime-agent connector requirement

例:

```text
takosumi/docker
takosumi/docker-compose
takosumi/systemd
takosumi/kubernetes
takosumi/aws-ecs
takosumi/aws-rds
takosumi/aws-s3
takosumi/cloudflare-workers
takosumi/cloudflare-r2
takosumi/gcp-cloud-run
takosumi/azure-container-apps
```

## Bundle

`bundle` は「複数 component を束ね、provider 差し替えで deploy しやすくする」
ための plugin-defined authoring abstraction である。bundle 自体は lifecycle
target ではない。plan 時に concrete components へ展開する。

```yaml
components:
  - name: my-app
    use: web-stack@v1
    with:
      image: ghcr.io/example/app:latest
      domain: app.example.com
      providers:
        app: takosumi/aws-ecs
        database: takosumi/aws-rds
        assets: takosumi/aws-s3
```

conceptual expansion:

```yaml
components:
  - name: my-app.app
    contract: web-service@v1
    provider: takosumi/aws-ecs

  - name: my-app.database
    contract: postgres@v1
    provider: takosumi/aws-rds

  - name: my-app.assets
    contract: object-store@v1
    provider: takosumi/aws-s3
```

provider selection rule:

- `with.providers` に明示された provider を最優先する。
- bundle default provider は明示 provider がない場合だけ使う。
- plan output には最終的に選ばれた provider を必ず表示する。
- apply は expanded concrete components に対して行う。

## Plugin Dependency

manifest には plugin dependency を書ける。

```yaml
plugins:
  - id: takosumi/cloudflare
    source: git+https://github.com/takos/takosumi-plugin-cloudflare
    version: v1.2.0
```

plugin は以下を定義できる。

| Definition  | Role                                 |
| ----------- | ------------------------------------ |
| `contract`  | component の抽象仕様                 |
| `provider`  | contract の concrete implementation  |
| `bundle`    | component 群の生成定義               |
| `connector` | runtime-agent / external system 境界 |

plugin source は任意 URL / Git を許可する。ただし production apply は lock 済み
plugin だけを対象にする。

## Lock File

`takosumi.lock` は manifest とは分離する。役割は plugin source の解決結果を固定
し、Git commit / tarball digest / integrity hash を保存し、CI / production の
再現性を保証することである。

```yaml
schemaVersion: 1

plugins:
  - id: takosumi/cloudflare
    source: git+https://github.com/takos/takosumi-plugin-cloudflare
    version: v1.2.0
    resolved: git+https://github.com/takos/takosumi-plugin-cloudflare#abc123
    integrity: sha256-...
```

未確定なのは deploy manifest plugin の trust policy である。現時点の推奨は
`lock + capability`。自由度を保ちつつ、plugin が必要権限を宣言し、operator
policy が production 実行を制御できるためである。

## References

component 間の値参照は manifest 内で明示する。現時点の推奨は現行 ref 構文の
維持である。

```yaml
components:
  - name: db
    contract: postgres@v1
    provider: takosumi/aws-rds
    spec:
      version: "16"

  - name: app
    contract: web-service@v1
    provider: takosumi/aws-ecs
    spec:
      image: ghcr.io/example/app:latest
      env:
        DATABASE_URL: ${secret-ref:db.connectionString}
```

推奨理由:

- 既存実装資産を活かせる。
- YAML 内で書きやすい。
- DAG edge を抽出しやすい。
- secret と non-secret の境界が明示される。

将来候補として、`${components.db.outputs.connectionString}` のような式構文や
`valueFrom` のような構造化参照は残す。ただし初期 canonical には入れない。

## Compile Target

次期 `components[]` manifest は、直接 `Deployment` を作らない。まず `AppSpec` /
`CoreAppSpec` 相当へ compile し、その後 descriptor closure と resolved graph
を経由して `Deployment.desired` を作る。この経路にすると、既存の policy
decision、binding resolver、route resolver、activation envelope を再利用
できる。

source:

- `packages/kernel/src/domains/deploy/types.ts`
- `packages/kernel/src/domains/deploy/compiler.ts`
- `packages/kernel/src/domains/deploy/descriptor_closure.ts`
- `packages/kernel/src/domains/deploy/resolved_graph.ts`
