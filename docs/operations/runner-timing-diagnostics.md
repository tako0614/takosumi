# Runner timing diagnostics

Successful PlanRun results may include an informational diagnostic with code
`runner_elapsed_timings` and message `runner elapsed timings (ms)`. Its `detail`
is JSON containing only finite, non-negative numeric durations from the Worker
path:

- `workerAdapterRpcMs`: the Worker adapter's runner RPC and response-body read,
  including capacity waits/retries when they occur.
- `doInputRestoreReadinessMs`: Durable Object request-body handling, input/state
  restore, and container readiness before dispatch.
- `doContainerExecutionResponseBufferMs`: container dispatch through bounded
  response buffering.
- `doPlanArtifactPersistenceMs`: Plan artifact promotion and persistence work.

These intervals are nested: `workerAdapterRpcMs` contains the Durable Object
work, and the three Durable Object intervals are sequential parts of that work.
Do not add these values together. The existing
`x-takosumi-runner-startup-seconds` response header is unchanged and overlaps
container readiness; it is not an additional interval.

A successfully completed non-destroy Plan may also include an informational
`core_plan_elapsed_timings` diagnostic. Its JSON `detail` has exactly these
finite, non-negative millisecond durations:

- `preClaimPreparationMs`: from entry to `runQueuedPlan`, before its first
  awaited read, until immediately before the running claim. It includes Run and
  prepared-input reads, profile selection, and compatibility checks. It does
  not include delivery time before the consumer enters this function.
- `claimMs`: from immediately before the running claim through its fenced CAS.
- `resolveRunEnvironmentMs`: dispatch-time environment and credential resolution.
- `dispatchPreparationMs`: Core execution dispatch, policy reads, and runner
  selection before the renewal guard starts.
- `renewalOutsideRunnerMs`: elapsed time inside the renewal guard but outside
  the `runner.plan` call; this includes its initial and final fence checks,
  renewable-credential preparation and cleanup, runner-job assembly after the
  initial check, and any pending renewal tick after the runner returns.
- `runnerPlanMs`: the complete `runner.plan` call, including the Worker adapter.

The Core intervals are sequential. The five keys from `claimMs` through
`runnerPlanMs` approximate the measured claim-to-runner-return portion of the
Plan; adding `preClaimPreparationMs` approximates consumer-entry-to-runner-return.
Neither sum is a measure of delivery delay. In particular, a gap from Run
`createdAt` to `startedAt` can include both time before `runQueuedPlan` starts
and its pre-claim work, so it must not be labeled queue-only.
`workerAdapterRpcMs` is nested inside `runnerPlanMs`; subtract it rather than
adding it when locating time outside the Worker RPC. These are monotonic
durations, not timestamps. Synchronous handoff between intervals and time from
runner return to `finishedAt` are not assigned to a Core key. A single sample
can locate a stage but does not establish its cause or a latency improvement.

The Worker timing diagnostic is optional for older runner responses. Neither
timing diagnostic carries timestamps, source/input data, artifact identifiers,
provider output, or error
text. Core timings are emitted only for succeeded non-destroy Plans; Worker
timings still follow their existing successful-Plan result path. Failure
classification, retry policy, replay behavior, and runner side effects are
unchanged. These measurements partition the measured Core and Worker paths;
they do not by themselves identify a bottleneck or include time outside those
paths.

Successful create/update Plans using the direct OpenTofu root also expose two
entries in the Runner response's existing `phaseTimings` array:

- `runner_plan_prepare`: source availability/build, module and state preparation,
  input/credential/provider-policy preparation and source revision lookup, before
  the shared init/plan pipeline starts.
- `runner_plan_finalize`: reading and hashing plan artifacts, constructing
  evidence and planned outputs, and building the response after command phases.

Like the existing command entries, these include `phase`, `startedAt`,
`finishedAt` and `durationMs`. The new durations use a monotonic clock; the
timestamps are wall-clock labels. They are separate from the numeric-only
Core and Worker diagnostics above. The intervals sit inside Runner execution,
not alongside its outer Worker duration. They do not cover all transport or
serialization time. Failed Plans, Apply and Destroy omit these two entries.
Worker code deployment does not add them to an older immutable Runner image;
that image must be published and selected separately.
