# Manifest (`.takosumi.yml`) {#appspec-takosumi-yml}

The manifest is the single `.takosumi.yml` file at the source root. Takosumi
reads it as an AppSpec, creates an Installation, and records each apply as a
Deployment.

The AppSpec shape is intentionally small.

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Notes
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
publish:
  api:
    output: web.http
    path: acme.notes.api
```

`components` is the component graph inside this manifest. A component chooses
its contract with `kind` and writes kind-owned input in `spec`. Deterministic
connections inside the same manifest use `connect`; platform services outside
the manifest use `listen`; service path declarations recorded as Installation
outputs use root `publish`.

## Root Fields {#root-fields}

| Field        | Required | Meaning                                                                        |
| ------------ | -------- | ------------------------------------------------------------------------------ |
| `apiVersion` | yes      | Current manifest version. The value is `"v1"`.                                 |
| `metadata`   | yes      | Manifest id, name, and optional descriptive metadata.                          |
| `components` | yes      | Component declarations keyed by name.                                          |
| `publish`    | no       | Records a component output as an Installation output service path declaration. |

## `metadata` {#metadata}

```yaml
metadata:
  id: com.example.notes
  name: Notes
  description: Team notes app
  publisher: Example Inc.
  homepage: https://example.com/notes
```

| Field         | Required | Meaning                                                             |
| ------------- | -------- | ------------------------------------------------------------------- |
| `id`          | yes      | Stable manifest identifier. Reverse domain notation is recommended. |
| `name`        | yes      | Human-facing display name.                                          |
| `description` | no       | Short human-facing description.                                     |
| `publisher`   | no       | Publisher or vendor name.                                           |
| `homepage`    | no       | App or publisher URL.                                               |

## `components` {#components}

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true
```

| Field     | Required | Meaning                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------- |
| `kind`    | yes      | Component kind. Operators resolve short aliases such as `worker` and full URIs. |
| `spec`    | no       | Kind-owned input such as worker entrypoints or gateway listener rules.          |
| `connect` | no       | Connects output from another component in this manifest to this component.      |
| `listen`  | no       | Connects a Space-visible platform service path to this component.               |

Short values in examples, such as `worker`, `postgres`, and `gateway`, assume an
operator distribution with an alias map. The resolved kind URI owns the `spec`
schema, output slots, and connection compatibility.

Component names, binding names, and root publish names use
`[a-z][a-z0-9-]{0,62}`. `.` is used only inside `component.output` references
and platform service paths.

## Source File References {#source-file-references}

Kinds that need files from source receive source-root-relative paths inside
kind-specific `spec` fields.

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

Source paths are POSIX relative paths. They do not start with `/`, do not
contain NUL, empty segments, `.`, or `..`, and must not normalize outside the
source root. `git` source resolves paths against the resolved commit tree,
`prepared` source resolves archive entries, and `local` source resolves against
the kernel-local source tree.

`local` has no portable byte pin. Use `git` or `prepared` source when runtime
file bytes must be pinned portably.

## `connect` {#connect}

`connect` is deterministic wiring inside one manifest. The producer does not
declare a separate local output entry in the manifest. When a consumer
references `output: component.outputSlot`, the installer applies the producer
first, materializes that output slot, and passes the material to the consumer.

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small

  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
```

| Field    | Required | Meaning                                                              |
| -------- | -------- | -------------------------------------------------------------------- |
| `output` | yes      | Component output in the same manifest, formatted `component.output`. |
| `inject` | yes      | How material is delivered to the consumer runtime.                   |
| `prefix` | no       | Prefix for env-like projections.                                     |
| `mount`  | no       | Path for path-based projections such as config mounts.               |

`output` has exactly two segments. `db.connection` means the `connection` output
slot of the `db` component. The kind definition and operator-selected
implementation binding define the output slot's material shape.

Cycles through `connect` fail before apply. `connect` is always required.

## `listen` {#listen}

`listen` connects a Space-visible platform service path to a component. It is
the entry point for service material offered by an account plane, operator
distribution, product distribution, or similar provider.

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true
```

