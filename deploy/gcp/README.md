# Takosumi GCP Kind Runbook

This directory documents the GCP surface as **operator-owned scope**. GCP lifecycle coverage comes from the operator's OpenTofu/native controller stack plus runtime-agent connector wiring. The deploy artifact that lands the Takosumi service image and runtime-agent image on GCP infrastructure is also the operator's responsibility.

## Why no reference deploy here

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/single-host/`) cover the substrate-neutrality claim at spec level. GCP / AWS / Azure / k8s are operator-owned targets: operators run the service image on whatever GCP compute they prefer (Cloud Run / GKE / GCE), point the service at a Postgres database (Cloud SQL), and expose the resulting databases, buckets, queues, DNS routes, and runtimes through PlatformService inventory.

## Required runtime shape

The GCP connectors talk to the GCP API directly via OAuth-bearer tokens (no GCP SDK dependency). They expect:

- A service account with the relevant roles (`roles/storage.admin`, `roles/run.admin`, `roles/cloudsql.admin`, `roles/dns.admin`) and either a JSON key or workload identity.
- A Postgres database for service state (`TAKOSUMI_DATABASE_URL` — Cloud SQL with Cloud SQL Auth Proxy is the typical choice).
- Network reachability from the runtime-agent to the GCP API endpoints in the relevant region.

## Recommended topology

```
Internet → Cloud Load Balancer
              │
              ▼
      service (Cloud Run service) ── Cloud SQL
              │
              ▼
  runtime-agent (Cloud Run service) ── GCP API (GCS, Run, SQL, DNS)
```

Both service and runtime-agent are stateless; Cloud Run scales them horizontally. State lives in Cloud SQL.

## Smoke check

```sh
TAKOSUMI_GCP_SERVICE_ACCOUNT_JSON='{...}' \
TAKOSUMI_PROVIDER_LIVE_PROVIDER=gcp \
TAKOSUMI_PROVIDER_LIVE_PROOF_FIXTURE_FILE=fixtures/live-provisioning/gcp.shape-v1.json \
bun run live-provisioning-smoke
```

Use `TAKOSUMI_PROVIDER_LIVE_PROOF_MODE=live` plus
`TAKOSUMI_PROVIDER_GATEWAY_URL` / provider-specific gateway credentials when
running the destructive live proof. Without live mode, the command runs the
credential-free fixture proof and reports `"live": false`.

## Substrate-neutral references

If you want a reference Docker image to base your Cloud Run / GKE deployments on, copy `deploy/single-host/Dockerfile.service` and `deploy/single-host/Dockerfile.runtime-agent`. They are substrate-neutral and run unmodified on any container runtime, including Cloud Run and GKE.
