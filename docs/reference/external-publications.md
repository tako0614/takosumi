# External Publications {#external-publications}

External publication is the core mechanism for letting material from outside the
AppSpec participate in the same `publish` / `listen` system as component-local
publications.

An AppSpec author writes the publication path directly in
`listen.<binding>.from`:

This example assumes an operator profile maps the short `worker` alias to an
adopted descriptor.

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

External publications use the same dependency language as component-local
publications: a publisher makes a path visible to the Space, and a component
listens to that path.

## Reference Grammar

`listen.<binding>.from` uses one plain dotted reference grammar:

| Shape                        | Meaning                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `component.publication`      | Same-AppSpec component publication. Exactly two segments. |
| `publisher.area.name[.more]` | External publication path. Three or more segments.        |

Component names and publication names cannot contain `.`, so a two-segment
reference and a three-or-more-segment external publication path are unambiguous.

External publication path grammar:

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

Rules:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- empty segment is invalid
- first segment is the publisher root

## Publisher Roots

The first segment names the distribution that offers the path. Core validates
the grammar and resolves the exact path in the target Space; distribution specs
own root naming and path inventory.

| Publisher root example | Owned by                         | Example path              |
| ---------------------- | -------------------------------- | ------------------------- |
| `operator`             | Operator distribution            | `operator.identity.main`  |
| `takos`                | Product distribution catalog     | `takos.memory.default`    |
| `acme`                 | Organization or private operator | `acme.database.reporting` |

Roots are Space-scoped. A Space has one active visible declaration for a given
publication path; duplicate visible declarations for the same path fail apply
with `409 failed_precondition`. Product distributions should document the roots
they publish and the material contracts behind those paths in their own
distribution/catalog docs.

Root adoption is operator-profile state:

- `operator` is the root owned by the active operator distribution for that
  Space.
- Product roots such as `takos` are visible only when the operator profile
  adopts that product distribution/catalog for the Space.
- Organization/private roots such as `acme` are owned by the account-plane or
  private operator policy that declares them.
- Two distributions cannot own the same root in one Space unless the operator
  profile defines an explicit delegation rule; ambiguous root ownership is a 409
  `failed_precondition` before materialization.

## Resolution

Resolution is Space-scoped. The same path in another Space can point to a
different declaration.

1. The operator gathers the external publication declarations visible to the
   target Space.
2. Active visible declarations must be unique by `(Space, publicationPath)`. If
   more than one declaration is visible for the same path, apply fails before
   provider side effects with `409 failed_precondition`; operator details may
   include a conflict/risk reason such as `shadowed-publication`.
3. A `listen.from` value with three or more segments is resolved by exact
   `publicationPath` match.
4. The selected declaration snapshot is recorded in retained
   implementation/operator evidence.
5. If the path is absent and `required: true`, apply fails before provider side
   effects.
6. If the path is absent and `required` is omitted or false, the binding is
   absent.
7. A kind-specific `spec` field that references an absent optional binding is
   invalid unless the adopted descriptor explicitly defines degraded behavior
   for that absent binding and records that degradation in retained
   implementation/operator evidence.

## Declaration And Material

Core resolves dotted `listen.from` paths: two segments for same-AppSpec
publications, three or more segments for Space-visible external publications.
Catalogs supply material vocabulary and access metadata. Operator or product
distribution specs define publisher roots and concrete publication paths, and
operator distributions materialize the selected declaration. Implementations
usually split "what can be used" from "what was materialized". The following
records are operator implementation examples, not additional Takosumi core
public entities:

```yaml
ExternalPublicationDeclaration:
  snapshotId: pubsnap_...
  publicationPath: publisher.area.name
  spaceId: space_acme_prod
  contractRef: some.material@v1
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
  grantHandles: []
```

`contractRef`, `sensitivity`, and `accessModes` come from a type catalog and
operator policy. The projection family is selected by AppSpec `listen.as`;
compatibility and detailed projection behavior come from catalog descriptor
metadata and operator policy. The implementation/operator ledger records the
selected declaration and materialization evidence when `listen` resolves an
external publication. Public Deployment output exposes only the non-secret
material fields defined by [Installer API](./installer-api.md#deployment).

## Relationship To Catalogs And Operators

- The Takosumi official type catalog defines reusable material vocabulary such
  as `identity.oidc@v1` in the
  [Official Type Catalog Specification](./type-catalog.md).
- An operator distribution decides which publication paths are visible in a
  Space.
- A product distribution can publish product-owned paths under its own root when
  it ships reusable product material or services.
- Takosumi Cloud defines its concrete publication paths in its own distribution
  specification. Start from [Takosumi Cloud](./takosumi-cloud.md).

## Related Pages

- [Takosumi Core Specification](./core-spec.md)
- [AppSpec](./app-spec.md)
- [Access Modes](./access-modes.md)
- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
