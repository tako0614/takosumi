# Takosumi AWS Kind Runbook

This directory documents the AWS surface as **operator-owned scope**. AWS lifecycle coverage comes from the operator's OpenTofu/native controller stack plus runtime-agent handler wiring. The deploy artifact that lands the Takosumi service image and runtime-agent image on AWS infrastructure is also the operator's responsibility.

## Why no reference deploy here

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/single-host/`) cover the substrate-neutrality claim at spec level. AWS / GCP / Azure / k8s are operator-owned targets: operators run the service image on whatever AWS compute they prefer (ECS / Fargate / EC2 / EKS), point the service at a Postgres database (RDS / Aurora), and expose the resulting databases, buckets, queues, DNS routes, and runtimes through PlatformService inventory.

## Required runtime shape

The AWS runtime handlers talk to the AWS API directly via SigV4-signed fetch calls (no AWS SDK dependency). They expect:

- AWS credentials supplied via `TAKOSUMI_AWS_ACCESS_KEY_ID` / `TAKOSUMI_AWS_SECRET_ACCESS_KEY` env vars on the runtime-agent process, or via instance role / IRSA when running on AWS compute.
- A Postgres database for service state (`TAKOSUMI_DATABASE_URL`).
- Network reachability from the runtime-agent to the AWS API endpoints in the relevant region.

## Recommended topology

```
Internet → ALB / CloudFront
              │
              ▼
        service (Fargate task)  ── Postgres (RDS)
              │
              ▼
    runtime-agent (Fargate task)  ── AWS API (S3, RDS, ECS, Route53)
```

Both service and runtime-agent are stateless; scale horizontally with Fargate service desired count. State lives in RDS.

## Smoke check

```sh
TAKOSUMI_AWS_ACCESS_KEY_ID=... \
TAKOSUMI_AWS_SECRET_ACCESS_KEY=... \
TAKOSUMI_PROVIDER_LIVE_PROVIDER=aws \
TAKOSUMI_PROVIDER_LIVE_PROOF_FIXTURE_FILE=fixtures/live-provisioning/aws.shape-v1.json \
bun run live-provisioning-smoke
```

Use `TAKOSUMI_PROVIDER_LIVE_PROOF_MODE=live` plus
`TAKOSUMI_PROVIDER_GATEWAY_URL` / provider-specific gateway credentials when
running the destructive live proof. Without live mode, the command runs the
credential-free fixture proof and reports `"live": false`.

## Substrate-neutral references

If you want a reference Docker image to base your AWS task definitions on, copy `deploy/single-host/Dockerfile.service` and `deploy/single-host/Dockerfile.runtime-agent`. They are substrate- neutral and run unmodified on any container runtime, including AWS Fargate / ECS / EKS.
