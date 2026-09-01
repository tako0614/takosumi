# Troubleshooting

When a run will not move, identify the run first, then the phase.

1. Find `status` and `errorCode` in the dashboard Activity or
   `GET /api/v1/runs/:runId`.
2. Find the failing phase (source / plan / apply) in
   `GET /api/v1/runs/:runId/logs`. Each phase carries different credentials
   (source → git only, plan / apply → provider only), so credential errors
   narrow down by phase.

## Quick table

| Symptom | Main signal | First move |
| --- | --- | --- |
| Fetching the source fails | Run `failed` + a git error in the source phase | Check the Source URL / ref and the Git connection's status |
| Stuck waiting for approval | Run `waiting_approval` | Find the approver. Deletion is two-stage: review → approve → run |
| Runs for the same service will not start | stays `queued` | Check for an in-flight run on the same Capsule; a run with a dead heartbeat is taken over automatically after ~10 minutes |
| An install stalled midway | The service shows "needs attention" | Retry from the update review on the detail screen, or delete and start over |
| Provider credentials are rejected | Provider errors in plan / apply | Test the connected account; rotate it if revoked or expired |
| The runner does not start | dispatch timeout / runner infrastructure error | On compose, check the `opentofu-runner` container's health and that `TAKOSUMI_RUNNER_SHARED_TOKEN` matches on both sides |
| A scheduled deletion never runs | "Deletion scheduled" past its date | Check the scheduler metrics below; work items retry up to 3 times |

## Self-healing, and watching it

A periodic sweep (every 5 minutes) reclaims stuck runs. When that recovery
lane itself is down, nothing self-heals any more — watch these:

- `takosumi_run_repair_total{outcome="failed"}` — repair failures
- `takosumi_run_queue_oldest_age_seconds` — the oldest queued run's wait
- `takosumi_billing_capture_pending` — applies with unfinalized billing
- `takosumi_work_items_backlog` — scheduled intent (deferred deletions) piling up

The bundled alert rules
(`deploy/observability/prometheus/takosumi-alerts.yaml`) carry thresholds for
all four.

## Verification errors mean: plan again

Apply only executes a saved plan, and verifies its digest, the source
snapshot, and the state generation. A verification error is the sign that
state moved on — nothing is broken; create a new plan and continue from the
new baseline.
