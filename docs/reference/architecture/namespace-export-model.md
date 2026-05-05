# Namespace Export Model

Exports are namespace-addressable usable surfaces. Namespace paths are resolved
inside a Space. Producers publish export declarations; link materialization
produces export material.

## Namespace path grammar

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- max segments: 8
- max path length: 255
- component names are single segments
- empty segments are invalid
- `default` is allowed only as an export leaf
- reserved namespace prefixes are operator-controlled and Space-visible only
  when granted by operator policy

Reserved prefixes:

```text
takos
operator
system
```

## ExportDeclaration vs ExportMaterial

### ExportDeclaration

The declaration says what can be used.

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  path: takos.database.primary
  spaceId: space:acme-prod
  scope: environment:prod
  owner:
    kind: external-participant
    id: db-platform
  descriptorDigest: sha256:...
  sensitivity: secret | restricted | public
  defaultProjection: null
  projectionVariants: []
  effectFamilies:
    - grant
    - secret
  effectDetails: {}
  accessModes:
    - read
    - read-write
  safeDefaultAccess: null
  freshness:
    state: fresh | stale | revoked | unknown
    observedAt: ...
```

### ExportMaterial

The material is produced by link materialization.

```yaml
ExportMaterial:
  linkId: link:api.DATABASE_URL
  exportSnapshotId: export-snapshot:...
  secretRefs: []
  endpointRefs: []
  grantHandles: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution stores declarations. OperationJournal and observations track
material.

## Default export

Bare namespace paths expand to `.default` only if the default export exists.

```text
billing -> billing.default
```

Default exports must not imply admin access. Grant-producing defaults require
`safeDefaultAccess` to be used without explicit access. `read-write` and `admin`
are never implicit.

## Space-scoped namespace resolution

Namespace resolution always happens inside a Space. The same path in another
Space is a different subject unless explicitly shared.

```text
1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace, if defined by the Space
5. space namespace
6. operator namespace granted to the Space
7. external participant namespace registered into the Space
8. explicitly shared namespace imports from another Space
```

Shadowing is policy-gated. Production should deny or require approval for
meaningful shadowing, especially when a local namespace shadows a Space,
operator, or external namespace.

## Space export sharing

Cross-space namespace use is denied by default. To use an export from another
Space, the operator must create a Space export share or namespace import.

```yaml
SpaceExportShare:
  fromSpaceId: space:platform
  toSpaceId: space:acme-prod
  exportPath: takos.oauth.token
  exportSnapshotId: export-snapshot:...
  allowedAccess:
    - read
    - call
```

ResolutionSnapshot records the share. Plan output must mark cross-space use as a
risk.

## Freshness

```text
fresh:
  usable

stale:
  policy decides allow-with-warning, require-refresh, or deny

revoked:
  deny

unknown:
  policy decides require-refresh or deny
```
