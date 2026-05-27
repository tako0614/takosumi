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
    kind: http-endpoint
    path: acme.notes.api
```

`components` is the component graph inside this manifest. A component chooses
its contract with `kind` and writes kind-owned input in `spec`. Deterministic
connections inside the same manifest use `connect`; publications outside the
manifest use `listen`; publication declarations recorded as Installation outputs
use root `publish`.

AppSpec uses `kind` as the selector word. Component `kind` says what is created.
`publish.kind` and `listen.kind` say which kind of output material is offered or
consumed. There is no manifest `type` selector. The word `type` is reserved for
JSON Schema, JSON-LD `@type`, and TypeScript type names. The prose may say
component kind or material kind for readability, but the manifest selector field
is always `kind`.

Use these three rules:

| Goal                                                 | Manifest shape                                   |
| ---------------------------------------------------- | ------------------------------------------------ |
| Connect to component output inside the same manifest | `connect.<binding>.output: component.outputSlot` |
| Connect to one known publication in the Space        | `listen.<binding>.path: owner.area.name`         |
| Discover every visible match, such as MCP servers    | `listen.<binding>.kind` + labels + `many: true`  |

`path` is not a URL path. It is a stable name for one publication inside a
Space. In one Space, one `path` can have only one active provider. For
collection discovery, publish pathless entries and select them by `kind` and
`labels`. In other words, `path` names one exact target; it never means "all
publications of this kind."

## Root Fields {#root-fields}

| Field        | Required | Meaning                                                           |
| ------------ | -------- | ----------------------------------------------------------------- |
| `apiVersion` | yes      | Current manifest version. The value is `"v1"`.                    |
| `metadata`   | yes      | Manifest id, name, and optional descriptive metadata.             |
| `components` | yes      | Component declarations keyed by name.                             |
| `publish`    | no       | Records a component output as an Installation output publication. |

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
| `listen`  | no       | Connects Space-visible publications to this component.                          |

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

`listen` connects Space-visible publications to a component. It is the entry
point for service material offered by an account plane, operator distribution,
product distribution, another Installation, or a similar provider. Use `path`
for a known exact target; use `kind` and `labels` when the target is discovered
or when multiple targets are expected.

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        kind: identity.oidc@v1
        inject: secret-env
        prefix: IDENTITY
        required: true
      tools:
        kind: mcp-server@v1
        labels:
          capability: docs
        many: true
        inject: config-mount
```

| Field      | Required | Meaning                                                                                             |
| ---------- | -------- | --------------------------------------------------------------------------------------------------- |
| `path`     | no       | Exact Space-visible publication path, such as `identity.primary.oidc`.                              |
| `kind`     | no       | Material kind selector. Required when `path` is omitted; with `path`, it is a compatibility check.  |
| `labels`   | no       | Label selector used with `kind` discovery.                                                          |
| `many`     | no       | When true, binds every matching publication as one collection material. It is not used with `path`. |
| `inject`   | yes      | How material is delivered to the consumer runtime.                                                  |
| `prefix`   | no       | Prefix for env-like projections.                                                                    |
| `mount`    | no       | Path for path-based projections such as config mounts.                                              |
| `required` | no       | Fails apply when the publication cannot be resolved.                                                |

`path` has three to eight dotted segments. Two-segment component outputs are
referenced with `connect`. Concrete publication paths and lifecycles live in the
specification for the distribution that provides them. `kind` follows the same
opaque alias-or-URI rule as component `kind`, but here it names the material
kind being consumed.

`path` and `kind` do different jobs. `path` is an exact name for one target.
`kind` is a discovery selector. Materials that may exist many times in a Space,
such as MCP servers, do not need paths: consume them with
`kind: mcp-server@v1` and `many: true`. Without `many`, the selector must resolve
to exactly one publication or apply fails.
Do not combine `path` with `many: true`: exact paths select one target, while
`many: true` only applies to kind / label discovery.

`many: true` binds every visible matching publication as one collection
material. Zero matches fail when `required: true`; zero matches on an optional
collection resolve to an empty collection. Operators must not silently truncate
matches. If a selector is too broad for policy or size limits, apply fails
before resources are created. Successful resolution records a deterministic
order and the selected publication identities with the Deployment.

An exact `listen.path` is optional unless `required: true` is set. When an
optional path is absent, the binding is not created. If kind-specific `spec`
treats that binding as required input, apply fails.

## Root `publish` {#root-publish}

Root `publish` records a component output as an Installation output publication.
It is for operator/projected consumers, not for component-to-component wiring
inside the same manifest. `path` is optional. Use it only for publications that
need a stable exact name; publish discoverable materials such as MCP servers
with `kind` and `labels`. `mcp-server@v1` is an official catalog material kind,
so pathless MCP server publications can be discovered as a set with
`listen.kind`.

```yaml
publish:
  api:
    output: web.http
    kind: http-endpoint
    path: acme.notes.api
  tools:
    output: web.mcp
    kind: mcp-server@v1
    labels:
      capability: docs
```

| Field    | Required | Meaning                                                                                        |
| -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `output` | yes      | Component output to expose, formatted `component.output`.                                      |
| `kind`   | no       | Material kind for this publication. The operator can derive it when the output slot is unique. |
| `path`   | no       | Service path used only when an exact name is needed.                                           |
| `labels` | no       | Discovery labels used with `listen.kind`.                                                      |

Root `publish` is not an HTTP exposure shortcut. HTTP listeners, hosts, TLS, and
route rules live in a gateway or ingress kind's `spec`. Root `publish` records
materialized output as an Installation output publication. Other Installations
or operator-facing workflows can resolve it only when an operator or product
distribution projects that declaration into a Space-visible publication
inventory.

One AppSpec cannot declare the same `publish.path` twice. After projection into
the Space-visible inventory, a publication with a path has at most one active
owner for that path in that Space. If another Installation publishes the same
path, the operator treats it as a conflict and does not turn off the existing
provider automatically. A publication without a path is discoverable by `kind`
and `labels` and does not participate in path conflict rules. To switch owners,
the existing owner removes `publish`, the Installation is disabled/deleted, or
an operator/admin performs an explicit transfer or disable. See
[Platform Services](./platform-services.md#path-uniqueness-and-conflict).

In short: named publications can conflict; pathless publications cannot conflict
by path. Do not add a path just to make discoverable collections work.

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
    kind: http-endpoint
    path: acme.notes.api
```

## Related Pages {#related-pages}

- [Official Catalog](./catalog.md)
- [Platform Services](./platform-services.md)
- [Installer API](./installer-api.md)
- [HTTP Exposure](./http-exposure.md)
- [Build Service Boundary](./build-spec.md)
