# @takos/takosumi-kind-postgres

Managed PostgreSQL instance intended to be bindable across compatible providers
through the standard wire protocol. Publishes connection material as a local
output slot.

## Kind Identity

- Kind name: `postgres`
- Kind URI: `https://takosumi.com/kinds/v1/postgres`
- Package source: `takosumi/packages/kind-postgres`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `postgres`

## Spec Fields

- `highAvailability`: `boolean` - Request provider-managed HA when supported.
  Operator policy and the selected implementation materialize or reject the
  request.
- `size`: `"small" | "medium" | "large" | "xlarge"` - Instance size class.
- `storage`: `object` - Persistent volume sizing.
- `version` (required): `string` - PostgreSQL major version string (e.g. `15`,
  `16`).

## Output Slot Contract

- `connection` as `service-binding`

## Listen Slots

- none

## Outputs

- `host` (required): `string` - Database hostname.
- `port` (required): `integer` - TCP port (typically 5432).
- `database` (required): `string` - Database name.
- `username` (required): `string` - Connection username (role name).
- `passwordSecretRef` (required): `string` - Reference to secret store entry
  holding password.
- `connectionString` (required): `string` - Passwordless client connection URL.
  Credentials are supplied through passwordSecretRef.

## Capability Terms

- `backups`
- `high-availability`
- `managed-credentials`
- `postgres-wire`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
