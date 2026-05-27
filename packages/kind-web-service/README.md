# @takos/takosumi-kind-web-service

Long-running HTTP service backed by an OCI image.

## Kind Identity

- Kind name: `web-service`
- Kind URI: `https://takosumi.com/kinds/v1/web-service`
- Package source: `takosumi/packages/kind-web-service`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `web-service`

## Spec Fields

- `env`: `object` - Environment variables passed to the service.
- `image` (required): `string` - OCI image reference.
- `port` (required): `integer` - Container listen port exposed by the service.
- `resources`: `object` - CPU / memory hints consumed by compatible provider
  bindings.
- `scale`: `object` - Replica bounds. `min: 0` requests zero steady replicas.
  Operator policy and the selected implementation materialize or reject the
  request.

## Output Slot Contract

- `http` as `http-endpoint`

## Listen Slots

- `*`: accepts `http-endpoint`, `service-binding`, `object-store`,
  `event-channel`, `identity.oidc@v1`, `billing.port@v1`; projection matrix
  `billing.port@v1` -> `secret-env`, `config-mount`; `event-channel` ->
  `secret-env`, `config-mount`; `http-endpoint` -> `env`, `config-mount`,
  `upstream`; `identity.oidc@v1` -> `secret-env`, `config-mount`; `object-store`
  -> `secret-env`, `config-mount`; `service-binding` -> `secret-env`,
  `config-mount`

## Outputs

- `url` (required): `string` - Implementation-local upstream URL
  (scheme-bearing) used by gateway/listener components.
- `internalHost` (required): `string` - Implementation-local service host.
- `internalPort` (required): `integer` - Implementation-local service port.

## Capability Terms

- `http-service`
- `oci-image`
- `replica-scaling`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
