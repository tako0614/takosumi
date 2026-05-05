# Storage Schema

> Stability: stable Audience: kernel-implementer, operator See also:
> [Journal Compaction](/reference/journal-compaction),
> [Audit Events](/reference/audit-events),
> [Lifecycle Protocol](/reference/lifecycle),
> [Actor / Organization Model](/reference/actor-organization-model),
> [API Key Management](/reference/api-key-management),
> [Auth Providers](/reference/auth-providers),
> [RBAC Policy](/reference/rbac-policy),
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Tenant Export / Deletion](/reference/tenant-export-deletion),
> [Trial Spaces](/reference/trial-spaces),
> [Quota Tiers](/reference/quota-tiers),
> [Cost Attribution](/reference/cost-attribution),
> [SLA Breach Detection](/reference/sla-breach-detection),
> [Incident Model](/reference/incident-model),
> [Support Impersonation](/reference/support-impersonation),
> [Notification Emission](/reference/notification-emission),
> [Zone Selection](/reference/zone-selection)

This reference defines the logical wire schema of the persistent records that
back the Takosumi kernel. It is intentionally not an SQL dump and not a
column-by-column DDL: kernel implementations may store each record class in a
relational table, a key-value engine, or a log-structured store, and they may
persist a subset of the fields listed here when the omitted fields are derivable
from other records.

The schema is expressed as record classes, each with required and optional
fields, primitive types, persistence semantics, and immutability rules. Where a
field references another record, the reference is by identifier and the
reference is read consistent with the originating snapshot.

Primitive types used throughout:

- `string`: UTF-8 string, bounded by per-field caps documented inline.
- `sha256`: lowercase hex digest with a `sha256:` prefix.
- `timestamp`: RFC 3339 UTC instant with millisecond precision.
- `enum`: closed string enum, declared inline.
- `array<T>`: ordered sequence with the inner type T.
- `digest`: opaque content-addressed identifier; in v1 always sha256.

## Relationship overview

```text
                +----------------------+
                | ResolutionSnapshot   |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | DesiredSnapshot      |
                +----------+-----------+
                           |
              +------------+------------+
              v                         v
   +----------------------+  +----------------------+
   | OperationPlan        |  | Approval             |
   +----------+-----------+  +----------+-----------+
              |                         |
              v                         |
   +----------------------+             |
   | JournalEntry (WAL)   |<------------+
   +----------+-----------+
              |
              v
   +----------------------+
   | ActivationSnapshot   |
   +----------+-----------+
              |
              v
   +----------------------+    +----------------------+
   | ObservationSet       |--->| DriftIndex           |
   +----------------------+    +----------+-----------+
                                          |
                                          v
                               +----------------------+
                               | RevokeDebt           |
                               +----------------------+

   +----------------------+
   | SpaceExportShare     |  (cross-Space, references Snapshots)
   +----------------------+
```

## ResolutionSnapshot

Captures the resolved manifest world for a deploy.

| Field               | Type            | Required | Notes                                                         |
| ------------------- | --------------- | -------- | ------------------------------------------------------------- |
| `id`                | string          | yes      | Snapshot identifier; immutable.                               |
| `spaceId`           | string          | yes      | Owning Space.                                                 |
| `manifestDigest`    | sha256          | yes      | Digest of the canonical manifest bytes.                       |
| `catalogReleaseId`  | string          | yes      | Adopted catalog release at resolve time.                      |
| `exportSnapshotIds` | `array<string>` | yes      | Snapshots of own Space exports referenced by this resolution. |
| `importedShares`    | `array<string>` | yes      | SpaceExportShare ids consumed by this resolution.             |
| `recordedAt`        | timestamp       | yes      | Resolve time.                                                 |

Persistence: kept while any DesiredSnapshot referencing this snapshot is
replayable. Indexed by `(spaceId, recordedAt)`.

Immutability: ResolutionSnapshots are immutable. Replay against a different
catalog release or import set produces a new snapshot.

## DesiredSnapshot

Captures the desired component / link / exposure / data-asset graph for a
deploy.

| Field                  | Type            | Required | Notes                        |
| ---------------------- | --------------- | -------- | ---------------------------- |
| `id`                   | string          | yes      | Snapshot identifier.         |
| `resolutionSnapshotId` | string          | yes      | Backing ResolutionSnapshot.  |
| `spaceId`              | string          | yes      | Owning Space.                |
| `desiredGeneration`    | integer         | yes      | Monotonic per Space.         |
| `components`           | `array<object>` | yes      | Resolved component records.  |
| `links`                | `array<object>` | yes      | Resolved link records.       |
| `exposures`            | `array<object>` | yes      | Resolved exposure records.   |
| `dataAssets`           | `array<object>` | yes      | Resolved DataAsset bindings. |
| `createdAt`            | timestamp       | yes      | Snapshot creation time.      |

Persistence: kept while any OperationPlan or ActivationSnapshot references this
DesiredSnapshot. Indexed by `(spaceId, desiredGeneration)`.

Immutability: DesiredSnapshots are immutable.

## OperationPlan

Derived from a DesiredSnapshot pair (current activation, target desired).
OperationPlan is not authoritative state; it is recomputed from the snapshots it
references.

| Field               | Type            | Required | Notes                               |
| ------------------- | --------------- | -------- | ----------------------------------- |
| `id`                | string          | yes      | Plan identifier.                    |
| `desiredSnapshotId` | string          | yes      | Target DesiredSnapshot.             |
| `spaceId`           | string          | yes      | Owning Space.                       |
| `operations`        | `array<object>` | yes      | Ordered Operation records.          |
| `planDigest`        | sha256          | yes      | Digest of the canonical plan bytes. |
| `createdAt`         | timestamp       | yes      | Plan creation time.                 |

Persistence: kept while the JournalEntry stream that references `planDigest` is
replayable. Implementations may evict plan bodies once the journal is fully
completed and the next plan supersedes them. Indexed by `(spaceId, createdAt)`
and `(planDigest)`.

Immutability: OperationPlans are immutable per `id`. Recomputation yields a new
plan.

## ActivationSnapshot

Captures the Space's activation state at the close of a deploy.

| Field                     | Type            | Required | Notes                                                |
| ------------------------- | --------------- | -------- | ---------------------------------------------------- |
| `id`                      | string          | yes      | Snapshot identifier.                                 |
| `desiredSnapshotId`       | string          | yes      | DesiredSnapshot the activation realizes.             |
| `spaceId`                 | string          | yes      | Owning Space.                                        |
| `assignments`             | `array<object>` | yes      | Object-to-Implementation assignments.                |
| `activatedAt`             | timestamp       | yes      | Activation close time.                               |
| `health`                  | enum            | yes      | One of `healthy`, `degraded`, `unhealthy`.           |
| `sourceObservationDigest` | sha256          | yes      | Digest of the ObservationSet used to compute health. |

Persistence: kept while the snapshot is the head of any group-activation chain
or while any DriftIndex points at it. Indexed by `(spaceId, activatedAt)`.

Immutability: ActivationSnapshots are immutable. Group-head moves record a new
ActivationSnapshot rather than mutating an existing one.

## JournalEntry (WriteAheadOperationJournal)

The write-ahead log that drives the apply pipeline.

