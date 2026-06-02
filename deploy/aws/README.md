# Takosumi AWS Kind Runbook

This directory documents the AWS surface as **operator-owned scope**: AWS native kind implementations (`takosumi-plugins/packages/kind-aws-*`) and runtime-agent connectors (`takosumi-plugins/packages/runtime-agent-connectors/src/connectors/aws/`) provide AWS lifecycle coverage when the operator wires them into their distribution. The deploy artifact (the Terraform / CDK / Pulumi that lands the Takosumi service image and runtime-agent image on AWS infrastructure) is also the operator's responsibility. Operators provide the production-grade AWS IaC stack for their distribution.

## Why no reference deploy here

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/single-host/`) cover the substrate-neutrality claim at spec level. AWS / GCP / Azure / k8s are operator-owned targets: operators run the service image on whatever AWS compute they prefer (ECS / Fargate / EC2 / EKS), point the service at a Postgres database (RDS / Aurora), and attach the needed AWS implementation subpaths such as `@takosjp/takosumi-plugins/kind/aws-fargate-web-service`, `@takosjp/takosumi-plugins/kind/aws-rds-postgres`, `@takosjp/takosumi-plugins/kind/aws-s3-object-store`, or `@takosjp/takosumi-plugins/kind/aws-route53-gateway`.

## Required runtime shape

The AWS connectors talk to the AWS API directly via SigV4-signed fetch calls (no AWS SDK dependency). They expect:

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
TAKOSUMI_PLUGIN_LIVE_PROVIDER=aws \
TAKOSUMI_PLUGIN_LIVE_PROOF_FIXTURE_FILE=fixtures/live-provisioning/aws.shape-v1.json \
bun run live-provisioning-smoke
```

Use `TAKOSUMI_PLUGIN_LIVE_PROOF_MODE=live` plus
`TAKOSUMI_PLUGIN_GATEWAY_URL` / provider-specific gateway credentials when
running the destructive live proof. Without live mode, the command runs the
credential-free fixture proof and reports `"live": false`.

## Substrate-neutral references

If you want a reference Docker image to base your AWS task definitions on, copy `deploy/single-host/Dockerfile.service` and `deploy/single-host/Dockerfile.runtime-agent`. They are substrate- neutral and run unmodified on any container runtime, including AWS Fargate / ECS / EKS.
