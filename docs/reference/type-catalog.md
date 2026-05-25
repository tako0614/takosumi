# Takosumi Official Type Catalog Specification {#type-catalog}

Takosumi publishes a reusable catalog of descriptor and material contract types
from `takosumi.com`. This catalog is official Takosumi vocabulary and sits next
to the Takosumi core specification and Takosumi Cloud distribution spec.
Operators can adopt these descriptors as-is, map short aliases to them, extend
them through provider policy, or publish their own catalogs on another domain.

This page is the catalog specification. It defines Takosumi-owned type
vocabulary: descriptor identities, material contract names, projection-family
names, and the JSON-LD publication format for the official catalog.

## Normative Scope

The official type catalog owns:

- descriptor identities under `https://takosumi.com/kinds/v1/*`
- descriptor metadata fields that describe `spec`, publication slots,
  publication vocabulary, and expected material shapes
- material contract names such as `http-endpoint`, `service-binding`,
  `object-store`, `identity.oidc@v1`, and `billing.port@v1`
- projection-family names such as `env`, `secret-env`, `upstream`,
  `config-mount`, and future catalog-published projection families
- access metadata vocabulary such as access mode enum, sensitivity classes, and
  safe default access
- JSON-LD kind descriptor documents under `https://takosumi.com/kinds/v1/*` and
  the context document at `https://takosumi.com/contexts/v1.jsonld`

The catalog owns reusable material shape vocabulary. Operator distribution specs
own concrete external publication paths, OIDC issuer operation, billing
behavior, account-plane records, provider provisioning, and dashboard APIs when
they adopt the catalog vocabulary.

Operator distributions own catalog adoption. They decide which catalog entries
are visible in a Space, which aliases are active, which provider or local
runtime implements each descriptor, and which external publication paths they
offer.

## Catalog Roles

| Role                       | Example                                         | Meaning                                              |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Kind descriptor            | `https://takosumi.com/kinds/v1/worker`          | Component `kind` schema and publication vocabulary.  |
| Material contract          | `http-endpoint`                                 | Type of material offered by `publish.<name>.as`.     |
| Projection family          | `env`, `secret-env`, `upstream`, `config-mount` | How listened material is projected into a consumer.  |
| External material contract | `identity.oidc@v1`                              | Reusable material type for external publications.    |
| Access metadata            | `invoke-only`, `restricted`                     | Grant and projection metadata for external material. |

AppSpec records catalog references as strings such as `kind`,
`publish.<name>.as`, and `listen.<binding>.as`. Operator resolution attaches
descriptor semantics, chooses which catalog entries are visible in a Space, and
selects the implementation binding that materializes them.

## Official Catalog Kind Descriptors

These are the current `takosumi.com` v1 catalog descriptors. They are not a
closed built-in kind set; an operator can adopt other descriptor URIs.

| Suggested alias | Kind URI                                     | Typical publication               |
| --------------- | -------------------------------------------- | --------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`       | `http` as `http-endpoint`         |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`  | `http` as `http-endpoint`         |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`     | `connection` as `service-binding` |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store` | `bucket` as `object-store`        |
| `gateway`       | `https://takosumi.com/kinds/v1/gateway`      | `public` as `http-endpoint`       |

Kind short aliases are operator-selected conveniences. The URI is the descriptor
identity; the alias exists only when an operator profile maps it. Descriptor
documents may publish `referenceAliases` as suggestions for operator profiles;
an operator profile activates aliases by mapping them explicitly.

## Material Contracts

Material contracts define the portable shape of material offered by
`publish.<name>.as` or an external publication declaration. Publisher paths,
provider resources, dashboard routes, and account-plane lifecycle live in the
operator or product distribution spec that offers the material.

