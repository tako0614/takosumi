# Operations guide

This section is for people running Takosumi in their own environment. Standing
it up is covered in [Running it yourself](../concepts/self-host.md); this
section covers the three things that always come after — upgrading, backup and
recovery, and untangling stuck runs.

- [Upgrading](./upgrade.md) — following new versions, and how migrations work
- [Backup and restore](./backup-restore.md) — what to protect against total loss
- [Troubleshooting](./troubleshooting.md) — triaging runs that will not move

For monitoring, start from the bundled alert rules
(`deploy/observability/prometheus/takosumi-alerts.yaml`) and Grafana dashboard
(`deploy/observability/grafana/takosumi-deploy-overview.json`). `/metrics`
serves Prometheus exposition behind the `TAKOSUMI_METRICS_SCRAPE_TOKEN` bearer.