| Field                 | Type            | Required | Notes                                                                                          |
| --------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `journalId`           | string          | yes      | Journal identifier; one per Space.                                                             |
| `operationId`         | string          | yes      | Identifier within the plan.                                                                    |
| `deploymentId`        | string          | yes      | Owning deployment.                                                                             |
| `spaceId`             | string          | yes      | Owning Space.                                                                                  |
| `desiredSnapshotId`   | string          | yes      | Target DesiredSnapshot.                                                                        |
| `operationPlanDigest` | sha256          | yes      | Digest of the OperationPlan that contains this entry.                                          |
| `stage`               | enum            | yes      | One of the WAL stage 8 values.                                                                 |
| `idempotencyKey`      | string          | yes      | The 4-tuple idempotency key.                                                                   |
| `desiredGeneration`   | integer         | yes      | Generation of the target DesiredSnapshot.                                                      |
| `approvedEffects`     | `array<object>` | yes      | Closed-enum approved effect records.                                                           |
| `actualEffects`       | `array<object>` | no       | Closed-enum actual effect records, recorded when stage transitions to `commit-acked` or later. |
| `generatedObjectIds`  | `array<string>` | no       | Object ids the operation produced.                                                             |
| `errorCode`           | enum            | no       | Closed lifecycle error code; present on failure stages.                                        |
| `timestamp`           | timestamp       | yes      | Stage transition time.                                                                         |

Persistence: kept until compaction (see
[Journal Compaction](/reference/journal-compaction)). Indexed by
`(spaceId, journalId, timestamp)` and `(idempotencyKey)`.

Immutability: each entry is append-only. Stage transitions write a new entry;
entries are never updated in place. Replay reconstructs the operation state by
folding the entry stream.

## PublicOperationJournalEntry

Current public deploy route WAL stage record for `POST /v1/deployments`. Backed
by `takosumi_operation_journal_entries`.

This record is intentionally narrower than the full internal `JournalEntry`: it
is derived from the public OperationPlan preview and records stage progress
around `applyV2` / `destroyV2` provider calls. It gives the public entrypoint
durable replay evidence and effect-digest mismatch checks, but it does not yet
implement full recovery mode selection or provider fencing tokens.

| Field                 | Type      | Required | Notes                                                                                            |
| --------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------ |
| `id`                  | string    | yes      | Row identifier.                                                                                  |
| `spaceId`             | string    | yes      | Public deploy Space / tenant scope.                                                              |
| `deploymentName`      | string    | no       | Deployment name from manifest metadata.                                                          |
| `operationPlanDigest` | sha256    | yes      | Deterministic public OperationPlan preview digest.                                               |
| `journalEntryId`      | string    | yes      | Operation id used in the WAL idempotency tuple.                                                  |
| `operationId`         | string    | yes      | Same operation identifier, duplicated for query ergonomics.                                      |
| `phase`               | enum      | yes      | `apply` / `destroy` today; full enum also reserves lifecycle phases.                             |
| `stage`               | enum      | yes      | One of `prepare`, `pre-commit`, `commit`, `post-commit`, `observe`, `finalize`, `abort`, `skip`. |
| `operationKind`       | string    | yes      | Public operation kind, for example `create` or `delete`.                                         |
| `resourceName`        | string    | no       | Manifest resource name.                                                                          |
| `providerId`          | string    | no       | Provider id selected by the manifest.                                                            |
| `effectDigest`        | sha256    | yes      | Digest of the canonical public WAL effect payload.                                               |
| `effect`              | object    | yes      | Canonical effect payload used for idempotent replay comparison.                                  |
| `status`              | enum      | yes      | `recorded` / `succeeded` / `failed` / `skipped`.                                                 |
| `createdAt`           | timestamp | yes      | Stage append time.                                                                               |

Persistence: retained under the same policy as public deploy records until a
full journal compaction policy is enabled. Indexed by
`(spaceId, operationPlanDigest)`, `(spaceId, deploymentName)`, and `createdAt`.

Mutation rule: append-only per
`(spaceId, operationPlanDigest, journalEntryId, stage)`. Re-appending the same
tuple with the same `effectDigest` is idempotent; re-appending with a different
digest hard-fails before the route advances the stage.

## TakosumiDeploymentRecord

Public deploy record for the CLI surface (`POST /v1/deployments` and
`takosumi status`). Backed by `takosumi_deployments`.

| Field              | Type            | Required | Notes                                           |
| ------------------ | --------------- | -------- | ----------------------------------------------- |
| `id`               | string          | yes      | Surrogate row id.                               |
| `tenantId`         | string          | yes      | Public deploy tenant / Space scope.             |
| `name`             | string          | yes      | Deployment name derived from manifest metadata. |
| `manifest`         | object          | yes      | Submitted manifest JSON.                        |
| `appliedResources` | `array<object>` | yes      | Last successful apply handles / outputs.        |
| `status`           | enum            | yes      | `applied` / `destroyed` / `failed`.             |
| `createdAt`        | timestamp       | yes      | Initial insert time.                            |
| `updatedAt`        | timestamp       | yes      | Last apply / destroy / failure update.          |

Persistence: retained until operator deletion or record GC. Indexed by
`(tenantId, name)` unique, `(tenantId)`, and `(status)`.

Mutation rule: upsert by `(tenantId, name)`. Destroy keeps the row with
`status = destroyed` and clears `appliedResources` so status and audit reads
still work.

## PublicDeployIdempotencyRecord

Replay cache for the public deploy CLI surface (`POST /v1/deployments`). This is
the storage-level backing for `X-Idempotency-Key` before a write enters the
deeper OperationJournal model.

| Field            | Type      | Required | Notes                                   |
| ---------------- | --------- | -------- | --------------------------------------- |
| `id`             | string    | yes      | Row identifier.                         |
| `tenantId`       | string    | yes      | Public deploy tenant / Space scope.     |
| `idempotencyKey` | string    | yes      | Caller-supplied operation key.          |
| `requestDigest`  | sha256    | yes      | Digest of the exact request body bytes. |
| `responseStatus` | integer   | yes      | HTTP status of the first JSON response. |
| `responseBody`   | object    | yes      | First JSON response body to replay.     |
| `createdAt`      | timestamp | yes      | First-seen time.                        |

Persistence: retained at least for the public deploy retry window. Indexed by
`(tenantId, idempotencyKey)` unique and `(createdAt)` for retention sweeps.

Mutation rule: first writer wins. A later request with the same key and same
`requestDigest` replays the stored response; the same key with a different
digest is rejected with `failed_precondition`.

## PublicDeployLeaseLock

Cross-process lease row for the public deploy CLI surface. Backed by
`takosumi_deploy_locks`.

| Field         | Type      | Required | Notes                                                    |
| ------------- | --------- | -------- | -------------------------------------------------------- |
| `tenantId`    | string    | yes      | Public deploy tenant / Space scope.                      |
| `name`        | string    | yes      | Deployment name.                                         |
| `ownerToken`  | string    | yes      | Opaque holder token generated at acquire time.           |
| `lockedUntil` | timestamp | yes      | Lease expiry. Another pod may take over after this time. |
| `createdAt`   | timestamp | yes      | First acquisition time for the current row.              |
| `updatedAt`   | timestamp | yes      | Last acquire / renewal time.                             |

Persistence: row exists only while a public deploy apply / destroy lock is held.
Primary key is `(tenantId, name)`, with `(lockedUntil)` indexed for expiry
inspection.

