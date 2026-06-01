# Takosumi Contract

TypeScript DTOs and wire types for the manifestless Takosumi v1 Installer API.

The public contract is centered on four concepts:

- `Source` - git, prepared, or local source input.
- `Installation` - a Space-scoped installed source record.
- `Deployment` - one apply result with source identity, plan snapshot, binding snapshot, outputs, and status.
- `PlatformService` - an operator-catalog service that can be bound during install or deploy.

Dry-run responses include an `InstallPlan` and `planSnapshotDigest`. The plan is
review evidence, not a persisted public entity. Apply requests can include the
expected digest to guard the reviewed source and operator binding resolution.

Repository metadata is inferred from generic source metadata such as Git URL,
commit, and `package.json` fields. The contract does not define a Takosumi
source DSL or Takosumi-specific repository metadata field.
