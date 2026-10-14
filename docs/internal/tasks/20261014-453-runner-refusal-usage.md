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
destroy. Preserve recording for executed/indeterminate attempts and artifact
relay recovery. Preserve the existing Run-level idempotency key: recovering an
immutable mutation result is not proof of a second provider execution, and a
new key could charge an already-recorded Run again across the code update.
Provider custody, deadlines, retry budget, mutation receipts, reservation
capture/release and existing usage rows are unchanged. No migration or backfill
is introduced. WIP cancellation and Idempotency code are not transplanted.

## Validation and review

Use the actual controller and first-write-wins usage store with a billing port
that returns a rating. Demonstrate the refusal/retry defect before the fix;
then verify successful retry quantities, retry exhaustion and artifact replay
deduplication. Run focused lifecycle tests and the entire owner gate:

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

## Other audit dispositions

The L4 fixed-64-byte comparison exists only in the WIP snapshot; current main
uses full-operand shared comparisons and does not bundle a shared-token HTTP
runner. Metrics identity labels were removed by #426 at emission, rendering
and Grafana selection. Both are checked against current main instead of
recovering old code. The operator `remaining.md` records the exhaustive audit
and a separate hardened self-host runner design. Runner bundling is outside
this PR.
