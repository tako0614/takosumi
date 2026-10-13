# Operations guide

These pages cover updating, backing up, and troubleshooting your own Takosumi deployment.
Start with [Running it yourself](../concepts/self-host.md) for deployment boundaries and
installation. To try the stock Bun/PostgreSQL composition locally, use its temporary override
procedure there.

- [Updating](./upgrade.md)
- [Backup and recovery](./backup-restore.md)
- [Troubleshooting](./troubleshooting.md)

Start monitoring with `deploy/observability/grafana/takosumi-deploy-overview.json`.
`/metrics` requires the `TAKOSUMI_METRICS_SCRAPE_TOKEN` bearer. Scrape labels omit
Workspace/Capsule IDs; inspect individual records through authorized APIs.

Set a public HTTP(S) URL as `TAKOSUMI_TCS_STORE_URL` in the composed app environment to
select an external TCS store. The service advertises it through
`/.well-known/takosumi` at `endpoints.extensions["takosumi.tcs-store.v1"]` as
the URL string read by the dashboard's `runtimeStoreUrl()`, so changing the store needs no SPA rebuild. Usernames,
passwords, query strings, and fragments are rejected. Without runtime configuration, the
dashboard uses build-time `VITE_TAKOSUMI_TCS_STORE_URL`; when both are absent there is no
default store. The stock Bun/PostgreSQL composition has no runner or runner artifact store,
and a TCS URL does not add those capabilities. See [Backup and recovery](./backup-restore.md)
for control and pre-destroy export storage.
