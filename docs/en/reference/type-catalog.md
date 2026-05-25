# Kind Catalog {#type-catalog}

Takosumi publishes reusable kind definitions and output type vocabulary from
`takosumi.com`. The Kind Catalog is a specification chapter next to the
core specification. Operator configurations, including Takosumi Cloud, adopt
catalog vocabulary from their own docs.

This page defines Takosumi type vocabulary: kind definition identities,
output type names, injection mode names, access metadata, and the
JSON-LD format for the official catalog.

## Normative Scope

The Kind Catalog defines:

- kind definition identities under `https://takosumi.com/kinds/v1/*`
- kind definition metadata fields for `spec`, publish slots, output
  vocabulary, and expected output formats
- output type names such as `http-endpoint`, `service-binding`,
  `object-store`, `identity.oidc@v1`, and `billing.port@v1`
- injection mode names such as `env`, `secret-env`, `upstream`, and
  `config-mount`
- access metadata vocabulary such as access mode enum, sensitivity levels, and
  safe default access
- JSON-LD kind definition documents under `https://takosumi.com/kinds/v1/*` and
  the context document at `https://takosumi.com/contexts/v1.jsonld`

The catalog defines reusable output formats. Operator configuration specs define
concrete platform service paths, OIDC issuer operation, billing behavior,
account management records, provider provisioning, and dashboard APIs.

Operators decide which catalog entries are enabled. They choose which catalog entries are visible in
a Space, which aliases are active, which provider or local runtime implements
each kind, and which platform service paths they offer.

## Catalog Roles

| Role                       | Example                                         | Meaning                                                |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Kind definition            | `https://takosumi.com/kinds/v1/worker`          | Component `kind` definition and output vocabulary.     |
| Output type                | `http-endpoint`                                 | Type of output offered by `publish.<name>.as`.         |
| Injection mode             | `env`, `secret-env`, `upstream`, `config-mount` | How listened output is delivered to a consumer.        |
| External output type       | `identity.oidc@v1`                              | Reusable output type for platform services.            |
| Access metadata            | `invoke-only`, `restricted`                     | Access and projection metadata for external output.    |

The manifest records catalog references as strings such as `kind`,
`publish.<name>.as`, and `listen.<binding>.as`. Operator resolution attaches
kind definition semantics, chooses which catalog entries are visible in a Space, and
selects the provider configuration that creates/updates the resources.

## Official Kind Definitions

These are the current `takosumi.com` v1 catalog kind definitions. They are not a
closed built-in kind set; operators can adopt other kind definition URIs.

| Suggested alias | Kind URI                                     | Typical published output          |
| --------------- | -------------------------------------------- | --------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`       | `http` as `http-endpoint`         |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`  | `http` as `http-endpoint`         |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`     | `connection` as `service-binding` |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store` | `bucket` as `object-store`        |
| `gateway`       | `https://takosumi.com/kinds/v1/gateway`      | `public` as `http-endpoint`       |

Short aliases are operator-selected conveniences. The URI is the kind definition
identity. Kind definition documents may publish `referenceAliases` as suggestions;
operator configurations activate aliases explicitly.

## Output Types

Output types define the portable format of output data offered by
`publish.<name>.as` or by a platform service entry. Publisher paths,
provider resources, dashboard routes, and account management lifecycle belong to the
operator or product distribution spec that offers the output.

