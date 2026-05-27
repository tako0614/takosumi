# Takosumi Official Catalog {#catalog}

Takosumi core is kind-agnostic. Reusable component kind definitions and material
kind vocabulary are supplied by catalogs and operator distributions.
`takosumi.com` hosts the official catalog as a specification chapter next to the
core specification. Operator distributions, including Takosumi Cloud, adopt
catalog vocabulary from their own docs.

This page defines Takosumi catalog vocabulary: kind definition identities,
material kind names, injection mode names, access metadata, and the JSON-LD
format for the official catalog. Code that targets the official vocabulary can
import TypeScript helpers from `@takos/takosumi-contract/catalog`.
`OfficialMaterialKindName` is the public name for material vocabulary.

Catalog selectors use `kind` consistently. Component `kind` says what is
created. `publish.kind` and `listen.kind` say what material is offered or
consumed. The word `type` is reserved for JSON-LD `@type`, JSON Schema `type`,
and TypeScript type names.

## Normative Scope

The official catalog defines:

- kind definition identities under `https://takosumi.com/kinds/v1/*`
- kind definition metadata fields for `spec`, output slots, material vocabulary,
  and expected output formats
- material kind names such as `http-endpoint`, `service-binding`,
  `object-store`, `event-channel`, `identity.oidc@v1`, `billing.port@v1`, and
  `mcp-server@v1`
- injection mode names such as `env`, `secret-env`, `upstream`, and
  `config-mount`
- access metadata vocabulary such as access mode enum, sensitivity levels, and
  safe default access
- package-owned `packages/kind-*/spec/kind.jsonld` sources, JSON-LD kind
  definition documents under `https://takosumi.com/kinds/v1/*`, and the context
  document at `https://takosumi.com/contexts/v1.jsonld`

The catalog defines reusable output formats. Operator distribution specs define
concrete platform service paths, OIDC issuer operation, billing behavior,
account management records, backend provisioning, and dashboard APIs.

Operator distributions decide which catalog entries are enabled. They choose
which catalog entries are visible in a Space, which aliases are active, which
backend or local runtime implements each kind, and which platform service paths
they offer.

## Catalog Roles

| Role              | Example                                         | Meaning                                                       |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Kind definition   | `https://takosumi.com/kinds/v1/worker`          | Component `kind` definition and output vocabulary.            |
| Material kind     | `http-endpoint`                                 | Kind of material offered by an output slot.                   |
| Injection mode    | `env`, `secret-env`, `upstream`, `config-mount` | How resolved output material is delivered to a consumer.      |
| Platform material | `identity.oidc@v1`, `mcp-server@v1`             | Reusable material kind for platform services.                 |
| Access metadata   | `invoke-only`, `restricted`                     | Access and projection metadata for platform service material. |

The manifest records catalog references as strings such as `kind` and `connect`
/ `listen` `inject` values. Operator resolution attaches kind definition
semantics, chooses which catalog entries are visible in a Space, and selects the
implementation binding that creates/updates the resources. Native kind packages
are listed in [Kind Packages](/en/reference/kind-packages).

## Official Kind Definitions

These are the current portable `takosumi.com` v1 catalog kind definitions. They
are not a closed built-in kind set; operators can adopt other kind definition
URIs.

| Suggested alias | Kind URI                                      | Typical output slot                        |
| --------------- | --------------------------------------------- | ------------------------------------------ |
| `worker`        | `https://takosumi.com/kinds/v1/worker`        | `http` as `http-endpoint`                  |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`   | `http` as `http-endpoint`                  |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`      | `connection` as `service-binding`          |
| `sqlite`        | `https://takosumi.com/kinds/v1/sqlite`        | `connection` as `service-binding`          |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store`  | `bucket` as `object-store`                 |
| `kv-store`      | `https://takosumi.com/kinds/v1/kv-store`      | `store` as `service-binding`               |
| `message-queue` | `https://takosumi.com/kinds/v1/message-queue` | `producer` / `consumer` as `event-channel` |
| `vector-store`  | `https://takosumi.com/kinds/v1/vector-store`  | `index` as `service-binding`               |
| `gateway`       | `https://takosumi.com/kinds/v1/gateway`       | `public` as `http-endpoint`                |

