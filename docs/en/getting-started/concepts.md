# Concepts {#concepts}

Takosumi installs source repositories into Spaces and records every apply as a Deployment.

v1 is manifestless. A source root does not need a Takosumi-specific file or metadata field. Display and identity hints
come from generic source metadata such as Git URL, commit, tag, and `package.json`.

## Public Concepts

| Concept | Role |
| --- | --- |
| Source | `git`, `prepared`, or `local` source input. Git records a commit; prepared source records an archive digest. |
| Installation | A Space-scoped installed source record with a current Deployment pointer. |
| Deployment | One apply result with source summary, InstallPlan snapshot, binding snapshot, outputs, and status. |
| PlatformService | Operator-provided service capability such as DB, OIDC, object store, queue, or runtime endpoint. |

## Dry-run And Apply

Dry-run returns an `InstallPlan` snapshot and `planSnapshotDigest` without creating an Installation. The plan is review
data, not a persisted public entity.

Apply fetches and resolves the Source, resolves PlatformService bindings through operator inventory, and stores
`planSnapshot` plus `bindingsSnapshot` on Deployment. Passing `expected.planSnapshotDigest` prevents applying a source
or binding resolution that differs from the reviewed dry-run.

## Terraform Boundary

Terraform/OpenTofu is operator-owned infrastructure tooling. Takosumi does not replace Terraform. Operators may create
resources with Terraform, then publish outputs into PlatformService inventory. Takosumi records which services were
selected for each Deployment.

## Next

- [Quickstart](./quickstart.md)
- [Installer API](../reference/installer-api.md)
- [Core Specification](../reference/core-spec.md)
- [Platform Services](../reference/platform-services.md)