| Contract           | Public / non-secret fields                                                                           | Secret refs                                               | Typical projections               |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| `http-endpoint`    | `targets[]` for callable upstreams and optional public `endpoints[]`.                                | none                                                      | `upstream`, `env`, `config-mount` |
| `service-binding`  | `service`, `protocol`, `host`, `port`, `database`, optional `username`, `connectionUrl`, `caCertRef` | `passwordRef`, token refs                                 | `secret-env`, `config-mount`      |
| `object-store`     | `bucket`, `endpoint`, `region`, `pathStyle`, optional `publicBaseUrl`, policy refs                   | `accessKeyIdRef`, `secretAccessKeyRef`, `sessionTokenRef` | `secret-env`, `config-mount`      |
| `event-channel`    | `channel`, `protocol`, endpoint/topic/queue/stream identity, delivery policy refs                    | producer/consumer credential refs                         | `secret-env`, `config-mount`      |
| `identity.oidc@v1` | issuer URL, discovery URL, client id, redirect/callback origin, optional JWKS/discovery refs         | `clientSecretRef`                                         | `secret-env`, `config-mount`      |
| `billing.port@v1`  | billing portal URL, usage report endpoint, billing subject ref                                       | `meteringCredentialRef`                                   | `secret-env`, `config-mount`      |

`http-endpoint` describes callable HTTP output data. Workload published outputs usually
emit `targets[]`; gateway or ingress published outputs usually emit `endpoints[]`.
One output must contain at least one of `targets[]` or `endpoints[]`. Public
reachability is a property of the publisher and the resulting output.

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
  secretRefs: [passwordRef, tokenRef]
  allowedProjections: [secret-env, config-mount]

object-store:
  publicFields: { bucket, endpoint, region, pathStyle, publicBaseUrl, policyRefs }
  secretRefs: [accessKeyIdRef, secretAccessKeyRef, sessionTokenRef]
  allowedProjections: [secret-env, config-mount]

event-channel:
  publicFields: { channel, protocol, endpoint, deliveryPolicyRefs }
  secretRefs: [producerCredentialRef, consumerCredentialRef]
  allowedProjections: [secret-env, config-mount]

identity.oidc@v1:
  publicFields: { issuerUrl, discoveryUrl, clientId, redirectOrigin, jwksRef }
  secretRefs: [clientSecretRef]
  allowedProjections: [secret-env, config-mount]

billing.port@v1:
  publicFields: { portalUrl, usageReportEndpoint, billingSubjectRef }
  secretRefs: [meteringCredentialRef]
  allowedProjections: [secret-env, config-mount]
