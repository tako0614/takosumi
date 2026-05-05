# Audit Events

> Stability: stable Audience: operator, kernel-implementer, integrator See also:
> [Storage Schema](/reference/storage-schema),
> [Journal Compaction](/reference/journal-compaction),
> [Connector Contract](/reference/connector-contract),
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

The audit log is the tamper-evident record of decisions, state transitions, and
operator-visible side effects in a Takosumi installation. This reference defines
the v1 event taxonomy: the common envelope each event carries, the closed
event-type enum, the indexed columns used for query, the redaction rule that
keeps secrets out of the audit store, the hash chain that gives the audit log
its tamper-evidence property, and the retention regimes that operators select
per Space.

## Common event envelope

Every audit event carries the same envelope. Implementations may serialize the
envelope as JSON, CBOR, or another canonical encoding so long as the field set
and ordering used for hash computation are stable.

| Field       | Type      | Required | Notes                                                                                                                          |
| ----------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `eventId`   | string    | yes      | Unique per event.                                                                                                              |
| `ts`        | timestamp | yes      | RFC 3339 UTC, millisecond precision.                                                                                           |
| `spaceId`   | string    | no       | Owning Space. Nullable for cross-Space events such as `share-created`.                                                         |
| `actor`     | string    | yes      | Identity of the principal that caused the event (operator id, deploy bearer subject, or `system` for kernel-initiated events). |
| `eventType` | enum      | yes      | One of the closed v1 enum below.                                                                                               |
| `severity`  | enum      | yes      | One of `info`, `notice`, `warning`, `error`, `critical`.                                                                       |
| `prevHash`  | sha256    | yes      | Hash of the immediately previous event in this chain.                                                                          |
| `hash`      | sha256    | yes      | Hash of the canonical bytes of this event including `prevHash`.                                                                |

The envelope additionally carries an event-type-specific `payload` object whose
schema is fixed per event type. Unknown payload fields are rejected at write
time; the envelope is not extensible without an RFC.

## Closed event-type enum (v1)

The v1 audit event taxonomy is closed and contains 88+ event types across the
kernel, identity, tenant, PaaS-operations, and workflow domains. Adding a new
event type goes through the `CONVENTIONS.md` §6 RFC and extends, never replaces,
the closed enum below.

Deployment lifecycle:

- `deployment-created`
- `deployment-applied`
- `deployment-destroyed`

Resolve / desired:

- `resolution-recorded`
- `desired-recorded`

Operation / WAL:

- `operation-intent-recorded`
- `operation-completed`
- `operation-failed`
- `compensation-completed`

Approval:

- `approval-issued`
- `approval-consumed`
- `approval-denied`
- `approval-invalidated`

RevokeDebt:

- `revoke-debt-created`
- `revoke-debt-aged`
- `revoke-debt-cleared`

Activation:

- `activation-snapshot-created`
- `group-head-moved`

Drift:

- `drift-detected`

Cross-Space share:

- `share-created`
- `share-activated`
- `share-refreshed`
- `share-stale`
- `share-revoked`

Catalog and connector:

- `catalog-release-adopted`
- `catalog-release-rotated`
- `publisher-key-enrolled`
- `publisher-key-revoked`

External participants:

- `external-participant-registered`
- `external-participant-revoked`

Secret partition:

- `secret-partition-rotated`

Locks:

- `lock-acquired`
- `lock-released`
- `lock-recovered`

Identity:

- `api-key-issued`
- `api-key-rotated`
- `api-key-revoked`
- `api-key-used`
- `api-key-expired`
- `auth-provider-registered`
- `auth-provider-revoked`
- `auth-success`
- `auth-failure`
- `membership-invited`
- `membership-accepted`
- `membership-left`
- `membership-removed`
- `role-assignment-created`
- `role-assignment-revoked`
- `role-assignment-expired`

Tenant:

- `space-provisioned`
- `space-provisioning-failed`
- `space-export-started`
- `space-export-completed`
- `space-export-failed`
- `space-soft-deleted`
- `space-restored`
- `space-hard-deleted`
- `space-redaction-applied`

Trial:

- `trial-space-created`
- `trial-extended`
- `trial-expired`
- `trial-converted`
- `trial-cleaned-up`

Incident:

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

Support impersonation:

- `support-impersonation-requested`
- `support-impersonation-approved`
- `support-impersonation-rejected`
- `support-impersonation-revoked`
- `support-impersonation-expired`
- `support-impersonation-session-started`
- `support-impersonation-session-ended`
- `support-impersonation-write-action-recorded`

Notification:

- `notification-emitted`
- `notification-acknowledged`

