# Takosumi v1 最終抽象仕様 {#takosumi-v1-final-abstract-spec}

> このページでわかること: Takosumi v1 kernel の抽象仕様と設計モデルの全体像。

Takosumi v1 は
**invariant-first、space-isolated、snapshot-backed、graph-shaped、
write-ahead-operation-journaled な PaaS operation kernel** である。

public AppSpec は意図的に小さく保たれている。kernel は AppSpec を canonical
state として扱わない。AppSpec は intent を作る。request context が `Space`
を選ぶ。kernel はその Space の中で、adopt 済みの catalog release に対して intent
を解決し、immutable snapshot を記録し、write-ahead journal を通じて idempotent
な operation を実行する。

```text
AppSpec + Space context
  -> IntentGraph
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> ObservationSet / DriftIndex / RevokeDebt
  -> ActivationSnapshot / GroupHead
```

## Public v1 AppSpec の語彙 {#public-v1-appspec-words}

public AppSpec の語彙に属するのは次の語のみである。

```text
apiVersion
kind
metadata
components
interfaces
permissions
build
use
routes
```

AppSpec は closed vocabulary である。未知の top-level field は validation で
失敗する。Public v1 の deploy intent は component kind からなる `components`
graph として表現される。provider id、artifact reference、binding、route、 custom
domain は contract package と operator policy を通じて解決される。 任意の
descriptor URL は public AppSpec の入力ではない。

`Space` は AppSpec field ではない。actor auth、API route、operator context、
または client profile から供給される。同じ AppSpec を異なる Space で適用すると、
異なる namespace export、policy、catalog release、secret、activation history
が解決される。

## Kernel v1 root 語彙 {#kernel-v1-root-words}

```text
Invariant
Space
CatalogRelease
IntentGraph
ResolutionSnapshot
DesiredSnapshot
Object
ExportDeclaration
ExportMaterial
Link
ProjectionSelection
Exposure
DataAsset
OperationPlan
WriteAheadOperationJournal
ObservationSet
DriftIndex
RevokeDebt
ActivationSnapshot
GroupHead
PolicyDecision
Approval
Implementation
Connector
```

## Root statement {#root-statement}

Takosumi v1 は行動の前に immutable snapshot を作る。すべての side effect は
実行前後に journal される。Observation が desired state を書き換えることはない。
deployment が外部 source object を破壊することはなく、link が所有する生成 object
だけが revoke または削除される。すべての resolution、namespace lookup、
policy、secret、journal、observation、activation は、明示的な Space export share
が許さない限り Space scope である。

## 読む順序 {#reading-order}

| Doc                                                                                                       | Question                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Invariant-First Root Model](./runtime-deployment-model.md#invariant-first-root-model)                    | What must never be violated?                                                                   |
| [Space Model](./space-model.md)                                                                           | How are namespace, policy, secrets, artifacts, and deployment state isolated?                  |
| [Manifest](../manifest.md#data-model)                                                                     | What does the user write?                                                                      |
| [Catalog Release and Descriptor Model](./catalog-release-descriptor-model.md)                             | Which semantic world is adopted?                                                               |
| [Snapshot Model](./snapshot-model.md)                                                                     | What is fixed before operation?                                                                |
| [Object Model](./object-model.md)                                                                         | What does the kernel lifecycle-own or observe?                                                 |
| [Namespace Export Model](./namespace-export-model.md)                                                     | How do objects and external systems publish usable surfaces?                                   |
| [Link and Projection Model](./link-projection-model.md)                                                   | How do component resource bindings and refs become links?                                      |
| [Exposure Activation Model](./namespace-export-model.md#exposure-activation-model)                        | How do route-bearing resources become ingress and activation?                                  |
| [Data Asset Model](./namespace-export-model.md#data-asset-model)                                          | How are source and artifacts represented without becoming a build system?                      |
| [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal) | How is work executed and recovered?                                                            |
| [Observation Drift & RevokeDebt Model](../incident-model.md#observation-drift--revokedebt-model)          | How is reality tracked without mutating desired state?                                         |
| [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)                          | How are safety decisions represented?                                                          |
| [Target Model](./target-model.md)                                                                         | What is an object target?                                                                      |
| [Implementation and Runtime-Agent Boundary](./implementation-operation-envelope.md)                       | What must implementations accept and return, and where is the kernel ↔ runtime-agent line?     |
| [Execution Lifecycle](./execution-lifecycle.md)                                                           | How do preview, apply, activate, destroy, rollback, recovery, and observe proceed?             |
| [API Surface Architecture](./api-surface-architecture.md)                                                 | How is the kernel HTTP API split, authenticated, versioned, and signed?                        |
| [CLI Surface Architecture](./cli-companion-architecture-note.md)                                          | How does the CLI sit between client and kernel without becoming the semantic authority?        |
| [Operator Boundaries](./operator-boundaries.md)                                                           | What is operator-controlled?                                                                   |
| [PaaS Provider Architecture](./paas-provider-architecture.md)                                             | How does Takosumi serve as a PaaS for multiple tenants?                                        |
| [Identity and Access Architecture](./identity-and-access-architecture.md)                                 | How are actors, organizations, roles, and API keys modeled?                                    |
| [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md)                                       | How are tenants provisioned, trial-bound, exported, and deleted?                               |
| [PaaS Operations Architecture](./paas-operations-architecture.md)                                         | How are quota tiers, SLA, incidents, support, and notifications kernel-side?                   |
| [Workflow Placement Rationale](./workflow-extension-design.md)                                            | Why does the kernel host no workflow primitive, and where should CI / scheduler concerns live? |
| [Operational Hardening Checklist](./operational-hardening-checklist.md)                                   | What must production enforce?                                                                  |

## 最小例 {#minimal-example}

```yaml
apiVersion: takosumi.dev/v1
kind: App

metadata:
  id: com.example.api
  name: Example API

components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.api.db

  api:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes: ["/"]
    listen:
      com.example.api.db:
        as: env
        prefix: DATABASE_

  domain:
    kind: custom-domain
    spec:
      name: app.example.com
    listen:
      com.example.api.api:
        as: target
```

`api`、`db`、`domain` は 1 つの Space scope graph の中で component intent
となる。 component 間の関係は `publish` / `listen` edge で表現し、 apply 時に
installer pipeline が materializer output を namespace registry に publish し、
listen 側 component に env / mount として注入する。
