# Operation Plan and Write-ahead Journal Model

OperationPlan is derived work inside one Space. WriteAheadOperationJournal is execution authority.

## OperationPlan

An OperationPlan is derived from `DesiredSnapshot` and `ObservationSet` for the same Space.

It contains operations such as:

```text
apply-object
delete-object
verify-object
materialize-link
rematerialize-link
revoke-link
prepare-exposure
activate-exposure
transform-data-asset
observe
compensate
```

OperationPlan is not canonical desired state.

## Write-ahead journal

Any side-effecting operation follows this shape:

```text
operation-intent-recorded
generated-object-planned
external-call-started
generated-object-observed
operation-completed
```

On failure:

```text
operation-failed
compensation-started
compensation-completed | compensation-failed
revoke-debt-created when needed
```

## Stage enumeration

Each journal entry carries a `stage` drawn from a closed v1 enum. Stages
run in the order below for a successful operation. `abort` and `skip` are
terminal stages that may replace any forward stage.

```text
prepare      → pre-commit → commit → post-commit → observe → finalize
                                       \
                                        → abort     (no further stages)
                                        → skip      (no-op resolution)
```

| stage | may write actual-effects | may queue RevokeDebt | may re-validate approval |
| --- | --- | --- | --- |
| prepare | no | no | yes |
| pre-commit | no | no | yes |
| commit | yes | no | no |
| post-commit | yes | yes | no |
| observe | no | yes | no |
| finalize | no | no | no |
| abort | no | yes | no |
| skip | no | no | no |

`pre-commit` is the canonical enforcement point for transform approval
gates (see [DataAsset Model](./data-asset-model.md)) and for collision
risks raised by [Link and Projection Model](./link-projection-model.md).
`post-commit` is the only stage that may mutate already-live objects;
debt is queued from there or `observe` when external cleanup cannot
complete. New stages require an RFC (CONVENTIONS.md §6).

## Idempotency keys

Each journal entry carries a deterministic idempotency key:

```text
idempotencyKey = (spaceId, operationPlanDigest, journalEntryId)
```

The triple is unique within a Space's WAL. On replay, an identical triple
deterministically re-applies the same operation. If a replay arrives with
the same `(spaceId, operationPlanDigest, journalEntryId)` but a
mismatching effect digest from the previously recorded entry, the kernel
hard-fails the operation and refuses to advance the stage. Recovery in
that case must mint a new `operationPlanDigest` (a fresh OperationPlan).

## Pre/post-commit hooks

CatalogRelease may declare pre-commit and post-commit hooks bound to
specific operation kinds. Hook lifecycle:

```text
1. discovery        — hooks adopted by the active CatalogRelease
2. invocation       — runs in the corresponding stage above
3. result recorded  — hook outcome is journaled as a side-effect entry
4. fail-closed      — any hook failure aborts the operation; no skip,
                      no silent-pass, no retry without operator approval
```

Hooks must not bypass policy or approval re-validation. They may emit
RevokeDebt only from `post-commit` or `observe` stages.

## Journal entries

```yaml
JournalEntry:
  spaceId: space:acme-prod
  journalId: journal:...
  operationId: operation:...
  deploymentId: deployment:...
  desiredSnapshotId: desired:...
  operationPlanDigest: sha256:...
  stage: operation-intent-recorded
  idempotencyKey: ...
  desiredGeneration: 7
  approvedEffects: {}
  timestamp: ...
```

## Deterministic generated ids

Generated object ids should be computed before external calls.

```text
grant id = hash(spaceId, deploymentId, linkId, exportSnapshotId, accessMode)
secret projection id = hash(spaceId, deploymentId, linkId, projectionName)
ingress reservation id = hash(spaceId, groupId, exposureId, host, path)
```

## Actual effects overflow

If `actualEffects` exceed `approvedEffects`:

```text
1. journal overflow
2. pause operation
3. compensate when possible
4. require approval or fail
5. create debt if compensation cannot complete
```


## Space isolation

An OperationPlan, OperationJournal, generated object id, compensation record, and RevokeDebt belong to exactly one Space. A journal entry from one Space must not be used as recovery authority in another Space.

Critical operations that mutate Space-global state are serialized per Space, and global ingress reservation may require additional operator-level serialization.

## OperationJournal retention

OperationJournal retains side-effect and recovery history. Entries related to active generated objects, unresolved compensation, unresolved revoke debt, or current activation must not be compacted away.

Separate stores may hold:

```text
AuditLog
ObservationHistory
CurrentStateIndex
```