SLA:

- `sla-warning-raised`
- `sla-breach-detected`
- `sla-recovering`
- `sla-recovered`
- `sla-threshold-changed`

Cost / quota:

- `space-attribution-changed`
- `quota-tier-registered`
- `quota-tier-updated`
- `quota-tier-removed`
- `space-tier-changed`

Trigger:

- `trigger-fired`
- `trigger-rejected`
- `trigger-deduplicated`

Hook:

- `hook-fired`
- `hook-completed`
- `hook-failed`

Step execution:

- `step-execution-started`
- `step-execution-completed`

This list is the complete v1 enum. Any value outside the list is rejected at
write time and surfaces as an audit-store integrity failure.

## Indexed columns

Implementations index the audit store on the following columns:

- `spaceId` — primary scope for per-Space queries.
- `ts` — required for time-range queries and retention sweeps.
- `actor` — required for actor-pivot investigation queries.
- `eventType` — required for filtering by taxonomy.

Implementations may add additional indexes (e.g. on `severity`) but must not
require additional indexed columns from upstream callers.

## Redaction rule

Secret values never appear in the audit log. The audit envelope records secret
partition rotations, secret access decisions, and secret-bound approvals by
reference, never by value.

- A `secret-partition-rotated` event records the partition identifier, the prior
  and new partition digest, and the actor. The event never contains plaintext
  secret values.
- An event whose payload would otherwise carry a secret value records the secret
  reference (`secret://<partition>/<key>`) and the digest of the access
  decision, not the value.
- The kernel rejects an audit write whose canonical payload contains a substring
  matching the active secret-partition redaction set. The rejection itself is
  recorded as a `severity: critical` `operation-failed` event with
  `errorCode: secret_redaction_failed`.

The redaction rule is enforced by the audit writer, not by the caller. A caller
that omits redaction is detected and refused.

## Hash chain

The audit log carries tamper-evidence through a per-Space and a global hash
chain.

Rationale: per-Space chain は tenant 内 audit integrity を Space operator 単独で
verify 可能にし、Space 間で互いに信頼を要求しない。global chain は cross-Space
event の total order を保証し、checkpoint で全 Space の chain head を bundle
する。1 chain だけでは Space tenant の独立 audit と global ordering
を両立できず、per-Space のみでは cross-Space 攻撃 (片側を 削除して別 Space
で再生する等) を検出できない。

- Each event's `hash` is the digest of the canonical envelope bytes including
  `prevHash`. This makes any single-event mutation detectable: re-deriving the
  chain from genesis surfaces the first divergent event.
- Each Space carries its own per-Space chain. The `prevHash` field references
  the immediately previous event in that Space.
- A global chain layers above the per-Space chains. Each per-Space chain
  rotation point produces a global checkpoint; the global chain's `prevHash`
  references the previous global checkpoint, and the checkpoint payload includes
  the per-Space chain heads at the time of rotation.
- Chain rotation runs on a configurable cadence
  (`TAKOSUMI_AUDIT_CHAIN_ROTATION_INTERVAL_HOURS`, default `24`) and on demand.
  Rotation produces a `lock-acquired` / `lock-released` pair around the rotation
  window.

Tamper detection runs offline. Operators verify chain integrity with internal
operator tooling; the current public `takosumi` CLI does not expose
`audit verify`.

The verifier walks the chain from genesis, recomputes each hash, and reports the
first divergence (if any). Verification does not mutate the audit store and does
not require quiescing the kernel.

## Retention regimes

Audit retention is governed by per-Space regimes. Each regime fixes a default
retention window and a set of fields that must remain queryable for the
duration. The regimes are:

- `default` — operator-tunable retention window, no compliance guarantee.
- `pci-dss` — PCI DSS-aligned retention.
- `hipaa` — HIPAA-aligned retention.
- `sox` — SOX-aligned retention.
- `regulated` — operator-extended regime for jurisdictional requirements that
  exceed the named regimes.

The regimes themselves, the retention windows they imply, the field sets they
protect, and the regime-selection rules are defined in the operator-facing
compliance reference. This audit-events reference defines only the event-shape
contract; the retention windows attach to the events recorded here.

## Event payload notes

Every event payload conforms to the closed schema for its `eventType`. The
schemas reference records defined in
[Storage Schema](/reference/storage-schema):

- Resolve / desired / operation / activation events reference
  ResolutionSnapshot, DesiredSnapshot, OperationPlan, JournalEntry, and
  ActivationSnapshot ids and digests.
- Approval events reference Approval ids and the closed risk enum.
- Drift and RevokeDebt events reference DriftIndex and RevokeDebt ids
  respectively.
