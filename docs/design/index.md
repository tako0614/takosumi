# Takosumi v1 Final Abstract Spec

Takosumi v1 is an **invariant-first, space-isolated, snapshot-backed, graph-shaped, write-ahead-operation-journaled PaaS operation kernel**.

The public manifest stays intentionally small. The kernel does not treat the manifest as canonical state. A manifest creates intent. The request context chooses a `Space`. The kernel resolves intent inside that Space against an adopted catalog release, records immutable snapshots, then executes idempotent operations through a write-ahead journal.

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
schemaVersion
profile
components
target
with
source
artifact
uses
use
access
expose
from
host
path
protocol
port
methods
```

The manifest is a closed vocabulary. Unknown fields fail validation. Public v1 targets are catalog aliases, not arbitrary descriptor URLs. User-facing access path selection is not part of public v1.

`Space` is not a manifest field. It is supplied by actor auth, API route, operator context, or client profile. The same manifest can be applied in different Spaces and resolve different namespace exports, policies, catalog releases, secrets, and activation history.

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

Takosumi v1 creates immutable snapshots before it acts. Every side effect is journaled before and after execution. Observations never rewrite desired state. External source objects are never destroyed by a deployment; only link-owned generated objects are revoked or deleted. All resolution, namespace lookup, policy, secrets, journals, observations, and activation are scoped by Space unless an explicit Space export share allows otherwise.

## Reading order

| Doc | Question |
| --- | --- |
| [Invariant-first Root Model](./invariant-first-root-model.md) | What must never be violated? |
| [Space Model](./space-model.md) | How are namespace, policy, secrets, artifacts, and deployment state isolated? |
| [Manifest Model](./manifest-model.md) | What does the user write? |
| [Catalog Release and Descriptor Model](./catalog-release-descriptor-model.md) | Which semantic world is adopted? |
| [Snapshot Model](./snapshot-model.md) | What is fixed before operation? |
| [Object Model](./object-model.md) | What does the kernel lifecycle-own or observe? |
| [Namespace Export Model](./namespace-export-model.md) | How do objects and external systems publish usable surfaces? |
| [Link and Projection Model](./link-projection-model.md) | How does `uses` become a link? |
| [Exposure and Activation Model](./exposure-activation-model.md) | How does `expose` become ingress and activation? |
| [DataAsset Model](./data-asset-model.md) | How are source and artifacts represented without becoming a build system? |
| [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md) | How is work executed and recovered? |
| [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md) | How is reality tracked without mutating desired state? |
| [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md) | How are safety decisions represented? |
| [Target Model](./target-model.md) | What is an object target? |
| [Implementation and Runtime-Agent Boundary](./implementation-operation-envelope.md) | What must implementations accept and return, and where is the kernel ↔ runtime-agent line? |
| [Execution Lifecycle](./execution-lifecycle.md) | How do preview, apply, activate, destroy, rollback, recovery, and observe proceed? |
| [API Surface Design](./api-surface-design.md) | How is the kernel HTTP API split, authenticated, versioned, and signed? |
| [CLI Surface Design](./cli-companion-design-note.md) | How does the CLI sit between client and kernel without becoming the semantic authority? |
| [Operator Boundaries](./operator-boundaries.md) | What is operator-controlled? |
| [PaaS Provider Design](./paas-provider-design.md) | How does Takosumi serve as a PaaS for multiple tenants? |
| [Identity and Access Design](./identity-and-access-design.md) | How are actors, organizations, roles, and API keys modeled? |
| [Tenant Lifecycle Design](./tenant-lifecycle-design.md) | How are tenants provisioned, trial-bound, exported, and deleted? |
| [PaaS Operations Design](./paas-operations-design.md) | How are quota tiers, SLA, incidents, support, and notifications kernel-side? |
| [Operational Hardening Checklist](./operational-hardening-checklist.md) | What must production enforce? |
| [Update Summary](./update-summary.md) | What changed in this final abstract version? |

## Minimal example

```yaml
schemaVersion: 1
profile: takos/default

components:
  api:
    target: docker-container
    with:
      artifact:
        kind: oci-image
        uri: ghcr.io/example/api@sha256:...
    uses:
      DATABASE_URL:
        use: takos.database.primary
        access: read-write
      BILLING: billing
      OAUTH_TOKEN: takos.oauth.token

  billing:
    target: cloudflare-workers

expose:
  web:
    from: api
    host: app.example.com
```

`billing` expands to `billing.default` only when that export exists in the active Space scope stack. `takos.database.primary` is resolved to an export declaration snapshot from the namespace registry visible to the current Space. Because it produces a grant, `access` is explicit. The selected projection, effect details, approval decisions, implementation choices, and Space provenance are recorded in `ResolutionSnapshot`.
