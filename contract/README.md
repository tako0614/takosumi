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
- `Secret` - encrypted Stack-flow backing material; secret values are
  write-only and redacted from logs and public records. Current v1alpha1
  material is sealed through ProviderConnection registration; it does not
  publish a standalone Secret API or bundled `Secret` Resource Shape.
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

Mobile delivery remains product-owned. `notification-pushers.ts` is the
portable client-to-host registration contract for new mobile shells; Takosumi
does not define a generic push service, managed target, or Resource Shape.
`mobile.ts` also retains typed `MobilePushHostRegistration*` DTOs and a strict
parser as a wire-compatibility surface for product hosts that still expose a
native-token registration route. The shared mobile kit does not advertise or
call that compatibility route, and product-specific token storage and delivery
stay in the product host.

Repositories are plain OpenTofu modules. Source identity comes from the
configured Git URL, ref, and module path plus the resolved commit. OpenTofu
Outputs remain ordinary state results; Takosumi exposes or consumes selected
values only through explicit service-side Output allowlists and Interface input
mappings. The contract does not define a Takosumi source DSL or
Takosumi-specific repository metadata file.

Platform launch evidence has a provider-neutral OSS baseline. Optional host or
edition requirements use the public, versioned
`PlatformReadinessContribution` contract. A contribution declares requirement
groups, evidence schemas, consistency rules, and redaction patterns as data;
the generic validator composes them through a duplicate-rejecting registry and
embeds the selected definitions in the readiness document. Extension code is
not a second validation authority, and absent contributions add no requirements.
Optional `collectionClassHints` only maps contribution-owned evidence types to
the fixed generic collector classes; it cannot define a new collector DSL or
attach host vocabulary to the OSS baseline.

The OSS contract runs existing providers through ProviderConnection,
CredentialRecipe, ProviderBinding, and per-run env/file injection. It must not
define complete provider-compatible cloud APIs or official managed capacity as
OSS product concepts. Compatibility API profiles are scoped capabilities such as
`compat.s3.v1`, `compat.oci.v1`, `compat.cloudevents.v1`, and
`compat.kubernetes.crd.v1`; official managed target pools, billing
enforcement, quota, usage rating, support, and resource backends belong to
Takosumi for Operator / Takosumi Cloud composition.

A CredentialRecipe auth mode may carry localized `presentation`, `inputHints`,
and an HTTPS setup guide. Those fields let any service-installed recipe render
the same generic Provider Connection form without a dashboard provider catalog.
They are presentation only: provider admission and credential materialization
remain exclusively defined by the recipe's explicit `env`, `files`, and
`preRun` contract, while providers without a guided recipe remain valid through
the generic-env path.
