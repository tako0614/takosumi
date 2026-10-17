# Troubleshooting

If the local smoke-test project does not start, use the `local_compose` helper in the same
shell as its startup. For the local check, `local_project` and `local_dir` are the ones
you set in [Local loopback check](../concepts/self-host.md#local-loopback-check).
For production, configure the helper with the same project and Compose file arguments
used when it was started.

```bash
set -euo pipefail
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose ps
local_compose logs --tail=100 postgres migrations accounts
curl -i http://localhost:26401/healthz # loopback-only local test
```

When `migrations` fails, `accounts` will not start. Preserve the migration error and applied
state before repairing. The Accounts health check also checks its PostgreSQL connection.
With the production Caddy composition, check `https://<public-hostname>/healthz`.

For Run failures, inspect status/errorCode in the dashboard or authorized `GET /api/v1/runs/:runId`, then
use logs/events to identify the failing phase.

| Symptom | Check |
| --- | --- |
| Source fetch fails | Git URL/ref, SourceSnapshot, Git connection |
| Waiting for approval | Stored Plan contents and approver |
| Stays queued | If another Run is in progress on the same service (Capsule), it waits for that Run to finish; check Deploy history in the dashboard. On Cloudflare, it also waits while every runner container slot is in use (`max_instances` in `wrangler.toml`, 10 in the template). If no slot frees within about 15 minutes, it stops waiting and logs `takosumi.run_owner.controller_poll_deadline_exceeded`, which `bunx wrangler tail` shows. The Run then stays queued until the periodic repair sweep described below picks it up. Also check that your `wrangler.toml` keeps the template's `RUNNER` binding |
| runner_capability_missing | The standard Bun and PostgreSQL composition has no runner. Plan and apply need a composition with a runner (see [Choosing a shape](../concepts/self-host.md#choosing-a-shape)) |
| Migration fails | Check `local_compose logs migrations postgres`, database connectivity, and applied migrations. Do not run a down migration. |
| `/healthz` does not respond | Check `local_compose ps`, Accounts logs, published port, and bind address. The local test uses `localhost:26401`. |
| Dashboard loads but sign-in fails | Check issuer, origin, redirect URI, and explicit mapping for upstream `clientSecretEnv`. |
| Provider authentication rejected | Phase-specific ProviderConnection, recipe, permissions, expiry |
| State/fence/receipt mismatch | Retained evidence and current state; investigate indeterminate mutations before retry |

The Cloudflare repair sweep picks up stalled Runs again and counts them as
`takosumi_run_repair_total{outcome="rescheduled"}`. Repair failures appear in `scheduled.run_repair_failures` and
`takosumi_run_repair_total{outcome="ordinary_failure"}` / `{outcome="retirement_failure"}`.
Source-poll, stale-auto-plan, and drift warnings identify the phase without exception text
or credentials.

Distinguish validation failures resolved by a new Plan from an unknown provider-mutation
outcome. A new Plan alone cannot resolve the latter. See the
[Run model](../concepts/run-model.md) and [state and outputs](../concepts/state-and-outputs.md).
