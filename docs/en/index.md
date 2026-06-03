# Takosumi

Takosumi is an OpenTofu-native deploy control plane, UI, and audit ledger.

OpenTofu configuration is the resource definition. Takosumi does not introduce a second infrastructure definition format. It records Git identity, source digest, variables digest, provider policy, plan digest, apply result, Deployment ledger entries, and non-sensitive OpenTofu outputs.

## What Takosumi does

1. An operator defines RunnerProfiles.
2. A user or dashboard registers a plain OpenTofu module repository as an Installation.
3. Takosumi creates a PlanRun and records policy, source, variables, provider lock, and plan digests.
4. A reviewed PlanRun creates an ApplyRun only when its expected guard matches.
5. A successful apply becomes a Deployment and publishes non-sensitive DeploymentOutput records.

## Public v1 surface

| Concept | Meaning |
| --- | --- |
| Installation | Space-scoped installed OpenTofu module record |
| PlanRun | One `tofu plan` attempt and reviewable digest record |
| ApplyRun | One `tofu apply` or destroy attempt |
| Deployment | Successful apply result |
| DeploymentOutput | Non-sensitive output projection |
| RunnerProfile | Operator execution, tenant runtime, and secret exposure boundary |

Start with the [Quickstart](./getting-started/quickstart.md).
