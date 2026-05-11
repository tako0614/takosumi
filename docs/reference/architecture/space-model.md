# Space Model

`Space` is the top-level isolation boundary for Takosumi v1.

A manifest does not declare a Space. The deploy / preview / apply request is
executed in a Space chosen by actor auth, API path, operator context, or CLI
profile. The same manifest may be resolved differently in different Spaces
because each Space has its own namespace scope, policy, allowed catalog
releases, secrets, artifacts, approvals, journals, observations, and GroupHeads.

## Space root rule

```text
Space is the boundary of meaning, authority, and ownership.
```

Every `Deployment`, `ResolutionSnapshot`, `DesiredSnapshot`, `OperationJournal`,
`ObservationSet`, `RevokeDebt`, `ActivationSnapshot`, approval, and `GroupHead`
belongs to exactly one Space.

```yaml
Space:
  id: space:acme-prod
  displayName: Acme Production
  defaultCatalogReleaseId: catalog-release-2026-05-04.1
  allowedCatalogReleaseIds:
    - catalog-release-2026-05-04.1
  policyPack: prod/strict
  namespaceRegistryDigest: sha256:...
  secretPartition: space:acme-prod
  artifactPartition: space:acme-prod
```

## Space vs namespace

A namespace path is a name inside a Space-scoped namespace table.

```text
takos.oauth.token
billing.default
takos.database.primary
```

The same namespace path in two Spaces is not the same ExportDeclaration unless
both Spaces explicitly import or share the same export snapshot.

```text
space:acme-prod / takos.database.primary
space:acme-dev  / takos.database.primary
```

These are separate resolution subjects.

## Address qualification

Canonical records carry `spaceId` as part of identity. Text addresses may be
rendered either as a tuple or as a qualified address.

```text
(space:acme-prod, object:api)
space:acme-prod/object:api
space:acme-prod/link:api.DATABASE_URL
```

The tuple form is preferred for storage. The qualified string is useful for
logs, plan output, and audit events.

## Namespace scope stack

Resolution happens inside a Space. The resolver checks scopes in this order:

```text
1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace, if the Space defines environments
5. space namespace
6. operator namespace granted to this Space
7. reserved: external participant namespace registered into this Space
8. reserved: explicitly shared namespace imports from another Space
```

If a namespace path exists in multiple scopes, the first matching scope wins
only when shadowing policy allows it. Production policy should deny or require
approval for meaningful shadowing.

## Reserved prefixes

Reserved prefixes are global names, but visibility is still Space-scoped.

```text
takos
operator
system
```

Only the operator may publish these prefixes. A reserved export such as
`takos.oauth.token` must still be granted or made visible to the Space before
resolution can use it.

## External participant registration

External participants register exports into a Space or into an operator
namespace that is explicitly granted to Spaces.

```yaml
ExternalNamespaceRegistration:
  spaceId: space:acme-prod
  path: takos.database.primary
  owner:
    kind: external-participant
    id: db-platform
  exportSnapshotId: export-snapshot:...
  freshness:
    state: fresh
```

External participant publishing is reserved vocabulary for a future RFC. Current
v1 dependencies must not require it.

## Cross-space links

Cross-space links are denied by default and are not a current v1 dependency.
`SpaceExportShare` and operator-approved namespace imports are reserved
vocabulary for a future RFC.

```yaml
SpaceExportShare:
  fromSpaceId: space:platform
  toSpaceId: space:acme-prod
  exportPath: takos.oauth.token
  exportSnapshotId: export-snapshot:...
  allowedAccess:
    - read
    - call
  expiresAt: optional
```

If a future RFC enables this vocabulary, resolution records the share in
`ResolutionSnapshot` and plan output must show cross-space usage as a risk.

## SpaceExportShare lifecycle

A future SpaceExportShare progresses through this reserved state machine:

```text
draft → active → refresh-required → stale → revoked
              ↘ revoked
```

| state              | meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `draft`            | operator created the share but has not activated it; consumers cannot resolve it                                    |
| `active`           | the share is usable; consumer Spaces resolve and link normally                                                      |
| `refresh-required` | the export snapshot or signing key is approaching its TTL; resolution still succeeds, plan output shows the warning |
| `stale`            | the TTL elapsed before refresh; resolution surfaces the `stale-export` Risk and then fails closed                   |
| `revoked`          | operator removed the share; new resolutions are denied and existing material enters cleanup                         |

Refresh / TTL rules:

- Each share carries an `expiresAt` and an operator-controlled refresh policy.
  Approaching the TTL transitions `active → refresh-required`.
- A successful refresh returns the share to `active`. A missed refresh
  transitions to `stale`.
- Both `stale` and `revoked` queue cleanup of dependent generated material per
  the
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md);
  unsuccessful cleanup produces RevokeDebt with
  `reason: cross-space-share-expired`.
- `stale-export` and `revoke-debt-created` are part of the closed Risk enum in
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md).

## Space-owned data boundaries

A Space owns or selects the following partitions:

```text
namespace registry visibility
secret-store partition
artifact visibility / retention policy
operation journals
observation sets
audit event partition
approvals and policy decisions
group heads and activation history
external participant registrations
```

Space isolation does not mean all data is physically stored in a separate
database. It means every read, write, resolution, and operation is scoped by
`spaceId` and policy.

## Group inside Space

A `Group` is a deployment stream inside a Space. `GroupHead` identity is:

```text
spaceId + groupId
```

Examples:

```text
space:acme-prod/group:web
space:acme-prod/group:api
space:acme-dev/group:web
```

GroupHead updates are serialized inside the owning Space. A Group cannot become
current in another Space.

## Space invariants

```text
Space containment invariant:
  No Deployment may resolve, materialize, activate, observe, or destroy outside its Space. SpaceExportShare / operator import escape hatches are reserved for future RFCs.

Namespace isolation invariant:
  Namespace paths are Space-scoped. Same path in different Spaces is not the same export by default.

Secret isolation invariant:
  Secret references created for a Space must not be projected into another Space unless an explicit share policy allows it.

Artifact isolation invariant:
  DataAsset visibility is Space-scoped unless operator artifact policy allows sharing.

Journal isolation invariant:
  OperationJournal entries belong to one Space and must not be used as recovery authority in another Space.

Activation isolation invariant:
  ActivationSnapshot and GroupHead updates are Space-local.
```

## Minimal example

The manifest does not mention Space.

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: api
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    spec: { version: "16", size: small }

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:...
      port: 8080
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
```

When applied in `space:acme-prod`, the resource graph, selected providers,
output refs, policies, secrets, artifacts, and GroupHead all resolve against the
production Space.

```text
space:acme-prod/takos.database.primary
```

When applied in `space:acme-dev`, the same manifest resolves against the
development Space.

```text
space:acme-dev/takos.database.primary
```
