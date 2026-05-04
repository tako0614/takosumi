# Observation, Drift, and RevokeDebt Model

Observation records reality inside a Space. Drift is computed. Debt records failed cleanup.

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

ObservationSet, DriftIndex, and RevokeDebt are Space-scoped. Observation from one Space must not mutate or validate DesiredSnapshot in another Space. RevokeDebt from a cross-space share belongs to the consuming Space and may reference the provider Space only through the recorded SpaceExportShare.

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

RevokeDebt records generated material that should be revoked or deleted but could not be cleaned up.

```yaml
RevokeDebt:
  spaceId: space:acme-prod
  id: revoke-debt:...
  generatedObject: generated:link:api.DATABASE_URL/grant
  sourceExportSnapshotId: export-snapshot:...
  externalParticipant: db-platform
  reason: revoke-failed
  status: pending | retrying | cleared | operator-action-required
  retryPolicy: {}
  createdAt: ...
```

RevokeDebt is not a warning. It is operational debt and must be visible in status, plan, audit, and production readiness checks.

## Observation retention

ObservationSet stores latest reality. ObservationHistory is optional and policy-controlled. OperationJournal and RevokeDebt carry recovery-critical history.
