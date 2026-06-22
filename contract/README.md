# Takosumi Contract

TypeScript DTOs and wire types for the OpenTofu-native Takosumi control-plane
contract.

The target public contract is centered on the final Takosumi model:

- `Workspace` - user/team boundary for projects, provider connections,
  secrets, state isolation, and audit.
- `Project` - one product, service, application, or infrastructure group.
- `Capsule` - one Git-hosted OpenTofu/Terraform module execution unit.
- `Source` - Git URL/ref/path registration and commit-pinned source identity.
- `ProviderConnection` - provider credential configuration stored by Takosumi.
- `CredentialRecipe` - provider-specific env/file/pre-run action definition for
  running an existing OpenTofu/Terraform provider as-is.
- `ProviderBinding` - provider address or alias to ProviderConnection mapping.
- `Secret` - encrypted backing material; secret values are write-only and
  redacted from logs and public records.
- `Run` / `Plan` / `Apply` / `Destroy` - execution records for init, validate,
  plan, apply, destroy, refresh, and output flows.
- `StateVersion` - persisted Capsule state generation.
- `Output` - captured `tofu output -json`, projected for UI and downstream
  inputs without exposing secret literals.
- `Runner` - local/docker/remote/operator/cloud execution boundary for checkout,
  OpenTofu execution, state sync, output extraction, and cleanup.
- `AuditEvent` - actor/action/target/result evidence.
- `Operator` - the party operating an OSS Takosumi for Operators instance.

Current DTOs and routes may still expose legacy names from the previous
architecture. Treat `Space`, `Installation`, `InstallConfig`, `Dependency`,
`DependencySnapshot`, `RunGroup`, `StateSnapshot`, `OutputSnapshot`,
`Deployment`, `Activity`, Provider Catalog, Gateway, and provider ownership
flags as migration debt or implementation compatibility only unless
a change deliberately maps them to the final model. In particular:

- `Space` maps to the Workspace owner boundary.
- `Installation` maps to a Capsule plus service-side configuration.
- `StateSnapshot`, `OutputSnapshot`, and `Deployment` map to StateVersion,
  Output, and successful Run evidence.
- `Dependency`, `DependencySnapshot`, and OutputShare-style records map to
  output-to-input wiring between Capsules.

Account-plane workload compatibility shapes remain internal and are not
re-exported from the public deploy-control contract facade.

Repositories are plain OpenTofu modules. Repository metadata is inferred from
Git URL, commit, module path, tags, and well-known OpenTofu outputs. The
contract does not define a Takosumi source DSL or Takosumi-specific repository
metadata file.

The OSS contract runs existing providers through ProviderConnection,
CredentialRecipe, ProviderBinding, and per-run env/file injection. It must not
define Cloudflare Compatibility Gateway, AWS/GCP compatibility APIs, S3 gateway,
Resource Driver systems, Compat Pack systems, managed Edge/Storage/Container
resources, official billing, official quota/usage, or official resource
backends as OSS product concepts; those belong to closed Takosumi Cloud.
