# Takosumi Contract

TypeScript DTOs and wire types for the OpenTofu-native Takosumi v1 Deploy
Control API.

The public contract is centered on these concepts:

- `RunnerProfile` - operator-owned OpenTofu runner policy, provider allowlist,
  credential reference boundary, state backend, execution substrate, tenant
  runtime dispatch, and secret exposure policy.
- `PlanRun` - persisted review record for `tofu plan`.
- `ApplyRun` - persisted execution record for `tofu apply`.
- `Installation` - Space-scoped installed OpenTofu module record.
- `Deployment` - immutable apply result with source identity, runner profile,
  plan digest, provider lock digest, outputs, and status.
- `DeploymentOutput` - public non-secret output value extracted from
  `tofu output -json`. Sensitive outputs and secret references are not stored
  in the public ledger.

Repositories are plain OpenTofu modules. Repository metadata is inferred from
Git URL, commit, module path, tags, and well-known OpenTofu outputs. The
contract does not define a Takosumi source DSL or Takosumi-specific repository
metadata file.