Mutation rule: acquire inserts or takes over an expired row atomically;
heartbeat extends `lockedUntil` for the matching `ownerToken`; release deletes
only the matching `ownerToken`.

## RevokeDebt

Tracks pending revocations whose effects have not yet been observed as cleared
in the world. See [RevokeDebt Model](/reference/revoke-debt) for the canonical
schema, reason / status enums, aging window, and Multi-Space ownership rule.

| Field                    | Type      | Required    | Notes                                                                                                                                    |
| ------------------------ | --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | string    | yes         | RevokeDebt identifier (`revoke-debt:<ulid>`).                                                                                            |
| `sourceKey`              | sha256    | yes         | Idempotency key for enqueue; derived from owner Space, reason, generated object, and WAL/source tuple.                                   |
| `generatedObjectId`      | string    | yes         | Owner generated object id; format `generated:...`.                                                                                       |
| `sourceExportSnapshotId` | string    | conditional | Required when reason is `link-revoke` / `cross-space-share-expired`.                                                                     |
| `externalParticipantId`  | string    | conditional | Required when an external participant initiated the revoke attempt.                                                                      |
| `reason`                 | enum      | yes         | Closed enum 5 values (`external-revoke` / `link-revoke` / `activation-rollback` / `approval-invalidated` / `cross-space-share-expired`). |
| `status`                 | enum      | yes         | Closed enum 3 values (`open` / `operator-action-required` / `cleared`).                                                                  |
| `ownerSpaceId`           | string    | yes         | Space owning the debt; for SpaceExportShare-derived debt this is the importing Space.                                                    |
| `originatingSpaceId`     | string    | yes         | Space that materialized the generated object. May equal `ownerSpaceId`.                                                                  |
| `deploymentName`         | string    | no          | Public deploy deployment name when debt originates from `/v1/deployments`.                                                               |
| `operationPlanDigest`    | sha256    | no          | WAL OperationPlan digest that produced the debt.                                                                                         |
| `journalEntryId`         | string    | no          | WAL entry id that produced the debt.                                                                                                     |
| `operationId`            | string    | no          | Operation id that produced the debt.                                                                                                     |
| `resourceName`           | string    | no          | Manifest resource name when debt is resource-scoped.                                                                                     |
| `providerId`             | string    | no          | Provider id associated with the resource-scoped debt.                                                                                    |
| `retryPolicy`            | object    | yes         | Retry policy parameters (interval, attempts, backoff). Owner-tunable.                                                                    |
| `retryAttempts`          | integer   | yes         | Count of cleanup retry attempts recorded for this debt.                                                                                  |
| `lastRetryAt`            | timestamp | no          | Last cleanup retry attempt timestamp.                                                                                                    |
| `nextRetryAt`            | timestamp | no          | Next scheduled retry time when policy can compute one.                                                                                   |
| `lastRetryError`         | object    | no          | Structured retry failure detail from the last attempt.                                                                                   |
| `detail`                 | object    | no          | Origin-specific structured detail.                                                                                                       |
| `createdAt`              | timestamp | yes         | Initial debt creation.                                                                                                                   |
| `statusUpdatedAt`        | timestamp | yes         | Last status transition timestamp; aging windows are evaluated from this value while status is `open`.                                    |
| `agedAt`                 | timestamp | no          | Auto-aging transition (`open` → `operator-action-required`).                                                                             |
| `clearedAt`              | timestamp | no          | Terminal clearance (`status = cleared`).                                                                                                 |

Persistence: kept while `status` is not `cleared`, plus the retain-after-cleared
retention window per [Compliance Retention](/reference/compliance-retention).
Implementation table: `takosumi_revoke_debts`, keyed by `id` with unique
`sourceKey`. Indexed by `(ownerSpaceId, status)`,
`(ownerSpaceId,
deploymentName)`, `(ownerSpaceId, operationPlanDigest)`, and
`(ownerSpaceId, status, nextRetryAt)`, and `createdAt`.

Multi-Space ownership rule: the importing Space (consumer) is the owner; the
exporting Space gets a read-only mirror (non-storage; status mutation only by
the owner).

Immutability: each status transition appends an entry to the audit log; the live
RevokeDebt record itself updates `status`, retry metadata, `statusUpdatedAt`,
`agedAt`, and `clearedAt` in place.

## Approval

Records an issued approval for a risk-bearing plan.

| Field                          | Type            | Required | Notes                                                                         |
| ------------------------------ | --------------- | -------- | ----------------------------------------------------------------------------- |
| `id`                           | string          | yes      | Approval identifier.                                                          |
| `spaceId`                      | string          | yes      | Owning Space.                                                                 |
| `desiredSnapshotDigest`        | sha256          | yes      | Digest of the DesiredSnapshot the approval covers.                            |
| `operationPlanDigest`          | sha256          | yes      | Digest of the OperationPlan.                                                  |
| `riskItemIds`                  | `array<string>` | yes      | Closed risk enum members the approval covers.                                 |
| `approvedEffects`              | `array<object>` | yes      | Approved effects, by closed effect enum.                                      |
| `effectDetailsDigest`          | sha256          | yes      | Digest of the per-effect detail payload.                                      |
| `predictedActualEffectsDigest` | sha256          | yes      | Digest of the predicted actual-effects payload.                               |
| `actor`                        | string          | yes      | Approving actor identity.                                                     |
| `policyVersion`                | string          | yes      | Active policy version at issue time.                                          |
| `expiresAt`                    | timestamp       | yes      | Expiry instant.                                                               |
| `status`                       | enum            | yes      | One of `pending`, `approved`, `denied`, `expired`, `invalidated`, `consumed`. |

Persistence: kept while the journal that references the approval is replayable,
plus the configured audit retention window. Indexed by `(spaceId, status)` and
`(operationPlanDigest)`.

Immutability: status transitions are append-only in the audit log. The live
record updates `status` in place to support fast lookup. Approvals carry the 6
invalidation triggers from the policy / risk / approval / error model.

## SpaceExportShare

The cross-Space share record.

| Field                | Type            | Required | Notes                                                                 |
| -------------------- | --------------- | -------- | --------------------------------------------------------------------- |
| `id`                 | string          | yes      | Share identifier.                                                     |
| `fromSpaceId`        | string          | yes      | Producer Space.                                                       |
| `toSpaceId`          | string          | yes      | Consumer Space.                                                       |
| `exportPath`         | string          | yes      | The exported namespace path.                                          |
| `exportSnapshotId`   | string          | yes      | The Snapshot of the producer-side export.                             |
| `allowedAccess`      | enum            | yes      | Access mode (read / read-write / admin / invoke-only / observe-only). |
| `expiresAt`          | timestamp       | no       | Optional hard expiry.                                                 |
| `lifecycleState`     | enum            | yes      | One of the 5 SpaceExportShare lifecycle values.                       |
| `policyDecisionRefs` | `array<string>` | yes      | Policy decisions that govern the share.                               |

Persistence: kept while `lifecycleState` is anything other than `revoked`, plus
the audit retention window. Indexed by
`(fromSpaceId, toSpaceId, lifecycleState)` and `(exportPath)`.

Immutability: lifecycle transitions are append-only in the audit log. The live
record updates `lifecycleState` and `policyDecisionRefs` in place.

