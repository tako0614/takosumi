# Time / Clock Model

> Stability: stable Audience: operator, kernel-implementer See also:
> [Audit Events](/reference/audit-events),
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [RevokeDebt Model](/reference/revoke-debt),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Space Export Share](/reference/space-export-share)

This page is the v1 contract for time and clock handling in a Takosumi
installation. It defines which clock source backs each time-sensitive feature,
how much skew the kernel tolerates between pods, the canonical timestamp format,
when the kernel reads the clock, how operator clock operations are detected, and
how time interacts with the audit chain.

## Clock sources

Takosumi distinguishes three clock sources. Each feature is bound to one
specific source; mixing sources in a single decision is a kernel implementation
bug.

- **Wall clock** — UTC, NTP-synchronized. Used for any value that an operator,
  integrator, or auditor must interpret as a calendar time: audit `ts`, TTL
  evaluation, approval `expiresAt`, share `expiresAt`, and idempotency window
  boundaries.
- **Monotonic clock** — process-local, never moves backward, advances during
  sleep. Used for any value that is meaningful only as a duration: operation
  duration, lock heartbeat, lock acquire timeout, rate limit window accounting,
  and worker poll backoff.
- **Logical / Lamport-like ordering** — derived from the audit hash chain
  (`prevHash`, `hash`). Used to order events deterministically even when
  wall-clock skew between pods would make `ts` ambiguous. The per-Space and
  global hash chains in [Audit Events](/reference/audit-events#hash-chain)
  provide the order; `ts` is recorded for human reading, not for tie-breaking.

## Per-feature clock binding

The following bindings are normative.

| Feature                                            | Clock source                                             |
| -------------------------------------------------- | -------------------------------------------------------- |
| Approval `expiresAt` evaluation                    | wall clock                                               |
| SpaceExportShare `expiresAt` evaluation            | wall clock                                               |
| RevokeDebt aging window                            | wall clock; monotonic for the in-process grace timer     |
| Lock acquire timeout                               | monotonic                                                |
| Lock heartbeat / TTL                               | monotonic                                                |
| Audit event `ts`                                   | wall clock                                               |
| Audit event ordering                               | Lamport-like (chain hash); `ts` is informational         |
| Idempotency replay window                          | wall clock                                               |
| WAL stage retry backoff                            | monotonic                                                |
| Rate limit token bucket refill                     | monotonic                                                |
| Quota usage time bucket                            | wall clock (boundary) + monotonic (in-bucket arithmetic) |
| Telemetry metric histograms (`*_duration_seconds`) | monotonic                                                |
| Drift detection observation window                 | wall clock                                               |
| Compaction cadence                                 | wall clock (cron-style)                                  |

A feature whose binding is not in the table above is not allowed to read time at
v1; adding one goes through the `CONVENTIONS.md` §6 RFC.

## Clock skew tolerance

Takosumi pods within a single installation must stay within **5 seconds** of
each other on the wall clock. The kernel measures pairwise skew during readiness
probing.

Rationale: 5 秒は practical NTP 同期で実用上達成できる範囲 (典型的には
sub-second) に十分な余裕を持たせつつ、HMAC replay window や lock heartbeat TTL
と整合する閾値。1 秒では NTP step / network jitter で false positive degrade
を頻発させ、10 秒以上では timestamp ordering invariants と replay window
の前提が崩れる。

- The readiness probe rejects pods whose observed skew against the installation
  reference clock exceeds 5 seconds. The pod surfaces as `degraded` until skew
  returns to within tolerance.
- NTP synchronization is an operator responsibility. Operators configure the
  host's NTP daemon to track a stable upstream and do not let local drift exceed
  the tolerance.
- Cross-region installations are out of scope for v1. A v1 installation occupies
  a single time-coherence region.

Rationale: cross-region は wall clock skew + replication latency の合算が NTP
同期前提の 5 秒許容を超える可能性が高く、multi-AZ within region とは 異なる
failure model (network partition の頻度、RTT の桁、independent NTP fleet)
を持つ。v1 は single region (multi-AZ within region は許容) のみを target に
invariants を validate し、cross-region split-brain protocol は 別 reference
として後追加する設計にしている。

A skew event itself is recorded as an audit `operation-failed` event with
`severity: warning` and `errorCode: clock_skew_exceeded`.

## Timestamp format

Every Takosumi timestamp uses the same canonical format.

```text
RFC 3339 in UTC, millisecond precision, trailing Z

example: 2026-05-05T10:00:00.123Z
```

This format applies uniformly across the audit log envelope, the kernel HTTP
API, the runtime-agent API, the CLI output, log lines, and metric exemplars.
Other zone offsets, sub-millisecond precision, and bare seconds are rejected at
parse time.

## TTL evaluation

TTL evaluation reads the wall clock at the **moment** of evaluation, never from
a cache.

- Approval `expiresAt`, share `expiresAt`, and any other TTL field is re-read
  every time the kernel needs to decide validity. A cached decision from a
  previous request is never reused for a TTL check.
- The kernel evaluates TTL strictly: `now > expiresAt` is expired,
  `now == expiresAt` is expired. There is no slop window built into the
  comparator; operator-tunable grace must be applied to `expiresAt` at write
  time.
- A WAL stage that has held a TTL-bound binding across a long `observe` interval
  re-evaluates the TTL when it next acts on the binding; the prior evaluation is
  not durable.

## Operator clock operations

Operators occasionally adjust the host clock (NTP step, manual set, container
migration). The kernel detects the most disruptive cases.

- On every kernel boot, the kernel records the wall-clock value and compares it
  to the value recorded at the prior shutdown. A reverse jump (the new value is
  older than the recorded value) is logged as `severity: warning`.
- A wall-clock reverse jump greater than **1 hour** triggers a safety abort: the
  kernel refuses to enter `apply` until the operator acknowledges the jump via
  the recovery CLI. TTL evaluations during this window are blocked to prevent
  un-expiry of already-expired approvals and shares.
- A forward jump (clock moves into the future) is permitted but surfaces a
  `clock_forward_jump` audit event when the magnitude exceeds 5 minutes. Forward
  jumps cause TTL fields to expire early; this is by design.

## Timezone handling

Internal representation is UTC end-to-end. Operator-facing surfaces may render
local time on top of the UTC value.

- Kernel storage, audit events, telemetry exemplars, and HTTP API responses all
  carry UTC values.
- Operator UIs and CLI output may render in the operator's local zone when the
  operator opts in via `TAKOSUMI_LOG_TIMEZONE` or an equivalent client-side
  flag. The underlying value remains UTC.
- Manifests, plans, and snapshots never carry local-zone timestamps. A manifest
  that submits a non-UTC timestamp is rejected with `invalid_argument`.

## Clock and the audit chain

The audit chain decouples integrity from clock truth.

- Each event records `ts` as the wall-clock value at write time. A later
  operator who finds `ts` implausible cannot rewrite the event without breaking
  `prevHash` continuity.
- Tamper detection runs on the chain hash, not on `ts`. A backdated `ts` (an
  event whose `ts` is older than its predecessor) is permitted by the chain
  rules but is surfaced by internal operator audit verification as a
  `non-monotonic-ts` warning. The current public `takosumi` CLI does not expose
  an `audit verify` command.
- Genesis events at chain rotation read the wall clock once; every later event
  in the rotation derives ordering from the chain.
- Cross-Space ordering is not implied by `ts`. Operators who need a cross-Space
  order use the global chain, not wall-clock comparison.

## Bootstrap

The very first event in a chain (genesis or post-rotation genesis) reads the
wall clock for `ts` and the chain identifier. Every later event in that chain
derives `prevHash` from the prior event, so the chain remains valid across
subsequent clock skew or operator clock operations.

A fresh kernel install whose host clock is unset surfaces as a hard boot
failure: the kernel refuses to write the genesis event when the wall clock
reports a Unix epoch earlier than the kernel's release build date. Operators set
the host clock and NTP source before the first kernel start.

## Operator-facing summary

The minimum operator obligations are:

- Run NTP on every kernel and runtime-agent host with a stable upstream.
- Keep pairwise wall-clock skew within 5 seconds.
- Avoid manual reverse jumps greater than 1 hour. When unavoidable, acknowledge
  the jump via the recovery CLI before re-enabling `apply`.
- Surface clock skew alerts to the same on-call surface that handles audit-store
  and storage alerts.

Meeting these obligations is sufficient for every clock-bound feature in the
per-feature binding table to behave correctly.

## Related design notes

- `design/operator-boundaries` — placement of NTP responsibility and the
  readiness contract.
- `design/operation-plan-write-ahead-journal-model` — clock binding for WAL
  stage retry and idempotency window.
- `design/policy-risk-approval-error-model` — approval `expiresAt` derivation
  and skew-related fail-closed rules.
