# @takos/takosumi-kind-object-store

Bucket-style object storage intended to be bindable across compatible S3-class
providers. Backend-specific placement, versioning, and public access controls
belong to native object-store kinds.

## Kind Identity

- Kind name: `object-store`
- Kind URI: `https://takosumi.com/kinds/v1/object-store`
- Package source: `takosumi/packages/kind-object-store`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `object-store`

## Spec Fields

- `name` (required): `string` - Logical bucket name (operator applies
  implementation scoping rules).

## Output Slot Contract

- `bucket` as `object-store`

## Listen Slots

- none

## Outputs

- `bucket` (required): `string` - Implementation-scoped bucket name.
- `endpoint` (required): `string` - S3-class endpoint URL.
- `region`: `string` - Bucket region.
- `accessKeyIdRef`: `string` - Reference to secret store entry holding the
  access key id.
- `secretAccessKeyRef`: `string` - Reference to secret store entry holding the
  secret access key.

## Capability Terms

- `s3-compatible`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
