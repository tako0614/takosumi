# Invariant-first Root Model

Takosumi v1 is not only graph-shaped. It is **invariant-first**. The graph gives
shape; invariants keep operations safe.

## North star

```text
Takosumi v1 is an invariant-first, space-isolated, snapshot-backed,
graph-shaped, write-ahead-operation-journaled PaaS operation kernel.
```

A manifest is authoring input. A deployment is resolved inside a Space. A
deployment is a collection of immutable snapshots plus operation journals and
observations.

## Root pipeline

```text
Manifest + Space context
  -> IntentGraph
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> ObservationSet
  -> ActivationSnapshot / GroupHead
```

## Required invariants

### 1. Authority invariant

Apply, activate, rollback, and destroy must use the recorded
`ResolutionSnapshot` and `DesiredSnapshot`. They must not use live descriptor
URLs, live namespace registries, or recomputed semantics as authority.

### 2. Snapshot invariant

`ResolutionSnapshot` and `DesiredSnapshot` are immutable. A new meaning or
desired graph creates a new snapshot.

### 3. Identity invariant

Every `Object`, `ExportDeclaration`, `Link`, `Exposure`, `DataAsset`,
`Operation`, generated object, and activation item has a stable address.

### 4. Ownership invariant

Lifecycle class restricts operations.

```text
managed:
  may be created, updated, replaced, deleted by the deployment

generated:
  owned by an Object, Link, Exposure, DataAsset, or Operation
  must have owner, reason, deterministic id, and delete policy

external:
  may be verified, observed, linked, and granted
  must not be created or deleted by the deployment

operator:
  controlled by operator policy
  user deployment must not delete it

imported:
  pre-existing object registered by operator policy
  delete is denied unless explicitly operator-approved
```

The revoke flow that enforces this invariant is detailed in
[Object Model — Object revoke flow](./object-model.md).

### 5. Secret invariant

Raw secret values are never stored in core canonical state. Core state may store
secret references, handles, projection metadata, and audit events.

### 6. Effects invariant

Implementations must not exceed `approvedEffects`. If `actualEffects` exceed
approved effects, execution must pause, journal the overflow, run compensation
when possible, and require approval or fail.

### 7. Write-ahead journal invariant

Any side-effecting operation must record intent before the side effect.
Generated object identities must be planned before external calls. Observed
handles must be appended after external calls.

### 8. Idempotency invariant

Retries are the same intent. Generated object identity should be deterministic
from stable inputs such as deployment id, link id, export snapshot id, access
mode, exposure id, and desired generation.

### 9. Activation invariant

Apply and activation are separate. GroupHead and traffic assignment move only
after apply-phase revalidation.

### 10. Observation invariant

Observation records reality. Observation must never mutate `DesiredSnapshot`.

### 11. External ownership invariant

External source objects are not destroyed by deployment destroy. Link-owned
generated grants, credentials, endpoints, and projections are revoked or
deleted. Revoke failure creates `RevokeDebt`.

### 12. Concurrency invariant

Production installations must serialize GroupHead updates, activation updates,
ingress reservations, generated credential mutation, generated grant mutation,
namespace registry writes, Space export sharing, and catalog release activation.

### 13. Space containment invariant

Every Deployment, ResolutionSnapshot, DesiredSnapshot, OperationJournal,
ObservationSet, RevokeDebt, ActivationSnapshot, approval, and GroupHead belongs
to exactly one Space. A deployment must not resolve, materialize, activate,
observe, or destroy outside its Space unless an explicit Space export share or
operator-approved namespace import permits it.

### 14. Namespace isolation invariant

Namespace paths are scoped by Space. The same path in two Spaces is not the same
ExportDeclaration by default. A reserved prefix such as `takos` is
operator-controlled, but its visibility is still Space-scoped.

### 15. Space data-boundary invariant

Secrets, DataAssets, operation journals, observations, approvals, and audit
events are Space-scoped. Sharing them across Spaces requires explicit operator
policy and must be recorded in ResolutionSnapshot.

## Final root primitives

```text
Manifest
Space
IntentGraph
CatalogRelease
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
```

`ProjectionSelection` is a `Link` attribute. It is not a public authoring
object.
