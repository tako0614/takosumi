# 内部設計の概要 {#architecture-overview}

Public concepts: AppSpec / Installation / Deployment。Public Installer API:
[Installer API](../installer-api.md)。この directory は kernel / operator
implementation author 向けの内部設計メモです。 AppSpec author は
[コンセプト](../../getting-started/concepts.md) と [AppSpec](../app-spec.md)
を先に読む。

```text
author / operator:
  source root or prepared source archive (including .takosumi.yml AppSpec)
    -> Installer API
    -> Installation / Deployment record

runtime request:
  client -> provider-native listener/route -> workload
         <- same provider data plane <- response
```

kernel API process は install / deploy / rollback の control plane
であり、通常の runtime request data plane ではありません。以下の internal
snapshots は apply 時に retained implementation/operator evidence と activation
intent を作るための構造です。

```text
AppSpec + Space context
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> provider / runtime-agent operation
  -> ObservationSet / DriftIndex / RevokeDebt
  -> ActivationSnapshot / GroupHead
```

## Public AppSpec vocabulary {#public-appspec-vocabulary}

AppSpec root: `apiVersion` / `metadata` / `components`。

component の公開 field は `kind`、`spec`、`publish`、`listen` です。
entrypoint、image、gateway route などの詳細は kind の `spec` または
operator-provided descriptor metadata に置きます。execution binding は AppSpec
の外で operator が選びます。kernel-owned release bundle や provider target list
はありません。

## 読む順序 {#reading-order}

| Doc                                                                               | Question                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Kernel](./kernel.md)                                                             | kernel と operator / application の責務境界はどこか。             |
| [Object Model](./object-model.md)                                                 | kernel が扱う object の lifecycle class と revoke flow。          |
| [Snapshot Model](./snapshot-model.md)                                             | snapshot 体系と各 snapshot の役割。                               |
| [Space Model](./space-model.md)                                                   | Space scope で何が分離されるか。                                  |
| [Deploy System](./deploy-system.md)                                               | Installation / Deployment lifecycle はどう進むか。                |
| [Kind Resolution Model](./kind-resolution-model.md)                               | kind alias / provider / connector 解決はどう決まるか。            |
| [External Publication Model](./external-publication-model.md)                     | component outputs と external publication path はどう扱われるか。 |
| [Link / Projection Model](./link-projection-model.md)                             | publish/listen は runtime binding にどう変換されるか。            |
| [Runtime Deployment](./runtime-deployment-model.md)                               | snapshot と WAL は何を保証するか。                                |
| [Execution Lifecycle](./execution-lifecycle.md)                                   | Preview / Apply / Activate / Destroy の各 phase。                 |
| [Policy / Risk / Approval / Error](./policy-risk-approval-error-model.md)         | risk 評価と approval flow はどう進むか。                          |
| [Runtime Routing](./runtime-routing.md)                                           | apply 後に request がどこに届くか。                               |
| [Implementation / Runtime-Agent Boundary](./implementation-operation-envelope.md) | kernel と runtime-agent の境界はどこか。                          |
| [API Surface](./api-surface-architecture.md)                                      | public / internal / runtime-agent の surface 分割。               |
| [CLI Surface](./cli-companion-architecture-note.md)                               | CLI の設計方針と kernel API との関係。                            |
| [Operator Boundaries](./operator-boundaries.md)                                   | operator が選ぶものと kernel が固定するものは何か。               |
| [External Descriptor Registry](./external-descriptor-registry-model.md)           | descriptor を operator がどう取り込むか。                         |
| [Workflow Placement](./workflow-extension-design.md)                              | workflow / scheduler をどこに置くか。                             |
| [Operational Hardening](./operational-hardening-checklist.md)                     | production readiness の normative checklist。                     |
| [Exposure Activation](./exposure-activation-model.md)                             | public ingress の activation と health state の追跡。             |

## Docs boundary {#docs-boundary}

account、billing、OIDC issuer、customer onboarding、managed offering support
workflow は operator account-plane の architecture として扱います。reference
implementation は `takosumi-cloud/` 側の docs に分かれます。