## ObservationSet

A point-in-time bundle of observed facts for a Space.

| Field               | Type            | Required | Notes                                                |
| ------------------- | --------------- | -------- | ---------------------------------------------------- |
| `id`                | string          | yes      | Observation set identifier.                          |
| `spaceId`           | string          | yes      | Owning Space.                                        |
| `desiredSnapshotId` | string          | yes      | DesiredSnapshot the observation is compared against. |
| `observedAt`        | timestamp       | yes      | Observation time.                                    |
| `observations`      | `array<object>` | yes      | Per-object observation records.                      |

Persistence: kept while the corresponding DriftIndex is live, plus the
configured observation retention. Indexed by `(spaceId, observedAt)`.

Immutability: ObservationSets are immutable.

## DriftIndex

The drift state computed from a DesiredSnapshot and an ObservationSet.

| Field               | Type            | Required | Notes                                   |
| ------------------- | --------------- | -------- | --------------------------------------- |
| `id`                | string          | yes      | Drift index identifier.                 |
| `spaceId`           | string          | yes      | Owning Space.                           |
| `desiredSnapshotId` | string          | yes      | DesiredSnapshot side of the comparison. |
| `observationSetId`  | string          | yes      | ObservationSet side of the comparison.  |
| `driftEntries`      | `array<object>` | yes      | Per-object drift records.               |
| `computedAt`        | timestamp       | yes      | Computation time.                       |

Persistence: kept while drift is open or unresolved. Indexed by
`(spaceId, computedAt)`.

Immutability: DriftIndexes are immutable. A new drift computation produces a new
DriftIndex.

## ExternalParticipant

Operator-issued identity for a non-Space participant that consumes exports or
signs envelopes.

| Field             | Type            | Required | Notes                                                |
| ----------------- | --------------- | -------- | ---------------------------------------------------- |
| `id`              | string          | yes      | `external-participant:<id>` form.                    |
| `spaceVisibility` | `array<string>` | yes      | spaceId list operator が visibility を grant した先. |
| `declaredExports` | `array<object>` | yes      | participant が publish 可能な export path 一覧.      |
| `publicKey`       | string          | yes      | ed25519 公開鍵 (signature verify 用).                |
| `verifiedAt`      | timestamp       | yes      | 最新 verification 完了時刻.                          |
| `expiresAt`       | timestamp       | no       | optional expiry, 経過後は revocation 扱い.           |
| `revokedAt`       | timestamp       | no       | revocation 時刻 (status:revoked).                    |

Persistence: kept while `revokedAt` is null OR audit retention で要求される間.
Indexed by `(id, spaceVisibility)`. Immutability: mutable in place:
`spaceVisibility` / `verifiedAt` / `revokedAt` のみ.

See also: [External Participants](/reference/external-participants).

## Connector

Operator-installed connector record that gates DataAsset accept paths.

| Field                 | Type            | Required | Notes                                           |
| --------------------- | --------------- | -------- | ----------------------------------------------- |
| `id`                  | string          | yes      | `connector:<id>` form, operator-installed.      |
| `acceptedKinds`       | `array<enum>`   | yes      | DataAsset kind subset (5値の closed enum から). |
| `spaceVisibility`     | `array<string>` | yes      | spaceId list operator policy 制御.              |
| `signingExpectations` | enum            | yes      | `none` / `optional` / `required`.               |
| `envelopeVersion`     | string          | yes      | 現状 `v1` のみ.                                 |
| `installedAt`         | timestamp       | yes      | 初回 install.                                   |
| `revokedAt`           | timestamp       | no       | revocation 時刻.                                |

Persistence: kept while `revokedAt` is null. Indexed by `(id)`. Immutability:
operator-only mutation.

See also: [Connector Contract](/reference/connector-contract).

## AuditLogEvent

A single append-only audit chain entry.

| Field       | Type      | Required | Notes                                               |
| ----------- | --------- | -------- | --------------------------------------------------- |
| `eventId`   | string    | yes      | `event:<ulid>` form.                                |
| `ts`        | timestamp | yes      | wall clock at event creation.                       |
| `spaceId`   | string    | no       | 該当 Space (cross-Space audit は null).             |
| `actor`     | string    | yes      | `operator` / `kernel` / `runtime-agent` / `system`. |
| `eventType` | enum      | yes      | audit-events.md の closed enum 値.                  |
| `severity`  | enum      | yes      | `debug` / `info` / `warn` / `error`.                |
| `payload`   | object    | yes      | event-type 固有の field map.                        |
| `prevHash`  | string    | yes      | 前 event の hash (chain integrity).                 |
| `hash`      | string    | yes      | 当 event の hash.                                   |

Persistence: compliance regime ごとの retention window (see
[Compliance Retention](/reference/compliance-retention)). Indexed by
`(spaceId, ts, actor, eventType)`. Immutability: append-only, never mutated.

See also: [Audit Events](/reference/audit-events).

## CatalogRelease Publisher Key

Operator-enrolled Ed25519 key used to verify CatalogRelease descriptors.

| Field             | Type      | Required | Notes                           |
| ----------------- | --------- | -------- | ------------------------------- |
| `keyId`           | string    | yes      | Publisher key identifier.       |
| `publisherId`     | string    | yes      | Trusted publisher owner.        |
| `publicKeyBase64` | string    | yes      | Raw Ed25519 public key, base64. |
| `status`          | enum      | yes      | `active` / `revoked`.           |
| `enrolledAt`      | timestamp | yes      | enrollment 完了時刻.            |
| `revokedAt`       | timestamp | no       | revoke 完了時刻.                |
| `reason`          | string    | no       | operator reason.                |

Persistence: operator trust root. Indexed by `(publisherId)` and `(status)`.

## CatalogRelease Descriptor

Signed descriptor body adopted by Spaces.

| Field                | Type      | Required | Notes                                     |
| -------------------- | --------- | -------- | ----------------------------------------- |
| `releaseId`          | string    | yes      | CatalogRelease id.                        |
| `publisherId`        | string    | yes      | descriptor signer publisher.              |
| `descriptorDigest`   | sha256    | yes      | sha256 over canonical payload.            |
| `descriptor`         | object    | yes      | Signed descriptor body including pins.    |
| `signatureAlgorithm` | string    | yes      | `Ed25519`.                                |
| `signatureKeyId`     | string    | yes      | key used for verification.                |
| `signatureValue`     | string    | yes      | base64 signature over canonical payload.  |
| `createdAt`          | timestamp | yes      | descriptor created time.                  |
| `activatedAt`        | timestamp | no       | publisher activation time, when supplied. |

Persistence: immutable while any adoption references the release. Indexed by
`(publisherId)`, `(descriptorDigest)`, and `(createdAt)`.

## CatalogReleaseAdoption

Per-Space adoption record for a catalog release.

| Field                         | Type      | Required | Notes                               |
| ----------------------------- | --------- | -------- | ----------------------------------- |
| `id`                          | string    | yes      | adoption record id.                 |
| `catalogReleaseId`            | string    | yes      | adopted release id.                 |
| `spaceId`                     | string    | yes      | adoption 対象 Space.                |
| `publisherId`                 | string    | yes      | descriptor publisher.               |
| `publisherKeyId`              | string    | yes      | adoption に使った publisher key id. |
| `descriptorDigest`            | sha256    | yes      | sha256 catalog descriptor digest.   |
| `adoptedAt`                   | timestamp | yes      | adoption 完了時刻.                  |
| `rotatedFromCatalogReleaseId` | string    | no       | rotation 元 release.                |
| `verification`                | object    | yes      | verifiedAt / algorithm / digest.    |

