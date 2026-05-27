# @takos/takosumi-kind-worker

Serverless JS function whose entrypoint is read from the resolved source view.

## Kind Identity

- Kind name: `worker`
- Kind URI: `https://takosumi.com/kinds/v1/worker`
- Package source: `takosumi/packages/kind-worker`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `worker`

## Spec Fields

- `entrypoint` (required): `string` - Source-root-relative worker module path
  inside the resolved source view.
- `env`: `object` - Optional env vars / bindings.

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
- `id` (required): `string` - Implementation-scoped worker identifier.
- `version`: `string` - Current deployed worker version.

## Capability Terms

- `serverless-http`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
