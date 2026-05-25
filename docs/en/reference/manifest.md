# Manifest (`.takosumi.yml`) {#appspec-takosumi-yml}

The manifest is the single `.takosumi.yml` file at the source root. The root
fields are only `apiVersion`, `metadata`, and `components`.

The manifest is a component graph. Each component chooses a contract with
`kind`, writes kind-specific input under `spec`, and declares connections with
`publish` and `listen`.

The Installer API validates source in the context of an
operator-supplied `spaceId` and records Installation and Deployment records.
Account membership, approval, billing, and dashboard projections belong to
account management (billing, auth).

## Root Fields {#root-fields}

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
```

| Field        | Required | Meaning                                                 |
| ------------ | -------- | ------------------------------------------------------- |
| `apiVersion` | yes      | Current manifest version. The value is `"v1"`.          |
| `metadata`   | yes      | Manifest id, name, and optional descriptive metadata.   |
| `components` | yes      | Runtime and resource declarations keyed by name.        |

## `metadata` {#metadata}

```yaml
metadata:
  id: com.example.notes
  name: Example Notes
  description: Team notes app
  publisher: Example Inc.
  homepage: https://example.com/notes
```

| Field         | Required | Meaning                                                            |
| ------------- | -------- | ------------------------------------------------------------------ |
| `id`          | yes      | Stable manifest identifier. Reverse domain notation is recommended. |
| `name`        | yes      | Human-facing display name.                                         |
| `description` | no       | Short human-facing description.                                    |
| `publisher`   | no       | Publisher or vendor name.                                          |
| `homepage`    | no       | App or publisher URL.                                              |

## `components` {#components}

| Field     | Required | Meaning                                                                 |
| --------- | -------- | ----------------------------------------------------------------------- |
| `kind`    | yes      | Component kind string (Takosumi does not interpret the value). The operator resolves aliases and URIs. |
| `spec`    | no       | Inputs defined by the kind, such as worker entrypoint or gateway listener rules. |
| `publish` | no       | Outputs offered by this component.                                      |
| `listen`  | no       | Connections that consume outputs from other components or platform services. |

The short aliases used in examples, such as `worker`, `postgres`, and `gateway`,
assume an operator configuration that maps those aliases to kind definition URIs. See the
[Kind Catalog](./type-catalog.md) for Takosumi-published catalog
vocabulary.

Component names, publish names, and listen names use
`[a-z][a-z0-9-]{0,62}`. `.` is reserved for `component.publication` references
and is not valid in map keys.

## Source File References {#source-file-references}

Kinds that need files from source, such as workers or static assets, receive
source-root-relative paths inside kind-specific `spec` fields. The same grammar
applies to `git`, `prepared`, and `local` source. Fields marked by the selected
kind definition as source-file references are checked before resource creation.

Source paths:

- are interpreted as POSIX relative paths
- do not start with `/`
- do not contain NUL, empty segments, `.`, or `..`
- must not normalize outside the source root

Resolution differs by source kind while preserving that boundary:

- `git`: paths resolve against the resolved commit tree. Symlinks are accepted
  only when the selected implementation treats them as data or the resolved
  target stays inside the source root.
- `prepared`: archive entry names, symlinks, hardlinks, duplicate normalized
  paths, and source-root escapes are rejected before resource creation.
- `local`: paths resolve against the kernel-local source tree. Symlink and
  hardlink realpaths must remain inside the local source root.

`local` has no portable byte pin. `manifestDigest` guards the `.takosumi.yml`
bytes. Use `git` or `prepared` source when runtime file bytes must be pinned
portably.

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

## `publish` {#publish}

`publish` names component-local output and offers it as an output type (the
type of data offered, e.g. `service-binding`, `http-endpoint`). An
output type describes what a consumer can connect to: database connection, HTTP
endpoint, object-store bucket, event channel, and similar output data.

External publishers offer output data through the same `listen.from` model.

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding
```

| Field | Required | Meaning                                                    |
| ----- | -------- | ---------------------------------------------------------- |
| `as`  | yes      | Output type alias or URI, such as `service-binding`. |

If `as` is an absolute URI, that URI is the output type identity. Other
strings are short aliases matched exactly against the Takosumi
Kind Catalog or an operator-adopted catalog. Unresolved contracts fail
before resource creation.

## `listen` {#listen}

```yaml
components:
  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
```

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        from: publisher.identity.primary
        as: secret-env
        prefix: IDENTITY
        required: true
