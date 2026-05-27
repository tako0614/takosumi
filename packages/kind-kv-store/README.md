# @takos/takosumi-kind-kv-store

Key-value store for small keyed values.

## Kind Identity

- Kind name: `kv-store`
- Kind URI: `https://takosumi.com/kinds/v1/kv-store`
- Package source: `takosumi/packages/kind-kv-store`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `kv`, `kv-store`

## Spec Fields

- `name` (required): `string` - Store name.

## Output Slot Contract

- `store` as `service-binding`

## Listen Slots

- none

## Outputs

- `storeId` (required): `string` - Implementation-scoped store identifier.
- `name` (required): `string` - Store name.
- `url`: `string` - Connection URL if the implementation exposes one.
- `tokenSecretRef`: `string` - Secret reference for clients that need
  token-based access.

## Capability Terms

- `kv-list`
- `kv-read-write`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
