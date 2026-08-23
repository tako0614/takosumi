# Generic Offering model

This is the current generic OSS Offering contract. It is independent of
Takoform and remains usable when no Form package or host is installed.

An Offering is an immutable availability and selection projection, not a
Resource or a second lifecycle ledger:

```text
immutable OfferingCatalog
  -> exact Offering id/version
  -> namespaced subject type/ref/version/digest
  -> explicit requirements and audience
  -> host-installed subject resolver
  -> exact resolution fingerprint
  -> OfferingSelection
```

There is no `latest` lookup, implicit fallback, commercial field, or implicit
provider choice. Unknown subjects, stale requirements, denied audiences, and
non-digest resolutions fail closed. Empty catalogs are valid, so the ordinary
Git/OpenTofu flow never depends on an Offering.

## OSS operator surface

The deploy-control bearer protects the generic catalog and selection routes:

```text
POST /internal/v1/offering-catalogs
GET  /internal/v1/offering-catalogs
GET  /internal/v1/offering-catalogs/:catalogId/versions/:catalogVersion
POST /internal/v1/offering-availability/query
POST /internal/v1/offering-selections/resolve
```

These routes carry generic namespaced subjects. They do not install Forms,
activate Forms, select a TargetPool, or publish commercial capacity. A host
composition may provide a resolver for its own subject type; duplicate exact
catalog authorities are ambiguous and fail closed.

## Ownership and Cloud composition

Takoform may be one subject source, but its portable schema/package/provider
authority remains external. A Form-backed subject is valid only when an
external Host can prove its own exact package, implementation, activation, and
principal-audience state; those checks are not an OSS Form Registry or
FormActivation contract.

Takosumi hosted service may attach implementation, capacity, SKU, price, quota, billing,
SLA, and support to an exact `OfferingSelection` in its closed commercial
binding. That binding cannot replace the OSS subject resolver, select another
Offering implicitly, or create a second Resource lifecycle.

Plain Stack resources continue through their OpenTofu Run. Interfaces and
InterfaceBindings authorize runtime access independently of Offering state.