Persistence: kept while resolution が当 release を参照する間 + audit retention.
Indexed by `(spaceId, adoptedAt)`, `(catalogReleaseId)`, and `(publisherKeyId)`.
Immutability: operator-only append.

See also: [Catalog Release Trust](/reference/catalog-release-trust).

## ImplementationRegistry

Operator-managed registry of provider implementations.

| Field                 | Type            | Required | Notes                                          |
| --------------------- | --------------- | -------- | ---------------------------------------------- |
| `id`                  | string          | yes      | `implementation:<id>` form.                    |
| `providerKind`        | string          | yes      | namespaced provider id (e.g. `@takos/aws-s3`). |
| `acceptedShapes`      | `array<string>` | yes      | `shape@version` list.                          |
| `signingExpectations` | enum            | yes      | `none` / `optional` / `required`.              |
| `publicKey`           | string          | no       | optional, signed implementation の verify 用.  |
| `installedAt`         | timestamp       | yes      | install 時刻.                                  |
| `revokedAt`           | timestamp       | no       | revocation 時刻.                               |

Persistence: kept while `revokedAt` is null. Indexed by `(id, providerKind)`.
Immutability: operator-only.

See also:
[Provider Implementation Contract](/reference/provider-implementation-contract).

## LockRecord

Cross-process lock lease record held by a kernel pod.

| Field            | Type      | Required | Notes                               |
| ---------------- | --------- | -------- | ----------------------------------- |
| `lockId`         | string    | yes      | scope + key の合成 ID.              |
| `holderId`       | string    | yes      | kernel pod id (UUID).               |
| `acquiredAt`     | timestamp | yes      | acquisition 時刻.                   |
| `leaseExpiresAt` | timestamp | yes      | monotonic-derived expiry.           |
| `epoch`          | integer   | yes      | 取得 epoch (recovery で increment). |

Persistence: lease expire 後に削除可. Indexed by `(lockId)`. Immutability:
mutable in place: `leaseExpiresAt` / heartbeat 更新.

See also: [Cross-Process Locks](/reference/cross-process-locks).

## SecretPartitionReference

Per-Space encrypted reference into a secret partition. Raw secret material is
never embedded in this record.

| Field           | Type      | Required | Notes                                                                     |
| --------------- | --------- | -------- | ------------------------------------------------------------------------- |
| `partitionTag`  | string    | yes      | `global` / `aws` / `gcp` / `cloudflare` / `azure` / `k8s` / `selfhosted`. |
| `spaceId`       | string    | yes      | 所属 Space.                                                               |
| `keyGeneration` | integer   | yes      | rotation generation.                                                      |
| `createdAt`     | timestamp | yes      | 初回 reference 生成時刻.                                                  |
| `rotatedAt`     | timestamp | no       | rotation 時刻.                                                            |

Persistence: kept indefinitely (rotation 履歴は audit に依存). Indexed by
`(spaceId, partitionTag)`. Immutability: append-only generation. 注: raw secret
value は本 record に **絶対に含まれない** (reference のみ).

See also: [Secret Partitions](/reference/secret-partitions).

## Organization

Operator-managed group that owns one or more Spaces and their billing contact
actor.

| Field                   | Type      | Required | Notes                                                                                       |
| ----------------------- | --------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`                    | string    | yes      | `organization:<ulid>` form.                                                                 |
| `displayName`           | string    | yes      | Human-readable name.                                                                        |
| `billingContactActorId` | string    | yes      | Actor identity that receives billing-related notifications.                                 |
| `complianceRegime`      | enum      | no       | One of the audit retention regimes (`default` / `pci-dss` / `hipaa` / `sox` / `regulated`). |
| `metadata`              | object    | no       | Operator-defined metadata bag (no secrets).                                                 |
| `createdAt`             | timestamp | yes      | Creation time.                                                                              |

Persistence: kept indefinitely while any Space references the Organization, plus
the audit retention window. Indexed by `(id)` and `(billingContactActorId)`.

Immutability: `displayName`, `billingContactActorId`, `complianceRegime`, and
`metadata` are mutable in place; transitions emit audit events. `id` and
`createdAt` are immutable.

See also: [Actor / Organization Model](/reference/actor-organization-model).

## Membership

Binds an actor to an Organization at a coarse role level.

| Field            | Type      | Required | Notes                                         |
| ---------------- | --------- | -------- | --------------------------------------------- |
| `id`             | string    | yes      | `membership:<ulid>` form.                     |
| `actorId`        | string    | yes      | Actor identity.                               |
| `organizationId` | string    | yes      | Owning Organization.                          |
| `role`           | enum      | yes      | One of `owner`, `admin`, `member`, `billing`. |
| `joinedAt`       | timestamp | yes      | Acceptance time.                              |
| `leftAt`         | timestamp | no       | Departure / removal time; null while active.  |

Persistence: kept while `leftAt` is null, plus the audit retention window.
Indexed by `(organizationId, role)` and `(actorId)`.

Immutability: `role` and `leftAt` are mutable in place; lifecycle transitions
emit audit events. `id`, `actorId`, `organizationId`, and `joinedAt` are
immutable.

See also: [Actor / Organization Model](/reference/actor-organization-model).

## RoleAssignment

Binds an actor to a role at a closed scope (org-level or space-level) for the
[RBAC Policy](/reference/rbac-policy).

| Field        | Type      | Required | Notes                                                          |
| ------------ | --------- | -------- | -------------------------------------------------------------- |
| `id`         | string    | yes      | `role-assignment:<ulid>` form.                                 |
| `actorId`    | string    | yes      | Actor identity.                                                |
| `scope`      | enum      | yes      | One of `org-level`, `space-level`.                             |
| `scopeId`    | string    | yes      | `organizationId` for `org-level`; `spaceId` for `space-level`. |
| `role`       | enum      | yes      | One of the closed roles in the RBAC matrix.                    |
| `assignedAt` | timestamp | yes      | Assignment time.                                               |
| `expiresAt`  | timestamp | no       | Optional auto-expiry instant.                                  |
| `revokedAt`  | timestamp | no       | Manual revocation instant; null while active.                  |

Persistence: kept while `revokedAt` is null and `expiresAt` has not passed, plus
the audit retention window. Indexed by `(actorId)` and `(scope, scopeId, role)`.

Immutability: `expiresAt` and `revokedAt` are mutable in place; transitions emit
audit events. The other fields are immutable.

See also: [RBAC Policy](/reference/rbac-policy).

## APIKey

Per-actor API key record for programmatic access.

| Field           | Type      | Required | Notes                                                                          |
| --------------- | --------- | -------- | ------------------------------------------------------------------------------ |
| `id`            | string    | yes      | `api-key:<ulid>` form.                                                         |
| `actorId`       | string    | yes      | Actor identity bound to the key.                                               |
| `kind`          | enum      | yes      | One of the closed APIKey kinds (operator / actor / runtime-agent).             |
| `scope`         | object    | yes      | Scope descriptor (allowed orgs, spaces, capabilities).                         |
| `tokenHash`     | string    | yes      | Argon2id hash of the issued bearer token; the plaintext token is never stored. |
| `expiresAt`     | timestamp | yes      | Required expiry instant.                                                       |
| `createdAt`     | timestamp | yes      | Issue time.                                                                    |
| `rotatedFromId` | string    | no       | Predecessor APIKey id when this key was produced by rotation.                  |
| `revokedAt`     | timestamp | no       | Revocation instant; null while active.                                         |

Persistence: kept while `revokedAt` is null and `expiresAt` has not passed, plus
the audit retention window. Indexed by `(actorId, kind)` and `(tokenHash)`.

Immutability: `revokedAt` is mutable in place; rotation produces a new APIKey
record with `rotatedFromId` set rather than mutating the prior record. The other
fields are immutable.

See also: [API Key Management](/reference/api-key-management).

## AuthProvider

Operator-installed authentication provider configuration.

| Field          | Type      | Required | Notes                                                                                                                   |
| -------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`           | string    | yes      | `auth-provider:<ulid>` form.                                                                                            |
| `type`         | enum      | yes      | One of the closed auth-provider types (`oidc` / `mtls` / `runtime-agent-enrollment` / `bearer-token`).                  |
| `config`       | object    | yes      | Full provider configuration JSON. Secret-bearing fields are stored as secret references (`secret://...`), never inline. |
| `registeredAt` | timestamp | yes      | Install time.                                                                                                           |
| `revokedAt`    | timestamp | no       | Revocation instant; null while active.                                                                                  |

