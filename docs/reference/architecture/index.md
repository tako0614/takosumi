# Takosumi v1 Final Abstract Spec

Takosumi v1 is an **invariant-first, space-isolated, snapshot-backed,
graph-shaped, write-ahead-operation-journaled PaaS operation kernel**.

The public manifest stays intentionally small. The kernel does not treat the
manifest as canonical state. A manifest creates intent. The request context
chooses a `Space`. The kernel resolves intent inside that Space against an
adopted catalog release, records immutable snapshots, then executes idempotent
operations through a write-ahead journal.

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

Only these words belong to the public manifest vocabulary:

```text
apiVersion
kind
metadata
name
labels
template
inputs
resources
shape
provider
spec
requires
```

The manifest is a closed vocabulary. Unknown top-level fields fail validation.
Public v1 deploy intent is expressed as optional Template invocation plus a
`resources[]` graph of Shape resources. Shape ids, provider ids, artifact
references, bindings, routes, and custom domains are resolved through contract
packages and operator policy; arbitrary descriptor URLs are not public manifest
inputs.

`Space` is not a manifest field. It is supplied by actor auth, API route,
operator context, or client profile. The same manifest can be applied in
different Spaces and resolve different namespace exports, policies, catalog
releases, secrets, and activation history.

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

Takosumi v1 creates immutable snapshots before it acts. Every side effect is
journaled before and after execution. Observations never rewrite desired state.
External source objects are never destroyed by a deployment; only link-owned
generated objects are revoked or deleted. All resolution, namespace lookup,
policy, secrets, journals, observations, and activation are scoped by Space
unless an explicit Space export share allows otherwise.

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
| [Update Summary](./update-summary.md)                                                         | What changed in this final abstract version?                                                  |

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

`db`, `api`, and `web` become resource intents in one Space-scoped graph.
`${ref:db.connectionString}` and `${ref:api.url}` are resolved only after the
producer resource outputs are known. The selected provider descriptors, data
asset requirements, approval decisions, implementation choices, and Space
provenance are recorded in `ResolutionSnapshot`.