| Contract           | Public / non-secret fields                                                                                                                                                | Secret refs                                                  | Typical projections               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `http-endpoint`    | `targets[]` for callable upstreams and optional public `endpoints[]` with `url`, `scheme`, `host`, `listener`, `visibility`, and optional `routes[]` (`pathPrefix`, `to`) | none                                                         | `upstream`, `env`, `config-mount` |
| `service-binding`  | `service`, `protocol`, `host`, `port`, `database`, optional `caCertRef`                                                                                                   | `usernameRef`, `passwordRef`, `connectionUrlRef`, token refs | `secret-env`, `config-mount`      |
| `object-store`     | `bucket`, `endpoint`, `region`, `pathStyle`, optional `publicBaseUrl`, policy refs                                                                                        | `accessKeyIdRef`, `secretAccessKeyRef`, `sessionTokenRef`    | `secret-env`, `config-mount`      |
| `event-channel`    | `channel`, `protocol`, endpoint/topic/queue/stream identity, delivery policy refs                                                                                         | producer/consumer credential refs                            | `secret-env`, `config-mount`      |
| `identity.oidc@v1` | issuer URL, discovery URL, client id, redirect/callback origin policy, optional public JWKS/discovery refs                                                                | `clientSecretRef`, refresh-token policy refs                 | `secret-env`, `config-mount`      |
| `billing.port@v1`  | billing portal URL, usage report endpoint, billing owner ref, account/install billing policy refs                                                                         | metering credential refs                                     | `secret-env`, `config-mount`      |

`http-endpoint` describes callable HTTP material. A workload upstream and a
public ingress output can both use this contract. Public reachability is a
property of the publisher and materialization result. For example, `web.http`
can be an upstream HTTP material, while `public.public` can be a materialized
public endpoint produced by a gateway/ingress component.

Compact schema:

```yaml
http-endpoint:
  publicFields:
    targets[]:
      required: true
      fields: { name, protocol, host, port, basePath, visibility }
    endpoints[]:
      required: false
      fields: { url, scheme, host, listener, visibility, primary, routes[] }
  secretRefs: []
  allowedProjections: [upstream, env, config-mount]

service-binding:
  publicFields: { service, protocol, host, port, database, caCertRef }
  secretRefs: [usernameRef, passwordRef, connectionUrlRef, tokenRef]
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
  publicFields: { issuerUrl, discoveryUrl, clientId, redirectOriginPolicy, jwksRef }
  secretRefs: [clientSecretRef, refreshTokenPolicyRef]
  allowedProjections: [secret-env, config-mount]

billing.port@v1:
  publicFields: { portalUrl, usageReportEndpoint, billingOwnerRef, policyRefs }
  secretRefs: [meteringCredentialRef]
  allowedProjections: [secret-env, config-mount]
```

`ref` fields are operator-owned reference strings. They are stable enough for
the operator read projection and runtime injection mechanism, but they are not
raw secret values.

Public Deployment outputs and inspect responses expose non-secret fields plus
refs. Raw passwords, client secrets, payment-provider credentials, bearer
tokens, and generated private keys are represented by refs and are delivered
only through operator-approved runtime secret mechanisms.

Material contract and projection-family names such as `http-endpoint`,
`service-binding`, `env`, `secret-env`, `upstream`, and `config-mount` are
compact official catalog terms. Operators decide whether a Space may use a term.
An adopted compact term keeps the catalog meaning. Absolute URI identities are
also valid when an operator profile accepts them.

## Projection Families

Projection families define how a listened material contract is presented to the
consumer component. AppSpec stores the selected family in `listen.<binding>.as`;
the selected descriptor and operator policy validate compatibility before
provider side effects.

| Projection family | Meaning                                                                                                 | Safety rule                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `env`             | Project non-secret public config into environment variables using the binding `prefix`.                 | Valid only for public/non-secret fields. Material with required secret refs must use another projection. |
| `secret-env`      | Project public config plus secret refs into runtime environment through the operator secret backend.    | Public records keep refs; raw secret values are injected only at workload runtime.                       |
| `upstream`        | Connect an HTTP endpoint material to an ingress/router/upstream binding without turning it into config. | Valid for `http-endpoint` consumer slots that accept upstream routing material.                          |
| `config-mount`    | Project public config and refs into a mounted config file, volume, or SDK config object.                | Mount path and file shape are descriptor-owned and validated by the selected binding.                    |