- Share events reference SpaceExportShare ids and lifecycle transitions.
- Catalog and connector events reference Connector identities under the
  `connector:<id>` form (see
  [Connector Contract](/reference/connector-contract)).

A payload is rejected at write time if any referenced id is not resolvable in
the audit store's referential view at the time of the write.

## Identity events

| Event                      | Severity | Description                                                    | Payload fields                                                       |
| -------------------------- | -------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `api-key-issued`           | info     | An APIKey was issued for an actor.                             | `apiKeyId`, `actorId`, `kind`, `scope`, `expiresAt`, `issuedBy`      |
| `api-key-rotated`          | info     | An APIKey rotation produced a new key from an existing one.    | `apiKeyId`, `rotatedFromId`, `actorId`, `expiresAt`, `rotatedBy`     |
| `api-key-revoked`          | warning  | An APIKey was revoked before its natural expiry.               | `apiKeyId`, `actorId`, `reason`, `revokedBy`                         |
| `api-key-used`             | info     | An APIKey was presented at an authentication boundary.         | `apiKeyId`, `actorId`, `kind`, `requestPath`, `result`               |
| `api-key-expired`          | info     | An APIKey reached `expiresAt` and was auto-revoked.            | `apiKeyId`, `actorId`, `expiresAt`                                   |
| `auth-provider-registered` | notice   | An AuthProvider record was installed by the operator.          | `providerId`, `type`, `registeredBy`                                 |
| `auth-provider-revoked`    | warning  | An AuthProvider was revoked.                                   | `providerId`, `type`, `revokedBy`, `reason`                          |
| `auth-success`             | info     | An authentication attempt resolved an actor identity.          | `actorId`, `providerId`, `mechanism`, `requestPath`                  |
| `auth-failure`             | warning  | An authentication attempt failed at a kernel-managed boundary. | `providerId`, `mechanism`, `requestPath`, `errorCode`                |
| `membership-invited`       | info     | An actor was invited into an Organization.                     | `organizationId`, `actorId`, `role`, `invitedBy`                     |
| `membership-accepted`      | info     | An actor accepted an Organization membership invite.           | `organizationId`, `actorId`, `role`, `acceptedAt`                    |
| `membership-left`          | notice   | An actor voluntarily left an Organization.                     | `organizationId`, `actorId`, `leftAt`                                |
| `membership-removed`       | warning  | An actor was removed from an Organization by another actor.    | `organizationId`, `actorId`, `removedBy`, `reason`                   |
| `role-assignment-created`  | notice   | A RoleAssignment binding role-to-actor was created.            | `assignmentId`, `actorId`, `scope`, `scopeId`, `role`, `assignedBy`  |
| `role-assignment-revoked`  | warning  | A RoleAssignment was revoked.                                  | `assignmentId`, `actorId`, `scope`, `scopeId`, `revokedBy`, `reason` |
| `role-assignment-expired`  | info     | A RoleAssignment reached its `expiresAt` and was auto-revoked. | `assignmentId`, `actorId`, `scope`, `scopeId`, `expiresAt`           |

See also: [Actor / Organization Model](/reference/actor-organization-model),
[API Key Management](/reference/api-key-management),
[Auth Providers](/reference/auth-providers),
[RBAC Policy](/reference/rbac-policy).

## Tenant events

| Event                       | Severity | Description                                             | Payload fields                                                             |
| --------------------------- | -------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `space-provisioned`         | info     | A Space completed provisioning successfully.            | `spaceId`, `organizationId`, `quotaTierId`, `provisioningSessionId`        |
| `space-provisioning-failed` | error    | A Space provisioning session failed and rolled back.    | `provisioningSessionId`, `spaceId`, `stage`, `errorCode`                   |
| `space-export-started`      | info     | A Space export job started.                             | `exportJobId`, `spaceId`, `mode`, `requestedBy`                            |
| `space-export-completed`    | info     | A Space export job completed and produced an artifact.  | `exportJobId`, `spaceId`, `mode`, `artifactSha256`, `downloadUrlExpiresAt` |
| `space-export-failed`       | error    | A Space export job failed.                              | `exportJobId`, `spaceId`, `mode`, `errorCode`                              |
| `space-soft-deleted`        | warning  | A Space was placed into soft-deleted state.             | `spaceId`, `requestedBy`, `softDeletedAt`, `retentionExpiresAt`            |
| `space-restored`            | notice   | A soft-deleted Space was restored.                      | `spaceId`, `restoredBy`, `restoredAt`                                      |
| `space-hard-deleted`        | critical | A Space was hard-deleted; tenant data is unrecoverable. | `spaceId`, `requestedBy`, `hardDeletedAt`, `redactionDigest`               |
| `space-redaction-applied`   | warning  | A right-to-erasure redaction was applied to a Space.    | `spaceId`, `requestedBy`, `redactionScope`, `redactionDigest`              |

