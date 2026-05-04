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
