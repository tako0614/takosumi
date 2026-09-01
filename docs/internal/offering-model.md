# Generic Offering model (superseded)

> Historical contract and migration note. This document is not a current
> Takosumi Core authority. Read [Core Spec](./core-spec.md), [Architecture](./architecture.md),
> and [Core Conformance](./core-conformance.md) for the current product: a
> customer BYOC Stack with no Generic Offering authority.

The old design treated an Offering as an immutable availability and selection
projection independent of Takoform:

```text
immutable OfferingCatalog
  -> exact Offering id/version
  -> namespaced subject type/ref/version/digest
  -> explicit requirements and audience
  -> host-installed subject resolver
  -> exact resolution fingerprint
  -> OfferingSelection
```

That projection is retained only as historical evidence. Existing Offering
routes, stores, schema projections, and selection helpers in the Takosumi tree
are an implementation conformance gap and deletion/migration custody. They do
not belong to Takosumi Core, must not select a provider or managed capacity,
and must not be used as a customer installation or lifecycle API.

## Historical OSS surface

The former deploy-control bearer protected these routes:

```text
POST /v1/offering-catalogs
GET  /v1/offering-catalogs
GET  /v1/offering-catalogs/:catalogId/versions/:catalogVersion
POST /v1/offering-availability/query
POST /v1/offering-selections/resolve
```

They are listed for migration and deletion inventory only, not as supported
routes. No new consumer may depend on an Offering catalog or
`OfferingSelection`. A retained route must be disabled or placed behind the
authenticated bounded migration drain, and it must not mint a new authority.

## Current ownership

Takoserver owns the managed-service Offering that binds an exact external Form
to provider installation, backend, capacity, placement, provider receipt,
commercial terms, and support. Takosumi Hosted may present that exact
Host-owned availability in a retail or client surface, but does not own the
Offering or managed supply. The retired Takosumi Cloud identity has no current
authority.

A Takoform provider may call the Takoserver Host with a Host-scoped credential.
Takosumi's normal BYOC path remains
`ProviderConnection` → `CredentialRecipe` → `ProviderBinding` → run-scoped
materialization and never depends on an Offering. Takosumi never receives the
Host's parent provider credential, provider installation, backend, capacity,
Workers for Platforms namespace/dispatcher, or native resource identity.

## Migration disposition

Before deletion, inventory each catalog, version, selection, resolver,
consumer, and durable row by exact immutable identity. Snapshot the data and
complete an isolated backup/restore readback. Migrate managed-service facts to
Takoserver's Host authority; migrate optional retail/client presentation to
Takosumi Hosted; delete unsupported generic projections only after inventory is
zero and no consumer pins them. A retained row is not evidence that Generic
Offering is part of Core.
