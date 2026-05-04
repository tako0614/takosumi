# Target Model

An ObjectTarget defines the surface and lifecycle expectations of an Object. It is not decomposed into separate public fields.

## Public target

```yaml
components:
  api:
    target: cloudflare-workers
```

The value is a catalog alias in public v1, resolved against the CatalogRelease allowed for the current Space.

## ObjectTarget descriptor

ObjectTarget descriptors define:

```text
input schema
accepted data asset kinds
possible exports
projection capabilities
operation capabilities
mutation constraints
implementation requirements
```

## Concrete, abstract, and composite targets

```text
concrete target:
  a specific object surface such as cloudflare-workers or aws-s3

abstract target:
  a selector resolved by profile and policy, not by open-ended graph search

composite target:
  declarative expansion into objects, links, exports, and exposures
```

v1 abstract target selection is deterministic and profile-order-first. If the profile cannot select a single allowed candidate, resolution fails.

## Input schema

Target input validation uses pinned input schema documents adopted by CatalogRelease.

```text
JSON-LD / descriptor:
  identity and semantic relations

Input schema:
  shape validation for `with`

Policy:
  allow / deny / approval

Implementation verify:
  external consistency and smoke checks
```

## Mutation constraints

Targets declare supported object mutations.

```text
no-op
update
replace
recreate
retain
orphan
delete
```

Immutable fields and default mutation behavior are target metadata.

## Space-specific availability

A target alias may exist in the operator catalog but still be unavailable in a Space. Target resolution requires both catalog alias resolution and Space policy permission.
