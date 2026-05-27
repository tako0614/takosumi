# 内部設計の概要 {#architecture-overview}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

この directory は Takosumi / operator implementation author 向けです。manifest author は [コンセプト](../../getting-started/concepts.md) と [manifest](../manifest.md) を先に読む。

```text
author / operator:
  source root or prepared source archive (including .takosumi.yml manifest)
    -> Installer API
    -> Installation / Deployment record

runtime request:
  client -> backend-native listener/route -> workload
         <- same backend data plane <- response
```

Takosumi API process は install / deploy / rollback の control plane であり、通常の runtime request data plane ではありません。以下の internal snapshots は apply 時に deploy record と activation intent を作るための構造です。

```text
manifest + Space context
  -> ResolvedPlan
  -> TargetState
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> execution binding / runtime-agent operation
  -> TrafficSnapshot / RoutingPointer
  -> ObservationState / DriftIndex / CleanupBacklog
```

Activation は apply 時の切り替えであり、現在の runtime target を選択する。Observation record と drift record は activation 後も保持される。pre-activation health check は activation step の前に使われる backend/runtime evidence である。

## Public Manifest vocabulary {#public-appspec-vocabulary}

manifest root: `apiVersion` / `metadata.id` / `metadata.name` / `components` / optional root `publish`。

component の公開 field は `kind`、`spec`、`connect`、`listen` です。root `publish` は Installation output service path declaration を記録します。 entrypoint、image、gateway route などの詳細は kind の `spec` または operator が提供する kind の定義に置きます。execution binding は manifest の外で operator が選びます。Takosumi 固有の release bundle や backend target list はありません。

## 読む順序 {#reading-order}

| Doc                                                           | Question                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| [Kernel](./kernel.md)                                         | Takosumi と operator / application の責務境界はどこか。       |
| [Object Model](./object-model.md)                             | Takosumi が扱う object の lifecycle class と revoke flow。    |
| [Snapshot Model](./snapshot-model.md)                         | snapshot 体系と各 snapshot の役割。                           |
| [Space Model](./space-model.md)                               | Space scope で何が分離されるか。                              |
| [Deploy System](./deploy-system.md)                           | Installation / Deployment lifecycle はどう進むか。            |
| [Kind Resolution Model](./kind-resolution-model.md)           | kind alias / binding / connector 解決はどう決まるか。         |
| [Platform Service Model](./platform-service-model.md)         | component outputs と platform service path はどう扱われるか。 |
| [バインディングモデル](./binding-model.md)                    | connect/listen は runtime binding にどう変換されるか。        |
| [Runtime Deployment](./runtime-deployment-model.md)           | snapshot と WAL は何を保証するか。                            |
| [Execution Lifecycle](./execution-lifecycle.md)               | Preview / Apply / Activate / Destroy の各 phase。             |
| [承認モデル](./approval-model.md)                             | risk 評価と approval flow はどう進むか。                      |
| [Runtime Routing](./runtime-routing.md)                       | apply 後に request がどこに届くか。                           |
| [Runtime-Agent 境界](./runtime-agent-boundary.md)             | Takosumi と runtime-agent の境界はどこか。                    |
| [API Surface](./api-surface-architecture.md)                  | public / internal / runtime-agent の surface 分割。           |
| [CLI Surface](./cli-companion-architecture-note.md)           | CLI の設計方針と Takosumi API との関係。                      |
| [Operator Boundaries](./operator-boundaries.md)               | operator が選ぶものと Takosumi が固定するものは何か。         |
| [公式型カタログモデル](./kind-catalog.md)                     | descriptor を operator がどう取り込むか。                     |
| [Workflow Placement](./workflow-extension-design.md)          | workflow / scheduler をどこに置くか。                         |
| [Operational Hardening](./operational-hardening-checklist.md) | production readiness の normative checklist。                 |
| [イングレスルーティング](./ingress-routing.md)                | public ingress の activation と health state の追跡。         |

## Docs boundary {#docs-boundary}

Operator account layer の architecture は `takosumi-cloud/` 側の docs に分かれます。
