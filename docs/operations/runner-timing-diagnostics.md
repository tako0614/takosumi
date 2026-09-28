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

The timing diagnostic is optional for older runner responses and does not carry
timestamps, source/input data, artifact identifiers, provider output, or error
text. It is present only when a successful Plan result reaches the existing
diagnostic path. Failure classification, retry policy, replay behavior, and
runner side effects are unchanged. These measurements partition Worker-side
elapsed time; they do not by themselves identify a bottleneck or include time
outside the measured request path.
