# @takos/takosumi-kind-sqlite

SQLite-compatible database for relational state in small and edge-oriented
workloads.

## Kind Identity

- Kind name: `sqlite`
- Kind URI: `https://takosumi.com/kinds/v1/sqlite`
- Package source: `takosumi/packages/kind-sqlite`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `sqlite`

## Spec Fields

- `name` (required): `string` - Database name.

## Output Slot Contract

- `connection` as `service-binding`

## Listen Slots

- none

## Outputs

- `databaseId` (required): `string` - Implementation-scoped database identifier.
- `name` (required): `string` - Database name.
- `url`: `string` - Connection URL if the implementation exposes one.
- `tokenSecretRef`: `string` - Secret reference for clients that need
  token-based access.

## Capability Terms

- `managed-credentials`
- `sqlite-wire`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
