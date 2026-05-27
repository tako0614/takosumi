# Reference {#reference}

Takosumi documentation is split by ownership.

## Core Specification

- [Specification Boundaries](./spec-boundaries.md) — ownership split between core, the Official Type Catalog, and operator distributions.
- [Core Specification](./core-spec.md) — Manifest, Installation, Deployment, Installer API, source guards, and connection grammar.
- [Manifest](./manifest.md) — the `.takosumi.yml` source-root file.
- [Installer API](./installer-api.md) — write endpoints for install, deploy, dry-run, and rollback.
- [Platform Services](./platform-services.md) — consuming Space-visible output through `listen.path`.
- [HTTP Exposure](./http-exposure.md) — modeling public HTTP endpoints through workload component outputs, gateway outputs, and root Installation output declarations.

## Official Type Catalog

- [Takosumi Official Type Catalog](./type-catalog.md) — reusable kind definitions, output type contracts, injection modes, and JSON-LD catalog metadata.
- [Access Modes](./access-modes.md) — access vocabulary for platform services and projections.

## Takosumi Cloud

- [Takosumi Cloud Entry](./takosumi-cloud.md) — bridge from core/catalog specs to `https://cloud.takosumi.com/docs/` and the local `takosumi-cloud/docs/{ja,en}/` Cloud account management docs.

## Build Boundary

- [Build Service Boundary](./build-spec.md)
- [Build Service Example](../operator/build-service-profile.md)
- [Digest Computation](./digest-computation.md)

## Operations

- [Operator Overview](../operator/index.md)
- [CLI](./cli.md)

## Reference Implementation / Package Inventory

These pages explain how the reference kernel connects adopted type definitions to implementation packages. They are not AppSpec core contract chapters.

- [Kind Packages](./kind-packages.md) — portable and native kind package ownership.
- [Kind Binding Implementations](./kind-bindings.md) — how the reference kernel attaches implementation bindings.
- [Reference Adapter Loading](./plugin-loading.md) — the `plugins` option as reference implementation wiring.

## Extension and Reference

- [Extending Takosumi](../extending.md)
- [Glossary](./glossary.md)