```

`identity.oidc@v1` and `billing.port@v1` are neutral output formats for
platform services. The catalog names the fields a workload can receive.
Issuer operation, client lifecycle, redirect policy, billing ownership, usage
authorization, payment-provider integration, and concrete platform service paths
belong to the operator or product distribution that offers the output.

`ref` fields are operator-provided reference strings. They are stable handles for
operator projections and Deployment records; they are not raw secret values.

Public Deployment outputs and operator read APIs expose only non-secret
fields plus refs. Raw passwords, client secrets, payment-provider credentials,
bearer tokens, and generated private keys are delivered only through
operator-approved runtime secret mechanisms.

## Injection Modes

Injection modes (how values are delivered: `env`, `secret-env`, etc.) define how a listened output type is presented to the
consumer component.

| Injection mode | Meaning                                                                                              | Safety rule                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `env`             | Project non-secret public config into environment variables using the listen `prefix`.               | Valid only for public/non-secret fields.                   |
| `secret-env`      | Project public config plus secret refs into runtime environment through the operator secret backend. | Raw secret values are injected only at workload runtime.   |
| `upstream`        | Connect HTTP endpoint output to an ingress/router/upstream connection.                               | Valid for upstream-capable `http-endpoint` consumer slots. |
| `config-mount`    | Project public config and refs into a mounted config file, volume, or SDK config object.             | Mount path and file format are defined by the kind.        |

Projection compatibility:

| Output type  | `env`                                     | `secret-env` | `upstream`                       | `config-mount` |
| ------------------ | ----------------------------------------- | ------------ | -------------------------------- | -------------- |
| `http-endpoint`    | valid for public/non-secret endpoint data | invalid      | valid for upstream-capable slots | valid          |
| `service-binding`  | invalid                                   | valid        | invalid                          | valid          |
| `object-store`     | invalid                                   | valid        | invalid                          | valid          |
| `event-channel`    | invalid                                   | valid        | invalid                          | valid          |
| `identity.oidc@v1` | invalid                                   | valid        | invalid                          | valid          |
| `billing.port@v1`  | invalid                                   | valid        | invalid                          | valid          |

Consumer slot metadata and operator policy can make a syntactically valid
combination invalid for a particular component.

## Consumer Slot Metadata

Kind definitions can describe what a `listen` slot accepts without
adding more manifest fields. This metadata is catalog vocabulary for validation
and docs. Generated helpers currently focus on spec/output aliases;
consumer slot metadata remains authoritative in the catalog document.

| Kind definition metadata                  | Meaning                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `listens.<slot>.accepts`                  | Output types accepted by the slot.                                    |
| `listens.<slot>.projectionFamilies`       | Injection modes accepted by the slot.                                 |
| `listens.<slot>.minimumAccess`            | Minimum access mode needed for the output.                            |
| `listens.<slot>.safeDefaultAccess`        | Default access before operator policy selects a stronger access mode. |
| `listens.<slot>.requiredWhenReferencedBy` | `spec` field reference that makes the connection required.            |

The manifest does not carry an access-mode field. It selects `listen.from` and
`listen.as`; kind definition metadata, platform service entries, and operator policy
resolve access and compatibility.

## Gateway Portable Subset

When an operator adopts the official `gateway` kind definition, that definition
provides portable HTTP ingress vocabulary. Its `spec.listeners` map declares
named HTTP/HTTPS listeners. Its `spec.routes` array connects a listener to a
local `listen` name.

Portable v1 route semantics:

- `routes[].to` is a local `listen` key, not an output type or URL.
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
  profiles may replace this with a stricter conflict rule.
- Rewrite, strip-prefix, header matching, method matching, and CORS policy are
  kind-specific extension fields when an operator configuration offers them.

JSON Schema captures local syntax for `routes[].path` (starts with `/`, no `?`
or `#`) and identifier syntax for `routes[].listener` and `routes[].to`.
Duplicate routes, segment-boundary conflicts, and unsupported extension fields
are kind definition semantic validation and operator conformance checks.

The gateway `public` published output uses the `http-endpoint` output type. A
produced public output includes non-secret `endpoints[]`. If multiple
endpoints are present, exactly one endpoint has `primary: true`.

## External Output Types

Platform services use the same output types as same-manifest component
published outputs. `identity.oidc@v1` and `billing.port@v1` are official output type
contracts in this catalog. An operator or product distribution spec defines the
concrete platform service path that offers them in a Space.

## Access Metadata

| Term                | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `accessModes`       | Allowed access modes: `read`, `read-write`, `admin`, `invoke-only`, and `observe-only`. |
| `sensitivity`       | Output sensitivity level such as `public-config` or `restricted`.                       |
| `safeDefaultAccess` | Default access mode before operator policy selects stronger access.                     |

## JSON-LD Kind Definition Metadata

JSON-LD is the format for kind definitions, vocabulary terms, and catalog
metadata. Runtime behavior belongs to the operator-selected provider
configuration.

`publications.<name>.contract` names the output type used by
`publish.<name>.as`. Kind definition documents can include `exampleMaterialMapping`
metadata for generated helper types, examples, and documentation checks. Markers
such as `$outputs.*` are non-executable example metadata; operator-selected
provider configurations collect and record provider output in Deployment records.

`listens.<slot>.projectionFamilies` lists injection modes accepted through a
component-local `listen` slot.

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
  "publications": {
    "http": {
      "contract": "http-endpoint"
    }
  }
}
```

## Source Of Truth

The public catalog surface is the published `https://takosumi.com/kinds/v1/*`,
`https://takosumi.com/kinds/v1/*.jsonld`, and
`https://takosumi.com/contexts/v1.jsonld` documents plus this page.

Conforming implementations may compile, mirror, or vendor the catalog. Runtime
execution uses the operator-selected provider configuration to choose runtime or
provider implementations.
