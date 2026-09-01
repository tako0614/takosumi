# Takosumi target architecture

Status: current target and migration design. This document explains the
component boundary that the implementation must converge on; it is not a
release authorization and does not make an incomplete component conformant.
The [Core Spec](./core-spec.md) is the contract. The [Core Conformance](./core-conformance.md)
matrix records what is proven today.

## Product boundary

Takosumi is the customer BYOC control plane. A Workspace/customer owns the
vendor account and credential. A plain OpenTofu/Terraform module selects the
standard provider, and the complete credential path is:

```text
Workspace-owned ProviderConnection
  -> CredentialRecipe
  -> ProviderBinding
  -> run-scoped materialization
  -> standard provider in one approved Run
```

Takoserver is not in this path. Takosumi does not receive a Takoserver parent
provider credential, choose a Takoserver backend or capacity, install a
provider on Takoserver's behalf, select a Workers for Platforms namespace or
dispatcher, or mint a native managed-resource identity.

Optional host-owned supply is a separate boundary. A Takoform provider may call
an external Takoform Host with a Host-scoped credential. The Takoserver Host
owns the managed-service Offering, Form/Resource and Deployment lifecycle,
provider installation and backend, capacity and placement, provider receipts,
Workers for Platforms namespace/dispatcher, native identity, and
support/commercial policy. The provider sees the Host contract, not the
Takoserver parent credential. Takosumi Cloud is a retired historical identity;
Takosumi Hosted may compose optional retail, commerce, and client experiences,
but it does not own managed supply.

## Target component graph

```text
Dashboard / CLI clients
        |
Accounts / OIDC edge adapters
        |
  +-----v------------------------------------------------+
  |                 Takosumi Core                       |
  |                                                     |
  |  StackCatalog ----------> RunAuthority              |
  |  CredentialBroker -----> /     |      ^             |
  |                              approved  | terminal /  |
  |                              envelope  | indeterminate|
  |                                  v     | result      |
  |                               Executor-+             |
  |                                  |                   |
  |                     no ledger commit authority       |
  |                                                      |
  |  RunAuthority -- authorized commit / pointer CAS --> |
  |                          ArtifactLedger              |
  +-----------------------------------------------------+
                              |
                 standard provider / optional
                 external Takoform Host call
                              |
                         Takoserver Host
```

The graph is one-way. Clients and edge adapters invoke operation-shaped Core
interfaces; they do not assemble store calls, leases, retries, or provider
dispatches. The Executor consumes an envelope produced by RunAuthority and
returns an immutable terminal or typed-indeterminate result to RunAuthority.
Only RunAuthority may validate/adopt that result and authorize ArtifactLedger
to commit artifacts or move the current-state pointer. Executor never writes
through to the ledger on its own. A Host extension is external to Core and
cannot turn a Host fact into an OSS authority.

## Five deep Core modules

| Module | Owns and hides | Explicitly does not own |
| --- | --- | --- |
| **StackCatalog** | Workspace, Project, Capsule, Git Source, immutable SourceSnapshot, source discovery, exact module selection, and the current Stack catalog | plan/apply policy, provider execution, credential values, Offering or managed-resource lifecycle |
| **RunAuthority** | Run creation, plan/apply/destroy/refresh review, leases, audit intent, the at-most-once mutation fence, terminal commit, and typed-indeterminate reconciliation | provider process execution, vendor account custody, raw secret material, managed capacity, billing, or client presentation |
| **CredentialBroker** | Workspace-owned ProviderConnection, CredentialRecipe and ProviderBinding validation, policy checks, and run-scoped env/file materialization | Stack lifecycle approval, scheduling/retry decisions, parent Host credentials, provider installation, or native resource identity |
| **ArtifactLedger** | Immutable source/plan/state/output artifacts, artifact digests, current-state pointer updates authorized by RunAuthority, audit evidence, and result retention | approval, scheduling, provider dispatch, Offering selection, billing, or a second desired-state ledger |
| **Executor** | Execution of one approved OpenTofu phase, sandbox process/filesystem/network/redaction bounds, scoped credential use, and immutable terminal result or typed indeterminate result | scheduling, approval, retry policy, current-state pointer, catalog, Offering, billing, Host/resource lifecycle, or recovery authority |

The modules may share a physical database adapter, but a universal store is not
their public lifecycle API. Each module exposes commands that hide validation
ordering, transaction boundaries, leases, idempotency, receipts, recovery, and
projections. Optional Interface/Binding authorization, backup/restore, drift,
autoplan, webhook, and metrics modules depend on these Core commands; they do
not become a sixth lifecycle authority.

## RunOwner and RunnerObject

RunOwner is the durable Core authority for a Run. It owns the queue/lease,
review and authorization state, the at-most-once provider-dispatch fence,
terminal commit, and reconciliation/adoption of a typed indeterminate result.
RunnerObject is the execution object for one envelope. It starts the approved
phase in the selected sandbox, materializes only the scoped credentials, and
returns a result to RunOwner. It may retain an executor-local delivery receipt
to prevent duplicate process/provider dispatch inside that substrate, but the
receipt is subordinate evidence: it cannot approve, schedule, retry, commit an
artifact, mutate the current-state pointer, or mint adoption authority.

