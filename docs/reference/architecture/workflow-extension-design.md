# Workflow Extension Design Rationale

This document records the design rationale for how Takosumi exposes "workflow /
cron / hook" style automation. Workflow surfaces such as scheduled jobs, build
pipelines, deployment hooks, and external-event-driven runs are
**plugin-supplied shapes**, not kernel-built-in features. The current kernel
ships the manifest / plugin / CatalogRelease hook surface; trigger,
declarable-hook, and `execute-step` route/store primitives are reserved
contracts for future implementation. This keeps the v1 invariants stable:
`Space` tenancy, the curated 5-shape catalog, the WAL stage 8-value enum, the
closed Risk taxonomy (19 values), the closed Approval invalidation triggers (6),
the closed RevokeDebt enums, the 5 DataAsset kinds, operator-installed
`connector:<id>` identity, and the WAL idempotency tuple
`(spaceId, operationPlanDigest, journalEntryId)`.

The doc is design-layer only. Wire-level shape is delegated to the reference
docs listed at the bottom.

## 1. Why kernel-side workflow primitive is not built-in

Takosumi has always positioned the kernel as a thin curation layer. The 5
curated shapes (`object-store`, `web-service`, `database-postgres`,
`custom-domain`, `worker`) are kernel-owned because they correspond to PaaS
primitives that any `Space` operator must reason about. Workflow / cron / hook
surfaces do not belong in this set. The reasoning:

- **Kernel thinness.** Embedding a GitHub Actions / GitLab CI style execution
  graph inside the kernel forces the kernel to model job DAG, matrix, retry, and
  concurrency semantics on top of the existing apply DAG. That is a second
  scheduler living inside the same `WriteAheadOperationJournal`. Two DAGs
  sharing one journal is a structural overload of the WAL stage enum and an
  obstacle to evolving either side.
- **Curation neutrality.** The catalog is intentionally small and middle-of-
  the-road. A built-in `workflow` shape would either be too opinionated for the
  long tail of CI / cron / lifecycle use cases or too generic to ship without
  becoming yet another DAG language.
- **Plugin freedom.** A plugin can model "cron job", "single-step build",
  "multi-step pipeline", "post-activate notification", and so on at exactly the
  level of detail its users need. Forcing all of them through one kernel-owned
  abstraction is more restrictive than the v1 plugin model already accepts.
- **Cyclical dependency risk.** Workflow features tend to be expressed as
  "deploy + run hook + observe + redeploy". Encoding that loop into a kernel
  primitive would deploy-bind the lifecycle and make `OperationPlan` ordering
  impossible to reason about in isolation.

The kernel therefore reserves primitives general enough that a plugin shape can
later bind to kernel-managed workflow semantics, and refuses to ship workflow
vocabulary itself.

## 2. Relation to existing primitives

Workflow shapes do not need new kernel concepts. They reuse:

- **Connector / Implementation / runtime-agent.** Step execution reuses the
  existing runner topology. A workflow step is an Implementation invocation
  scoped to a `Space`, dispatched by the same runtime-agent path that today
  drives apply / activate / destroy.
- **DataAsset (5 closed kinds).** Step bundles are `oci-image` / `js-module` /
  `wasm-module` / `source-archive` / `static-archive`. No new DataAsset kind is
  required, and none is added.
- **pre/post-commit hook (catalog-supplied).** The kernel already runs hooks
  curated by the catalog at well-known apply phases. Section 3.c extends this
  surface so that **operator manifests** can declare hooks too, without
  introducing a separate "hook plugin" concept.
- **Template engine and `${ref:...}`.** A multi-step workflow declaration is a
  Template-shaped DAG over OperationPlan kicks. Reusing `${ref:...}` keeps
  cross-step data flow consistent with the current resolution model.
- **Approval invalidation triggers (6 closed values).** A workflow run that
  changes a referenced artifact triggers the same invalidation rules as any
  other apply.
- **WAL stage enum (8 closed values).** `execute-step` traverses the same 8
  stages. Operation kind disambiguates the context so stage semantics are not
  overloaded.

## 3. Four minimal kernel primitives reserved

The reserved contract has exactly four primitives. Each is generic and has no
workflow vocabulary baked in. Current code does not expose these as active
routes/stores yet.

### 3.a. Trigger primitive (3 closed kinds)

```text
trigger.kind ∈ { manual, schedule, external-event }
```

`manual` is operator-initiated, `schedule` is clock-driven (the kernel time
clock model is the source of truth), and `external-event` is HMAC-SHA256
authenticated payload delivery. The kind set is closed in v1.

### 3.b. Operation kind expansion

The operation kind enum grows from 11 to 12. The new value is `execute-step`,
which generalizes the previous `transform-data-asset` shape into "run an
Implementation step against a `Space`". `transform-data-asset` is a degenerate
`execute-step` whose effect is a DataAsset materialization.