See also: [Tenant Provisioning](/reference/tenant-provisioning),
[Tenant Export / Deletion](/reference/tenant-export-deletion).

## Trial events

| Event                 | Severity | Description                                               | Payload fields                                                                   |
| --------------------- | -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `trial-space-created` | info     | A Space was created with the trial attribute.             | `spaceId`, `organizationId`, `trialExpiresAt`, `trialQuotaTierId`, `trialOrigin` |
| `trial-extended`      | notice   | A trial Space had its `trialExpiresAt` extended.          | `spaceId`, `previousExpiresAt`, `newExpiresAt`, `extendedBy`                     |
| `trial-expired`       | warning  | A trial Space passed `trialExpiresAt` without conversion. | `spaceId`, `trialExpiresAt`                                                      |
| `trial-converted`     | info     | A trial Space converted to a paid quota tier.             | `spaceId`, `previousQuotaTierId`, `newQuotaTierId`, `convertedBy`                |
| `trial-cleaned-up`    | warning  | An expired trial Space was cleaned up.                    | `spaceId`, `cleanedUpAt`, `redactionDigest`                                      |

See also: [Trial Spaces](/reference/trial-spaces).

## Incident events

| Event                           | Severity | Description                                                   | Payload fields                                                           |
| ------------------------------- | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `incident-detected`             | error    | An incident was opened, either by auto-detection or operator. | `incidentId`, `severity`, `origin`, `affectedSpaceIds`, `affectedOrgIds` |
| `incident-acknowledged`         | notice   | An incident was acknowledged by an operator.                  | `incidentId`, `acknowledgedBy`, `acknowledgedAt`                         |
| `incident-state-changed`        | notice   | An incident transitioned between lifecycle states.            | `incidentId`, `previousState`, `newState`, `changedBy`                   |
| `incident-severity-changed`     | warning  | An incident's severity level changed.                         | `incidentId`, `previousSeverity`, `newSeverity`, `changedBy`             |
| `incident-resolved`             | notice   | An incident was resolved.                                     | `incidentId`, `resolvedBy`, `resolvedAt`, `rootCause`                    |
| `incident-postmortem-published` | info     | A postmortem was attached to an incident.                     | `incidentId`, `postmortemDigest`, `publishedBy`                          |

See also: [Incident Model](/reference/incident-model),
[SLA Breach Detection](/reference/sla-breach-detection).

## Support impersonation events

| Event                                         | Severity | Description                                                              | Payload fields                                                 |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `support-impersonation-requested`             | warning  | A support actor requested an impersonation grant against a Space.        | `grantId`, `supportActorId`, `spaceId`, `scope`, `requestedAt` |
| `support-impersonation-approved`              | warning  | An impersonation grant was approved.                                     | `grantId`, `approvedBy`, `approvedAt`, `expiresAt`             |
| `support-impersonation-rejected`              | notice   | An impersonation grant request was rejected.                             | `grantId`, `rejectedBy`, `reason`                              |
| `support-impersonation-revoked`               | warning  | An approved impersonation grant was revoked early.                       | `grantId`, `revokedBy`, `reason`                               |
| `support-impersonation-expired`               | info     | An impersonation grant reached its `expiresAt`.                          | `grantId`, `expiresAt`                                         |
| `support-impersonation-session-started`       | warning  | A support actor opened an impersonation session under an approved grant. | `sessionId`, `grantId`, `acceptScope`, `openedAt`              |
| `support-impersonation-session-ended`         | notice   | A support impersonation session ended.                                   | `sessionId`, `grantId`, `endedAt`, `endReason`                 |
| `support-impersonation-write-action-recorded` | warning  | A write action was performed within a read-write impersonation session.  | `sessionId`, `grantId`, `actionDigest`, `targetResource`       |

See also: [Support Impersonation](/reference/support-impersonation).

## Notification events

| Event                       | Severity | Description                                                           | Payload fields                                                  |
| --------------------------- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `notification-emitted`      | info     | A NotificationSignal was emitted into the pull-only delivery surface. | `signalId`, `category`, `scope`, `scopeId`, `recipientActorIds` |
| `notification-acknowledged` | info     | A NotificationSignal was acknowledged by a recipient actor.           | `signalId`, `actorId`, `acknowledgedAt`                         |

See also: [Notification Emission](/reference/notification-emission).

## SLA events

