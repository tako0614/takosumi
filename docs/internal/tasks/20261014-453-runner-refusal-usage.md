# Runner refusal usage accounting (wiprest)

- Owner/repository: Takosumi OSS only, issue #453, branch
  `fix/wiprest-20261014`.
- Base: `2d4619ccf3d318606683d60f2b9ba9ad4199d10b`.
- Input: TASK-0031 WIP audit dated 2026-10-13, section 4 M3.
- Authority trigger: runner usage measurements supplied to the host billing
  port. Independent review of the complete candidate is required.
- Publication scope: ordinary feature-branch push, ready PR and formal QA
  request. No merge, deployment (including staging), production access,
  force-push, direct main push or historical usage rewrite.

## Problem and accounting boundary

The safe mutating-run retry path recognizes `capacity_exhausted` and
`run_deadline_exceeded` as refusals before provider execution. Requeue and
retry exhaustion nevertheless record runner minutes. The usage store dedupes
on `${runId}:runner_minute`, so a refused attempt can occupy the row later
needed by the successful execution.

Suppress runner usage for these explicit pre-provider refusals in apply and
destroy when no runner work preceded the refusal. A destroy can first execute
runner-owned pre-destroy commands. Pair its durable started/succeeded/refusal
audit sequence by attempt and settle those confirmed intervals at terminal
success, exhaustion or queued dead-letter failure, together with any current
execution interval. Exclude queue wait, operator-only actions, duplicate or
malformed evidence and not-applicable actions. Preserve recording for
executed/indeterminate attempts and artifact relay recovery. Preserve the existing Run-level idempotency key: recovering an
immutable mutation result is not proof of a second provider execution, and a
new key could charge an already-recorded Run again across the code update.
Provider custody, deadlines, retry budget, mutation receipts, reservation
capture/release and existing usage rows are unchanged. No migration or backfill
is introduced. WIP cancellation and Idempotency code are not transplanted.

## Validation and review

Use the actual controller and first-write-wins usage store with a billing port
that returns a rating. Demonstrate the refusal/retry defect before the fix;
then verify successful retry quantities, retry exhaustion and artifact replay
deduplication. Add regression proof for pre-destroy runner work followed by a
refusal, success/exhaustion/dead-letter settlement, and operator-only exclusion;
verify nonzero host rating uses the same quantity. The existing coarse Run
wall-time meter is retained, rather than claiming exact container CPU time. Run focused lifecycle tests and the entire owner gate:

```sh
env -u NODE_ENV -u TAKOSUMI_ENVIRONMENT bun run check
```

Task-local dependencies and loopback browser ports 15763/15764 isolate the
checks. The complete candidate SHA, commands, test/phase counts, failed attempts,
raw log SHA-256 and independent review are recorded in the PR and operator
evidence at `/root/dev/takos/.operator-private/Takosumi-wiprest-20261014/`.
The independent reviewer must have no unresolved blocking finding before the
formal quality/release QA request. QA is requested for that complete head; it
does not authorize this owner to merge or deploy.

## PR #454 DLQ settlement follow-up

The Codex P1 review on `e338848281ee2af76cbbc4f4797a366ac0428580`
identified a second loss boundary: the queued destroy backstop commits
`failed` before rating and writing runner usage. A temporary rating or ledger
write failure then escapes, while later deliveries reject the terminal Run.
The controller regression on that source head records 1 pass / 2 fail:
rating and pre-write faults lose the confirmed interval; a write committed
before an acknowledgement fault already deduplicates correctly.

Commit an authenticated positive duration as a runner-usage intent in the
same observed-row/Workspace-fenced terminal CAS. Only the winning failure
writer settles the existing Run-level key. Terminal DLQ delivery and the
existing scheduled Run repair both replay the frozen measurement and close
its audit marker with the existing exact terminal finalizer. Prepared-input
storage outages remain retryable before the terminal write; invalid or
missing proof cannot create a billable intent. A pending intent blocks
Workspace freeze on memory, PostgreSQL and D1. No schema migration, usage
backfill, historical-row rewrite or capture/release change is introduced.

Follow-up evidence lives at
`/root/dev/takos/.operator-private/Takosumi-fix454-20261014/`.
Validate rating/write/acknowledgement/completion faults, reconstruction on a
fresh controller, frozen measurements after sidecar removal, lost CAS,
store recovery/finalization parity and management blocking, then rerun the
complete owner gate at the final commit on isolated loopback ports.
The follow-up dashboard/docs listeners use ports 16853/16854.
An independent reviewer must report blocking 0 before ordinary branch push
and a new formal QA request to the quality/release owner (`cc1494c7`).
The previously stated publication restrictions still apply.

The first independent follow-up review rejected the candidate because
Workspace archive is separate from management freeze and the ordinary repair
sweep excludes archived Workspaces. A new regression proves that gap before
the additional fix. Preserve the ordinary archived execution exclusion, but
let a known archived Workspace's failed destroy be rescheduled only after an
exact Workspace/Run Core query confirms its durable pending usage intent.
The public Run projection does not expose that internal audit authority.
An individual query outage must not suppress later repairs. The rejected
candidate's partial owner gate was interrupted; only a new complete gate on
the final reviewed head counts toward handoff.

## Other audit dispositions

The L4 fixed-64-byte comparison exists only in the WIP snapshot; current main
uses full-operand shared comparisons and does not bundle a shared-token HTTP
runner. Metrics identity labels were removed by #426 at emission, rendering
and Grafana selection. Both are checked against current main instead of
recovering old code. The operator `remaining.md` records the exhaustive audit
and a separate hardened self-host runner design. Runner bundling is outside
this PR.
