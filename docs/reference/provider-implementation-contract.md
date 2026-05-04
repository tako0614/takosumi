# Provider Implementation Contract

> Stability: stable
> Audience: kernel-implementer, integrator
> See also: [Runtime-Agent API](/reference/runtime-agent-api), [Connector Contract](/reference/connector-contract), [WAL Stages](/reference/wal-stages), [Risk Taxonomy](/reference/risk-taxonomy), [Closed Enums](/reference/closed-enums)

This page defines the **wire-level lifecycle contract** that a provider
plugin Implementation must satisfy when hosted inside a runtime-agent.
[Runtime-Agent API](/reference/runtime-agent-api) covers the kernel ↔
runtime-agent HTTP RPC envelope, and
[Connector Contract](/reference/connector-contract) covers the
`connector:<id>` identity and accepted-kind vector. This page sits
between those two: it specifies the request / response envelope an
Implementation receives from the runtime-agent dispatcher, the closed
status enum it must return, the effect bound it must respect, and the
recovery / dry-materialization / verify behaviours it must implement.

The contract is wire-shape only. Packaging is free: an Implementation
may ship as a Deno module, a binary, an HTTP service, a WASM module, or
a container image. As long as the runtime-agent dispatcher can
materialize the operation envelope below into a call, the
Implementation conforms.

## Operation request envelope

The runtime-agent invokes an Implementation with the following
envelope. Field order is normative; absent fields are explicit nulls,
not omissions.

```yaml
OperationRequest:
  spaceId: space:<name>
  operationId: operation:<ulid>
  operationAttempt: integer >= 1
  journalCursor: journal:<ulid>
  idempotencyKey: <opaque string>
  desiredGeneration: integer >= 1
  desiredSnapshotId: desired:<sha256>
  resolutionSnapshotId: resolution:<sha256>
  operationKind: <enum>
  inputRefs: [<id>, ...]
  preRecordedGeneratedObjectIds: [generated:..., ...]
  expectedExternalIdempotencyKeys: [<opaque string>, ...]
  approvedEffects: [<closed effect descriptor>, ...]
  recoveryMode: normal | continue | compensate | inspect
  walStage: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
  deadline: <RFC 3339 timestamp>
```

Field semantics:

- `operationAttempt` increments on every retry of the same
  `operationId`. The Implementation must treat all attempts of the same
  `operationId` as the same logical operation.
- `journalCursor` is the WAL cursor at which this attempt was
  dispatched. It is informational; the Implementation does not write
  the WAL itself.
