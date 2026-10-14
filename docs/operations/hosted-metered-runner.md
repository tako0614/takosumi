# Hosted-metered runner: local qualification only

The explicit `hosted-metered-v1` image profile is a dormant Linux composition.
It produces raw active CPU observations for local qualification. It does not
admit Cloudflare executions, authorize Hosted billing, or provide a complete
Run measurement. Ordinary `runner/Dockerfile`, `USER bun`, and `runner/start.sh`
keep their existing behavior.

The profile uses `runner/Dockerfile.hosted-metered` and
`runner/start-hosted-metered.sh`. Its root PID 1 owns the signing key, private
control directory, CPU counter, and outbox. The image omits the old
`/app/runner/start.sh` path: an unmodified Container owner overriding its
entrypoint to that path must fail before an ordinary root runner starts.
Image build proof and platform execution admission are separate authorities.
The metered image's local proof cannot be converted into the ordinary v1
activation proof.

## Execution boundary

Root executes only fixed, immutable native/Bun/bootstrap paths from `/app`.
A non-setuid native launcher drops all real/effective/saved UID/GID values to
65534, supplementary groups, every capability set and inherited descriptor
above 2, and enables `no_new_privs` before exec. Fixed workload directory setup
also happens after this drop. Root never evaluates a module or changes cwd into
a tenant tree.

The trusted Bun child makes itself non-dumpable after exec, checks that state,
disables the transpiler cache, ignores debug signals, and only then imports
the runner. It exposes no HTTP listener. Root multiplexes authenticated
requests and cancellation over protected stdin/stdout. Provider commands retain
their existing separate pipes, `/dev/null` stdin, deadlines, private FIFO
inputs, credential refresh and artifact behavior. The other existing spawn
sites are the fixed ownership `flock` helper and private-input `mkfifo`; they
also execute in the dropped child. No signing/control key enters child env,
argv, files, or descriptors.

Providers share the child's UID. `PR_SET_DUMPABLE=0` alone is not the complete
boundary: the native and actual-source gates additionally attack proc, memory,
ptrace, pidfd descriptor access, stdio injection, debug signals, runtime code
and cache permissions. Same-UID providers can stop or kill the trusted child.
That is an unavailable/pending attempt with no successful close receipt.

## Local control and closure

Only `takosumi.hosted-metered-local-admission@v1` is recognized. It is installed
with a synthetic 32-byte key under the root-private
`/run/takosumi-metered` directory, with directory mode 0700 and files mode 0600.
The protocol in `runner/lib/hosted_metered_protocol.ts` defines the exact
admission/context types and HMAC bytes. The MAC binds the method, path and query,
body digest, nonce, original Workspace/Run/attempt/image/request digest and
collector boot. Authentication precedes replay reservation and forwarding.
Each boot accepts one exact Run POST body once. Artifact and credential refresh
requests remain authenticated and can run concurrently with that operation.

The native supervisor pins a real cgroup-v2 `cpu.stat` descriptor, filesystem
identity and membership. CPU is the bigint `usage_usec` difference, including
forked, auto-reaped and escaped descendants. Rusage, RSS, elapsed wall time,
estimates and a missing-source zero are not substitutes. Root retains an
existing ownership lease on its private control root while requests and the
child tree can still write. Close cannot overtake a dispatch intent write or
an in-flight credential/artifact operation.

Close requires direct child exit, adopted-child reaping through `ECHILD`, the
same monotonic counter, native finalization and lease finalization. These facts
form the closure commit point. A stop before that point leaves the original
intent pending and publishes no closed record. A stop after it waits for the
already-proven raw CPU receipt's private durable publication. Lost replies use
the exact authenticated outbox; they never rerun the provider operation.
Counter, owner, child, authentication or finalization failures remain
unavailable/pending. The receipt explicitly contains
`qualification: "local-native-only"` and `completeRunMeasurement: false`.

## Evidence and remaining owning ports

`bun scripts/check-hosted-metered-native.ts --image "$CACHED_RUNNER_IMAGE"`
uses only an already-cached immutable runtime and actual tracked C/Bun sources.
It reports `source-bound-cached-runtime-unbuilt-image`, not a newly built image
proof. Its owned private Container, cgroup and temporary fixture must be removed
before it prints success. Syscall fault injection is labeled separately from
real kernel counter qualification.

`scripts/prove-runner-hosted-metered.ts` is a different gate. It requires the
actual newly built image's immutable descriptor/config and its own entrypoint,
with no source mount or replacement entrypoint. It exercises protected child
attacks, independent same-cgroup workload intervals, authenticated real
Plan/Apply, failed producer/collector closure, and the legacy entrypoint guard.
Only that gate can emit the descriptor-bound native image report used by the
owning image release flow. No local source-bind result may stand in for it.

Cloudflare admission still needs the actual application policy and exact
application/version/image/type/Container binding, an exclusive original Run
lease, root-only key provisioning, durable original receipt transport and
close acknowledgement before shutdown. Configuration omission or a local
kernel result is not evidence of the actual application's policy. With the
`durable_object` policy, non-root IDs do not establish the required capability
and file-permission boundary; see the official
[Container exec security contract](https://developers.cloudflare.com/containers/api/durable-object-container/#exec)
and [scheduling policy contract](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).

CPU boundary/collector/VM overhead attribution, provisioned memory (not RSS),
egress and every other required measurement remain separate owner decisions
and producers. This source does not fill missing meters, settle a quote, change
a tariff, capture/release a hold, or write a second financial ledger.