Projection compatibility:

| Material contract  | `env`                                     | `secret-env` | `upstream`                       | `config-mount` |
| ------------------ | ----------------------------------------- | ------------ | -------------------------------- | -------------- |
| `http-endpoint`    | valid for public/non-secret endpoint data | invalid      | valid for upstream-capable slots | valid          |
| `service-binding`  | invalid                                   | valid        | invalid                          | valid          |
| `object-store`     | invalid                                   | valid        | invalid                          | valid          |
| `event-channel`    | invalid                                   | valid        | invalid                          | valid          |
| `identity.oidc@v1` | invalid                                   | valid        | invalid                          | valid          |
| `billing.port@v1`  | invalid                                   | valid        | invalid                          | valid          |

Consumer slot metadata and operator policy can make a syntactically valid cell
invalid for a particular component. For example, `http-endpoint` + `upstream`
requires a consumer slot that accepts provider/private upstream routing.
Secret-bearing contracts default to `env: invalid`; a descriptor that wants a
secretless public config env projection should define a separate env-safe
material contract or an explicit operator profile extension.

## Consumer Slot Metadata

Kind descriptors can describe what a `listen` binding slot accepts without
adding more AppSpec fields. This metadata is catalog vocabulary for validation,
docs, and generated helper types.

| Descriptor metadata                 | Meaning                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `listens.<slot>.accepts`            | Material contracts accepted by this consumer slot, such as `http-endpoint`.          |
| `listens.<slot>.projectionFamilies` | Projection families accepted for that slot, such as `upstream` or `secret-env`.      |
| `listens.<slot>.minimumAccess`      | Minimum access mode needed for the material, such as `read` or `invoke-only`.        |
| `listens.<slot>.safeDefaultAccess`  | Default access before operator policy selects or approves a stronger grant.          |
| `listens.<slot>.required`           | Whether the descriptor treats the binding as required when its `spec` references it. |

Operators combine descriptor metadata with Space policy and external publication
declarations. AppSpec does not carry an access-mode field: it selects
`listen.from` and `listen.as`, then the operator resolves access from descriptor
metadata, publication declaration, and policy. Unsupported material contracts,
unsafe projections such as secret material through plain `env`, access-mode
mismatches, and contract-version mismatches are rejected before implementation
side effects. Operator profiles may restrict accepted projections; widening a
slot requires descriptor or profile extension.

## Gateway Portable Subset

When an operator adopts the official `gateway` descriptor, that descriptor
publishes the portable HTTP ingress vocabulary below. Its `spec.listeners` map
declares named HTTP/HTTPS listeners. Its `spec.routes` array connects a listener
to a local `listen` binding name.

Portable v1 route semantics:

- `routes[].to` is a local `listen` binding key, not a material contract or URL.
- `routes[].path` is an HTTP path prefix. It is `/` or starts with `/`.
- `routes[].path` is a configuration path string, not a full URL. It must not
  contain `?`, `#`, NUL, an empty string, or a path segment escape that changes
  the prefix into another path.
- Matching uses only the URL path. Query strings and fragments are excluded.
- Matching is case-sensitive and compares the URL path string before
  percent-decoding or path normalization.
- Percent-encoded octets are compared literally for routing. `%2F` is not
  treated as `/` for prefix or segment-boundary matching.
- `/` matches every path. `/api` matches `/api` and `/api/...`, but not
  `/apiary`. `/api/` matches `/api/...`, but not `/api`.
- Route matching is longest-prefix within the same listener, with the segment
  boundary rule above. Two routes with the same listener and path are invalid
  after exact string comparison unless an operator-specific extension defines a
  stricter conflict rule.
- Rewrite, strip-prefix, header matching, method matching, and CORS policy are
  descriptor-specific extension fields when an operator profile offers them.
- Provider/operator conformance docs describe how unsupported listener, host,
  TLS, or path-routing requests are rejected before implementation side effects.

