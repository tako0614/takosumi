# Platform Services {#platform-services}

Platform services are service material offered to a Space by an operator
distribution, account plane, product distribution, another Installation, or
another external provider. Components consume them with exact `listen.path` or
discover them with `listen.kind` and optional labels.

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

`connect` is for component output inside the same manifest. `listen` is for
Space-visible publications outside the manifest.

## Choosing The Shape {#choosing-the-shape}

| Goal                                           | Manifest shape               | Conflict rule                               |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------- |
| Name one known service exactly                 | `listen.path`                | One active provider per Space and path      |
| Use every visible MCP server or similar target | `listen.kind` + `many: true` | Pathless publications can have many matches |
| Discover exactly one publication               | `listen.kind` + labels       | Zero or multiple matches fail apply         |
| Use a component output in the same manifest    | `connect.output`             | Does not participate in Space-visible paths |

The AppSpec selector field is always `kind`. Components use `kind` to choose
what is created; publications and listeners use `kind` to choose material. The
word `type` stays in JSON Schema, JSON-LD `@type`, and TypeScript type names.

## Path Grammar {#path-grammar}

`listen.<binding>.path` is a dotted path for exact matches. It is not a URL
path; it is a publication name inside a Space.

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

Rules:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- no empty segments
- first segment `takosumi` / `system` and `_` prefixes are reserved

Paths such as `identity.primary.oidc` or `acme.database.reporting` resolve by
exact match. Add a path only when a publication needs a stable name. The field
distinguishes platform service paths from component outputs: component outputs
such as `db.connection` are written in `connect.output`; exact external services
are written in `listen.path`.

## Publication Kind And Discovery {#publication-kind-and-discovery}

`kind` is used for components and publications. Component `kind` answers "what
is created"; publication `kind` answers "what is offered".

```yaml
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server@v1
        many: true
        inject: config-mount
```

This example binds every visible `mcp-server@v1` publication in the Space as one
collection material. `labels` narrows the selector. Without `many`, resolution
must produce exactly one match or apply fails. With `required: true`, zero
matches fail apply; with optional `many: true`, zero matches resolve to an empty
collection.

`mcp-server@v1` is an official catalog discoverable material kind. Takosumi
core does not special-case MCP; it treats it like any other material kind. When
a product or operator distribution offers MCP server publications in a Space,
AppSpec uses the same `listen.kind` mechanism to consume all visible matches or
a label-filtered set.

Collection discovery is the alternative to inventing paths. For MCP servers,
tool endpoints, helper services, and similar "give me all visible matches"
cases, publish pathless entries and let consumers select by `kind` plus optional
`labels`. A `many: true` collection preserves the individual publication
entries, the operator must order the collection deterministically, and the
Deployment record keeps the selected set. Operators must not silently truncate
matches. If a selector is too broad for policy or size limits, narrow it with
labels or fail apply before resources are created.

## Path Ownership {#path-ownership}

Path inventory, lifecycle, and ownership belong to the distribution or
organization that offers the path. Takosumi core handles grammar, reserved
prefix guards, and exact-match resolution. `takosumi.*` and `system.*` are
reserved platform/operator namespaces; each distribution spec defines the
concrete paths it publishes.

| Provider example                 | Example path              |
| -------------------------------- | ------------------------- |
| Account plane                    | `identity.primary.oidc`   |
| Billing provider                 | `billing.primary.default` |
| Organization or private operator | `acme.database.reporting` |

Takosumi Cloud or another operator distribution can publish its concrete paths
in its own distribution spec. Those paths are provider-owned Space-visible
service material, not additional Takosumi core concepts.

## Resolution {#resolution}

Resolution is Space-scoped:

1. The operator gathers platform service entries and publications visible to the
   target Space.
2. Active visible entries with paths are unique by `(Space, path)`.
3. `listen.path` resolves by exact match.
4. `listen.kind` selects visible publications by kind and labels.
5. The selected service state and materialization evidence are recorded with the
   Deployment.