Short aliases are operator-selected conveniences. The URI is the kind definition
identity. Kind definition documents may publish `referenceAliases` as
suggestions; operator distributions activate aliases explicitly.

Official native kind definitions use the same `https://takosumi.com/kinds/v1/*`
catalog URI space. Native definitions can carry backend-specific `spec` and
output vocabulary, so their package sources live in the sibling
`takosumi-plugins/packages/kind-*` repository. Those packages contain both the
descriptor and a reference plugin binding; the plugin is reference
implementation wiring, not part of the AppSpec core contract. Native kind
packages are listed in [Kind Packages](/en/reference/kind-packages).

Official descriptor `spec` JSON Schemas are closed shapes. Official portable and
native kinds spell supported fields instead of accepting undeclared fields with
`additionalProperties: true`. Reference packages use the same field set for
runtime validation, so descriptor metadata, TypeScript helpers, and pre-apply
plugin validation stay aligned. If a backend needs another field, update that
native kind descriptor or define another kind URI. AppSpec core stays
kind-agnostic, but the official catalog favors precise schemas that catch typos
and unsupported inputs.

Portable data kind `spec` shapes only include fields whose meaning is stable
across providers. `kv-store` has `name`; `message-queue` has `name` and optional
`deliveryDelay`; `vector-store` requires `name`, `dimensions`, and `metric`.
Default TTLs, retry counts, dead-letter queues, retention, and index defaults
differ by backend and creation API, so they belong in native kind descriptors
rather than portable fields.

## Material Kinds

Material kinds define the portable format of output data offered by a component
output slot or by a platform service entry. Service paths, backend resources,
dashboard routes, and account management lifecycle belong to the operator or
product distribution spec that offers the output.

Official output material is a closed shape. Operator-specific fields should be
modeled as another material kind or catalog extension. Implementation-local
outputs are not output material until the kind definition or implementation
binding projects them into the official material shape.

| Contract           | Public / non-secret fields                                                                                                                                                     | Secret refs                                               | Typical projections               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------- |
| `http-endpoint`    | `targets[]` for callable upstreams and optional public `endpoints[]`. A target can carry `url`, `host` + `port`, or both. `protocol` / `basePath` refine the host + port form. | none                                                      | `upstream`, `env`, `config-mount` |
| `service-binding`  | `protocol` plus one of `service`, `connectionUrl`, or `host` + `port`. May also include `database`, optional `username`, and `caCertRef`.                                      | `passwordRef`, token refs                                 | `secret-env`, `config-mount`      |
| `object-store`     | `bucket`, `endpoint`, `region`, `pathStyle`, optional `publicBaseUrl`, policy refs                                                                                             | `accessKeyIdRef`, `secretAccessKeyRef`, `sessionTokenRef` | `secret-env`, `config-mount`      |
| `event-channel`    | `channel`, `protocol`, endpoint/topic/queue/stream identity, delivery policy refs                                                                                              | producer/consumer credential refs                         | `secret-env`, `config-mount`      |
| `identity.oidc@v1` | issuer URL, discovery URL, client id, redirect/callback origin, optional JWKS/discovery refs                                                                                   | `clientSecretRef`                                         | `secret-env`, `config-mount`      |
| `billing.port@v1`  | billing portal URL, usage report endpoint, billing subject ref                                                                                                                 | `meteringCredentialRef`                                   | `secret-env`, `config-mount`      |
| `mcp-server@v1`    | Streamable HTTP MCP endpoint URL, protocol version, display name / description                                                                                                 | `tokenRef`                                                | `secret-env`, `config-mount`      |

`http-endpoint` describes callable HTTP output data. Workload component outputs
usually emit `targets[]`; gateway or ingress outputs usually emit `endpoints[]`.
One output material must contain at least one of `targets[]` or `endpoints[]`.
Public reachability is a property of the gateway/ingress kind and the resulting
output; root `publish` only records an Installation output declaration.

Official output values are closed shapes. A secret reference is an object with
only `{ secretRef: string }`.

