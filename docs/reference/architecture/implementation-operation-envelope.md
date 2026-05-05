# Implementation and Runtime-Agent Boundary

This document fixes the v1 boundary between the Takosumi kernel and the
runtime-agent process, and the operation envelope they exchange. Wire-level
field tables live in [Runtime-Agent API](/reference/runtime-agent-api) and
[Lifecycle Protocol](/reference/lifecycle); this page records the architecture
intent — what each side owns, where the trust chain breaks, and which invariants
force the split.

## Boundary statement

The kernel orchestrates state. It owns Spaces, ResolutionSnapshots,
DesiredSnapshots, OperationPlans, the Write-Ahead Journal, policy evaluation,
Approval bookkeeping, and RevokeDebt. The kernel process must not hold cloud or
OS credentials, and must not perform the side-effecting external I/O that
materializes resources.

The runtime-agent owns execution. It hosts connector code, holds the cloud SDK /
OS API credentials of its host environment, performs all external I/O, and
reports observed state back to the kernel through `describe`. A runtime-agent
runs on the host that legitimately owns those credentials — typically the
operator's deploy account — so credential blast radius is the runtime-agent
host, never the kernel.

This split is structural, not advisory. Anything that touches a cloud SDK, a
docker socket, or a systemd unit lives in a runtime-agent connector; anything
that decides whether such a touch is allowed lives in the kernel.

## Packaging freedom

The runtime-agent is defined by a fixed protocol, not a fixed packaging. A
connector implementation may be a Deno binary, an in-process module, an HTTP
service, a WASM module, a container, an external gateway wrapping a SaaS, or an
operator-private daemon. Only the lifecycle / connectors RPC surface and the
operation envelope shape are fixed. Operators choose the packaging that matches
their credential boundary and their fleet topology.

## Operation envelope

The kernel sends an OperationRequest to the runtime-agent for every
materializing step of an OperationPlan:

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

Field responsibilities:

- `spaceId` — isolation key. The runtime-agent must scope every external call,
  generated object, and secret to this Space.
- `operationId` / `operationAttempt` / `journalCursor` — WAL coordinates.
  Replays of the same triple must be idempotent.
- `idempotencyKey` — the kernel-derived
  `(spaceId, operationPlanDigest,
  journalEntryId)` triple, projected to the
  connector's idempotency space.
- `desiredGeneration` / `desiredSnapshotId` / `resolutionSnapshotId` — the
  snapshots the kernel committed against. The runtime-agent must not read
  snapshots it was not handed.
- `operationKind` — selects the connector hook.
- `inputRefs` / `preRecordedGeneratedObjectIds` /
  `expectedExternalIdempotencyKeys` — kernel-side pre-allocation so that retries
  do not duplicate generated objects.
- `approvedEffects` — the policy ceiling for this operation.
- `recoveryMode` — see Recovery mode below.

## Operation result

The runtime-agent returns an OperationResult:

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

Status enum responsibilities (closed, six values):

- `succeeded` — all approved effects were applied. The kernel advances the WAL
  to `commit` and projects `actualEffects` into the ResolutionSnapshot.
- `failed` — no observable side effect occurred; safe to retry under the same
  idempotency key. `errorCode` is required.
- `partial` — some effects landed, others did not. The kernel records the
  partial set into the journal and opens a RevokeDebt if the partial set cannot
  be reconciled by another `commit` attempt.
- `requires-approval` — dry materialization predicted effects that exceed
  `approvedEffects`. The kernel does not advance past `pre-commit` and routes to
  Approval with the predicted digest.
- `compensation-required` — the runtime-agent observed a state from which
  forward progress is unsafe; the kernel must run `compensate` against this
  operation and any committed downstream operations.

## Effect rule

`actualEffects` must never exceed `approvedEffects`. The WAL `pre-commit` stage
is the enforcement point: the kernel compares the runtime-agent's predicted (or
just-applied) effect set against `approvedEffects` before allowing the
transition to `commit`. A mismatch is recorded under the
`actual-effects-overflow` risk and aborts the operation. Connectors that cannot
stay within `approvedEffects` must return `requires-approval` during dry
materialization rather than commit and overflow.

## Dry materialization

Side-effecting operations expose a dry phase that predicts the effect set
without committing it: generated objects, grants, credentials, secret
projections, endpoints, network changes, and traffic changes. The kernel hashes
the prediction into `predictedActualEffectsDigest` and binds that digest to the
Approval that was issued.

When an Approval is replayed, the kernel re-runs dry materialization and
compares the new digest against the bound one. A mismatch is one of the six
numbered Approval invalidation triggers and forces a new Approval round; the
existing Approval cannot be consumed against a different predicted effect set.
This is what keeps Approval semantics meaningful across kernel restarts and
across operator clock drift between approval issuance and apply.

## Recovery mode

