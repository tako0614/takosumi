# @takos/takosumi-kind-vector-store

Vector index for embeddings, similarity search, and vector metadata operations.

## Kind Identity

- Kind name: `vector-store`
- Kind URI: `https://takosumi.com/kinds/v1/vector-store`
- Package source: `takosumi/packages/kind-vector-store`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `vector-store`

## Spec Fields

- `dimensions` (required): `integer` - Vector dimensions.
- `metric` (required): `"cosine" | "euclidean" | "dot-product"` - Distance
  metric.
- `name` (required): `string` - Index name.

## Output Slot Contract

- `index` as `service-binding`

## Listen Slots

- none

## Outputs

- `indexId` (required): `string` - Implementation-scoped index identifier.
- `name` (required): `string` - Index name.
- `url`: `string` - Index endpoint URL if available.
- `tokenSecretRef`: `string` - Secret reference for clients that need
  token-based access.

## Capability Terms

- `vector-delete`
- `vector-query`
- `vector-upsert`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
