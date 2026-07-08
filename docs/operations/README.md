# Takosumi Operator Runbooks

This directory contains operator runbooks for deployment, rollback, incident
response, cost monitoring, secret rotation, readiness collection, and production
verification.

These documents are not published product docs and are not customer-facing
contracts. They may mention operator-local paths, deployment commands, private
evidence records, payment-provider synchronization, support procedures, and
closed implementation details that must not be copied into public docs.

Use public docs for stable external contracts:

```text
../index.md
../reference/api.md
../reference/model.md
../reference/docs-contract.md
../../app-docs/index.md
../../app-docs/pricing.md
```

Use this directory for operator procedures:

```text
platform-worker-deploy.md
real-cloud-staging.md
cloud-customer-operations.md
cloud-pricing.md
secret-rotation.md
incident-response.md
rollback-sop.md
```

When a runbook detail becomes a public contract, rewrite the stable contract
into the public docs without private paths, secret names, raw evidence refs,
payment-provider IDs, or implementation wiring.
