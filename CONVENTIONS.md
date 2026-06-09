# Takosumi Conventions

Takosumi v1 is OpenTofu-native. A repository is installed as a plain OpenTofu
module using generic repository metadata; it does not carry a Takosumi-specific
metadata file, component graph, provider selector, or repository metadata field.

## Public Words

- `Space`: owner namespace (`@handle`) for members, Sources, Connections,
  Installations, the dependency DAG, policy, activity, and billing.
- `Source`: Git URL / default ref / module path record that yields immutable
  SourceSnapshots.
- `Connection`: operator default or Space-owned external connection used through
  ProviderBinding.
- `Provider Template`: provider source / credential source / helper / policy
  catalog. Hosted managed default starts Cloudflare-only.
- `Provider Env Set`: Space-owned provider definition for arbitrary
  OpenTofu providers.
- `ProviderEnvSet`: Space-scoped trust record for a Provider Env Set provider
  version and checksums.
- `Installation`: Space-scoped OpenTofu Capsule execution unit.
- `Dependency`: output-to-input edge between Installations.
- `Run`: persisted source_sync / compatibility_check / plan / apply /
  destroy_plan / destroy_apply execution record.
- `RunGroup`: ordered group of Runs across the Installation DAG.
- `Deployment`: one successful apply result with source snapshot, dependency
  snapshot, state generation, output snapshot, and status.
- `OutputSnapshot`: projected `tofu output -json` generation after apply.
- `Activity`: Space-scoped audit trail.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Do not
add a new Takosumi public selector DSL.

## Operator Execution Boundary

Operator distributions own internal execution profiles, provider credential
mint drivers, OpenTofu state storage, runtime attachment, approval gates, and
account-facing policy. A distribution may populate policy from OpenTofu modules,
static config, cloud APIs, dashboard input, or private ops inventory. Takosumi
records policy decisions, Run evidence, Deployment, and OutputSnapshot records;
it does not expose provider credential values.

Backend adapters and runner implementations live in the operator distribution.
Those exports are distribution-local API, not Takosumi source authoring
vocabulary.

## Source And Build

Build recipes stay outside Takosumi. CI or an operator build service calls the
Deploy Control API to create an Installation plan Run from a Git URL /
SourceSnapshot, module path, variables, dependencies, and resolved internal
execution policy. Apply uses the saved plan and verifies plan digest, source
snapshot, dependency snapshot, compatibility report, and state generation to
prevent drift between review and execution.
