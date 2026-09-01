# Generalization and Product-Boundary Audit

Status: current audit against the [Core Spec](./core-spec.md) and target
[Architecture](./architecture.md). This is a verification note, not a second
product contract. Core Spec owns the current route and ownership decisions.

## Current boundary

Takosumi OSS is a customer BYOC, provider-neutral Git/OpenTofu/Terraform
control plane. Its supported deployment path is one Stack flow:

```text
Workspace/customer-owned vendor account
  -> ProviderConnection / CredentialRecipe / ProviderBinding
  -> StackCatalog (Workspace / Project / Capsule / Git Source / Snapshot)
  -> RunAuthority (review / lease / mutation fence)
  -> CredentialBroker (run-scoped materialization)
  -> Executor (one immutable Run envelope)
  -> ArtifactLedger (state / Output / audit / result)
```

The module and its provider configuration choose what is deployed. Takosumi
does not ship a first-party provider, a Takosumi DSL, a hidden vendor branch,
or a second desired-state ledger. Takoserver is not in the customer BYOC path.

An optional Takoform provider call to a Takoserver Host is a separate
Host-owned-supply path. The Host owns its managed Offering, Form/Resource and
Deployment lifecycle, provider installation/backend, provider account and
credential, capacity/placement, receipt, Workers for Platforms namespace and
dispatcher, native identity, and commercial/support policy. Takosumi can carry
only the Host-scoped credential needed by that ordinary provider call; it does
not select or receive the Host's parent credential or implementation facts.
Takosumi Hosted is optional retail/commerce/client composition and does not own
managed supply. Takosumi Cloud is a retired historical identity.

## Generalization checks

The current implementation is conformant only when all of the following hold:

- Provider behavior comes from the module, an explicit ProviderBinding, or an
  explicitly selected adapter. Vendor names, URLs, Output names, and display
  metadata do not select behavior.
- StackCatalog is the sole catalog for Workspace/Project/Capsule/Source/
  Snapshot/discovery. `Run`, `StateVersion`, and `Output` remain the canonical
  execution records. Plan, apply, destroy, and refresh are Run operations, not
  extra ledgers.
- RunAuthority owns review, leases, the at-most-once Apply/Destroy fence,
  terminal commit, and indeterminate reconciliation. Executor receives one
  immutable approved envelope and cannot approve, schedule, retry, adopt, or
  move the current-state pointer.
- Provider credentials arrive only through the run-scoped
  `ProviderConnection` / `CredentialRecipe` / `ProviderBinding` path. Secret
  values do not enter specs, Outputs, logs, audit records, or discovery.
- ArtifactLedger stores immutable source/plan/state/Output/audit/result
  artifacts and digest-bound current-state updates. No observer or client may
  create a required lifecycle write without durable command intent.
- Cloud/Host-specific capacity, pricing, payment, SLA, and support stay in
  Takoserver or another external Host. Takosumi Hosted may compose retail/client
  presentation, but OSS does not infer an Offering from a package, provider, or
  catalog entry. Generic Offering is not Core authority.
- Empty or absent Host/extension composition is valid. Adding or removing an
  external Host does not create a second deployment or reconciliation lifecycle.
- Ordinary Worker deploy applies only to the Takosumi platform Worker. Managed
  customer `ModuleWorker` execution, Workers for Platforms namespaces, and
  dispatch belong to Takoserver Host, never to the Takosumi runner.

## Current conformance gaps

These findings must remain visible until the owning changes and evidence land:

| Gap | Why it matters | Required treatment |
| --- | --- | --- |
| Offering routes/stores/schema are still composed in parts of bootstrap/Worker | They imply an OSS catalog/selection authority that the target rejects | Disable new use; classify all rows, routes, fixtures, and callers as deletion/migration custody, then remove after inventory-zero and restore evidence. |
| Resource Shape, Form Registry/FormActivation, TargetPool, SpacePolicy, and Resource lifecycle remain in current composition | Retained implementation can be mistaken for supported authoring or Host authority | Freeze writes/discovery. Keep only the bounded authenticated drain for exact migration, then delete composition, schedulers, and storage in the safe order. |
| Existing controller/store/runner code crosses multiple lifecycle authorities | Callers can bypass command ordering and weaken recovery or fence semantics | Extract the five deep modules and narrow envelope; do not merge RunOwner/fence with RunnerObject/Executor. |
| Historical Cloud wording remains in neighboring material | It obscures Hosted versus Takoserver ownership | Name Takosumi Cloud only as retired history, Takosumi Hosted only for retail/client composition, and Takoserver for managed supply. |

## Retained Resource/Form/Offering data

The old Resource Shape, Form Host, TargetPool, SpacePolicy, Offering, and
related rows are retained only as migration data. They are not current OSS
authoring or release authority. OSS may keep the bytes and metadata needed to
observe, delete, or perform an exact operator migration; retained rows do not
give OSS control of a Form, Offering, backend, or capacity.

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
Form Registry and FormActivation operations; discovery; Offering selection;
and TargetPool or SpacePolicy writes remain unavailable. Unknown or disabled
paths return `404`; recognized retired operations return `410` while the drain
is on. The drain does not create a Form, select capacity, mint an Offering, or
change the supported Stack/Interface model.

## Review evidence

Reviewers should compare implementation and docs with the Core Spec and
Architecture, then run the authoritative-doc, generalization-boundary, and
import-boundary checks. Any retained Resource/Form/Offering route must be
classified as migration-only and must not be described as a current lifecycle,
provider, catalog, or Host authority.
