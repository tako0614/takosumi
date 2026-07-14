# Takosumi Operator Runbooks

This directory contains operator runbooks for deployment, rollback, incident
response, cost monitoring, secret rotation, readiness collection, and production
verification.

These documents are not published product docs and are not customer-facing
contracts. They cover the OSS/Operator deployment boundary and may mention
operator-local paths and evidence classes. Official Cloud payment, managed
capacity, price-book, and closed handler procedures live in
`takosumi-cloud/docs/operations`, not this OSS repository.

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
Deploy / topology:
  platform-worker-deploy.md
  deploy-topology-notes.md
  release-artifacts.md
  lan-dev-setup.md

Pricing / cost:
  cloud-pricing.md
  cost-monitoring.md

Secrets / patching:
  secret-rotation.md
  secret-rotation-policy.md
  patch-management.md

State / migrations:
  resource-state-adoption.md
  online-db-migrations.md

Incident / recovery / on-call:
  incident-response.md
  rollback-sop.md
  disaster-recovery.md
  backup-restore-drills.md
  oncall.md
  troubleshooting.md
```

`cloud-pricing.md` is intentionally only the OSS disabled/showback versus
commercial-extension boundary. When a runbook detail becomes a public
contract, rewrite the stable contract into the public docs without private
paths, secret names, raw evidence refs, payment-provider IDs, or implementation
wiring.

Official hosted launch, staging, customer operations, and real-Cloudflare smoke
procedures live in `takosumi-cloud/docs/operations`. They are not part of the
OSS/Operator software contract.
