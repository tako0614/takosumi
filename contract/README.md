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
- `Operator` - the party operating a Takosumi for Operator instance.

The root contract facade exports canonical names only. Internal stores may still
read old physical columns while operator data is migrated, but that storage
detail is not part of the public contract. Public code should use `Workspace`,
`Capsule`, `StateVersion`, `Output`, `Run`, `ProviderConnection`,
`CredentialRecipe`, and `ProviderBinding` directly.

Account-plane workload compatibility shapes remain internal and are not
re-exported from the public deploy-control contract facade.

Repositories are plain OpenTofu modules. Repository metadata is inferred from
Git URL, commit, module path, tags, and well-known OpenTofu outputs. The
contract does not define a Takosumi source DSL or Takosumi-specific repository
metadata file.

The OSS contract runs existing providers through ProviderConnection,
CredentialRecipe, ProviderBinding, and per-run env/file injection. It must not
define complete provider-compatible cloud APIs or official managed capacity as
OSS product concepts. Compatibility API profiles are scoped capabilities such as
`compat.s3.v1`, `compat.oci.v1`, `compat.cloudevents.v1`, and
`compat.cloudflare.workers.v1`; official managed target pools, billing
enforcement, quota, usage rating, support, and resource backends belong to
Takosumi for Operator / Takosumi Cloud composition.
