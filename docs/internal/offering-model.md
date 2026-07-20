# Generic Offering model

Status: target contract, Core engine, immutable D1/Postgres catalog,
operator API, Worker composition port, platform bridge, and exact built-in
Form subject adapter implemented in OSS. Cloud commercial binding migration
and live evidence remain.

Takosumi owns one noncommercial Offering mechanism. Takoform is one possible
subject source; it is not the Offering catalog's type system. A host can offer
another service only by installing a resolver for its own namespaced subject
type.

```text
immutable OfferingCatalog
  -> exact Offering id/version
  -> open subject type/ref/version/digest
  -> explicit requirement refs
  -> explicit audience
  -> installed subject resolver
  -> exact resolution fingerprint
  -> OfferingSelection
```

There is no `latest` lookup or fallback resolver. An unknown subject type,
inactive row, denied audience, missing/stale requirement, unavailable subject,
or non-digest resolution result fails closed. Empty catalogs are valid, so
plain OpenTofu and zero-form Takosumi do not depend on this feature.

## Durable catalog and operator API

OSS persists immutable catalog snapshots in D1 migration v50 and Postgres
migration v97. A `(catalog id, catalog version)` can be published
idempotently only when its complete content is unchanged; substitution returns
a conflict. Selection fingerprints bind the full catalog row, exact reference,
resolver id, and subject-resolution fingerprint, so later host state cannot
reinterpret a previously selected version.

The deploy-control bearer protects the generic administration and evaluation
routes:

```text
POST /v1/offering-catalogs
GET  /v1/offering-catalogs
GET  /v1/offering-catalogs/:catalogId/versions/:catalogVersion
POST /v1/offering-availability/query
POST /v1/offering-selections/resolve
```

The request schemas reject unknown commercial/private fields. Catalog storage
and availability remain usable with no Form Registry and with any installed
namespaced subject resolver. A host-code catalog reader can be composed with
the durable store, but an exact id/version present in more than one authority
is ambiguous and fails closed.

## Subject ownership

A Form-backed subject uses:

```text
type:    forms.takoform.com/v1alpha1/Form
ref:     the complete encoded FormRef key
version: definitionVersion
digest:  packageDigest
requirement:
  takosumi.dev/v1alpha1/FormActivation + exact activation id/revision
```

The OSS Form resolver requires Workspace and exact Resource namespace context and re-reads the
exact activation revision, package/definition identity, principal audience,
canonical executable adapter/target availability, and an unchanged evidence
window before returning its resolution fingerprint. A different activation
cannot make the exact requested activation ready.

The Form resolver re-reads the installed package, exact FormRef,
FormActivation, implementation, target eligibility, and caller availability.
Other subject types install equivalent resolvers for their own authority. A
Capsule, provider-backed operator service, or protocol endpoint does not become
a Form merely because an operator offers it.

## Commercial composition

The OSS Offering record contains no manager, credentials, capacity, SKU,
price, currency, payment, invoice, quota, SLA, or support field. Takosumi Cloud
or another commercial operator may attach those fields to an exact
`OfferingSelection` in a separate commercial binding:

```text
OfferingSelection
  + implementation/manager/capacity readiness
  + SKU / PriceCatalog
  + quote / reserve / capture / usage / invoice
  = commercial service admission
```

That layer may reject a generically available Offering, but it cannot replace
the subject resolver, select another Offering implicitly, or create a second
Resource lifecycle ledger.

## Runtime and Resource boundary

An Offering is availability and selection state, not a Resource. Form-backed
control operations still converge on `/v1/resources`; plain Stack subjects use
their existing Capsule/Run path; service endpoints keep their own canonical
lifecycle. Runtime data-plane handlers resolve the selected Ready object and
its Interface/InterfaceBinding before backend access. They never create an
Offering or Resource implicitly.