Persistence: kept while `revokedAt` is null, plus the audit retention window.
Indexed by `(id)` and `(type)`.

Immutability: `config` is mutable in place; updates emit audit events.
`revokedAt` is mutable in place. `id`, `type`, and `registeredAt` are immutable.

See also: [Auth Providers](/reference/auth-providers).

## TrialAttribute

Trial-specific metadata attached to a Space.

| Field              | Type      | Required | Notes                                                                 |
| ------------------ | --------- | -------- | --------------------------------------------------------------------- |
| `spaceId`          | string    | yes      | Owning Space; primary key.                                            |
| `trial`            | boolean   | yes      | Always `true` while the attribute is present.                         |
| `trialExpiresAt`   | timestamp | yes      | Trial expiry instant.                                                 |
| `trialQuotaTierId` | string    | yes      | QuotaTier applied while the trial is active.                          |
| `trialOrigin`      | enum      | yes      | Closed origin enum (e.g. `self-service`, `operator-grant`, `import`). |

Persistence: kept while the Space is in the trial state. On conversion the
record is removed; on cleanup the record is removed together with the Space.
Indexed by `(trialExpiresAt)`.

Immutability: `trialExpiresAt` and `trialQuotaTierId` are mutable in place via
the trial-extension flow; transitions emit audit events. `spaceId`, `trial`, and
`trialOrigin` are immutable.

See also: [Trial Spaces](/reference/trial-spaces).

## ProvisioningSession

Tracks an in-flight Space provisioning attempt.

| Field          | Type      | Required | Notes                                                                                                      |
| -------------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`           | string    | yes      | `provisioning-session:<ulid>` form.                                                                        |
| `spaceId`      | string    | yes      | Target Space.                                                                                              |
| `status`       | enum      | yes      | One of the closed provisioning statuses (e.g. `pending`, `running`, `completed`, `failed`, `rolled-back`). |
| `currentStage` | enum      | yes      | One of the closed provisioning stage values.                                                               |
| `startedAt`    | timestamp | yes      | Session start time.                                                                                        |
| `completedAt`  | timestamp | no       | Terminal time when `status` is `completed`, `failed`, or `rolled-back`.                                    |
| `error`        | object    | no       | Closed error envelope (`errorCode`, `message`, `stage`) on failure.                                        |

Persistence: kept while `status` is non-terminal, plus the audit retention
window after a terminal status. Indexed by `(spaceId, status)` and
`(startedAt)`.

Immutability: `status`, `currentStage`, `completedAt`, and `error` are mutable
in place; transitions emit audit events. The other fields are immutable.

See also: [Tenant Provisioning](/reference/tenant-provisioning).

## ExportJob

Tracks a Space export request.

| Field                  | Type      | Required | Notes                                                               |
| ---------------------- | --------- | -------- | ------------------------------------------------------------------- |
| `id`                   | string    | yes      | `export-job:<ulid>` form.                                           |
| `spaceId`              | string    | yes      | Source Space.                                                       |
| `mode`                 | enum      | yes      | Closed export mode (e.g. `full`, `metadata-only`, `audit-only`).    |
| `status`               | enum      | yes      | Closed export status (`pending`, `running`, `completed`, `failed`). |
| `artifactSha256`       | sha256    | no       | Digest of the export artifact when `status` is `completed`.         |
| `downloadUrlExpiresAt` | timestamp | no       | Expiry instant of the issued pre-signed download URL.               |
| `requestedAt`          | timestamp | yes      | Request time.                                                       |
| `completedAt`          | timestamp | no       | Terminal time when `status` is `completed` or `failed`.             |

Persistence: kept while the artifact is downloadable, plus the audit retention
window. Indexed by `(spaceId, requestedAt)` and `(status)`.

Immutability: `status`, `artifactSha256`, `downloadUrlExpiresAt`, and
`completedAt` are mutable in place; transitions emit audit events. The other
fields are immutable.

See also: [Tenant Export / Deletion](/reference/tenant-export-deletion).

## QuotaTier

Operator-managed quota tier definition.

| Field                | Type      | Required | Notes                                                                                                                                   |
| -------------------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tierId`             | string    | yes      | `quota-tier:<id>` form; primary key.                                                                                                    |
| `dimensions`         | object    | yes      | Closed dimension map: `deploymentCount`, `artifactStorageBytes`, `journalVolumeBytes`, `approvalPendingCount`, `spaceExportShareCount`. |
| `rateLimitOverrides` | object    | no       | Optional rate-limit overrides keyed by closed rate-limit dimension.                                                                     |
| `createdAt`          | timestamp | yes      | Registration time.                                                                                                                      |

Persistence: kept while any Space references the tier, plus the audit retention
window. Indexed by `(tierId)`.

Immutability: `dimensions` and `rateLimitOverrides` are mutable in place;
updates emit audit events. `tierId` and `createdAt` are immutable.

See also: [Quota Tiers](/reference/quota-tiers).

## CostAttributionConfig

Per-Space cost attribution configuration.

| Field         | Type      | Required | Notes                                                                                                                            |
| ------------- | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `spaceId`     | string    | yes      | Owning Space; primary key.                                                                                                       |
| `attribution` | object    | yes      | Closed-key attribution map (cost-center, project, environment, owner-actor). Values are operator-controlled strings; no secrets. |
| `updatedAt`   | timestamp | yes      | Last update time.                                                                                                                |

Persistence: kept while the Space exists, plus the audit retention window.
Indexed by `(spaceId)`.

Immutability: `attribution` and `updatedAt` are mutable in place; updates emit
audit events. `spaceId` is immutable.

See also: [Cost Attribution](/reference/cost-attribution).

## SLAThreshold

Operator-registered SLA threshold definition.