```text
kind ∈ { ..., execute-step }   # 12 values total
```

### 3.c. Declarable hook extension point

A resource manifest may declare a hook on a known lifecycle phase. The kernel
treats the declaration as a request to enqueue an `execute-step` operation at
that phase, subject to the same Approval / Risk / RevokeDebt rules as any other
`OperationPlan` kick.

```yaml
# illustrative; not normative
hooks:
  - phase: post-activate
    runs: ${ref:steps.notify}
```

### 3.d. Trigger ↔ resource binding

A resource declares which triggers can fan out into operations against it. The
kernel watches the declared triggers and, when one fires, kicks an
`OperationPlan` whose root operation is `execute-step`.

```text
trigger fires
  → kernel resolves binding
  → kernel constructs OperationPlan(kind=execute-step, ...)
  → WAL stage 1 ... 8 (unchanged)
```

## 4. Plugin shapes built on these primitives

The shapes below are illustrative. They are NOT part of the curated 5-shape
catalog and NOT part of this spec; they are listed only to show that the four
primitives suffice. Any third party may publish them via the `CONVENTIONS.md` §6
RFC route.

- `cron-job@v1` — `schedule` trigger plus a step bundle.
- `workflow-job@v1` — single-step build / test / migrate.
- `workflow-pipeline@v1` — multi-step DAG modelled as a Template.
- `pre-apply-hook@v1` / `post-activate-hook@v1` — deployment lifecycle hooks.

The curated 5 shapes (`object-store`, `web-service`, `database-postgres`,
`custom-domain`, `worker`) are unchanged.

## 5. Git decoupling invariants

Workflow does not pull git into the kernel.

- The kernel data model has no `commit`, `branch`, `ref`, or `repo` field. All
  trigger primitives are git-agnostic.
- `external-event` payloads are opaque to the kernel. The kernel verifies the
  HMAC-SHA256 signature, attaches the payload as audit data, and refuses to
  parse it.
- HMAC-SHA256 verification is kernel-enforced, not optional. An unsigned
  external event is rejected before any `OperationPlan` is constructed.
- The `source-archive` DataAsset kind continues to be git-agnostic. Its optional
  `metadata.gitCommit` field is audit annotation only and does not flow into any
  kernel decision.

## 6. Structural alternatives considered

Three alternatives were evaluated and rejected.

- **"Do not allow workflow shapes in `resources[]`."** Rejected because that
  forces a manifest envelope change. The envelope is fixed at v1.
- **"Introduce a separate manifest kind for workflows."** Rejected because the
  primitives in §3 let plugin shapes ride inside the existing `resources[]`
  envelope without a kind split.
- **"Ship workflow as a built-in shape."** Rejected on curation neutrality
  grounds (§1) and to preserve the 5-shape catalog invariant.

## 7. Workflow run lifecycle vs. apply pipeline

A workflow run is one specific use of an `OperationPlan`. It is not a parallel
pipeline.

- Same WAL stages (8 values), same idempotency tuple
  `(spaceId, operationPlanDigest, journalEntryId)`.
- Same Approval invalidation triggers (6 values), same Risk taxonomy (19
  values), same RevokeDebt closed enums.
- `DriftIndex` does not apply to workflow runs. A run is ephemeral; its result
  is recorded as an observation entry rather than a drift entry.
- `Connector` identity remains `connector:<id>` and is operator-installed.
  External-event triggers do not create new identities.

## 8. Boundary

```text
reserved Takosumi kernel      Trigger primitive (3 kinds)
contract                      execute-step operation kind (12th value)
                              declarable hook extension point
                              trigger ↔ resource binding
                              HMAC-SHA256 enforcement on external-event

provided by plugin shapes     cron-job, workflow-job, workflow-pipeline,
                              pre-apply-hook, post-activate-hook, etc.
                              (CONVENTIONS.md §6 RFC, third-party)

outside Takosumi              UI for workflow authoring
                              webhook receivers
                              git push handlers
                              matrix execution
                              OIDC federation
                              cross-run artifact sharing
```

The bottom group is operator-side concern (for example `takos-private`) and will
be revisited in a future RFC if it ever enters the kernel.

## Related reference docs

- [Trigger Resource Model](/reference/triggers.md)
- [Execute-Step Operation](/reference/execute-step-operation.md)
- [Declarable Hooks](/reference/declarable-hooks.md)
- [WAL Stages](/reference/wal-stages.md)
- [Approval Invalidation](/reference/approval-invalidation.md)
- [Risk Taxonomy](/reference/risk-taxonomy.md)
- [Time / Clock Model](/reference/time-clock-model.md)
- [Artifact Kinds](/reference/artifact-kinds.md)
- [Templates](/reference/templates.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
- [Operation Plan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [Data Asset Model](./data-asset-model.md)