| Event                   | Severity | Description                                                     | Payload fields                                                                           |
| ----------------------- | -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sla-warning-raised`    | warning  | An SLA dimension entered a warning band before breach.          | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`                                  |
| `sla-breach-detected`   | error    | An SLA threshold was breached.                                  | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`, `incidentId`                    |
| `sla-recovering`        | notice   | An SLA dimension is returning toward nominal during hysteresis. | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`                                  |
| `sla-recovered`         | info     | An SLA dimension recovered to nominal.                          | `dimension`, `scope`, `scopeId`, `recoveredAt`, `thresholdId`                            |
| `sla-threshold-changed` | notice   | An SLAThreshold record was registered or updated.               | `thresholdId`, `dimension`, `scope`, `scopeId`, `previousValue`, `newValue`, `changedBy` |

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## Cost / quota events

| Event                       | Severity | Description                                                    | Payload fields                                                              |
| --------------------------- | -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `space-attribution-changed` | notice   | A Space's CostAttributionConfig was updated.                   | `spaceId`, `previousAttributionDigest`, `newAttributionDigest`, `changedBy` |
| `quota-tier-registered`     | notice   | A QuotaTier was registered.                                    | `tierId`, `dimensions`, `registeredBy`                                      |
| `quota-tier-updated`        | notice   | A QuotaTier's dimensions or rate-limit overrides were updated. | `tierId`, `previousDigest`, `newDigest`, `changedBy`                        |
| `quota-tier-removed`        | warning  | A QuotaTier was removed from the registry.                     | `tierId`, `removedBy`, `reason`                                             |
| `space-tier-changed`        | notice   | A Space's assigned QuotaTier changed.                          | `spaceId`, `previousTierId`, `newTierId`, `changedBy`                       |

See also: [Quota Tiers](/reference/quota-tiers),
[Cost Attribution](/reference/cost-attribution).

## Trigger events

Reserved workflow-extension event vocabulary. The current kernel does not emit
these events until trigger routes and stores are implemented.

| Event                  | Severity | Description                                                                      | Payload fields                                                                                        |
| ---------------------- | -------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `trigger-fired`        | info     | A registered trigger fired and produced a downstream OperationPlan.              | `triggerId`, `registrationId`, `kind`, `resourceRef`                                                  |
| `trigger-rejected`     | warning  | A trigger fire attempt was rejected before it could produce a downstream effect. | `triggerId?`, `kind`, `reason` (`auth-failed` / `signature-invalid` / `rate-limit` / `unknown-event`) |
| `trigger-deduplicated` | info     | A trigger fire collapsed into an earlier fire inside the dedup window.           | `triggerId`, `originalTriggerId`, `dedupWindowSeconds`                                                |

See also: [Triggers](/reference/triggers).

## Hook events

Reserved declarable-hook event vocabulary. Catalog-supplied executable WAL hook
evidence is currently recorded in the operation journal, not as these
HookBinding audit events.

| Event            | Severity | Description                                                                  | Payload fields                                              |
| ---------------- | -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `hook-fired`     | info     | A declared hook fired against a lifecycle phase boundary.                    | `hookBindingId`, `phase`, `hookOrder`, `bundleRef`          |
| `hook-completed` | info     | A hook execution completed successfully.                                     | `hookBindingId`, `durationMs`, `outputCount`                |
| `hook-failed`    | error    | A hook execution failed; the bound phase outcome depends on `failurePolicy`. | `hookBindingId`, `errorCode`, `durationMs`, `failurePolicy` |

See also: [Declarable Hooks](/reference/declarable-hooks).

## Step execution events

Reserved `execute-step` event vocabulary. The current kernel does not emit these
events until `execute-step` dispatch and StepResult storage are implemented.

| Event                      | Severity | Description                                                  | Payload fields                                       |
| -------------------------- | -------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `step-execution-started`   | info     | An `execute-step` operation was dispatched to runtime-agent. | `operationId`, `bundleRef`, `attempt`                |
| `step-execution-completed` | info     | An `execute-step` operation reached a terminal status.       | `operationId`, `status`, `durationMs`, `outputCount` |

See also: [Execute-Step Operation](/reference/execute-step-operation).

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

## Related architecture notes

- `reference/architecture/policy-risk-approval-error-model` — closed risk and
  approval enums referenced by Approval events.
- `reference/architecture/operation-plan-write-ahead-journal-model` — WAL stage
  enum referenced by Operation events.
- `reference/architecture/snapshot-model` — Snapshot semantics referenced by
  Activation events.
- `reference/architecture/operator-boundaries` — actor identity model and
  redaction trust boundary.