The gateway `public` publication uses the `http-endpoint` material contract. A
materialized public output includes non-secret `endpoints[]`. Each endpoint
records `url`, `scheme`, `host`, `listener`, `visibility`, `primary`, and
optional `routes[]`. `routes[]` records the portable route summary (`pathPrefix`
and `to`) so account-plane surfaces can show or launch the public endpoint
without owning request routing. If multiple endpoints are present, exactly one
has `primary: true`; account-plane launch surfaces use that endpoint as the
default launch URL.

## Workload External Material Contracts

External publications use the same material contracts as component-local
publications. `identity.oidc@v1` and `billing.port@v1` are official material
contracts in this catalog. An operator or product distribution spec defines the
concrete publication path that offers them in a Space.

## Access Metadata

External publication declarations and materialization evidence can use the
official access metadata vocabulary.

| Term                | Meaning                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `accessModes`       | Allowed grant modes from the official enum: `read`, `read-write`, `admin`, `invoke-only`, and `observe-only`. |
| `sensitivity`       | Material sensitivity class such as `public-config`, `restricted`, or operator-defined extensions.             |
| `safeDefaultAccess` | Default access mode before operator policy selects or approves a stronger grant.                              |

The detailed access-mode semantics are in [Access Modes](./access-modes.md).

## Catalog Descriptor Metadata

Catalog descriptor metadata is published as JSON-LD under
`https://takosumi.com/contexts/v1.jsonld` and `https://takosumi.com/kinds/v1/*`.
JSON-LD is a publication format for kind schema, vocabulary terms, and catalog
metadata; runtime behavior lives in the operator-selected implementation
binding. Material contracts, projection families, and access metadata are valid
catalog terms through this specification and may be referenced from descriptor
documents.

`publications.<name>.contract` names the material contract used by
`publish.<name>.as` and describes the fields a publication may expose.
Descriptor documents can include provider-result field mapping metadata for
generated helper types, examples, and documentation checks. Operator bindings
decide how provider outputs are collected and recorded as
implementation/operator evidence.

`listens.<slot>.projectionFamilies` lists projection families accepted through a
component-local `listen` binding slot. It is descriptor metadata for
compatibility checks. Runtime injection details such as environment variable
expansion, upstream target construction, sidecar mounts, or SDK config files
belong to the operator-selected implementation binding.

Descriptor `capabilityTerms` are common capability vocabulary terms for matching
and docs. Provider availability, quotas, runtime limits, credentials, and
concrete feature support are provider package / operator profile metadata.

Provider-specific capability descriptors, native provider schemas, and
reference-kernel conformance metadata are documented in provider implementation
docs and maintenance maps. The official catalog specification describes the
portable vocabulary an AppSpec may reference.

The JSON-LD context may include semantic terms such as `AppSpec`,
`Installation`, or `Deployment` so descriptors can link to the broader
vocabulary. Those terms are semantic vocabulary, not the AppSpec or Installer
API wire schema. Core wire shape remains defined by [AppSpec](./app-spec.md) and
[Installer API](./installer-api.md).

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
`https://takosumi.com/contexts/v1.jsonld` documents plus this specification
page. These documents publish vocabulary and descriptor metadata. Catalog
compatibility is based on descriptor URI identity, material contract names,
projection-family names, access vocabulary, and documented material field
shapes. Runtime implementations may consume those documents directly or load an
equivalent operator-adopted descriptor registry. Repository source paths for
maintainers are tracked in [Spec Maintenance Map](./public-spec-source-map.md).

Conforming implementations may compile, mirror, or vendor the catalog. Runtime
execution does not require JSON-LD processing, and JSON-LD documents do not
select plugins, providers, or materializers.

Generated TypeScript helpers and reference-kernel adapters can live in
`@takos/takosumi-plugins`, but those helpers are an implementation convenience.
The catalog compatibility surface is the published vocabulary and JSON-LD
documents.

## Related Pages

- [Specification Boundaries](./spec-boundaries.md)
- [Takosumi Core Specification](./core-spec.md)
- [AppSpec](./app-spec.md)
- [HTTP Exposure](./http-exposure.md)
- [External Publications](./external-publications.md)
- [Takosumi Cloud](./takosumi-cloud.md)