6. If an exact path or discovery target is absent and `required: true`, apply
   fails before resource creation.
7. If an exact path is absent and `required` is omitted or false, the binding is
   not created.
8. If `many: true` discovery has zero matches and `required` is omitted or
   false, it resolves to an empty collection material.

If a kind-specific `spec` treats an absent optional binding as required input,
apply fails. Degraded behavior is valid when the adopted kind definition and
operator record describe that behavior.

## Path Uniqueness And Conflict {#path-uniqueness-and-conflict}

For one platform service path in one Space, there is at most one active
provider. This only constrains publications that declare a path. Publications
without a path are candidates for `kind` / `labels` discovery, and many entries
can share the same `kind`. `listen.path` resolves by exact match, so Takosumi
does not choose between two active entries by priority.

The active entry owner is the distribution, Installation, or operator record
currently offering that path. For entries projected from root `publish`, the
owner includes at least `spaceId`, `installationId`, the `publish` name, and the
source output. A new Deployment from the same owner Installation is an update to
the same service.

Conflicts are evaluated only for exact paths. Multiple publications with the
same `kind` are not a conflict. Takosumi does not add a separate `type`
selector; component and publication classification both use `kind`.

| Situation                                        | Rule                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| One AppSpec repeats the same root `publish.path` | Reject during AppSpec validation.                                                                 |
| Same Installation redeploys the same path        | Replace the current projection with the new Deployment output. The old snapshot becomes inactive. |
| Same Installation removes root `publish`         | Turn off the active projection owned by that Installation. Keep Deployment history.               |
| Same Installation changes the path               | Turn off the old path and activate the new path. If the new path is already active, fail.         |
| Different Installation publishes the same path   | Treat as conflict. Do not turn off the existing owner automatically.                              |
| Multiple publications have no path               | Not a conflict. They are candidates for `listen.kind` + `labels` selectors.                       |
| `listen.kind` matches many and `many` is omitted | Fail apply. Narrow by labels/path or set `many: true`.                                            |
| `listen.kind` matches many with `many: true`     | Bind every matching publication as one collection material.                                       |
| Workload publishes an operator-reserved path     | Reject as a policy violation.                                                                     |
| Rollback tries to reactivate an earlier path     | Activate if the path is free. If another owner is active, rollback/projection conflicts.          |
| Installation is deleted or disabled              | Turn off active projections owned by that Installation.                                           |

Conflict resolution is explicit: the existing owner removes root `publish`, the
Installation is disabled/deleted, or an operator/admin performs a deliberate
transfer or disable operation. An AppSpec cannot take over another owner's
active entry by declaring the same path.

When an operator projects root `publish` declarations into the Space-visible
inventory, projection is a compare-and-set on `(Space, path)`. If two applies
try to activate the same path concurrently, only one succeeds; the other fails
or is marked blocked as a conflict. In every case, `listen.path` sees at most
one active entry.

## Service Material {#service-material}

A platform service entry has material shape, sensitivity, and access metadata.
Material vocabulary comes from the official catalog or another operator-adopted
catalog. Credentials, endpoints, and authorizations are materialized by the
operator implementation.

Example implementation records:

```yaml
PlatformServiceDeclaration:
  snapshotId: svcsnap_...
  path: identity.primary.oidc
  spaceId: space_acme_prod
  kind: identity.oidc@v1
  sensitivity: restricted
```

```yaml
PlatformServiceMaterialization:
  linkId: link_inst_abc_identity
  declarationSnapshotId: svcsnap_...
  path: identity.primary.oidc
  endpointRefs: []
  secretRefs: []
  authorizationRefs: []
```

Public Deployment output returns only the non-secret fields defined by the
[Installer API](./installer-api.md#deployment). Raw credentials stay in operator
secret delivery.

## Related Pages {#related-pages}

- [Core Specification](./core-spec.md)
- [Manifest](./manifest.md)
- [Access Modes](./access-modes.md)
- [Official Catalog](./catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
