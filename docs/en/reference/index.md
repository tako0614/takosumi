# Reference {#reference}

Takosumi documentation is split by ownership.

## Core Specification

- [Specification Boundaries](./spec-boundaries.md) — ownership split between
  core, the Kind Catalog, and operator configurations.
- [Core Specification](./core-spec.md) — Manifest, Installation, Deployment,
  Installer API, source guards, and publish/listen grammar.
- [Manifest](./manifest.md) — the `.takosumi.yml` source-root file.
- [Installer API](./installer-api.md) — write endpoints for install, deploy,
  dry-run, and rollback.
- [Platform Services](./external-publications.md) — consuming Space-visible
  output through the same `listen.from` grammar.
- [HTTP Exposure](./http-exposure.md) — modeling public HTTP endpoints through
  workload published outputs and adopted ingress kind definitions.

## Kind Catalog

- [Kind Catalog](./type-catalog.md) — reusable kind definitions, output type
  contracts, injection modes, and JSON-LD catalog metadata.
- [Access Modes](./access-modes.md) — access vocabulary for platform services
  and projections.

## Takosumi Cloud

- [Takosumi Cloud Entry](./takosumi-cloud.md) — bridge from core/catalog specs
  to `https://cloud.takosumi.com/docs/` and the local
  `takosumi-cloud/docs/{ja,en}/` Cloud account management docs.

## Build Boundary

- [Build Service Boundary](./build-spec.md)
- [Build Service Example](../operator/build-service-profile.md)
- [Digest Computation](./digest-computation.md)

## Operations

- [Operator Overview](../operator/index.md)
- [CLI](./cli.md)

## Extension And Reference

- [Extending Takosumi](../extending.md)
- [Glossary](./glossary.md)
