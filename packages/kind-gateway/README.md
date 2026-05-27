# @takos/takosumi-kind-gateway

HTTP listener, TLS, and routing component. A gateway listens to local upstream
bindings, carries listener/domain requests in spec, and publishes the public
HTTP endpoint it materializes. Operator policy and the selected implementation
materialize or reject those requests.

## Kind Identity

- Kind name: `gateway`
- Kind URI: `https://takosumi.com/kinds/v1/gateway`
- Package source: `takosumi/packages/kind-gateway`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `gateway`

## Spec Fields

- `listeners` (required): `object` - Named HTTP listeners. A listener may
  request an operator-managed host and TLS policy.
- `routes` (required): `array` - Path routing rules. Each route sends requests
  from a listener to one connect binding name.

## Output Slot Contract

- `public` as `http-endpoint`

## Listen Slots

- `*`: accepts `http-endpoint`; projections `upstream`

## Outputs

- `url` (required): `string` - Public URL including scheme.
- `host` (required): `string` - Resolved public hostname.
- `scheme` (required): `string` - Resolved public scheme (`http` or `https`).
- `listener` (required): `string` - Listener name that produced the public
  endpoint.
- `routes` (required): `object[]` - Portable route summary with pathPrefix and
  connect binding target.

## Capability Terms

- `auto-tls`
- `host-routing`
- `path-routing`
- `wildcard`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