For HTTP output, `url` is an absolute `http` / `https` URL, `scheme` /
`protocol` is `http` or `https`, `port` is an integer from 1 to 65535, and
`visibility` is one of `private`, `space`, `public`, or `internal`. Target
`host` and `port` appear together. `protocol` and `basePath` refine the
host/port form, so they require `host` + `port`. `basePath` and
`routes[].pathPrefix` start with `/` and do not contain `?` or `#`. `name`,
`listener`, `routes[].to`, and `tokenRefs` keys are ASCII identifiers
(`A-Za-z0-9_.-`).

`service-binding` describes non-HTTP service connectivity. It is not limited to
TCP. Material identifies the target with `protocol` plus one of `service`,
`connectionUrl`, or `host` + `port`. Credentials travel through `passwordRef`,
`tokenRef`, or named `tokenRefs`; `connectionUrl` does not embed a password.

Compact schema:

```yaml
http-endpoint:
  publicFields:
    targets[]:
      required: false
      fields: { name, url, protocol, host, port, basePath, visibility }
    endpoints[]:
      required: false
      fields: { url, scheme, host, listener, visibility, primary, routes[] }
  requires: at least one of targets[] or endpoints[]
  secretRefs: []
  allowedProjections: [upstream, env, config-mount]

service-binding:
  publicFields: { service, protocol, host, port, database, username, connectionUrl, caCertRef }
  secretRefs: [passwordRef, tokenRef, tokenRefs]
  requires: protocol plus one of service, connectionUrl, or host + port
  rule: host and port appear together; connectionUrl is an absolute URI and must not contain an embedded password; tokenRefs keys are identifiers
  allowedProjections: [secret-env, config-mount]

object-store:
  publicFields: { bucket, endpoint, region, pathStyle, publicBaseUrl, policyRefs }
  secretRefs: [accessKeyIdRef, secretAccessKeyRef, sessionTokenRef]
  rule: accessKeyIdRef and secretAccessKeyRef appear together; sessionTokenRef requires both
  allowedProjections: [secret-env, config-mount]

event-channel:
  publicFields: { channel, protocol, endpoint, topic, queue, stream, deliveryPolicyRefs }
  secretRefs: [producerCredentialRef, consumerCredentialRef]
  rule: endpoint is an absolute URI when present
  allowedProjections: [secret-env, config-mount]

identity.oidc@v1:
  publicFields: { issuerUrl, discoveryUrl, clientId, redirectOrigin, jwksRef }
  secretRefs: [clientSecretRef]
  allowedProjections: [secret-env, config-mount]

billing.port@v1:
  publicFields: { portalUrl, usageReportEndpoint, billingSubjectRef }
  secretRefs: [meteringCredentialRef]
  allowedProjections: [secret-env, config-mount]

mcp-server@v1:
  publicFields: { endpointUrl, transport, protocolVersion, serverName, description }
  secretRefs: [tokenRef]
  requires: endpointUrl as an absolute http(s) URL and transport: streamable-http
  allowedProjections: [secret-env, config-mount]
```

`identity.oidc@v1`, `billing.port@v1`, and `mcp-server@v1` are neutral output
formats for platform services. The catalog names the fields a workload can
receive. Issuer operation, client lifecycle, redirect policy, billing ownership,
usage authorization, payment-provider integration, MCP server registration, and
concrete platform service paths belong to the operator or product distribution
that offers the output.

`mcp-server@v1` is the material kind for discovering remote MCP servers through
Space-visible publications. This catalog uses `transport: streamable-http` for
remote MCP connectivity. Server registration, authorization, scopes, tool
policy, and pathless discovery inventory are distribution responsibilities.

`ref` fields are operator-provided reference strings. They are stable handles
for operator projections and Deployment records; they are not raw secret values.

Public Deployment outputs and operator read APIs expose only non-secret fields
plus refs. Raw passwords, client secrets, payment-backend credentials, bearer
tokens, and generated private keys are delivered only through operator-approved
runtime secret mechanisms.

## Injection Modes

Injection modes (how values are delivered: `env`, `secret-env`, etc.) define how
resolved output material is presented to the consumer component.

| Injection mode | Meaning                                                                                              | Safety rule                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `env`          | Project non-secret public config into environment variables using the listen `prefix`.               | Valid only for public/non-secret fields.                   |
| `secret-env`   | Project public config plus secret refs into runtime environment through the operator secret backend. | Raw secret values are injected only at workload runtime.   |
| `upstream`     | Connect HTTP endpoint output to an ingress/router/upstream connection.                               | Valid for upstream-capable `http-endpoint` consumer slots. |
| `config-mount` | Project public config and refs into a mounted config file, volume, or SDK config object.             | Mount path and file format are defined by the kind.        |