| Field          | Type      | Required    | Notes                                      |
| -------------- | --------- | ----------- | ------------------------------------------ |
| `id`           | string    | yes         | `sla-threshold:<ulid>` form.               |
| `dimension`    | enum      | yes         | One of the closed v1 SLA dimensions.       |
| `comparator`   | enum      | yes         | One of `gt`, `gte`, `lt`, `lte`.           |
| `value`        | number    | yes         | Threshold value.                           |
| `scope`        | enum      | yes         | One of `kernel-global`, `org`, `space`.    |
| `scopeId`      | string    | conditional | Required when `scope` is `org` or `space`. |
| `registeredAt` | timestamp | yes         | Registration time.                         |

Persistence: kept while the threshold is active, plus the audit retention
window. Indexed by `(dimension, scope, scopeId)`.

Immutability: `comparator` and `value` are mutable in place; transitions emit
audit events. The other fields are immutable.

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## SLAObservation

Append-only point-in-time SLA observation.

| Field       | Type      | Required    | Notes                                      |
| ----------- | --------- | ----------- | ------------------------------------------ |
| `id`        | string    | yes         | `sla-observation:<ulid>` form.             |
| `dimension` | enum      | yes         | One of the closed v1 SLA dimensions.       |
| `scope`     | enum      | yes         | One of `kernel-global`, `org`, `space`.    |
| `scopeId`   | string    | conditional | Required when `scope` is `org` or `space`. |
| `value`     | number    | yes         | Observed value at `ts`.                    |
| `ts`        | timestamp | yes         | Observation time.                          |

Persistence: kept for the observation retention window (see
[Observation Retention](/reference/observation-retention)). Indexed by
`(dimension, scope, scopeId, ts)`.

Immutability: append-only; never mutated.

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## Incident

Operator- or auto-detection-opened incident record.

