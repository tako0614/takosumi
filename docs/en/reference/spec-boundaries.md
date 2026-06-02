# Specification Boundaries {#spec-boundaries}

Takosumi ecosystem surfaces have different owners and compatibility promises.

| Surface | Question |
| --- | --- |
| Takosumi | Can this Source be installed, deployed, rolled back, and recorded? |
| Operator distribution | How are account plane, PlatformService inventory, backend behavior, and OpenTofu state provided? |
| Operator implementation | How are runtime-agent implementation code, inventory importers, and backend adapters provided? |

## Takosumi

Takosumi owns Source / Installation / Deployment / PlatformService DTOs, the five Installer API endpoints, `InstallPlan`,
source guards, `planSnapshotDigest`, Deployment records, and pointer rollback.

Takosumi does not own OpenTofu execution, provider credentials, account APIs, billing, OIDC, dashboard,
operator infrastructure graphs, or source-repo-specific Takosumi DSL.

## Operator Distribution

Operator distributions own account-facing behavior and backend operation: account ownership, installer tokens,
PlatformService inventory, OpenTofu state where used, OIDC, billing, dashboard, deploy facade, runtime and
gateway choices.

## Operator Implementation

Operator implementation contains operator-owned inventory importers, runtime-agent implementation code, and backend
adapters. It is not an OpenTofu provider replacement or a Takosumi package split.

## Related

- [Takosumi v1](./takosumi-v1.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
