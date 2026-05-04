# Implementation Operation Envelope

Implementation packaging is free. The operation protocol is fixed.

## Packaging freedom

An implementation may be a binary, module, HTTP service, WASM module, container, gateway, wrapper, or operator-private service.

## Operation envelope

```yaml
OperationRequest:
  spaceId: space:acme-prod
  operationId: operation:...
  operationAttempt: 2
  journalCursor: journal:...
  idempotencyKey: ...
  desiredGeneration: 7
  desiredSnapshotId: desired:...
  resolutionSnapshotId: resolution:...
  operationKind: materialize-link
  inputRefs: []
  preRecordedGeneratedObjectIds: []
  expectedExternalIdempotencyKeys: []
  approvedEffects: {}
  recoveryMode: normal | continue | compensate | inspect
```

## Operation result

```yaml
OperationResult:
  operationId: operation:...
  status: succeeded | failed | partial | requires-approval | compensation-required
  actualEffects: {}
  generatedObjects: []
  secretRefs: []
  endpointRefs: []
  grantHandles: []
  observations: []
  retryHint: {}
  compensationHint: {}
  errorCode: optional
```

## Effect rule

Implementation must not exceed approved effects. If it cannot operate within approved effects, it must fail before side effects or return `requires-approval` during dry materialization.

## Dry materialization

Side-effecting operations should support a dry materialization phase that predicts:

```text
generated objects
grants
credentials
secret projections
endpoints
network changes
traffic changes
```

Dry output becomes approval/risk input. Actual execution must be checked against it.

## Runtime boundary

The kernel orchestrates snapshots, journals, and policy. Credentials and external I/O remain within implementation / connector / runtime boundary.

## Space requirement

Implementations receive `spaceId` in the operation envelope. They must not read or mutate objects, secrets, artifacts, grants, or namespace exports from another Space unless the operation input includes an approved SpaceExportShare or operator import.
