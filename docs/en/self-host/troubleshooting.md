# Troubleshooting

Inspect status/errorCode in the dashboard or authorized `GET /api/v1/runs/:runId`, then
use logs/events to identify the failing phase.

| Symptom | Check |
| --- | --- |
| Source fetch fails | Git URL/ref, SourceSnapshot, Git connection |
| Waiting for approval | Stored Plan contents and approver |
| Stays queued | Active Runs for the Capsule, runner wiring/capacity, Run-owner dispatch |
| runner_capability_missing | The stock Bun/PostgreSQL distribution has no runner; inspect actual composition |
| Provider authentication rejected | Phase-specific ProviderConnection, recipe, permissions, expiry |
| State/fence/receipt mismatch | Retained evidence and current state; investigate indeterminate mutations before retry |

Cloudflare repair failures appear in `scheduled.run_repair_failures` and
`takosumi_run_repair_total{outcome="ordinary_failure"}` / `{outcome="retirement_failure"}`.
Source-poll, stale-auto-plan, and drift warnings identify the phase without exception text
or credentials.

Distinguish validation failures resolved by a new Plan from an unknown provider-mutation
outcome. A new Plan alone cannot resolve the latter. See the
[Run model](../concepts/run-model.md) and [state and outputs](../concepts/state-and-outputs.md).
