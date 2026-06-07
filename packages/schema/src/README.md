# Takosumi Contract

TypeScript DTOs and wire types for the OpenTofu-native Takosumi v1 Deploy
Control API.

The public contract is centered on these concepts:

- `Space` - owner namespace directly containing Sources, Connections,
  Installations, the dependency graph, Runs, Deployments, OutputSnapshots, and
  Activity.
- `Source` / `SourceSnapshot` - Git URL/ref/path registration and immutable
  commit-pinned source archive.
- `Connection` / `CapabilityBinding` - operator default or Space-scoped
  external connection selection for source, compute, dns, storage, database, and
  secrets capabilities.
- `OpenTofu Capsule` / `Installation` / `InstallConfig` - Git-hosted
  OpenTofu module-compatible configuration, normalized into a generated root
  and recorded as the Space-scoped Capsule + generated root + tfstate +
  output/deployment unit.
- `Dependency` / `DependencySnapshot` - DAG edges from producer outputs to
  consumer inputs, pinned at plan time.
- `Run` / `RunGroup` - source_sync / compatibility_check / plan / apply /
  destroy / drift / backup execution records and DAG-wide orchestration groups.
- `Billing` / `UsageEvent` / `CreditReservation` - Space plan, credit
  reservation, and usage capture records.
- `StateSnapshot` / `OutputSnapshot` - tfstate generations and projected
  non-secret OpenTofu output generations.
- `Deployment` - immutable successful-apply record.
- `Activity` - Space-scoped audit trail.

`RunnerProfile`, `PlanRun`, `ApplyRun`, and `DeploymentOutput` remain internal
compatibility and account-plane seam shapes; they are not the public product
vocabulary.

Repositories are plain OpenTofu modules. Repository metadata is inferred from
Git URL, commit, Capsule path, tags, and well-known OpenTofu outputs. The
contract does not define a Takosumi source DSL or Takosumi-specific repository
metadata file.
