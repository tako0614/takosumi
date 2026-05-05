# Target Model

An ObjectTarget defines the surface and lifecycle expectations of an Object. It
is not decomposed into separate public fields.

## Public resource target

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/cloudflare-workers"
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
```

Public v1 does not expose a separate top-level `target` field. A resource target
is the pair of `resources[].shape` and `resources[].provider`, resolved against
the catalog, provider registry, and policy allowed for the current Space.

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

### Target selection algorithm

Resolution uses a deterministic, fail-closed pipeline. The first step that
yields exactly one allowed candidate wins. Any step that yields zero or
more-than-one candidate fails resolution.

```text
1. Catalog alias lookup
   The public manifest value (e.g. `cloudflare-workers`) must resolve to
   exactly one descriptor in the CatalogRelease adopted by the current
   Space.

2. Concrete match in Space
   If the descriptor is concrete and the Space allows it, resolution
   succeeds with that descriptor.

3. Abstract fallback by profile
   If the descriptor is abstract, the profile order is consulted. The
   first concrete candidate that the Space policy allows wins.

4. Composite expansion
   If the descriptor is composite, it expands into a graph of objects,
   links, exports, and exposures. Each child enters this same pipeline at
   step 1.

5. Fail-closed
   If no step has produced a single allowed concrete descriptor,
   resolution fails. v1 has no graph search, no operator override at
   resolution time, and no catalog escape hatch.
```

## Input schema

Target input validation validates `resources[].spec` against the Shape contract
selected by `resources[].shape` and the provider's declared support.

```text
JSON-LD / descriptor:
  identity and semantic relations

Input schema:
  shape validation for `spec`

Policy:
  allow / deny / approval

Implementation verify:
  external consistency and smoke checks
```

## Mutation constraints

A target's mutation behavior is one of the closed v1 constraint kinds below.
Each constraint declares which lifecycle classes from
[Object Model](./object-model.md) may use it. New constraint kinds require an
RFC (CONVENTIONS.md §6).

| mutation-constraint | semantics                                                            | allowed lifecycle classes    |
| ------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `immutable`         | object cannot change after create; replace required for any mutation | managed, generated           |
| `replace-only`      | every mutation creates a new object and revokes the previous one     | managed, generated           |
| `in-place`          | every mutation updates the same object identity                      | managed, generated, imported |
| `append-only`       | mutations may only add; existing fields cannot change or be removed  | managed, generated, imported |
| `ordered-replace`   | replaces are serialized; no concurrent replaces in one Space         | managed, generated           |
| `reroute-only`      | object identity is fixed; mutations only re-point traffic / handles  | external, operator, imported |

`external` and `operator` lifecycle classes only ever take `reroute-only`
mutations because their identity is owned outside Takosumi.

Mutation constraints are descriptor metadata. The runtime operations that
realize them are issued by the
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
and bounded by [Object Model — Revoke participation matrix](./object-model.md).

## Access mode enum

`access` on a Link declaration is one of the closed v1 modes below. This is the
canonical home for the access vocabulary;
[Link and Projection Model](./link-projection-model.md) and
[Namespace Export Model](./namespace-export-model.md) reference it without
redefining.

```text
read         observation only; no grant material is generated
read-write   read plus mutation rights on the export's resource
admin        full management of the export's resource
invoke-only  may call the resource but cannot read or mutate underlying state
observe-only may only receive notifications / metrics; no resource access
```

`safeDefaultAccess` on an export declaration may pick a default from this set.
New access modes require an RFC (CONVENTIONS.md §6).

## Space-specific availability

A target alias may exist in the operator catalog but still be unavailable in a
Space. Target resolution requires both catalog alias resolution and Space policy
permission.