- `idempotencyKey` is derived from
  `(spaceId, operationPlanDigest, journalEntryId)` (see
  [WAL Stages — Idempotency key](/reference/wal-stages#idempotency-key)).
  The same key always implies the same expected effect digest.
- `desiredGeneration` is the monotonically increasing generation of the
  Space's DesiredSnapshot. Implementations use it to detect that a
  prior in-flight operation was superseded.
- `inputRefs` lists the resolved object / generated / link IDs the
  Implementation may read from.
- `preRecordedGeneratedObjectIds` lists `generated:<owner-kind>:<owner-id>/<reason>`
  IDs the kernel has already minted; the Implementation must use those
  exact IDs when it reports `generatedObjects[]`.
- `expectedExternalIdempotencyKeys` lists the external API idempotency
  keys the kernel expects the Implementation to forward to its
  connector.
- `approvedEffects` is the closed bound the apply pipeline obtained
  through approval. The Implementation must not exceed it.
- `recoveryMode` selects how the Implementation should treat partial
  prior state (see below).
- `walStage` is the stage on whose behalf this dispatch runs. The
  Implementation does not advance WAL stages itself.
- `deadline` is an absolute deadline, not a duration. The
  Implementation must abort and return `failed` with a `retryable`
  error before the deadline elapses.

## Operation result envelope

The Implementation returns the following envelope. Fields the
Implementation does not produce are explicit empty arrays, not
omissions.

```yaml
OperationResult:
  operationId: operation:<ulid>
  status: succeeded | failed | partial | requires-approval | compensation-required
  actualEffects: [<closed effect descriptor>, ...]
  generatedObjects: [{ id: generated:..., ... }, ...]
  secretRefs: [<secret partition handle>, ...]
  endpointRefs: [<endpoint descriptor>, ...]
  grantHandles: [<grant descriptor>, ...]
  observations: [<observation tuple>, ...]
  retryHint: { retryable: bool, after: <duration?>, reason?: <code> }
  compensationHint: { kind: <enum>, debt?: <descriptor> }
  errorCode: <LifecycleErrorBody code | DomainErrorCode | connector-extended:* | null>
  walStageAck: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
```

The Implementation never invents new identity prefixes. It echoes the
IDs supplied in the request (`operationId`,
`preRecordedGeneratedObjectIds`) and uses them verbatim.

## Operation status enum (5 values)

The `status` field is a closed 5-value enum. Each value has a precise
semantic meaning that the apply pipeline relies on:

| Status | Meaning |
| --- | --- |
| `succeeded` | The operation completed and `actualEffects` is final. |
| `failed` | The operation could not proceed; the WAL stage transitions to `abort`. |
| `partial` | Some effects materialized but more work is needed; the kernel may dispatch a follow-up attempt. |
| `requires-approval` | The Implementation discovered an effect that needs explicit approval; the apply pipeline pauses and surfaces a Risk. |
| `compensation-required` | Prior partial state must be rolled back; the WAL stage transitions to `abort` and `compensationHint` drives compensate recovery. |

`partial` is the only non-terminal status. The other four are terminal
for the current attempt; the apply pipeline reschedules a fresh
attempt only after re-resolving approval / compensation as required.

## Recovery mode behaviour

`recoveryMode` is a closed 4-value enum that tells the Implementation
what assumptions to make about prior state:

- `normal`: no prior partial state exists; the Implementation acts as
  if this is a first attempt for the `idempotencyKey`.
- `continue`: a prior attempt for the same `idempotencyKey` made
  forward progress; the Implementation must finish it idempotently and
  return the same effect digest as the prior attempt would have.
- `compensate`: prior partial state must be rolled back; the
  Implementation must reverse `actualEffects` it has already
  reported under the same `idempotencyKey`. Effects that cannot be
  reversed surface as `compensation-required` with a populated
  `compensationHint.debt` so the kernel can enqueue a RevokeDebt entry.
- `inspect`: the Implementation must report observed external state
  without performing any mutating call. This mode is used by
  `actual-effects-overflow` triage and by recovery dry-runs.

`inspect` mode never advances the WAL beyond the current stage. The
Implementation returns `succeeded` with `actualEffects` reflecting the
observed external state and a `walStageAck` equal to the input
`walStage`.

## Effect bound rule

The Implementation operates under a strict invariant:

```text
actualEffects ⊆ approvedEffects
```

The Implementation must compute its own intended effect set before
performing any external mutation, and refuse to proceed if the
intended set escapes `approvedEffects`. If actual external state
diverges and the Implementation discovers it has produced an effect
outside `approvedEffects`, it must:

1. Stop further mutation.
2. Return `status = failed` with
   `errorCode = actual-effects-overflow`.
3. Populate `actualEffects` with the full observed effect set,
   including the overflow.
4. Set `compensationHint.kind = overflow` so the apply pipeline can
   schedule compensate recovery.

`actual-effects-overflow` is a closed Risk
(see [Risk Taxonomy — `actual-effects-overflow`](/reference/risk-taxonomy)).
The kernel never silently widens `approvedEffects` in response.

## Dry materialization phase

Before the apply pipeline binds approval, it asks each Implementation
to predict its actual effects. The runtime-agent dispatches this as a
normal `OperationRequest` with the following constraints:

- `walStage = prepare`.
- `recoveryMode = inspect`.
- The Implementation must not perform any external mutation.
- The Implementation populates `actualEffects` with its **predicted**
  effect set.

The kernel hashes the predicted set with
[the digest computation rules](/reference/digest-computation) and
binds the result as `predictedActualEffectsDigest` on the
OperationPlan. Subsequent `commit` / `post-commit` attempts are bound
to that digest: deviating from it triggers `actual-effects-overflow`.

Dry materialization is side-effect free by contract. Implementations
that cannot produce a deterministic prediction must return
`status = requires-approval` with an explanatory `errorCode`; the
apply pipeline then surfaces this as a plan-level Risk.

## Idempotency contract

For any single `idempotencyKey`:

- The Implementation must produce the **same** `actualEffects` digest
  on every successful attempt. Returning a different digest under the
  same key is a hard-fail at the kernel; the apply pipeline rejects
  the result and refuses to advance the WAL.
- The Implementation must reuse `expectedExternalIdempotencyKeys` when
  forwarding mutations to its connector. Inventing new external keys
  defeats end-to-end idempotency.
- Retries for the same `idempotencyKey` carry incrementing
  `operationAttempt` values. The Implementation must not treat a
  higher attempt number as license to widen the effect set.

## Connector relationship

An Implementation never holds external credentials. Mutating calls
flow through a Connector, which is the operator-installed software
unit defined in
[Connector Contract](/reference/connector-contract).

- The active `connector:<id>` for the Implementation is part of the
  resolved `inputRefs` set; the runtime-agent supplies the resolved
  Connector record (`acceptedKinds`, `signingExpectations`,
  `envelopeVersion`) but never the Connector's credentials.
- DataAsset delivery to the Connector follows
  [DataAsset Kinds — accepted-kind vector](/reference/artifact-kinds)
  and is bound by the Connector's `acceptedKinds` vector. An
  Implementation that asks the Connector to accept a kind outside
  that vector receives an `artifact_kind_mismatch` failure that
  surfaces as `errorCode = artifact_kind_mismatch` in the
  OperationResult.
- Implementations consume artifact bytes by hash through the
  runtime-agent's artifact partition; the deploy bearer never reaches
  the Implementation.

## Verify operation

`POST /v1/lifecycle/verify` (see
[Runtime-Agent API — `/v1/lifecycle/verify`](/reference/runtime-agent-api))
dispatches a verify-style OperationRequest with:

- `operationKind = verify-object`.
- `walStage = prepare` (verify never advances the WAL).
- `recoveryMode = inspect`.

The Implementation must perform a read-only health check against its
Connector and return:

- `status = succeeded` with empty `actualEffects` on a healthy probe.
- `status = failed` with `errorCode` set to a closed
  `LifecycleErrorBody` code on an unhealthy probe.

Verify operations never produce WAL entries, never widen
`approvedEffects`, and never enqueue RevokeDebt.

## Failure mode to journal entry mapping

Each terminal status maps to a fixed WAL transition:

| Status | WAL effect | Journal entry recorded |
| --- | --- | --- |
| `succeeded` | Stage advances to `walStageAck`. | Effect digest persisted; observations appended. |
| `failed` | Stage transitions to `abort`. | `errorCode` persisted; `compensationHint` informs the abort plan. |
| `partial` | Stage retains current value; attempt counter advances. | Partial effects persisted; next attempt resumes from the same WAL cursor. |
| `requires-approval` | Stage transitions to `skip` for this attempt. | Approval re-validation Risk surfaces; the apply pipeline waits for a fresh approval. |
| `compensation-required` | Stage transitions to `abort`. | RevokeDebt enqueued via `compensationHint.debt`; compensate recovery scheduled. |

The Implementation never writes the WAL directly. The runtime-agent
forwards the OperationResult to the kernel, which is the sole writer
of the WAL ledger.

## Packaging freedom

The contract above constrains the wire shape, not the implementation
language or runtime. A conforming Implementation may be:

- A Deno module loaded by the runtime-agent in-process.
- A standalone binary the runtime-agent invokes through a stable
  on-host transport (Unix domain socket, named pipe, stdio).
- A remote HTTP service the runtime-agent dispatches to over a
  trusted local network.
- A WASM module the runtime-agent instantiates per attempt.
- A container the runtime-agent runs through a host-local container
  runtime.

The runtime-agent dispatcher is the boundary that adapts each form to
the OperationRequest / OperationResult envelope. As long as the
envelope, the status enum, the effect bound, and the idempotency rule
are satisfied, the Implementation is conformant.

## Related design notes

- docs/design/paas-provider-design.md
- docs/design/implementation-operation-envelope.md
- docs/design/operation-plan-write-ahead-journal-model.md
- docs/design/policy-risk-approval-error-model.md
- docs/design/data-asset-model.md
