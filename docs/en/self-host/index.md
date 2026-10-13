# Operations guide

These pages cover updating, backing up, and troubleshooting your own Takosumi deployment.
Start with [Running it yourself](../concepts/self-host.md) for installation.

- [Updating](./upgrade.md)
- [Backup and recovery](./backup-restore.md)
- [Troubleshooting](./troubleshooting.md)

Start monitoring with `deploy/observability/grafana/takosumi-deploy-overview.json`.
`/metrics` requires the `TAKOSUMI_METRICS_SCRAPE_TOKEN` bearer. Scrape labels omit
Workspace/Capsule IDs; inspect individual records through authorized APIs.

Set `TAKOSUMI_TCS_STORE_URL` to a public HTTP(S) store URL. Discovery advertises it
under `endpoints.extensions["takosumi.tcs-store.v1"]`, so changing the store requires
no SPA rebuild. Usernames, passwords, query strings, and fragments are rejected.
Without runtime configuration the dashboard uses `VITE_TAKOSUMI_TCS_STORE_URL`;
when both are absent there is no default store.
