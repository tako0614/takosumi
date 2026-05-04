# Link and Projection Model

`uses` creates Link intent. A Link connects a consumer slot to an ExportDeclaration snapshot inside one Space.

## Link record

```yaml
Link:
  spaceId: space:acme-prod
  id: link:api.DATABASE_URL
  consumer: object:api
  slot: DATABASE_URL
  sourceExportSnapshotId: export-snapshot:takos.database.primary@...
  sourceSpaceId: space:acme-prod
  access: read-write
  selectedProjection:
    family: secret-env
    name: DATABASE_URL
    updateBehavior: restart-required
  effectFamilies:
    - grant
    - secret
  effectDetailsDigest: sha256:...
  selectedImplementation: implementation:...
  policyDecisionRefs: []
```

ProjectionSelection is a Link field, not a public manifest object.


## Space rule

A Link normally connects a consumer Object to an ExportDeclaration in the same Space. Cross-space links are denied unless the ResolutionSnapshot records an explicit SpaceExportShare or operator-approved namespace import.

Cross-space links must appear in plan risk output and approval binding.

## Projection families

```text
env
secret-env
file-secret
runtime-capability
sdk-config
http-client-config
service-endpoint
volume-mount
```

Secret exports must not project to plain `env`.

## Access defaults

Grant-producing exports require explicit `access` unless the export declares `safeDefaultAccess`.

```yaml
uses:
  DATABASE_URL:
    use: takos.database.primary
    access: read-write
```

## Link mutation

```text
rematerialize:
  same source / access / projection, refresh material

reproject:
  projection changes

regrant:
  access mode or grant details change

rewire:
  source export changes

revoke:
  link removed

retain-generated:
  generated material retained with approval
```

## Link materialization states

```text
pending
materializing
materialized
stale
rematerializing
revoking
revoked
failed
debt
```

## Collision rules

If a Link projection would collide with a literal target input field, environment variable, runtime binding, mount path, or reserved target name, resolution fails unless a future explicit override mechanism is added. Public v1 has no override.
