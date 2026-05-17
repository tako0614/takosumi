# Takos GCP Provider Runbook

This directory documents the GCP surface as **operator-owned scope**:
the kernel-side provider plugins
(`packages/plugins/src/providers/gcp/`) and runtime-agent connectors
(`packages/runtime-agent/src/connectors/gcp/{gcs,cloud_run,cloud_sql}.ts`)
are production-grade and ship by default. The deploy artifact (the
Terraform / Pulumi / Deployment Manager that lands the Takosumi
kernel image and runtime-agent image on GCP infrastructure) is the
operator's responsibility — Takosumi does not ship a reference IaC
stack for GCP.

## Why no reference deploy here

The two reference distributions Takosumi ships
(`deploy/cloudflare/` and `deploy/selfhosted/`) cover the
substrate-neutrality claim at spec level. GCP / AWS / Azure / k8s are
spec-compliant — operators run the kernel image on whatever GCP
compute they prefer (Cloud Run / GKE / GCE) and point the kernel at
a Postgres database (Cloud SQL). Once the kernel is reachable, all
4 GCP provider plugins (`@takos/gcp-gcs`, `@takos/gcp-cloud-run`,
`@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`) work without
modification.

## Required runtime shape

The GCP connectors talk to the GCP API directly via OAuth-bearer
tokens (no GCP SDK dependency). They expect:

- A service account with the relevant roles
  (`roles/storage.admin`, `roles/run.admin`, `roles/cloudsql.admin`,
  `roles/dns.admin`) and either a JSON key or workload identity.
- A Postgres database for kernel state (`TAKOSUMI_DATABASE_URL` —
  Cloud SQL with Cloud SQL Auth Proxy is the typical choice).
- Network reachability from the runtime-agent to the GCP API
  endpoints in the relevant region.

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

Both kernel and runtime-agent are stateless; Cloud Run scales them
horizontally. State lives in Cloud SQL.

## Smoke check

```sh
TAKOSUMI_GCP_SERVICE_ACCOUNT_JSON='{...}' \
deno task live-smoke --provider gcp --shape object-store
```

## Substrate-neutral references

If you want a reference Docker image to base your Cloud Run / GKE
deployments on, copy `deploy/selfhosted/Dockerfile.kernel` and
`deploy/selfhosted/Dockerfile.runtime-agent`. They are
substrate-neutral and run unmodified on any container runtime,
including Cloud Run and GKE.