After `env` or `secret-env` expands material into an environment record, public
config values are strings and secret values remain `{ secretRef: "..." }`
objects. `secret-env` is not flattened into a `secret://...` string. The
implementation binding or runtime connector either maps that `{ secretRef }` to
the backend's secret mechanism or fails closed before creating resources.

Projection compatibility:

| Material kind      | `env`                                     | `secret-env` | `upstream`                       | `config-mount` |
| ------------------ | ----------------------------------------- | ------------ | -------------------------------- | -------------- |
| `http-endpoint`    | valid for public/non-secret endpoint data | invalid      | valid for upstream-capable slots | valid          |
| `service-binding`  | invalid                                   | valid        | invalid                          | valid          |
| `object-store`     | invalid                                   | valid        | invalid                          | valid          |
| `event-channel`    | invalid                                   | valid        | invalid                          | valid          |
| `identity.oidc@v1` | invalid                                   | valid        | invalid                          | valid          |
| `billing.port@v1`  | invalid                                   | valid        | invalid                          | valid          |
| `mcp-server@v1`    | invalid                                   | valid        | invalid                          | valid          |

Consumer slot metadata and operator policy can make a syntactically valid
combination invalid for a particular component.

## Consumer Slot Metadata

Kind definitions can describe what a consumer binding slot accepts without
adding more manifest fields. This metadata is catalog vocabulary for validation
and docs. Generated helpers export listen slot descriptors in addition to spec,
output, and output slot metadata. `spec/kind.jsonld` remains the source of
truth; the generated helper is a typed mirror for package authors and operator
wiring.

The official `worker` and `web-service` descriptors allow `http-endpoint` on the
wildcard listen slot. Same-manifest dependencies are modeled by having a
consumer reference the producer's `web.http` output slot with
`connect.<binding>.output`. Platform services and external services outside the
manifest use `listen.<binding>.path` for an exact service path or
`listen.<binding>.kind` plus labels for discovery. Use `inject: env` when the
consumer needs endpoint config such as a base URL, and `inject: upstream` when
the consumer slot is acting as a router or proxy upstream. Secret-bearing
material kinds still follow the compatibility table above, so `service-binding`,
`object-store`, `identity.oidc@v1`, `billing.port@v1`, and `mcp-server@v1` are
not valid plain `env` inputs.

| Kind definition metadata                  | Meaning                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `listens.<slot>.accepts`                  | Material kinds accepted by the slot.                                  |
| `listens.<slot>.projectionFamilies`       | Injection modes accepted by the slot.                                 |
| `listens.<slot>.projectionMatrix`         | Machine-readable valid injection-mode intersection per material kind. |
| `listens.<slot>.minimumAccess`            | Minimum access mode needed for the output.                            |
| `listens.<slot>.safeDefaultAccess`        | Default access before operator policy selects a stronger access mode. |
| `listens.<slot>.requiredWhenReferencedBy` | `spec` field reference that makes the connection required.            |

The manifest does not carry an access-mode field. It selects `connect.output` /
`listen.path` / `listen.kind` and `inject`; kind definition metadata, platform
service entries, and operator policy resolve access and compatibility.

Native worker and web-service kinds must carry the same `projectionMatrix` as
their portable base. Backend-specific fields and outputs can be added by a
native descriptor, but the material-safety rule does not change: secret-bearing
material kinds such as `service-binding` and `object-store` are not projected as
plain `env`. If a backend adds another injection mode, it must be explicit in
that backend's native kind descriptor and operator policy.

## Gateway Portable Subset

When an operator adopts the official `gateway` kind definition, that definition
provides portable HTTP ingress vocabulary. Its `spec.listeners` map declares
named HTTP/HTTPS listeners. Its `spec.routes` array connects a listener to a
local `connect` binding key.

Portable v1 route semantics:

- `routes[].to` is a local `connect` binding key, not a material kind,
  `listen.path`, or URL.
