# Operator Boundaries

Operator controls the adopted semantic world, implementation world, credentials,
Space configuration, and production safety boundaries.

## Operator-controlled areas

```text
Space creation, deletion, and membership
Space catalog release assignment
Space namespace registry visibility
Space export sharing
CatalogRelease activation
Descriptor ingestion and trust
Namespace registry writes
Implementation registry
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Artifact policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

## Space administration

A Space is an operator-governed isolation boundary. The operator defines:

```text
who can deploy into the Space
which CatalogRelease ids are allowed
which policy pack applies
which namespace exports are visible
which operator namespaces are granted
which operator-owned namespace exports are visible (external participants are reserved / future RFC)
which secrets and artifacts are visible
which groups exist or may be created
```

The manifest does not create or configure Spaces.

## Public manifest does not install implementation code

The manifest references catalog aliases and namespace paths visible in the
active Space. It does not install implementation packages.

## Credential boundary

Core canonical state stores references and handles, not raw secret values.
External I/O and credentials stay inside implementation / connector / runtime
boundary. Secret partitions are Space-scoped unless operator policy explicitly
shares them.

## Connector boundary

Connectors are operator-installed and operator-controlled. They are addressed as
`connector:<id>` per
[DataAsset Model — Connector contract](./data-asset-model.md); the public
manifest never names a connector. Connector visibility, acceptedKinds, and
signing expectations are operator-governed and Space-scoped.

## Production mode

Production must fail closed when required operator ports, trusted
implementations, Space policies, or Space catalog assignments are missing. Dev
fallback must not be silently accepted in production.

## Catalog release activation

CatalogRelease activation is a serialized operator operation. Assignment of a
CatalogRelease to a Space is also serialized. Deployments resolve against a
release id allowed for their Space.

## Space export sharing

Cross-space export sharing is reserved vocabulary, not a current v1 default
surface. If a future RFC enables it, it must be an operator operation and record
source Space, destination Space, export path, export snapshot id, allowed
access, expiry if any, and policy decision references. Cross-space sharing is
denied by default, and cross-instance sharing is not adopted.
