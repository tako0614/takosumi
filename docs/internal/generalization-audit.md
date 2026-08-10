# Generalization and Product-Boundary Audit

Status: current audit against the [Core Spec](./core-spec.md). This is a
verification note, not a second product contract. The Core Spec owns the
current route and ownership decisions.

## Current boundary

Takosumi OSS is a provider-neutral Git/OpenTofu/Terraform control plane. Its
supported deployment path is one Stack flow:

```text
Git source and module
  -> Workspace / Project / Capsule
  -> ProviderConnection / CredentialRecipe / ProviderBinding
  -> guarded Run
  -> encrypted StateVersion and ordinary Output
  -> AuditEvent and explicit Interface / InterfaceBinding
```

The module and its provider configuration choose what is deployed. Takosumi
does not ship a first-party provider, a Takosumi DSL, or a second desired-state
ledger.

Takoform owns portable Form definitions, FormRef and package publication,
provider releases, and conformance. A Takosumi Cloud deployment or another
external Host owns hosted Form instances, the Form Host lifecycle, backend
implementations, targets, capacity, billing, SLA, support, and abuse controls.
An external Host therefore owns the Form lifecycle; historical package or
Resource data in OSS does not create or activate a Form.

## Generalization checks

The current implementation is conformant only when all of the following hold:

- Provider behavior comes from the module, an explicit provider binding, or an
  explicitly selected adapter. Vendor names, URLs, Output names, and display
  metadata do not select behavior.
- `Run`, `StateVersion`, and `Output` remain the only Stack execution records.
  Plan, apply, destroy, and refresh are Run operations, not extra ledgers.
- Outputs are ordinary module values. Runtime or service connections require
  an explicit Interface and InterfaceBinding; no reserved Output name becomes
  a registry, credential channel, or lifecycle command.
- Provider credentials arrive only through the run-scoped
  `ProviderConnection` / `CredentialRecipe` / `ProviderBinding` path. Secret
  values do not enter specs, Outputs, logs, audit records, or discovery.
- Cloud-specific capacity, pricing, payment, SLA, and support stay in the
  one-way Cloud extension or another external Host. OSS does not infer an
  offering from a package, provider, or catalog entry.
- Empty extension catalogs are valid. Adding or removing an extension does not
  create a second deployment or reconciliation lifecycle.

## Retained Resource/Form data

The old Resource Shape, Form Host, TargetPool, SpacePolicy, and related rows are
retained only as migration data. They are not current OSS authoring or release
authority. OSS may keep the bytes and metadata needed to observe, delete, or
perform an exact operator migration; the retained rows do not give OSS control
of a Form or its backend.

The platform edge returns `404` for the legacy surface by default. An operator
may enable the bounded drain with
`TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1` together with the authenticated
control-plane token and database. While the drain is enabled, the implemented
legacy actions are limited to:

| Legacy area | Allowed action |
| --- | --- |
| Resource collection and records | Authenticated `GET`/`HEAD` list/read/events, `POST` observe, and `DELETE` |
| TargetPool and SpacePolicy records | Authenticated `GET`/`HEAD` (including list) and `DELETE` |

Resource preview, apply, recover, import, and refresh; Resource/Form writes;
Form Registry and FormActivation operations; discovery; and TargetPool or
SpacePolicy writes remain unavailable. Unknown or disabled paths return `404`;
recognized retired operations return `410` while the drain is on. The drain
does not create a Form, select capacity, or change the supported Stack model.

## Review evidence

Reviewers should compare implementation and docs with the Core Spec, then run
the authoritative-doc, generalization-boundary, and import-boundary checks.
Any retained Resource/Form route must be classified as migration-only and
must not be described as a current lifecycle or provider authority.
