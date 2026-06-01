# Specification Boundaries {#spec-boundaries}

Takosumi ecosystem surfaces have different owners and compatibility promises.

| Surface | Question |
| --- | --- |
| Takosumi core | Can this Source be installed, deployed, rolled back, and recorded? |
| Operator distribution | How are account plane, PlatformService inventory, backend behavior, and Terraform state provided? |
| Integration packages | How are runtime-agent connectors, inventory importers, and backend adapters provided? |

## Takosumi Core

Core owns Source / Installation / Deployment / PlatformService DTOs, the five Installer API endpoints, `InstallPlan`,
source guards, `planSnapshotDigest`, Deployment records, and pointer rollback.

Core does not own Terraform/OpenTofu execution, provider credentials, account APIs, billing, OIDC, dashboard, cloud
resource graphs, or source-repo-specific Takosumi DSL.

## Operator Distribution

Operator distributions own account-facing behavior and backend operation: account ownership, installer tokens,
PlatformService inventory, Terraform/OpenTofu state where used, OIDC, billing, dashboard, deploy facade, runtime and
gateway choices.

## Integration Packages

`takosumi-plugins` contains operator-adoptable inventory importers, runtime-agent connectors, and backend adapters. It
is not a Terraform provider replacement.

## Related

- [Core Specification](./core-spec.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
