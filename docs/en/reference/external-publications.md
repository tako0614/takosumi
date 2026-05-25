# Platform Services {#platform-services}

Platform services are outputs offered by an operator or product
distribution outside the manifest. Workloads consume them through the same
`listen` mechanism used for same-manifest component outputs.

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

Core defines the dotted path grammar and exact-match resolution behavior. Operator
distribution specs define the concrete platform service paths and visibility policy. The
output type comes from the Kind Catalog or another
operator-adopted catalog.

## Reference Grammar {#reference-grammar}

`listen.<binding>.from` uses one dotted reference grammar.

| Shape                        | Meaning                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `component.publication`      | Published output in the same manifest. Two segments.       |
| `publisher.area.name[.more]` | Platform service path. Three or more segments.             |

Platform service path grammar:

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

Rules:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- no empty segments
- the first segment is the publisher root

## Publisher Root {#publisher-root}

The first segment identifies the distribution or organization that offers the
path. Root naming and path inventory belong to the distribution spec. The
Installer resolves a valid path against the list of available services
visible in the target Space.

Only one active visible entry may exist for a platform service path in a Space.
Duplicate visible entries fail apply with 409 before resource creation.

Common publisher roots are ordinary distribution choices:

| Publisher root | Provided by                      | Example path              |
| -------------- | -------------------------------- | ------------------------- |
| `operator`     | Operator configuration           | `operator.identity.main`  |
| `takos`        | Product distribution catalog     | `takos.memory.default`    |
| `acme`         | Organization or private operator | `acme.database.reporting` |

Root enablement is operator configuration state. A Space has one active owner for a
root. Operator configurations can add explicit delegation rules when shared ownership
is intentional.

## Resolution {#resolution}

Resolution is Space-scoped:

1. The operator gathers platform service entries visible to the target
   Space.
2. Active visible entries are unique by `(Space, publicationPath)`.
3. A three-or-more-segment `listen.from` value is resolved by exact path match.
4. The selected service state is recorded in the Deployment record.
5. If the path is absent and `required: true`, apply fails before resource
   creation.
6. If the path is absent and `required` is omitted or false, the connection is
   absent.

Output type, sensitivity level, and access metadata come from the Kind Catalog
and operator policy. How values are delivered comes from the manifest `listen.as`.

If an optional connection is absent and a kind-specific `spec` field references
that connection, the adopted kind definition must define the degraded behavior and the
operator records that decision in the Deployment record.

## Service Entries And Output Data {#declaration-and-material}

Core resolves dotted `listen.from` paths. Catalogs provide output type vocabulary
and access metadata. Operator or product distribution specs define publisher
roots and concrete platform service paths.

An operator implementation can store records like:

```yaml
PlatformServiceDeclaration:
  snapshotId: pubsnap_...
  publicationPath: publisher.area.name
  spaceId: space_acme_prod
  materialContract: some.material@v1
  sensitivity: restricted
  accessModes: [read, invoke-only]
  safeDefaultAccess: null
```

```yaml
PublicationMaterialization:
  linkId: link_inst_abc_binding
  publicationSnapshotId: pubsnap_...
  publicationPath: publisher.area.name
  endpointRefs: []
  secretRefs: []
  authorizationRefs: []
```

Public Deployment output exposes only the non-secret output fields defined by
the [Installer API](./installer-api.md#deployment). Raw credentials stay behind
operator-approved secret delivery.

## Catalog And Operators {#catalog-and-operators}

- The Kind Catalog defines reusable output type vocabulary such as
  `identity.oidc@v1`.
- Operator configurations decide which concrete platform service paths are visible in
  a Space.
- Product distributions can publish product-specific paths under their own root.
- Takosumi Cloud defines its concrete platform service paths in its Cloud
  distribution spec.

## Related Pages {#related-pages}

- [Core Specification](./core-spec.md)
- [Manifest](./manifest.md)
- [Access Modes](./access-modes.md)
- [Kind Catalog](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
