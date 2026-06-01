# Glossary {#glossary}

## Public Concepts

### Source

A repository or prepared artifact submitted to the Installer API. Takosumi
accepts `git`, `prepared`, and `local` sources. Display metadata and source
identity come from generic inputs such as Git URL, commit, tag, source digest,
artifact digest, and `package.json`.

### Installation

The record of a Source installed in a Space. It holds the current Deployment
pointer, Space, repo metadata, and latest public outputs. Ownership, team
membership, and billing belong to the operator distribution.

### Deployment

One immutable record created by install or deploy apply. It stores source
identity, `planSnapshotDigest`, `planSnapshot`, `bindingsSnapshot`, status, and
non-secret outputs. Rollback moves the current pointer to a retained Deployment;
it does not resolve the Source again.

### PlatformService

A service capability exposed by the operator catalog or inventory in a Space.
Examples include OIDC issuers, Postgres, object storage, queues, MCP servers,
and runtime targets. Takosumi core does not create these services; it resolves
`BindingSelection` through the operator catalog resolver.

### InstallPlan

The review snapshot returned only from dry-run. It is not persisted. Apply uses
`planSnapshotDigest` to verify that the reviewed Source and binding selection
are still the ones being applied.

### BindingSelection

The PlatformService selection supplied by an install/deploy request, operator
policy, or account-plane UI. Takosumi resolves it through the operator catalog
resolver and stores the resolved binding snapshot on the Deployment.

### Operator

The party running Takosumi and owning catalog/inventory, runtime adapters,
storage, secret stores, Terraform/OpenTofu state, billing, OIDC, dashboards, and
approval policy. Takosumi is one reference operator distribution.

### Space

The operator-owned isolation unit containing Installations. Takosumi records
`spaceId`; membership, quota, billing subject, and service visibility are
operator concerns.

### dry-run

Validation without side effects. It fetches source, extracts metadata, resolves
bindings, checks operator policy, and returns `InstallPlan`, `changes[]`, and
`expected` guards.

### apply

The operation that records a reviewed Source and binding selection as a
Deployment. Apply rejects mismatched `expected.planSnapshotDigest` or current
pointer guards with 409.

### expected guard

A TOCTOU guard proving the reviewed input is the one being applied. It can hold
`commit`, `sourceDigest`, `artifactDigest`, `planSnapshotDigest`, and
`currentDeploymentId`.

### Prepared source

A source handoff artifact produced by CI, a build service, or operator
automation. The Installer API uses the fetched payload byte digest as source
identity. Build recipes, cache keys, and provenance stay in operator or build
service records.

### planSnapshotDigest

The digest of the `InstallPlan` snapshot returned by dry-run. Apply uses it to
stop changes to Source or binding selection after review.

### sourceDigest / artifactDigest

Byte digests for prepared source or build artifacts. The Installer API request
and operator policy decide which artifact is source identity.

## Boundaries

### Terraform / OpenTofu

Infrastructure creation, provider state, locks, and credentials belong to
operator distributions or `takos-private/`. Takosumi core does not run
Terraform; it consumes PlatformServices published by the operator catalog.

### Operator catalog / inventory

The operator-owned source of truth for PlatformServices, runtime targets,
binding implementations, and service visibility. Takosumi calls its resolver and
stores selected binding snapshots on Deployments.

### Runtime adapter

The boundary used by the reference kernel to abstract host runtime differences.
Kernel core uses `src/kernel/shared/runtime/` for filesystem, env, server,
subprocess, and clock access.

### Account layer

The operator-owned layer for accounts, billing, OIDC issuers, dashboards,
approval workflows, and deploy facades. Takosumi core public records remain
Source, Installation, Deployment, and PlatformService.

## Related Pages

- [Core Specification](./core-spec.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
- [Build Service Boundary](./build-spec.md)
