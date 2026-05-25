# Takosumi Core Specification {#core-spec}

Takosumi core specification is the portable contract for installing source into
a Space and recording each apply as a Deployment. The public model has three
entities:

| Entity       | Meaning                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| AppSpec      | `.takosumi.yml` in a source root. Authors declare components and connections.                           |
| Installation | An AppSpec installed into a Space, with current state.                                                  |
| Deployment   | One apply result for an Installation, including source identity, `manifestDigest`, status, and outputs. |

The core specification defines the AppSpec envelope, the Installer API, source
input kinds, digest guards, and publish/listen reference grammar. It treats
component kinds, material contracts, projection families, and external
publication paths as resolvable strings. Catalogs own the vocabulary behind
those strings. Operator distributions make catalog entries available in a Space,
attach implementation bindings, and expose account-plane APIs such as billing,
OIDC, dashboards, and deploy facades.

## AppSpec

AppSpec root fields:

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
```

`components` contains one or more named components.

Component fields:

The short kind below assumes an operator profile has activated an alias from the
Takosumi official type catalog. A compatible operator can require a URI instead.

```yaml
components:
  web:
    kind: worker
    spec: {}
    publish: {}
    listen: {}
```

| Field     | Core meaning                                              |
| --------- | --------------------------------------------------------- |
| `kind`    | Opaque string resolved by the operator distribution.      |
| `spec`    | Open object owned by the selected kind descriptor.        |
| `publish` | Component-local publication names and material contracts. |
| `listen`  | Component-local binding names and source references.      |

## Publish / Listen

`publish` declares material produced by a component. `listen` consumes material
from another publication.

This example uses operator profile aliases for kind names (`postgres`, `worker`)
and compact official catalog terms for material/projection names
(`service-binding`, `secret-env`). The shape of `publish` and `listen` is core;
the meanings of those catalog terms live in the official type catalog.

```yaml
components:
  db:
    kind: postgres
    publish:
      connection:
        as: service-binding

  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: secret-env
```

`listen.<binding>.from` uses one plain dotted reference grammar:

| Shape                        | Resolution                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `component.publication`      | Same-AppSpec component publication. Exactly two segments.                                                             |
| `publisher.area.name[.more]` | Space-visible external publication. Three to eight segments; see [External Publications](./external-publications.md). |

Map keys for component names, publication names, and listen binding names do not
contain `.`, so the two forms are unambiguous at parse time. AppSpec uses plain
dotted names for both forms.

External publications participate in the same listen system as component
publications. The core specification defines the path grammar and resolution
semantics. External publication publisher roots and concrete paths are defined
by operator or product distribution specs. The selected declaration's material
contract is selected from the Takosumi official type catalog or another
operator-adopted catalog.

## Installer API

The public Installer API is five Installation-centered endpoints:

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

These five endpoints are the portable write lifecycle. A compatible operator
also exposes the documented read projection needed for Installation
list/inspect, Deployment history, async polling, and rollback target selection.
That read projection belongs to the operator distribution or reference
implementation profile and follows the minimum semantics in
[Status And Read Surfaces](./status-output.md).

Source input kinds:

| Kind       | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `git`      | Remote git source. Apply guard uses resolved commit + `manifestDigest`.                     |
| `prepared` | Remote prepared source archive. Apply guard uses archive payload digest + `manifestDigest`. |
| `local`    | Kernel-local source tree for dev/operator-local use. Apply guard uses `manifestDigest`.     |

`manifestDigest` is the sha256 of the raw `.takosumi.yml` bytes. For prepared
source, the kernel computes the sha256 of the archive payload it fetched.
Prepared source is a core source kind; the concrete archive payload format is an
operator build-service capability, while archive root/path-safety rules and the
payload digest guard are Installer API contract. `local` source has no portable
source byte identity, so deploy dry-run / apply must provide `source` instead of
omitting it. Build commands, build graph nodes, cache keys, and provenance
records belong to the build service or operator automation, not the core
Installer API.

## Layer Split

| Layer                          | Defines                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Takosumi core                  | AppSpec envelope, publish/listen grammar, Installation / Deployment, Installer API, source/digest guards.                 |
| Takosumi official type catalog | Reusable kind descriptor documents, material contract shapes, projection-family names, and JSON-LD catalog metadata.      |
| Operator distribution          | Which descriptors, material contracts, external publications, account-plane APIs, and providers are available in a Space. |

Concrete workload external publication paths and account-plane API/facade
identifiers belong to operator distribution specs. Start from the local
[Takosumi Cloud](./takosumi-cloud.md) page for the Takosumi Cloud distribution.

## Related Pages

- [AppSpec](./app-spec.md)
- [Specification Boundaries](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [External publications](./external-publications.md)
- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