| Field      | Required | Meaning                                                               |
| ---------- | -------- | --------------------------------------------------------------------- |
| `path`     | yes      | Space-visible platform service path, such as `identity.primary.oidc`. |
| `inject`   | yes      | How material is delivered to the consumer runtime.                    |
| `prefix`   | no       | Prefix for env-like projections.                                      |
| `mount`    | no       | Path for path-based projections such as config mounts.                |
| `required` | no       | Fails apply when the path cannot be resolved.                         |

`path` has three to eight dotted segments. Two-segment component outputs are
referenced with `connect`. Concrete platform service paths and lifecycles live
in the specification for the distribution that provides them.

A platform service is optional unless `required: true` is set. When an optional
path is absent, the binding is not created. If kind-specific `spec` treats that
binding as required input, apply fails.

## Root `publish` {#root-publish}

Root `publish` records a component output as an Installation output service
path declaration. It is for operator/projected consumers, not for
component-to-component wiring inside the same manifest.

```yaml
publish:
  api:
    output: web.http
    path: acme.notes.api
```

| Field    | Required | Meaning                                                                                                                                              |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output` | yes      | Component output to expose, formatted `component.output`.                                                                                            |
| `path`   | yes      | Service path recorded as an Installation output. An operator or product distribution may project it into a Space-visible platform service inventory. |

Root `publish` is not an HTTP exposure shortcut. HTTP listeners, hosts, TLS, and
route rules live in a gateway or ingress kind's `spec`. Root `publish` records
materialized output as an Installation output declaration. Other Installations
or operator-facing workflows can resolve it only when an operator or product
distribution projects that declaration into a Space-visible platform service
inventory.

One AppSpec cannot declare the same `publish.path` twice. After projection into
the Space-visible inventory, one path in one Space has at most one active
provider. If another Installation publishes the same path, the operator treats
it as a conflict and does not turn off the existing provider automatically. To
switch owners, the existing owner removes `publish`, the Installation is
disabled/deleted, or an operator/admin performs an explicit transfer or disable.
See [Platform Services](./platform-services.md#path-uniqueness-and-conflict).

## Runtime HTTP Exposure {#runtime-http-exposure}

HTTP exposure is also a component graph. A worker has an HTTP output; a gateway
connects to it and publishes it through route and listener configuration.

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
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

Runtime requests are handled by the backend data plane.

```text
install / deploy:
  manifest -> Installer API -> Deployment record

runtime request:
  client -> backend-native listener/route -> workload
         <- same backend data plane <- response
```

`routes[].to` points to a `connect` binding key. In this example the binding key
is `app` and the injection mode is `upstream`. Default host assignment, custom
domain proof, DNS ownership proof, and TLS provisioning are handled by the
gateway kind and operator policy.

## Deployment Outputs {#deployment-outputs}

A Deployment records component output material and provider outputs produced by
apply. Output slots referenced by `connect` or root `publish` are materialized
and returned in public responses without secrets. Backend object IDs, DNS
verification records, TLS certificate handles, and similar evidence can also be
stored in an operator-facing ledger.

## Where Adjacent Data Lives {#where-adjacent-data-lives}

| Data                              | Surface                                         |
| --------------------------------- | ----------------------------------------------- |
| Space, organization, actor        | Installer API, token claims, operator context   |
| Git URL or source pin             | Installer API / CLI input / Deployment record   |
| local source path                 | dev / operator-local Installer API input        |
| build recipe or container command | build service or CI outside the manifest        |
| runtime file path                 | kind-specific `spec`                            |
| backend credential                | operator / implementation binding               |
| implementation selection          | operator distribution                           |
| identity, billing, signup UI      | operator distribution / account management docs |
| workflow, schedule, webhook       | automation that submits source to Installer API |

## Complete Example {#complete-example}

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

  assets:
    kind: object-store
    spec:
      name: notes-assets

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
      assets:
        output: assets.bucket
        inject: secret-env
        prefix: ASSETS
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
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
publish:
  api:
    output: web.http
    path: acme.notes.api
```

## Related Pages {#related-pages}

- [Official Type Catalog](./type-catalog.md)
- [Platform Services](./platform-services.md)
- [Installer API](./installer-api.md)
- [HTTP Exposure](./http-exposure.md)
- [Build Service Boundary](./build-spec.md)