The simplification target is a narrow immutable envelope, not a merge of
RunOwner, the mutation fence, and Executor. Apply and Destroy therefore remain
at-most-once provider dispatches. A transport failure after dispatch is
`runner_mutation_indeterminate`; redelivery may only adopt the exact immutable
state/output target recorded before the failure, with freshly verified Run
authority and an exact semantic match.

## Optional compositions

- **Accounts/OIDC** are edge adapters. They authenticate a principal and map it
  to a Workspace; they do not become a second Run or credential authority.
- **Dashboard and CLI** are clients of the Core command interfaces.
- **Interface/Binding** provides explicit provider-neutral runtime
  authorization over ordinary Stack Outputs. It does not infer a provider or
  create a managed Offering.
- **Backup, drift/autoplan, webhook, and metrics** are operational adapters
  around the five modules. They must preserve the same command owner and
  recovery path.
- **Takosumi Hosted** can compose retail, commerce, or client presentation
  outside Core. Managed supply, Offerings, placement, and provider receipts
  remain Takoserver Host authority.
- **Ordinary Worker deploy** is valid for the Takosumi platform Worker and its
  product components. A managed customer `ModuleWorker`, Workers for Platforms
  namespace, or dispatcher belongs to Takoserver and never to the Takosumi
  runner.

## Current implementation gaps

The target above is intentionally stricter than the current tree. These are
conformance gaps, not supported exceptions:

| Gap | Current evidence | Required disposition |
| --- | --- | --- |
| Generic Offering authority | Current bootstrap/Worker composition and Offering routes/stores can still expose the old generic catalog and selection projection | Treat routes, stores, schema, fixtures, and callers as deletion/migration custody. Takosumi Core has no Offering authority; managed-service Offering moves to Takoserver. |
| Resource/Form lifecycle | Current bootstrap/Worker still composes parts of Resource Shape, Form Registry/FormActivation, TargetPool, SpacePolicy, Resource lifecycle, and same-origin compatibility/transition injection points | Freeze new desired state and discovery. Keep only the bounded authenticated read/observe/delete drain; any unavoidable provider mutation uses a one-time operator migration tool outside Core. Delete composition, injection points, and data custody after inventory-zero evidence. |
| Five-module extraction | Existing controller/store/runner composition still crosses lifecycle concerns and may expose broad adapters | Move invariants behind the five operation-shaped modules without weakening RunOwner, lease, or mutation-fence semantics. |
| Hosted identity | Older material calls the retired Takosumi Cloud identity the owner of managed capacity or Offerings | Current docs and integrations must name Takosumi Hosted only for optional retail/client composition and Takoserver for managed supply. Historical references remain explicitly historical. |
| Managed customer Worker lane | Any ordinary account-Worker path used as managed customer execution is not a Takosumi capability | Takoserver must own Workers for Platforms user Workers and its dispatcher. Takosumi must not add a branch, credential, namespace, or native identity for that lane. |

## Safe deletion and migration order

Deletion is a controlled migration, not a shortcut around the authority
boundary. The order below keeps old data recoverable and prevents a removed
projection from becoming an accidental writer:

1. **Freeze admission.** Stop new Offering, Resource/Form, TargetPool, and
   SpacePolicy writes and discovery. Leave the supported Stack/Run path
   explicit. Do not remove the RunOwner mutation fence.
2. **Snapshot and inventory.** Record exact schema/data counts, identities,
   callers, route registrations, scheduled jobs, and external consumers. Take
   an isolated backup and complete a restore/readback drill before deleting or
   rewriting anything. Never snapshot or copy secret values into the evidence.
3. **Drain and hand off.** Reconcile retained Resource/Form rows with exact
   immutable identities and authenticated Workspace/actor scope. Hand
   managed-service Offering, capacity, placement, provider receipt, and native
   identity to Takoserver's Host contract; map optional retail/client
   presentation to Takosumi Hosted. Do not infer identities from `latest`, kind,
   or caller-selected Space.
4. **Remove entrypoints.** After inventory-zero and read-only evidence, remove
   legacy route registration, bootstrap/Worker composition, discovery flags,
   and maintenance schedulers. Keep a bounded delete/read migration tool only
   for rows proved to remain.
5. **Remove storage.** Once all rows are migrated or explicitly deleted and the
   restore drill is retained, remove Offering and Resource/Form stores, schema
   projections, compatibility adapters, and their migration-only code. A
   retained migration record is not a reason to retain a supported route.
6. **Close documentation and gates.** Remove current-surface wording and
   fixtures, keep historical notes marked superseded, run authoritative-doc,
   boundary, and product checks, and verify no consumer still pins the deleted
   identity.
7. **Deploy and read back by owner.** The Takosumi owner deploys only the
   platform Worker through its normal deploy contract. Takoserver and Hosted
   deploy their own surfaces, read back the exact result, and retain a provider
   rollback or forward-repair path. A green check or this plan is not deploy
   authorization.

Until every step has evidence, old rows and code are migration custody and a
conformance gap. They are never a reason to describe Generic Offering or the
Resource/Form host as Takosumi Core.
