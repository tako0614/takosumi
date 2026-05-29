# @takos/takosumi-kind-web-service

Long-running HTTP service. `image` and `scale` are optional container-subset
fields; the divergent systemd binding of this kind uses only `port` plus its own
command and omits container-only fields. `healthCheck` and `volumes` are
likewise OPTIONAL container-subset hints: backends that do not run containers
(such as systemd) ignore or reject them at apply, exactly like the existing
optional `image` and `scale`. `healthCheck.interval` and `healthCheck.timeout`
are in SECONDS. `volumes[].source` is a logical, operator/binding-resolved
volume name or URI (backend-neutral) and `volumes[].target` is an absolute
container mount path.

## Kind Identity

- Kind name: `web-service`
- Kind URI: `https://takosumi.com/kinds/v1/web-service`
- Package source: `takosumi/packages/kind-web-service`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `web-service`

## Spec Fields

- `env`: `object` - Environment variables passed to the service.
- `healthCheck`: `object` - Optional container-subset health probe hint.
  Container backends use it to gate readiness and restart unhealthy instances;
  non-container backends (such as the divergent systemd binding) ignore or
  reject it at apply.
- `image` (required): `string` - OCI image reference.
- `port` (required): `integer` - Container listen port exposed by the service.
- `resources`: `object` - CPU / memory hints consumed by compatible provider
  bindings.
- `scale`: `object` - Replica bounds. `min: 0` requests zero steady replicas.
  Operator policy and the selected implementation materialize or reject the
  request.
- `volumes`: `array` - Optional container-subset volume mounts. Container
  backends attach each logical volume at the given mount path; non-container
  backends (such as the divergent systemd binding) ignore or reject them at
  apply.

## Output Slot Contract

- `http` as `http-endpoint`

## Listen Slots

- `*`: accepts `http-endpoint`, `service-binding`, `object-store`,
  `event-channel`, `identity.oidc@v1`, `billing.port@v1`, `mcp-server@v1`;
  projection matrix `billing.port@v1` -> `secret-env`, `config-mount`;
  `event-channel` -> `secret-env`, `config-mount`; `http-endpoint` -> `env`,
  `config-mount`, `upstream`; `identity.oidc@v1` -> `secret-env`,
  `config-mount`; `mcp-server@v1` -> `secret-env`, `config-mount`;
  `object-store` -> `secret-env`, `config-mount`; `service-binding` ->
  `secret-env`, `config-mount`

## Outputs

- `url` (required): `string` - Implementation-local upstream URL
  (scheme-bearing) used by gateway/listener components.
- `internalHost` (required): `string` - Implementation-local service host.
- `internalPort` (required): `integer` - Implementation-local service port.

## Capability Terms

- `container-health-check`
- `http-service`
- `oci-image`
- `persistent-volume`
- `replica-scaling`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
