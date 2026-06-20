# Takosumi Contract

TypeScript DTOs and wire types for the OpenTofu-native Takosumi v1 Deploy
Control API.

The public contract is centered on these concepts:

- `Space` - owner namespace directly containing Sources, Connections,
  Installations, the dependency graph, Runs, Deployments, OutputSnapshots, and
  Activity.
- `Source` / `SourceSnapshot` - Git URL/ref/path registration and immutable
  commit-pinned source archive.
- `Connection` / `ProviderConnection` - Git credentials and provider
  credentials. ProviderConnections are explicit per provider source and optional
  alias; internal resolver rows remain vault/runner implementation details and
  are not public `/api/v1` identifiers.
- `OpenTofu Capsule` / `Installation` / `InstallConfig` - Git-hosted
  OpenTofu module-compatible configuration, normalized into a generated root
  and recorded as the Space-scoped Capsule + generated root + tfstate +
  output/deployment unit.
- `Dependency` / `DependencySnapshot` - DAG edges from producer outputs or
  same-Space producer state to consumer inputs, pinned at plan time.
- `Run` / `RunGroup` - source_sync / compatibility_check / plan / apply /
  destroy / drift / backup execution records and DAG-wide orchestration groups.
- `Billing` / `UsageEvent` / `CreditReservation` - Space plan, credit
  reservation, and usage capture records.
- `StateSnapshot` / `OutputSnapshot` - tfstate generations and projected
  non-secret OpenTofu output generations.
- `Deployment` - immutable successful-apply record.
- `Activity` - Space-scoped audit trail.

Account-plane workload compatibility shapes remain internal and are not
re-exported from the public deploy-control contract facade.

Repositories are plain OpenTofu modules. Repository metadata is inferred from
Git URL, commit, module path, tags, and well-known OpenTofu outputs. The
contract does not define a Takosumi source DSL or Takosumi-specific repository
metadata file.