```

| Field      | Required | Meaning                                                                       |
| ---------- | -------- | ----------------------------------------------------------------------------- |
| `from`     | yes      | Same-manifest `component.publication` or platform service path.                                    |
| `as`       | yes      | How values are delivered (`env`, `secret-env`, etc.), checked with the published output and policy. |
| `prefix`   | no       | Prefix for delivery modes such as `env` and `secret-env`.                                          |
| `mount`    | no       | Path for file or volume projections.                                                               |
| `required` | no       | Makes unresolved platform service paths fail apply.                                                |

`listen.from` uses one plain dotted reference grammar. Exactly two segments,
such as `db.connection`, reference a published output in the same manifest. Three to
eight segments, such as `publisher.identity.primary`, reference a Space-visible
[platform service](./external-publications.md). Component and publish
names cannot contain `.`, so the two forms are unambiguous.

`as` values such as `env`, `secret-env`, `config-mount`, and `upstream` are
validated against three inputs: the source output type, the consumer kind
definition's slot metadata, and operator policy. The meaning of `prefix` and `mount`
follows the same validation. The manifest core defines source references,
listen names, and closed key grammar.

`required` is for platform service paths. Two-segment
`component.publication` references are always required, so `required` on a local
reference is invalid.

## Validation Before Apply {#validation-before-apply}

Resolution runs before resource creation. It uses operator-supplied
kind definitions, output types, the list of available platform services, and policy.

The following conditions fail apply:

- Unresolved local sources
- Unsupported projections
- Unsafe projection of secret-bearing output into plain environment variables
- Contract version mismatches

The implementation or operator ledger records the selected
platform service state and delivery mode. Public Deployment
responses guarantee the non-secret `outputs` defined by
[Installer API](./installer-api.md#deployment).

Cycles inside one manifest fail apply. A two-segment `component.publication`
reference is always required. A platform service path with three or more
segments is optional by default and becomes an apply error with
`required: true`.

If an optional platform service is absent, the connection does not exist.
If kind-specific `spec` refers to that connection as required input, apply fails.
An absent optional connection is allowed only when the adopted kind definition defines a
degraded behavior and the implementation or operator records that degradation in
the Deployment record.

## Runtime HTTP Exposure {#runtime-http-exposure}

Public app endpoints are normal component connections. HTTP routes, TLS, and
public hostnames are expressed by the adopted ingress kind definition's `spec` plus
ordinary `listen` and `publish`.

A workload publishes `web.http` as upstream output. A gateway or ingress
component listens to that output and connects it to public reachability
through listener configuration and operator activation.

The example assumes an operator configuration that maps `worker` and `gateway` to
adopted kind definition URIs. `listeners` and `routes` are gateway-specific
schema defined by that kind, not manifest core fields. See [HTTP Exposure](./http-exposure.md) and the
[Kind Catalog](./type-catalog.md#gateway-portable-subset).

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: notes.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

```text
install / deploy:
  manifest -> Installer API -> Deployment record / outputs

runtime request:
  client -> provider-native listener/route -> workload
         <- same provider data plane <- response
```

`host` is gateway-specific ingress input defined by that kind. Host omission, reservation,
custom-domain proof, DNS ownership proof, and TLS provisioning are handled by
the adopted kind definition, operator policy, and provider flow.

`routes[].to` points to a `listen` key. In this example the listen key
is `app` and the injection mode is `upstream`.

Provider object IDs, DNS verification records, TLS certificate handles, and
generated refs stay in the Deployment record. Runtime file
paths used by a workload stay in the workload component's kind-specific `spec`.
Runtime requests are handled by the provider data plane.

## Where Adjacent Data Lives {#where-adjacent-data-lives}

| Data                              | Surface                                         |
| --------------------------------- | ----------------------------------------------- |
| Space, organization, actor        | Installer API, token claims, operator context   |
| Git URL or source pin             | Installer API / CLI input / Deployment record   |
| local source path                 | dev / operator-local Installer API input        |
| build recipe or container command | build service or CI outside the manifest        |
| runtime file path                 | kind-specific `spec`                            |
| provider credential               | operator / provider configuration               |
| implementation selection          | operator configuration                          |
| identity, billing, signup UI      | operator configuration / account management docs |
| workflow, schedule, webhook       | automation that submits source to Installer API |

## Complete Example {#complete-example}

This example assumes an operator configuration with a short alias map. The
`public.spec.routes` structure is catalog-defined schema for the official `gateway`
kind.

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  assets:
    kind: object-store
    spec:
      name: notes-assets
    publish:
      bucket:
        as: object-store

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
      assets:
        from: assets.bucket
        as: secret-env
        prefix: ASSETS
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: notes.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

## Related Pages {#related-pages}

- [Kind Catalog](./type-catalog.md)
- [Platform Services](./external-publications.md)
- [Takosumi Cloud](./takosumi-cloud.md)
- [Installer API](./installer-api.md)
- [HTTP Exposure](./http-exposure.md)
- [Build Service Boundary](./build-spec.md)
