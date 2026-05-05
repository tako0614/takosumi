# Observation, Drift, and RevokeDebt Model

Observation records reality inside a Space. Drift is computed. Debt records
failed cleanup.

## ObservationSet

```yaml
ObservationSet:
  spaceId: space:acme-prod
  desiredSnapshotId: desired:...
  observedAt: ...
  observations:
    object:api:
      state: present | missing | degraded | unknown
    link:api.DATABASE_URL:
      state: materialized | stale | failed
    export:takos.database.primary:
      freshness: fresh | stale | revoked | unknown
```

ObservationSet does not mutate DesiredSnapshot.

## Space rule

ObservationSet, DriftIndex, and RevokeDebt are Space-scoped. Observation from
one Space must not mutate or validate DesiredSnapshot in another Space.
RevokeDebt from a cross-space share belongs to the consuming Space and may
reference the provider Space only through the recorded SpaceExportShare.

## DriftIndex

DriftIndex compares DesiredSnapshot with ObservationSet.

```yaml
Drift:
  address: link:api.DATABASE_URL
  kind: stale-secret-projection
  severity: warning | error
  detectedAt: ...
```

## RevokeDebt

RevokeDebt records generated material that should be revoked or deleted but
could not be cleaned up.

### RevokeDebt record schema

```yaml
RevokeDebt:
  id: revoke-debt:...
  generatedObjectId: generated:link:api.DATABASE_URL/grant
  sourceExportSnapshotId: export-snapshot:...
  externalParticipantId: db-platform
  reason: external-revoke
  status: open
  ownerSpaceId: space:acme-prod
  originatingSpaceId: space:acme-prod
  retryPolicy: {}
  createdAt: ...
```

Closed v1 enums:

```text
reason:
  external-revoke         external system rejected or could not acknowledge
  link-revoke             link revoke could not complete cleanly
  activation-rollback     activation rolled back but cleanup is pending
  approval-invalidated    a previously approved retain became invalid
  cross-space-share-expired
                          share expired before consumer cleanup completed

status:
  open                    debt is queued and will be retried
  operator-action-required
                          retry is exhausted or blocked; operator must act
  cleared                 debt is satisfied; entry is preserved for audit
```

### Multi-Space ownership rule

RevokeDebt is owned by the Space that materialized the generated object. For
material produced through a SpaceExportShare:

- `ownerSpaceId` is the importing (consuming) Space; the import side drives
  retry, status, and cleanup.
- `originatingSpaceId` is the exporting (provider) Space and gets a read-only
  mirror entry of the same RevokeDebt id for audit.
- The exporting Space cannot mutate `status` directly; it may only revoke the
  SpaceExportShare, which transitions the debt to `cross-space-share-expired` on
  the importing side.

### ActivationSnapshot propagation

`status: operator-action-required` propagates into ActivationSnapshot state but
is fail-safe-not-fail-closed:

- New traffic shifts (i.e. activations that would advance GroupHead) are blocked
  while the related debt is `operator-action-required`.
- Existing GroupHead pointers and existing TrafficAssignments are **not** rolled
  back automatically; runtime continues serving the previous assignment.
- See
  [Exposure and Activation Model — Post-activate health state](./exposure-activation-model.md)
  for how `unhealthy` annotations and debt interact in observation.

RevokeDebt is not a warning. It is operational debt and must be visible in
status, plan, audit, and production readiness checks.

## Observation retention

ObservationSet stores latest reality. ObservationHistory is optional and
policy-controlled. OperationJournal and RevokeDebt carry recovery-critical
history.

## Observability architecture

This section records the architecture-layer rules that govern how observation,
drift, and debt become operator-visible signals. Wire shape lives in the
reference docs.

### Audit retention policy

Retention is layered. Each layer has a distinct purpose and a distinct TTL
boundary.

```text
ObservationSet         latest reality only; superseded by next observation
ObservationHistory     optional; opt-in retention of past ObservationSet entries
OperationJournal       recovery-critical; retained until journal compaction allows it
AuditLog               compliance-driven; retained per operator policy
```

Architecture rules:

- TTL values are not fixed by the kernel. Each layer carries an
  operator-controlled retention policy.
- ObservationSet may be discarded freely as long as a successor ObservationSet
  exists.
- OperationJournal entries must not be discarded while any dependent RevokeDebt
  is non-terminal or while WAL replay correctness depends on them.
- AuditLog retention is independent of the other three; compliance windows do
  not shorten OperationJournal retention.

### Drift propagation

A drift entry surfaces in `DriftIndex` first. From there it propagates along a
fixed path:

```text
DriftIndex
  -> ActivationSnapshot annotation     drift annotates the relevant activation entry
  -> status surface                    operator status / plan / preview reflects the drift
  -> approval invalidation             see Approval invalidation triggers in policy-risk-approval-error-model
```

DriftIndex never mutates DesiredSnapshot. Activation rollback caused by drift is
mediated by RevokeDebt and the activation lifecycle, not by direct
DesiredSnapshot edit.

### RevokeDebt aging

RevokeDebt that remains in `status: open` past an aging window transitions
automatically to `operator-action-required`.

```text
open --(aging window elapsed without retry success)--> operator-action-required
```

Aging architecture rules:

- The aging window is policy-controlled, not a kernel constant. The architecture
  only requires that such a window exists and that the transition is automatic,
  idempotent, and journaled.
- Manual operator action can move `open` directly to `operator-action-required`
  regardless of the window.
- `cleared` is terminal. Aged debt that becomes cleared records both the aging
  transition and the clearance event.

### ObservationHistory policy

ObservationHistory is optional and Space-scoped.

```text
opt-in    operator enables retention; ObservationSet entries are appended to history
opt-out   default; only the latest ObservationSet is kept
```

Architecture rules:

- ObservationHistory is never authoritative for resolution or planning. It is a
  query surface only.
- Enabling ObservationHistory does not change DriftIndex semantics. Drift is
  computed against current ObservationSet versus DesiredSnapshot.
- Disabling ObservationHistory must not delete OperationJournal or RevokeDebt
  records.

## Cross-references

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
- [Exposure and Activation Model](./exposure-activation-model.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