- `routes[].path` is an HTTP path prefix. It is `/` or starts with `/`.
- Matching uses only the URL path. Query strings and fragments are excluded.
- Matching is case-sensitive and compares the URL path string before
  percent-decoding or path normalization.
- Percent-encoded octets are compared literally. `%2F` is not treated as `/`.
- `/` matches every path. `/api` matches `/api` and `/api/...`, but not
  `/apiary`.
- `routes[].path` is a configuration path string, not a full URL. `?`, `#`, NUL,
  empty strings, and segment escapes that change the path are invalid.
- Route matching is longest-prefix within the same listener.
- Duplicate routes with the same listener and path are invalid. Operator
  distributions may replace this with a stricter conflict rule.
- Rewrite, strip-prefix, header matching, method matching, and CORS policy
  belong to native gateway kind descriptors that explicitly define those fields.

JSON Schema captures local syntax for `routes[].path` (starts with `/`, no `?`,
`#`, or NUL) and identifier syntax for `routes[].listener` and `routes[].to`.
Duplicate routes, dot-segment rejection, segment-boundary matching behavior, and
backend rejection of unsupported fields are kind definition semantic validation
and operator conformance checks. Official v1 descriptors do not accept
undeclared fields.

The gateway `public` output slot uses the `http-endpoint` material kind. A
produced gateway output includes non-secret `endpoints[]`. If multiple endpoints
are present, exactly one endpoint has `primary: true`.

## External Material Kinds

Platform services use the same material kinds as same-manifest component
outputs. `identity.oidc@v1`, `billing.port@v1`, and `mcp-server@v1` are official
material kind contracts in this catalog. An operator or product distribution
spec defines the concrete platform service path or pathless discovery inventory
that offers them in a Space.

## Access Metadata

| Term                | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `accessModes`       | Allowed access modes: `read`, `read-write`, `admin`, `invoke-only`, and `observe-only`. |
| `sensitivity`       | Official enum: `public-config`, `internal`, `restricted`, `secret-bearing`.             |
| `safeDefaultAccess` | Default access mode before operator policy selects stronger access.                     |

## JSON-LD Kind Definition Metadata

JSON-LD is the format for kind definitions, vocabulary terms, and catalog
metadata. Runtime behavior belongs to the operator-selected implementation
binding.

`outputSlots.<name>.contract` names the material kind used by a component output
slot. Kind definition documents can include `exampleMaterialMapping` metadata
for generated helper types, examples, and documentation checks.
`exampleMaterialMapping` uses the same field layout as the official material
shape; secret refs use `{ "secretRef": "$outputs.name" }`. Markers such as
`$outputs.*` are non-executable example metadata. A marker that satisfies a
required field or required alternative references a required output. For
example, `billing.port@v1` needs either `portalUrl` or `usageReportEndpoint` to
be a required output or a literal value. Operator-selected implementation
bindings collect and record backend output in Deployment records.

`listens.<slot>.projectionFamilies` lists injection modes accepted through a
component-local consumer slot. In the manifest, same-manifest outputs attach to
that slot through `connect`; platform and external publications attach through
`listen.path` or `listen.kind`.

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://takosumi.com/kinds/v1/worker",
  "name": "worker",
  "spec": {
    "type": "object",
    "properties": {
      "entrypoint": { "type": "string" }
    },
    "required": ["entrypoint"]
  },
  "outputSlots": {
    "http": {
      "contract": "http-endpoint"
    }
  }
}
```

## Source Of Truth

The public catalog surface is the package-owned
`packages/kind-*/spec/kind.jsonld` sources, sibling
`takosumi-plugins/packages/kind-*/spec/kind.jsonld` native sources, published
`https://takosumi.com/kinds/v1/*`, `https://takosumi.com/kinds/v1/*.jsonld`, and
`https://takosumi.com/contexts/v1.jsonld` documents, this page, and the
`@takos/takosumi-contract/catalog` TypeScript helpers.

Catalog compatibility is based on kind definition URI identity, material kind
names, projection-family names, access vocabulary, and documented output
material fields. Conforming implementations may compile, mirror, or vendor the
catalog. Runtime execution uses the operator-selected implementation binding to
choose the backend implementation; JSON-LD is catalog metadata, not a runtime
plugin-loading requirement.
