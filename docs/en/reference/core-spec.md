# Core Specification {#core-spec}

Takosumi core is the portable contract for installing source into a Space and
recording apply results as Deployments. The public model has three entities.

| Entity       | Meaning                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest     | `.takosumi.yml` in a source root. It declares `metadata.id`, the component graph, and optional Installation output service path declarations. |
| Installation | A manifest installed into a Space, with current state.                                                                                        |
| Deployment   | One apply result with source identity, `manifestDigest`, status, and outputs.                                                                 |

Core defines:

- AppSpec shape
- Installation and Deployment lifecycle
- Installer API
- Source input kinds and digest guards
- Component output reference and platform service path grammar

Component kinds, output slots, material shapes, and injection modes are resolved
by the adopted kind definitions and operator-selected implementation bindings.

## Manifest {#manifest}

```yaml
apiVersion: v1
metadata:
  id: com.example.app
  name: Example App
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
publish:
  api:
    output: web.http
    path: acme.example.api
```

Component fields:

```yaml
components:
  web:
    kind: worker
    spec: {}
    connect: {}
    listen: {}
```

| Field     | Core meaning                                                      |
| --------- | ----------------------------------------------------------------- |
| `kind`    | String resolved by the operator distribution.                     |
| `spec`    | Open object defined by the selected kind.                         |
| `connect` | Connects same-manifest component output to the consumer.          |
| `listen`  | Connects Space-visible platform service material to the consumer. |

Root `publish` records component output as an Installation output service path declaration. An operator or product distribution may project that declaration into a Space-visible platform service inventory.

## Connection Model {#connection-model}

Deterministic wiring inside one manifest:

```yaml
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
```

Platform service outside the manifest:

```yaml
components:
  web:
    kind: worker
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        required: true
```

Space-visible service path:

```yaml
publish:
  api:
    output: web.http
    path: acme.notes.api
```

| Shape                          | Resolution                                                   |
| ------------------------------ | ------------------------------------------------------------ |
| `component.output`             | Component output in the same manifest. Exactly two segments. |
| `identity.primary.oidc[.more]` | Space-visible platform service. Three to eight segments.     |

`connect` references `component.output`. `listen.path` references a platform
service path. Root `publish.path` is recorded in Deployment output as an
Installation output declaration. External consumers can resolve it only when
the operator or product distribution projects that declaration into a
Space-visible platform service inventory.
In that inventory, one path in one Space has at most one active provider. The
same path from a different owner is a conflict, not an automatic overwrite.

## Installer API {#installer-api}

The public write API has five endpoints:

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

Dashboard, CLI, polling, history, rollback selection, and support views are
operator-owned read models around this write lifecycle.

## Source Input {#source-input}

| Kind       | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `git`      | Remote git source. Apply guard uses resolved commit plus `manifestDigest`.                             |
| `prepared` | Remote source prepared by CI or a build service. Apply guard uses source digest plus `manifestDigest`. |
| `local`    | Kernel-local source tree for development or operator-local use. Apply guard uses `manifestDigest`.     |

`manifestDigest` is the sha256 of raw `.takosumi.yml` bytes. For prepared
source, Takosumi also computes the sha256 of the fetched source payload.

Portable Installer API v1 prepared source payloads are uncompressed POSIX tar
archives. Build recipes, provenance, and cache metadata belong to the operator
build-service profile.

## Layer Split {#layer-split}

| Layer                 | Defines                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Takosumi core         | AppSpec shape, Installation / Deployment, Installer API, source / digest guards, reference grammar.         |
| Official type catalog | Reusable kind definitions, output slots, material vocabulary, and JSON-LD catalog metadata.                 |
| Operator distribution | Available kinds, platform service paths, account layer APIs, provider bindings, dashboards, deploy facades. |

Concrete workload-facing platform service paths and account layer API
identifiers live in the operator distribution specification. For Takosumi Cloud,
see [Takosumi Cloud](./takosumi-cloud.md).

## Related Pages {#related-pages}

- [Manifest](./manifest.md)
- [Spec Boundaries](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
- [Official Type Catalog](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
