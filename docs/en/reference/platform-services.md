# Platform Services {#platform-services}

Platform services are service material offered to a Space by an operator
distribution, account plane, product distribution, or another external
provider. Components consume them with `listen.path`.

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

`connect` is for component output inside the same manifest. `listen` is for
Space-visible service material outside the manifest.

## Path Grammar {#path-grammar}

`listen.<binding>.path` is a dotted path.

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment "." segment "." segment ("." segment)*
```

Rules:

- minimum 3 segments
- maximum 8 segments
- maximum 255 characters
- no empty segments

Paths such as `identity.primary.oidc` or `acme.database.reporting` are resolved by
exact match. The field distinguishes platform service paths from component
outputs: component outputs such as `db.connection` are written in
`connect.output`; external services are written in `listen.path`.

## Path Ownership {#path-ownership}

Path inventory, lifecycle, and ownership belong to the distribution or
organization that offers the path. Takosumi core does not special-case path
prefixes; it handles grammar and exact-match resolution.

| Provider example                 | Example path              |
| -------------------------------- | ------------------------- |
| Account plane                    | `identity.primary.oidc`   |
| Billing provider                 | `billing.primary.account` |
| Organization or private operator | `acme.database.reporting` |

Takosumi Cloud or another operator distribution can publish its concrete paths
in its own distribution spec. Those paths are provider-owned Space-visible
service material, not additional Takosumi core concepts.

## Resolution {#resolution}

Resolution is Space-scoped:

1. The operator gathers platform service entries visible to the target Space.
2. Active visible entries are unique by `(Space, path)`.
3. `listen.path` resolves by exact match.
4. The selected service state and materialization evidence are recorded with the Deployment.
5. If the path is absent and `required: true`, apply fails before resource creation.
6. If the path is absent and `required` is omitted or false, the binding is not created.

If a kind-specific `spec` treats an absent optional binding as required input,
apply fails. Degraded behavior is valid when the adopted kind definition and
operator record describe that behavior.

## Path Uniqueness And Conflict {#path-uniqueness-and-conflict}

For one platform service path in one Space, there is at most one active
provider. `listen.path` resolves by exact match, so Takosumi does not choose
between two active entries by priority.

The active entry owner is the distribution, Installation, or operator record
currently offering that path. For entries projected from root `publish`, the
owner includes at least `spaceId`, `installationId`, the `publish` name, and the
source output. A new Deployment from the same owner Installation is an update to
the same service.

| Situation                                        | Rule                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| One AppSpec repeats the same root `publish.path` | Reject during AppSpec validation.                                                                 |
| Same Installation redeploys the same path        | Replace the current projection with the new Deployment output. The old snapshot becomes inactive. |
| Same Installation removes root `publish`         | Turn off the active projection owned by that Installation. Keep Deployment history.               |
| Same Installation changes the path               | Turn off the old path and activate the new path. If the new path is already active, fail.         |
| Different Installation publishes the same path   | Treat as conflict. Do not turn off the existing owner automatically.                              |
| Workload publishes an operator-reserved path     | Reject as a policy violation.                                                                     |
| Rollback tries to reactivate an earlier path     | Activate if the path is free. If another owner is active, rollback/projection conflicts.          |
| Installation is deleted or disabled              | Turn off active projections owned by that Installation.                                           |

Conflict resolution is explicit: the existing owner removes root `publish`, the
Installation is disabled/deleted, or an operator/admin performs a deliberate
transfer or disable operation. An AppSpec cannot take over another owner's
active entry by declaring the same path.

When an operator projects root `publish` declarations into the Space-visible
inventory, projection is a compare-and-set on `(Space, path)`. If two applies try
to activate the same path concurrently, only one succeeds; the other fails or is
marked blocked as a conflict. In every case, `listen.path` sees at most one
active entry.

## Service Material {#service-material}

A platform service entry has material shape, sensitivity, and access metadata.
Material vocabulary comes from the official type catalog or another
operator-adopted catalog. Credentials, endpoints, and authorizations are
materialized by the operator implementation.

Example implementation records:

```yaml
PlatformServiceDeclaration:
  snapshotId: svcsnap_...
  path: identity.primary.oidc
  spaceId: space_acme_prod
  materialContract: identity.oidc@v1
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
- [Official Type Catalog](./type-catalog.md)
- [Takosumi Cloud](./takosumi-cloud.md)
