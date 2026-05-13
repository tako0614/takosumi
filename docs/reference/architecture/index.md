# Takosumi v1 Final Abstract Spec

> このページでわかること: Takosumi v1 kernel の抽象仕様と設計モデルの全体像。

Takosumi v1 は
**invariant-first、space-isolated、snapshot-backed、graph-shaped、
write-ahead-operation-journaled な PaaS operation kernel** である。

public manifest は意図的に小さく保たれている。kernel は manifest を canonical
state として扱わない。manifest は intent を作る。request context が `Space`
を選ぶ。kernel はその Space の中で、adopt 済みの catalog release に対して intent
を解決し、immutable snapshot を記録し、write-ahead journal を通じて idempotent
な operation を実行する。

```text
Manifest + Space context
  -> IntentGraph
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> ObservationSet / DriftIndex / RevokeDebt
  -> ActivationSnapshot / GroupHead
```

## Public v1 manifest words

public manifest の語彙に属するのは次の語のみである。

```text
apiVersion
kind
metadata
name
labels
resources
shape
provider
spec
requires
```

manifest は closed vocabulary である。未知の top-level field は validation で
失敗する。Public v1 の deploy intent は Shape resource からなる `resources[]`
graph として表現される。Shape id、provider id、artifact reference、binding、
route、custom domain は contract package と operator policy を通じて解決される。
任意の descriptor URL は public manifest の入力ではない。

`Space` は manifest field ではない。actor auth、API route、operator context、
または client profile から供給される。同じ manifest を異なる Space
で適用すると、 異なる namespace export、policy、catalog
release、secret、activation history が解決される。

## Kernel v1 root words

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

## Root statement

Takosumi v1 は行動の前に immutable snapshot を作る。すべての side effect は
実行前後に journal される。Observation が desired state を書き換えることはない。
deployment が外部 source object を破壊することはなく、link が所有する生成 object
だけが revoke または削除される。すべての resolution、namespace lookup、
policy、secret、journal、observation、activation は、明示的な Space export share
が許さない限り Space scope である。

## Reading order

| Doc                                                                                           | Question                                                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Invariant-first Root Model](./invariant-first-root-model.md)                                 | What must never be violated?                                                                  |
| [Space Model](./space-model.md)                                                               | How are namespace, policy, secrets, artifacts, and deployment state isolated?                 |
| [Manifest Model](./manifest-model.md)                                                         | What does the user write?                                                                     |
| [Catalog Release and Descriptor Model](./catalog-release-descriptor-model.md)                 | Which semantic world is adopted?                                                              |
| [Snapshot Model](./snapshot-model.md)                                                         | What is fixed before operation?                                                               |
| [Object Model](./object-model.md)                                                             | What does the kernel lifecycle-own or observe?                                                |
| [Namespace Export Model](./namespace-export-model.md)                                         | How do objects and external systems publish usable surfaces?                                  |
| [Link and Projection Model](./link-projection-model.md)                                       | How do Shape resource bindings and refs become links?                                         |
| [Exposure and Activation Model](./exposure-activation-model.md)                               | How do route-bearing resources become ingress and activation?                                 |
| [DataAsset Model](./data-asset-model.md)                                                      | How are source and artifacts represented without becoming a build system?                     |
| [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md) | How is work executed and recovered?                                                           |
| [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)           | How is reality tracked without mutating desired state?                                        |
| [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)              | How are safety decisions represented?                                                         |
| [Target Model](./target-model.md)                                                             | What is an object target?                                                                     |
| [Implementation and Runtime-Agent Boundary](./implementation-operation-envelope.md)           | What must implementations accept and return, and where is the kernel ↔ runtime-agent line?    |
| [Execution Lifecycle](./execution-lifecycle.md)                                               | How do preview, apply, activate, destroy, rollback, recovery, and observe proceed?            |
| [API Surface Architecture](./api-surface-architecture.md)                                     | How is the kernel HTTP API split, authenticated, versioned, and signed?                       |
| [CLI Surface Architecture](./cli-companion-architecture-note.md)                              | How does the CLI sit between client and kernel without becoming the semantic authority?       |
| [Operator Boundaries](./operator-boundaries.md)                                               | What is operator-controlled?                                                                  |
| [PaaS Provider Architecture](./paas-provider-architecture.md)                                 | How does Takosumi serve as a PaaS for multiple tenants?                                       |
| [Identity and Access Architecture](./identity-and-access-architecture.md)                     | How are actors, organizations, roles, and API keys modeled?                                   |
| [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md)                           | How are tenants provisioned, trial-bound, exported, and deleted?                              |
| [PaaS Operations Architecture](./paas-operations-architecture.md)                             | How are quota tiers, SLA, incidents, support, and notifications kernel-side?                  |
| [Workflow Placement Rationale](./workflow-extension-design.md)                                | Why does the kernel host no workflow primitive, and how does `takosumi-git` own this concern? |
| [Operational Hardening Checklist](./operational-hardening-checklist.md)                       | What must production enforce?                                                                 |

## Minimal example

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: example-api
  labels:
    tier: demo
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
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

  - shape: custom-domain@v1
    name: web
    provider: "@takos/cloudflare-dns"
    spec:
      name: app.example.com
      target: ${ref:api.url}
```

`db`、`api`、`web` は 1 つの Space scope graph の中で resource intent となる。
`${ref:db.connectionString}` と `${ref:api.url}` は producer resource output が
判明した後にのみ解決される。選ばれた provider descriptor、data asset 要件、
承認決定、implementation 選択、Space provenance は `ResolutionSnapshot` に
記録される。