`recoveryMode` is a closed four-value enum carried on the envelope so the
runtime-agent knows what posture the kernel is taking after a restart or a
failed prior attempt:

- `normal` — default forward apply. Use when the WAL stage cleanly identifies
  the next step.
- `continue` — a prior `commit` attempt may have leaked external side effects;
  finish the `commit` under the same idempotency key.
- `compensate` — reverse a previously committed effect, opening a RevokeDebt
  with reason `activation-rollback` when applicable.
- `inspect` — produce a diff between WAL and live state without applying any
  effect.

The kernel selects the mode from WAL evidence — the last recorded stage, the
presence of partial effects, and operator override during recovery. The
runtime-agent does not pick the mode; it executes whichever mode the kernel
hands it, and rejects a request whose `recoveryMode` is inconsistent with the
connector's known state. Selection guidance for operators is fixed in
[Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes).

## Idempotency contract

The triple `(spaceId, operationPlanDigest, journalEntryId)` is generated on the
kernel side at `prepare` and is the canonical idempotency key. A runtime-agent
that receives the same triple twice must return the same effect set: same
generated object IDs, same handles, same secret refs. Connectors achieve this by
projecting the triple into their backend's idempotency mechanism (cloud-native
idempotency tokens, deterministic resource names, or a connector-side dedupe
ledger). Non-deterministic connectors are not v1-compliant.

## Connector vs implementation

`connector:<id>` and `implementation` are layered roles inside the
runtime-agent. A `connector:<id>` is the operator-installed adapter that defines
the DataAsset / handle shape for a `(shape, provider)` pair and exposes the
lifecycle hooks. An implementation is the operation-level logic that runs on top
of a connector to fulfill an OperationPlan step. Both roles are hosted by the
same runtime-agent process, but their responsibilities do not collapse:
connector lifecycle is the persistent, handle-keyed object; implementation is
the per-operation execution that borrows the connector to drive the underlying
SDK.

## Verify semantics

`POST /v1/lifecycle/verify` is a credential / reachability smoke test for
registered connectors. It does not advance the WAL, does not materialize a
Snapshot, and does not change `LifecycleStatus`. `describe` answers "what is the
live state of this handle"; `verify` answers "can this connector reach its
backend at all". Health is judged by the kernel / operator dashboard from
`LifecycleVerifyResult.ok`; the runtime-agent only reports. The intended
placement is pre-flight, before `apply`, exactly so that `connector_not_found`
and `connector-extended:*` failures surface before any WAL stage is touched.

## Signature chain

The kernel-to-runtime-agent direction is authenticated by Ed25519
gateway-manifest signing. The kernel signs the manifest that describes which
`(shape, provider)` pairs the runtime-agent is allowed to host; the
runtime-agent verifies the signature on enrollment and on every manifest
refresh. This binds runtime-agent capability to a kernel identity the operator
approved.

The runtime-agent-to-kernel direction is a separate auth path: enrollment tokens
establish identity, heartbeat / lease tokens keep the runtime-agent attached,
and the agent bearer (`TAKOSUMI_AGENT_TOKEN`) protects the lifecycle /
connectors RPCs. The two directions never share key material; compromising one
does not collapse the other.

## Space isolation

`spaceId` arrives in every envelope and every lifecycle request. Implementations
and connectors must not read or mutate objects, secrets, artifacts, grants, or
namespace exports belonging to a different Space unless the operation input
includes an approved SpaceExportShare or an operator import. Cross-Space access
without that input is a contract break and is closed under the
`actual-effects-overflow` risk.

## Failure modes

- **Partial failure.** The runtime-agent committed some but not all approved
  effects. Status is `partial`; the kernel journals which effects landed and
  either retries the missing subset under the same idempotency key or opens a
  RevokeDebt for the leaked subset.
- **Compensation.** The runtime-agent returns `compensation-required`, or
  `recoveryMode: compensate` is in force. The kernel runs the connector's
  compensate hook against the recorded effects and emits a RevokeDebt with
  reason `activation-rollback`.
- **Debt.** Whenever an effect was applied but cannot be reconciled with the
  desired state — overflow, partial, compensate without full reverse — the
  kernel opens a RevokeDebt entry. The debt's status enum and reason enum are
  closed; resolution requires either a successful compensate, a manual operator
  close-out, or an Approval that retroactively widens `approvedEffects` to cover
  the leaked set. Debt is the v1 mechanism by which the kernel keeps "what is
  approved" and "what actually exists" in sync without silently dropping
  discrepancies.

## Cross-references

- [Runtime-Agent API](/reference/runtime-agent-api)
- [Lifecycle Protocol](/reference/lifecycle)
- [Execution Lifecycle](/reference/architecture/execution-lifecycle)
- [OperationPlan / Write-Ahead Journal Model](/reference/architecture/operation-plan-write-ahead-journal-model)
