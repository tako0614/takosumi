# Build Service Boundary {#build-service-boundary}

Takosumi core does not run builds. A build service, CI system, or operator
automation can prepare source before calling the Installer API. Core receives
only the URL, digest, and metadata submitted as `source.kind: "prepared"`.

## Handoff Flow

```text
source root
  -> build service / CI prepares source
  -> build service creates a prepared source payload
  -> build service computes the payload digest
  -> caller invokes the Installer API with prepared source URL + digest
  -> Installer verifies payload digest / path safety / size caps
  -> Installer records Deployment source identity
```

`source.digest` is the sha256 of the payload bytes fetched by the Installer. It
is not a build graph digest, lockfile digest, cache key, or provenance digest.
For gzip-compressed tar archives, the digest covers the fetched compressed
payload bytes.

## Prepared Source Archive Contract

- Prepared source is a POSIX tar payload representing a resolved source root.
- Path traversal, absolute paths, NUL bytes, source-root escapes, and operator
  size cap violations are rejected before side effects.
- Repo metadata comes from generic inputs such as Git URL, commit, tag, and
  `package.json`. Takosumi does not require a source-specific metadata field.
- Build recipes, commands, caches, provenance, and approval workflows are
  recorded by the build service or operator automation.
- Deployment source identity is the source input verified by the Installer, not
  the build recipe.

## Build Service Profile

Operators may define any build-service profile. It can be YAML, JSON, hosted CI
workflow configuration, repository convention, or UI input. Takosumi core does
not make that profile part of the public contract.

Information a build service may keep:

- build recipe and command
- dependency cache key
- source checkout and lockfile evidence
- build artifact digest
- provenance, SBOM, or signature
- approval workflow record

Information submitted to Takosumi core:

- prepared source URL
- payload digest
- optional artifact digest
- source label / display metadata
- operator-selected `BindingSelection`

## Terraform / OpenTofu

Terraform and OpenTofu are infrastructure tools for operator distributions or
`takos-private/`. If a build service creates a Terraform plan, provider state,
locks, credentials, and apply permission still remain operator-owned. Takosumi
core does not run Terraform; it resolves PlatformServices exposed by the
operator catalog.

## Related Pages

- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
- [Build Service Example](../operator/build-service-profile.md)
