# Takos GCP Provider Runbook

This directory documents the GCP surface as **operator-owned scope**: the operator-attached provider package (`packages/gcp-providers/`) and runtime-agent connectors (`packages/runtime-agent/src/connectors/gcp/`) provide GCP lifecycle coverage when the operator wires them into their distribution. The deploy artifact (the Terraform / Pulumi / Deployment Manager that lands the Takosumi kernel image and runtime-agent image on GCP infrastructure) is also the operator's responsibility. Operators provide the production-grade GCP IaC stack for their distribution.

## Why no reference deploy here

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/selfhosted/`) cover the substrate-neutrality claim at spec level. GCP / AWS / Azure / k8s are operator-owned targets: operators run the kernel image on whatever GCP compute they prefer (Cloud Run / GKE / GCE), point the kernel at a Postgres database (Cloud SQL), and attach the GCP provider factories from `@takos/takosumi-gcp-providers` plus matching runtime-agent credentials.

## Required runtime shape

The GCP connectors talk to the GCP API directly via OAuth-bearer tokens (no GCP SDK dependency). They expect:

- A service account with the relevant roles (`roles/storage.admin`, `roles/run.admin`, `roles/cloudsql.admin`, `roles/dns.admin`) and either a JSON key or workload identity.
- A Postgres database for kernel state (`TAKOSUMI_DATABASE_URL` — Cloud SQL with Cloud SQL Auth Proxy is the typical choice).
- Network reachability from the runtime-agent to the GCP API endpoints in the relevant region.

## Recommended topology

```
Internet → Cloud Load Balancer
              │
              ▼
      kernel (Cloud Run service) ── Cloud SQL
              │
              ▼
  runtime-agent (Cloud Run service) ── GCP API (GCS, Run, SQL, DNS)
```

Both kernel and runtime-agent are stateless; Cloud Run scales them horizontally. State lives in Cloud SQL.

## Smoke check

```sh
TAKOSUMI_GCP_SERVICE_ACCOUNT_JSON='{...}' \
deno task live-smoke --provider gcp --shape object-store
```

## Substrate-neutral references

If you want a reference Docker image to base your Cloud Run / GKE deployments on, copy `deploy/selfhosted/Dockerfile.kernel` and `deploy/selfhosted/Dockerfile.runtime-agent`. They are substrate-neutral and run unmodified on any container runtime, including Cloud Run and GKE.
