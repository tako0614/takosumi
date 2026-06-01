# 内部設計の概要 {#architecture-overview}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) と [Core Specification](../core-spec.md) を参照。
:::

この directory は Takosumi / operator implementation author 向けです。Takosumi v1 は manifestless です。current public input は Source、Installation、Deployment、PlatformService、InstallPlan です。

```text
author / operator:
  git repo, prepared source archive, or local source snapshot
    -> Installer API
    -> InstallPlan dry-run
    -> Installation / Deployment record

runtime request:
  client -> backend-native listener/route -> workload
         <- same backend data plane <- response
```

Takosumi API process は install / deploy / rollback の control plane であり、通常の runtime request data plane ではありません。apply 時の internal snapshots は Deployment record と activation intent を作るための実装 detail です。

```text
Source + Space context + BindingSelection
  -> InstallPlan
  -> TargetState
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> operator adapter / runtime-agent operation
  -> TrafficSnapshot / RoutingPointer
  -> ObservationState / DriftIndex / CleanupBacklog
```

Activation は apply 時の切り替えであり、現在の runtime target を選択します。Observation record と drift record は activation 後も保持されます。pre-activation health check は activation step の前に使われる backend/runtime evidence です。

## Public v1 vocabulary {#public-v1-vocabulary}

Public concept は次の 4 つに閉じます。

- `Source`: git / prepared / local source input and resolved source identity.
- `Installation`: Space-scoped installed source record.
- `Deployment`: one apply result with source summary, plan snapshot, binding snapshot, outputs, and status.
- `PlatformService`: operator-catalog service capability selected during install or deploy.

Dry-run response は `InstallPlan` と `planSnapshotDigest` を返します。`InstallPlan` は persisted public entity ではありません。

## 読む順序 {#reading-order}

| Doc                                                           | Question                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| [Kernel](./kernel.md)                                         | Takosumi と operator / application の責務境界はどこか。       |
| [Object Model](./object-model.md)                             | Takosumi が扱う object の lifecycle class と revoke flow。    |
| [Snapshot Model](./snapshot-model.md)                         | snapshot 体系と各 snapshot の役割。                           |
| [Space Model](./space-model.md)                               | Space scope で何が分離されるか。                              |
| [Deploy System](./deploy-system.md)                           | Installation / Deployment lifecycle はどう進むか。            |
| [Adapter Resolution Model](./kind-resolution-model.md)        | Source / PlatformService / adapter 解決はどう決まるか。       |
| [Platform Service Model](./platform-service-model.md)         | operator PlatformService inventory はどう扱われるか。         |
| [バインディングモデル](./binding-model.md)                    | BindingSelection は Deployment binding にどう記録されるか。   |
| [Runtime Deployment](./runtime-deployment-model.md)           | snapshot と WAL は何を保証するか。                            |
| [Execution Lifecycle](./execution-lifecycle.md)               | Preview / Apply / Activate / Destroy の各 phase。             |
| [承認モデル](./approval-model.md)                             | risk 評価と approval flow はどう進むか。                      |
| [Runtime Routing](./runtime-routing.md)                       | apply 後に request がどこに届くか。                           |
| [Runtime-Agent 境界](./runtime-agent-boundary.md)             | Takosumi と runtime-agent の境界はどこか。                    |
| [API Surface](./api-surface-architecture.md)                  | public / internal / runtime-agent の surface 分割。           |
| [CLI Surface](./cli-companion-architecture-note.md)           | CLI の設計方針と Takosumi API との関係。                      |
| [Operator Boundaries](./operator-boundaries.md)               | operator が選ぶものと Takosumi が固定するものは何か。         |
| [Reference Metadata Model](./kind-catalog.md)                 | reference adapter metadata を operator がどう取り込むか。     |
| [Workflow Placement](./workflow-extension-design.md)          | workflow / scheduler をどこに置くか。                         |
| [Operational Hardening](./operational-hardening-checklist.md) | production readiness の normative checklist。                 |
| [イングレスルーティング](./ingress-routing.md)                | public ingress の activation と health state の追跡。         |

## Docs boundary {#docs-boundary}

Operator account layer の architecture は `takosumi/` 側の docs に分かれます。
