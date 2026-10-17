# Operations guide

These pages cover updating, backing up, and troubleshooting your own Takosumi deployment.
Start with [Running it yourself](../concepts/self-host.md) for deployment boundaries and
installation. To try the standard Bun and PostgreSQL composition on your own machine, use the
temporary override file (`compose.local-test.yml`) from
[Local loopback check](../concepts/self-host.md#local-loopback-check) on that page.

- [Updating](./upgrade.md)
- [Backup and recovery](./backup-restore.md)
- [Troubleshooting](./troubleshooting.md)

Start monitoring with `deploy/observability/grafana/takosumi-deploy-overview.json`.
`/metrics` requires the `TAKOSUMI_METRICS_SCRAPE_TOKEN` bearer. Scrape labels omit
Workspace/Capsule IDs; inspect individual records through authorized APIs.

The services listed in the dashboard's **Store** come from TCS 2.0 compatible Stores: the one
set on the server, and any a user adds in the browser. To set one on the server, put the public
HTTP(S) URL of the Store in the environment variable `TAKOSUMI_TCS_STORE_URL` and restart the
server (on Cloudflare, redeploy the Worker). Takosumi then tells the dashboard about it through
`endpoints.extensions["takosumi.tcs-store.v1"]` in `/.well-known/takosumi`, so the dashboard
needs no rebuild. Check that it took effect with
`curl https://<public-hostname>/.well-known/takosumi`. A URL with a username, password, query
string, or fragment is ignored, and nothing is advertised. Without the server setting, the
dashboard uses the build-time `VITE_TAKOSUMI_TCS_STORE_URL`; with neither, there is no default
Store. The integration boundary is in [Store API](../reference/store-api.md).

Setting a Store URL does not add a runner or a runner artifact store to the standard Bun and
PostgreSQL composition. See [Backup and recovery](./backup-restore.md)
for control and pre-destroy export storage.