| Field                  | Type            | Required | Notes                                                                                    |
| ---------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`                   | string          | yes      | `incident:<ulid>` form.                                                                  |
| `title`                | string          | yes      | Human-readable summary.                                                                  |
| `state`                | enum            | yes      | One of the closed incident states (`detected`, `acknowledged`, `mitigated`, `resolved`). |
| `severity`             | enum            | yes      | One of the closed incident severity values.                                              |
| `origin`               | enum            | yes      | One of `auto-detection`, `operator`, `customer-report`.                                  |
| `affectedSpaceIds`     | `array<string>` | yes      | Spaces affected; may be empty.                                                           |
| `affectedOrgIds`       | `array<string>` | yes      | Organizations affected; may be empty.                                                    |
| `detectedAt`           | timestamp       | yes      | Detection time.                                                                          |
| `acknowledgedAt`       | timestamp       | no       | Acknowledgement time.                                                                    |
| `mitigatedAt`          | timestamp       | no       | Mitigation time.                                                                         |
| `resolvedAt`           | timestamp       | no       | Resolution time.                                                                         |
| `rootCause`            | string          | no       | Operator-provided summary; recorded on resolution.                                       |
| `relatedAuditEventIds` | `array<string>` | yes      | Audit events that anchor the incident timeline.                                          |

Persistence: kept indefinitely while `state` is non-`resolved`, plus the audit
retention window after resolution. Indexed by `(state, severity, detectedAt)`.

Immutability: `state`, `severity`, `acknowledgedAt`, `mitigatedAt`,
`resolvedAt`, `rootCause`, and `relatedAuditEventIds` are mutable in place;
transitions emit audit events. The other fields are immutable.

See also: [Incident Model](/reference/incident-model).

## SupportImpersonationGrant

Approved or pending grant that allows a support actor to impersonate within a
Space.

| Field            | Type      | Required | Notes                                                                          |
| ---------------- | --------- | -------- | ------------------------------------------------------------------------------ |
| `id`             | string    | yes      | `support-impersonation-grant:<ulid>` form.                                     |
| `supportActorId` | string    | yes      | Support-staff actor identity.                                                  |
| `spaceId`        | string    | yes      | Target Space.                                                                  |
| `requestedAt`    | timestamp | yes      | Request time.                                                                  |
| `approvedAt`     | timestamp | no       | Approval time; null while pending.                                             |
| `scope`          | enum      | yes      | One of `read`, `read-write`.                                                   |
| `status`         | enum      | yes      | Closed grant status (`pending`, `approved`, `rejected`, `revoked`, `expired`). |
| `expiresAt`      | timestamp | no       | Optional expiry instant.                                                       |
| `revokedAt`      | timestamp | no       | Revocation instant; null unless `status` is `revoked`.                         |

Persistence: kept while `status` is non-terminal, plus the audit retention
window. Indexed by `(supportActorId, status)` and `(spaceId, status)`.

Immutability: `status`, `approvedAt`, `expiresAt`, and `revokedAt` are mutable
in place; transitions emit audit events. The other fields are immutable.

See also: [Support Impersonation](/reference/support-impersonation).

## SupportImpersonationSession

Open or closed support impersonation session under an approved grant.

| Field              | Type      | Required | Notes                                                                 |
| ------------------ | --------- | -------- | --------------------------------------------------------------------- |
| `id`               | string    | yes      | `support-impersonation-session:<ulid>` form.                          |
| `grantId`          | string    | yes      | Backing SupportImpersonationGrant.                                    |
| `openedAt`         | timestamp | yes      | Session start time.                                                   |
| `endedAt`          | timestamp | no       | Session close time; null while open.                                  |
| `sessionTokenHash` | string    | yes      | Argon2id hash of the session bearer token; plaintext is never stored. |
| `acceptScope`      | enum      | yes      | One of `read`, `read-write`; bounded by the grant scope.              |

Persistence: kept while the session is open, plus the audit retention window.
Indexed by `(grantId)` and `(openedAt)`.

Immutability: `endedAt` is mutable in place; the other fields are immutable.
Write actions performed within a `read-write` session are recorded as audit
events rather than mutations on this record.

See also: [Support Impersonation](/reference/support-impersonation).

## NotificationSignal

Pull-only notification record.

| Field               | Type            | Required    | Notes                                               |
| ------------------- | --------------- | ----------- | --------------------------------------------------- |
| `id`                | string          | yes         | `notification:<ulid>` form.                         |
| `category`          | enum            | yes         | One of the closed v1 notification categories.       |
| `scope`             | enum            | yes         | One of `kernel-global`, `org`, `space`.             |
| `scopeId`           | string          | conditional | Required when `scope` is `org` or `space`.          |
| `payload`           | object          | yes         | Category-specific payload; redacted of secrets.     |
| `recipientActorIds` | `array<string>` | yes         | Actors that may pull the signal.                    |
| `emittedAt`         | timestamp       | yes         | Emission time.                                      |
| `acknowledgedAt`    | timestamp       | no          | Acknowledgement time when a recipient acknowledges. |

Persistence: kept while unacknowledged, plus the audit retention window. Indexed
by `(scope, scopeId, emittedAt)` and `(recipientActorIds)`.

Immutability: `acknowledgedAt` is mutable in place; transitions emit audit
events. The other fields are immutable.

See also: [Notification Emission](/reference/notification-emission).

## ZoneAttribute

Zone attribute model attached to Space, Object, DataAsset, and Connector records
to express single-region zone preferences. The attribute is a layered overlay
rather than a standalone table; it is materialized as the following fields on
the host records:

| Host record | Field            | Type   | Required | Notes                                                                                                                         |
| ----------- | ---------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Space       | `defaultZone`    | string | yes      | The Space's default zone identifier. All Objects and DataAssets in the Space inherit this zone unless they declare their own. |
| Object      | `zone`           | string | yes      | The materialized zone for this Object. Inherited from Space `defaultZone` at creation; may be overridden at create time.      |
| DataAsset   | `zonePreference` | string | no       | Declared zone preference; resolved against connector zone constraints at bind time.                                           |
| Connector   | `zonePreference` | string | no       | Operator-declared zone preference for the connector implementation.                                                           |

Persistence: each field is co-persisted with its host record and inherits the
host's persistence and retention rules. No standalone ZoneAttribute table
exists.

Indexing: `(spaceId, defaultZone)` on Space; `(spaceId, zone)` on Object;
`(zonePreference)` on DataAsset and Connector when present.

Immutability: `defaultZone` is mutable in place at the Space level (transitions
emit audit events). Object `zone` is immutable once the Object is created; zone
movement is performed by replacing the Object. DataAsset and Connector
`zonePreference` are mutable in place by the operator.

Relationship: Object zone resolves from Space `defaultZone`; DataAsset binding
requires zone-compatibility between the Space `defaultZone` and the Connector
`zonePreference`. Cross-zone links are governed by the cross-zone link policy;
see [Zone Selection](/reference/zone-selection).

See also: [Zone Selection](/reference/zone-selection).

## Trigger

Reserved workflow-extension record. The current kernel does not create or
persist Trigger rows yet.

Per-fire instance of a registered trigger.

| Field                     | Type      | Required    | Notes                                                                |
| ------------------------- | --------- | ----------- | -------------------------------------------------------------------- |
| `id`                      | string    | yes         | `trigger:<ulid>` form.                                               |
| `registrationId`          | string    | yes         | `trigger-registration:<ulid>` form.                                  |
| `spaceId`                 | string    | yes         | Owning Space.                                                        |
| `kind`                    | enum      | yes         | One of `manual`, `schedule`, `external-event`.                       |
| `firedAt`                 | timestamp | yes         | Fire time.                                                           |
| `payload`                 | object    | conditional | `external-event` only. Opaque JSON, redacted of secrets.             |
| `causedOperationId`       | string    | conditional | Resulting OperationPlan id; present only when `status` is `fired`.   |
| `status`                  | enum      | yes         | One of `fired`, `rejected`, `deduplicated`.                          |
| `dedupReferenceTriggerId` | string    | conditional | Required when `status` is `deduplicated`; references the prior fire. |

Persistence: kept until the audit retention window passes. Indexed by
`(spaceId, firedAt)` and `(registrationId, firedAt)`.

Immutability: append-only. Trigger records are never mutated after insert.

See also: [Triggers](/reference/triggers).

## TriggerRegistration

Reserved workflow-extension record. The current kernel does not create or
persist TriggerRegistration rows yet.

Operator- or actor-registered trigger source.

| Field              | Type      | Required    | Notes                                                                            |
| ------------------ | --------- | ----------- | -------------------------------------------------------------------------------- |
| `id`               | string    | yes         | `trigger-registration:<ulid>` form.                                              |
| `spaceId`          | string    | yes         | Owning Space.                                                                    |
| `resourceRef`      | string    | yes         | `object:<resource-name>` form; the manifest resource the trigger fires against.  |
| `kind`             | enum      | yes         | One of `manual`, `schedule`, `external-event`.                                   |
| `spec`             | object    | yes         | Kind-specific spec (cron expression / external event name / manual descriptor).  |
| `secretHash`       | string    | conditional | `external-event` only. Argon2id hash of the HMAC secret; plaintext never stored. |
| `missedFirePolicy` | enum      | conditional | `schedule` only. One of `skip`, `catchup-latest`.                                |
| `createdAt`        | timestamp | yes         | Registration time.                                                               |
| `revokedAt`        | timestamp | no          | Revocation instant; null while active.                                           |

Persistence: kept while `revokedAt` is null. Indexed by `(spaceId, kind)` and
`(resourceRef)`.

Immutability: `revokedAt` is mutable in place; transitions emit audit events.
The other fields are immutable.

See also: [Triggers](/reference/triggers).

## HookBinding

Reserved declarable-hook record. Catalog-supplied executable WAL hooks are
implemented separately and do not create HookBinding rows.

Declared hook binding to a lifecycle phase boundary on a deployment.

| Field                | Type      | Required | Notes                                                                                             |
| -------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------- |
| `id`                 | string    | yes      | `hook-binding:<ulid>` form.                                                                       |
| `spaceId`            | string    | yes      | Owning Space.                                                                                     |
| `resourceRef`        | string    | yes      | `object:<hook-resource-name>` form; the manifest hook resource.                                   |
| `hookOrder`          | enum      | yes      | Cross product of lifecycle phase and hook order (e.g. `pre-apply`, `post-apply`, `side-observe`). |
| `bindToDeploymentId` | string    | yes      | Deployment the hook binds against.                                                                |
| `bundleRef`          | string    | yes      | `dataasset:sha256:...` form; DataAsset bundle the hook executes via runtime-agent.                |
| `failurePolicy`      | enum      | yes      | One of `abort`, `warn`.                                                                           |
| `timeout`            | duration  | yes      | Per-hook execution timeout.                                                                       |
| `createdAt`          | timestamp | yes      | Binding creation time.                                                                            |
| `revokedAt`          | timestamp | no       | Revocation instant; null while active.                                                            |

Persistence: kept while `revokedAt` is null OR the last fire is still within the
audit retention window. Indexed by `(spaceId, bindToDeploymentId, hookOrder)`.

Immutability: `revokedAt` is mutable in place; transitions emit audit events.
The other fields are immutable.

See also: [Declarable Hooks](/reference/declarable-hooks).

## See also

- [Actor / Organization Model](/reference/actor-organization-model)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export / Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)
- [Triggers](/reference/triggers)
- [Execute-Step Operation](/reference/execute-step-operation)
- [Declarable Hooks](/reference/declarable-hooks)

## Implementation freedom

Kernel implementations are free to:

- Persist a subset of these record classes in a single physical store.
- Materialize OperationPlan from the JournalEntry stream rather than storing the
  plan body, as long as `planDigest` remains computable and verifiable.
- Combine ObservationSet and DriftIndex into a single physical store so long as
  the logical fields above remain queryable.
- Replace the suggested indexes with equivalent indexes that satisfy the
  documented query patterns.

Implementations are not free to:

- Mutate immutable snapshot records in place.
- Drop fields whose presence is required to satisfy
  [Journal Compaction](/reference/journal-compaction) retention rules.
- Persist secret values inline; secrets are referenced, never embedded (see
  [Audit Events](/reference/audit-events)).

## Related architecture notes

- `reference/architecture/snapshot-model` — the immutable snapshot taxonomy.
- `reference/architecture/operation-plan-write-ahead-journal-model` — WAL stage
  enum and idempotency tuple.
- `reference/architecture/observation-drift-revokedebt-model` — observation,
  drift, and RevokeDebt semantics.
- `reference/architecture/policy-risk-approval-error-model` — Approval
  invalidation triggers and risk enum.
- `reference/architecture/namespace-export-model` — SpaceExportShare lifecycle.
