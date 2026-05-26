# Takosumi AWS Kind Runbook

This directory documents the AWS surface as **operator-owned scope**: AWS native kind packages (`takosumi-plugins/packages/kind-aws-*`) and runtime-agent connectors (`packages/runtime-agent/src/connectors/aws/`) provide AWS lifecycle coverage when the operator wires them into their distribution. The deploy artifact (the Terraform / CDK / Pulumi that lands the Takosumi kernel image and runtime-agent image on AWS infrastructure) is also the operator's responsibility. Operators provide the production-grade AWS IaC stack for their distribution.

## Why no reference deploy here

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/single-host/`) cover the substrate-neutrality claim at spec level. AWS / GCP / Azure / k8s are operator-owned targets: operators run the kernel image on whatever AWS compute they prefer (ECS / Fargate / EC2 / EKS), point the kernel at a Postgres database (RDS / Aurora), and attach the needed AWS kind factories such as `@takos/takosumi-kind-aws-fargate-web-service`, `@takos/takosumi-kind-aws-rds-postgres`, `@takos/takosumi-kind-aws-s3-object-store`, or `@takos/takosumi-kind-aws-route53-gateway`.

## Required runtime shape

The AWS connectors talk to the AWS API directly via SigV4-signed fetch calls (no AWS SDK dependency). They expect:

- AWS credentials supplied via `TAKOSUMI_AWS_ACCESS_KEY_ID` / `TAKOSUMI_AWS_SECRET_ACCESS_KEY` env vars on the runtime-agent process, or via instance role / IRSA when running on AWS compute.
- A Postgres database for kernel state (`TAKOSUMI_DATABASE_URL`).
- Network reachability from the runtime-agent to the AWS API endpoints in the relevant region.

## Recommended topology

```
Internet → ALB / CloudFront
              │
              ▼
        kernel (Fargate task)  ── Postgres (RDS)
              │
              ▼
    runtime-agent (Fargate task)  ── AWS API (S3, RDS, ECS, Route53)
```

Both kernel and runtime-agent are stateless; scale horizontally with Fargate service desired count. State lives in RDS.

## Smoke check

```sh
TAKOSUMI_AWS_ACCESS_KEY_ID=... \
TAKOSUMI_AWS_SECRET_ACCESS_KEY=... \
deno task live-smoke --provider aws --shape object-store
```

The live smoke calls each native kind lifecycle once and tears down.

## Substrate-neutral references

If you want a reference Docker image to base your AWS task definitions on, copy `deploy/single-host/Dockerfile.kernel` and `deploy/single-host/Dockerfile.runtime-agent`. They are substrate- neutral and run unmodified on any container runtime, including AWS Fargate / ECS / EKS.
