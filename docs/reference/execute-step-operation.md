# Execute-Step Operation

> **DEPRECATED — policy reversed.** This document records the `execute-step`
> operation kind that was previously reserved as a 12th value in the
> `operationKind` closed enum for future workflow integration. The reservation
> has been **withdrawn**: the kernel keeps the existing 11 operation kinds and
> ships no `execute-step` primitive. Step execution and arbitrary DataAsset
> bundle dispatch are not kernel concerns; they live entirely above the
> `POST /v1/deployments` boundary in the `takosumi-git` sibling product. See
> [Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
> for the current policy. This page is retained as historical design context and
> will be removed in a follow-up cleanup.

> Stability: deprecated Audience: historical reference

## Overview

The `execute-step` operation kind was originally proposed to generalize
`transform-data-asset` into a canonical mechanism for dispatching arbitrary
DataAsset bundles to a runtime-agent. With the policy reversal, the kernel does
**not** introduce this generalization. `transform-data-asset` remains the only
DataAsset-bundle dispatch operation kernel-side. Workflow-style multi-step
execution is performed by `takosumi-git` outside the kernel.

The `execute-step` operation kind generalizes `transform-data-asset` into the
canonical mechanism by which the kernel dispatches an arbitrary DataAsset bundle
to a runtime-agent for execution. An execute-step takes a DataAsset bundle
reference (the executable surface), an opaque inputs payload (the step
parameterization), and a capture policy, and produces zero or more DataAssetRef
outputs that are persisted as step output back into the kernel storage.

`execute-step` extends the `operationKind` closed enum from 11 to 12 values.
`transform-data-asset` is retained as a specialized form whose bundle is a
catalog-supplied transformer and whose output kinds are constrained to
derived-artifact kinds. Any provider that can host `transform-data-asset` can be
reused for `execute-step` because the dispatch envelope is a strict superset.

## Operation kind closed v1 enum (12 values)

```text
apply-object | delete-object | verify-object
materialize-link | rematerialize-link | revoke-link
prepare-exposure | activate-exposure
transform-data-asset | observe | compensate
execute-step
```

`execute-step` shares the dispatch boundary documented in
[Provider / Implementation Contract](/reference/provider-implementation-contract);
the StepEnvelope below is the per-kind specialization carried inside the generic
`OperationRequest`.

## StepEnvelope (kernel to runtime-agent)

```yaml
StepEnvelope:
  operationId: operation:<ulid>
  spaceId: space:<name>
  bundleRef: dataasset:sha256:<digest>
  bundleKind: oci-image | js-module | wasm-module | source-archive | static-archive
  inputs: <opaque JSON>
  timeout: <duration>
  deadline: <RFC 3339 timestamp>
  capturePolicy:
    stdout: <bool>
    stderr: <bool>
    files: [<path-glob>, ...]
  idempotencyKey: <kernel-generated tuple>
  attempt: <integer >= 1>
  recoveryMode: normal | continue | compensate | inspect
```

`timeout` defaults to the operator-tunable
`TAKOSUMI_STEP_DEFAULT_TIMEOUT_SECONDS` (default 1800). `deadline` is the
absolute timestamp the runtime-agent must observe; if both are present, the
earlier of the two governs. `bundleKind` is drawn from the DataAsset kind
vocabulary; runtime-agent rejects an envelope whose `bundleKind` is outside its
connector's accepted-kind vector.

## StepResult (runtime-agent to kernel)

```yaml
StepResult:
  operationId: operation:<ulid>
  status: succeeded | failed | timed-out | cancelled
  outputs: [<DataAssetRef>, ...]
  logsRef: dataasset:sha256:<digest>
  errorCode: <closed string, optional>
  errorMessage: <string, optional>
  durationMs: <integer>
  resourceUsage:
    cpu: <optional>
    mem: <optional>
    network: <optional>
```

Step status closed v1 enum (4 values):
`succeeded | failed | timed-out |
cancelled`. `errorCode` is drawn from the
runtime-agent error model (`actual-effects-overflow`, `connector-failed`,
`connector-extended:*`, etc). `outputs[]` are DataAssetRefs the kernel persists
into storage; `logsRef` points to the captured log artifact (see Logs handling).
`resourceUsage` is optional and informational.

## WAL stage traversal

| Stage         | execute-step behavior                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`     | Kernel constructs the StepEnvelope, finalizes the idempotency tuple, binds the inputs digest into the OperationPlan.                               |
| `pre-commit`  | Approval and policy gates fire here. The same hook surface that gates transform approval (`transform-data-asset`) governs `execute-step`.          |
| `commit`      | Kernel POSTs the envelope to runtime-agent and the step executes. `actual-effects` is written when the step reports `succeeded`.                   |
| `post-commit` | Kernel persists declared outputs and the captured log artifact as DataAssets and binds them into the storage schema.                               |
| `observe`     | Kernel re-reads step status to confirm reported state, decides whether retry is required, and updates ObservationSet entries.                      |
| `finalize`    | Kernel updates ObservationSet bookkeeping. ActivationSnapshot is not normally updated because workflow runs are ephemeral and not part of routing. |

`abort` and `skip` apply per the generic WAL contract; cancelled steps land on
`abort` after partial-output discard (see Cancel protocol).

## Idempotency

The idempotency tuple `(spaceId, operationPlanDigest, journalEntryId)` from
[WAL Stages](/reference/wal-stages#idempotency-key) is reused unchanged. Kernel
guarantees:

- Same tuple, same effect digest: deterministic re-apply. The runtime-agent must
  return the same `outputs[]` digests; the kernel compares before re-binding.
- Same tuple, different effect digest: hard-fail with `failed_precondition`. The
  operator must re-resolve into a new OperationPlan, which produces a new
  `operationPlanDigest`.
- `attempt` is incremented by the retry policy and is **not** part of the
  idempotency key. The kernel distinguishes attempts internally; the
  runtime-agent must treat all attempts of the same `operationId` as the same
  logical step.

## Logs handling

The runtime-agent captures the streams and files declared in `capturePolicy` and
bundles them into a single log artifact before reporting `StepResult`. Raw log
bytes never transit the kernel — the kernel only ingests the digest through the
DataAsset upload path.

- The log artifact's DataAsset kind is `static-archive` (within the existing
  five-kind vocabulary).
- `logsRef` is retained alongside the operation's audit row and is included in
  step result audit views.
- Log retention follows the per-Space compliance regime defined in
  [Compliance / Retention](/reference/compliance-retention).

## Cancel protocol

A cancel request is dispatched via
`POST /api/internal/v1/operations/:id/cancel`. The kernel forwards the cancel
signal to the runtime-agent hosting the in-flight step.

1. Runtime-agent sends SIGTERM (or platform equivalent) to the step process
   tree.
2. Runtime-agent waits for graceful exit up to
   `TAKOSUMI_STEP_CANCEL_GRACE_SECONDS` (default 30s).
3. If the process tree has not exited inside the grace window, runtime-agent
   sends SIGKILL.
4. StepResult is reported with `status = cancelled`. Partial outputs are
   discarded; only the log artifact captured up to the cancel point is uploaded.

Effects already committed before the cancel signal landed remain in the WAL. If
the operator needs to roll those back, a separate `compensate` operation is the
correct path; cancel does not retroactively revert committed effects.

## Relationship to transform-data-asset

`transform-data-asset` is the specialized form of `execute-step` where:

- The bundle is a catalog-supplied transformer (not arbitrary operator code).
- `bundleKind` is constrained to the transformer-shaped subset.
- `outputs[]` are restricted to derived-artifact kinds (typically `js-module`
  and `static-archive`).
- The approval surface, manifest vocabulary, and RevokeDebt accounting all
  remain in the existing `transform-data-asset` shape.

Internally, `transform-data-asset` reduces to `execute-step` plus the bundle and
output-kind constraint checks. Existing manifests, approval bindings, and
RevokeDebt entries continue to use the `transform-data-asset` enum value; they
are not rewritten to `execute-step`.

## Approval and Risk integration

`execute-step` participates in the same approval surface as every other
operationKind:

- All six approval invalidation triggers apply unchanged (see
  [Approval Invalidation Triggers](/reference/approval-invalidation)).
- A bundle digest change fires trigger 1 (digest change).
- An external bundle (e.g. `oci-image` referenced by mutable tag) is subject to
  trigger 4 (external freshness change); operators that want reproducibility
  must pin by digest.
- The `actual-effects-overflow` Risk is enforced for `execute-step` exactly as
  for `transform-data-asset`: declared effects in the StepEnvelope bound the
  actual effects the runtime-agent may report, and overflow stops the WAL at
  `inspect` recovery mode.

## Resource usage and quota

Step execution adds one quota dimension on top of the existing surface:

- `step-concurrent-per-space`: the maximum number of `execute-step` operations
  that may be in `commit` stage concurrently in a single Space. Tunable by
  `TAKOSUMI_STEP_MAX_CONCURRENT_PER_SPACE` (default 4).

Other quota dimensions (artifact bytes, total operation throughput, etc.) apply
per their existing definitions.

## Audit events

`execute-step` emits two new audit events alongside the existing
`operation-completed` / `operation-failed` envelope:

- `step-execution-started` — emitted when the runtime-agent acknowledges the
  StepEnvelope and begins execution.
- `step-execution-completed` — emitted when the StepResult is recorded,
  regardless of terminal status.

Both events carry `operationId`, `spaceId`, `bundleRef`, and the captured
`logsRef` (when present). They sit alongside the operation envelope events and
do not replace them.

## Boundary

The kernel's responsibility for `execute-step` is bounded:

- Envelope dispatch, journaling, output capture, and cancel signal routing are
  kernel-side.
- Actual step execution, process management, network access, and file system
  access are hosted by the runtime-agent (operator-installed) and its underlying
  connectors.
- Customer-facing step monitoring UI is outside Takosumi's surface; the
  audit-event stream and StepResult records are the integration boundary
  consumers build on top of.

## Related design notes

- `docs/reference/architecture/workflow-extension-design.md`
