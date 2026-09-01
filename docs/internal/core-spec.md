# Takosumi Core Spec

Last updated: 2026-09-01

This document is the present Takosumi OSS contract. It supersedes historical
planning notes such as [`final-plan.md`](./final-plan.md); those notes cannot
change the current route, ownership, or release boundary. The domain terms are
listed in [`CONTEXT.md`](../../CONTEXT.md), and the target decomposition and
deletion order are in [`architecture.md`](./architecture.md).

## Definition

Takosumi OSS is the customer BYOC control plane for a plain Git-based
OpenTofu/Terraform Stack. It has one supported Git/OpenTofu/Terraform deployment
flow: one Stack through a reviewed Run, encrypted state, ordinary Outputs, and
audit evidence. The Workspace/customer owns the vendor account and credential.
The user's module
and provider graph select the provider; Takosumi does not add a Takosumi DSL,
a hidden provider, or a second desired-state ledger.

The standard provider path is explicit and complete:

```text
Workspace/customer account and credential
  -> ProviderConnection
  -> CredentialRecipe
  -> ProviderBinding
  -> run-scoped materialization
  -> approved OpenTofu provider phase
```

Takoserver is not in this BYOC path. An optional managed path is an external
Host composition: a Takoform provider may call a Takoserver Host with a
Host-scoped credential. Takosumi never selects or receives the Takoserver
parent provider credential, provider installation, backend, capacity,
Workers-for-Platforms namespace, dispatcher, or native resource identity.

Takoform is an ordinary external provider and portable specification project.
Takoform owns Form definitions, FormRef/package publication, provider releases,
and portable conformance. Takosumi ships no first-party Terraform/OpenTofu
provider and does not host a Form Registry or hosted Form lifecycle.

## Ownership boundary

| Area | Owner |
| --- | --- |
| Stack catalog (Workspace, Project, Capsule, Git Source, SourceSnapshot, and discovery), Runs and Run authority, state/Output/artifact ledger, audit, ProviderConnection, CredentialRecipe, ProviderBinding, Executor contract, Interfaces, and InterfaceBindings | Takosumi OSS |
| Workspace/customer vendor account and credential used by BYOC | Workspace/customer, brokered by Takosumi only for the authorized Run |
| Portable Form schema, FormRef, data-only Form Packages, typed provider, package signatures, and conformance | Takoform |
| Managed-service Offering, hosted Form/resource and Deployment lifecycle, backend/provider installation, provider account and credential, targets/capacity/placement, Workers for Platforms namespace and dispatcher, native identity, receipts, commercial terms, billing, SLA, support, and abuse controls | Takoserver Host |
| Optional retail, commerce, and client presentation around a managed Host | Takosumi Hosted; it does not own managed supply or provider authority |

Takosumi Cloud is a retired historical identity. It is not current authority
for OSS composition, managed supply, availability, pricing, SLA, or support.

The portable project may own the portable Interface descriptor, schema, and
declarative mapping semantics required by an external Form or provider. It does
not own Takosumi's runtime Interface records, InterfaceBinding/token
authorization, or their write and lifecycle authority. It also owns no
Resource ID, lifecycle ledger, Run, StateVersion, Output, Target, credential,
Policy, or Adapter in Takosumi OSS. Takosumi OSS does not acquire portable
definition, provider, Host, or managed-capacity authority by retaining
migration rows.

Takosumi Core does not own:

```text
Generic Offering catalogs or OfferingSelection authority
Takoserver managed-service Offering or Host/resource lifecycle
invoice / payment integration
rated billing and payment enforcement
operator-provided deployment target capacity
Workers for Platforms namespaces, dispatchers, or managed ModuleWorkers
Takoserver native managed-resource identities or internals
official SLA / support / abuse tooling
```

Protocol-specific data paths may be composed around an existing deployed
service, but they are not a second deployment lifecycle. Official hosted
capacity is not an OSS Core responsibility.

## Five deep Core modules

Takosumi Core converges on five invariant-bearing modules. The modules may use
one physical database adapter, but a universal store is not their public
lifecycle API.

| Module | Owns and hides | Explicitly does not own |
| --- | --- | --- |
| **StackCatalog** | Workspace, Project, Capsule, Git Source, immutable SourceSnapshot, exact module selection, and source discovery | Run approval or execution, credential values, Offering, or managed-resource lifecycle |
| **RunAuthority** | Plan/apply/destroy/refresh review, Run creation, leases, audit intent, at-most-once mutation fence, terminal commit, and typed-indeterminate reconciliation | Provider process execution, vendor account custody, raw secret material, capacity, billing, or client presentation |
| **CredentialBroker** | ProviderConnection, CredentialRecipe, ProviderBinding validation and policy, and run-scoped env/file materialization | Stack lifecycle approval, scheduling/retry decisions, parent Host credentials, provider installation, or native identity |
| **ArtifactLedger** | Immutable source/plan/state/output artifacts and digests, current-state pointer updates authorized by RunAuthority, audit evidence, and result retention | Approval, scheduling, provider dispatch, Offering selection, billing, or a second desired-state ledger |
| **Executor** | One approved OpenTofu phase, process/filesystem/network/redaction bounds, scoped credential use, and immutable terminal result or typed indeterminate result | Scheduling, approval, retry policy, current-state pointer, catalog, Offering, billing, Host/resource lifecycle, or recovery authority |

Accounts/OIDC are edge adapters. Dashboard and CLI are clients. Interface /
Binding authorization, backup/restore, drift/autoplan, webhook, and metrics are
optional modules around these five authorities; they do not become a second
Run or resource lifecycle.

## Supported Stack model

| Concept | Meaning |
| --- | --- |
| Workspace | Personal purpose, resource, and security boundary for sources, secrets, state, Runs, and audit; optional membership and sharing extend it |
| Project | A service or infrastructure grouping |
| Capsule | One OpenTofu/Terraform module execution unit, with concrete environments such as `production` and `preview` |
| Source | Git URL/ref/commit/path for a plain module |
| ProviderConnection | Workspace/customer-owned vendor credential configuration |
| CredentialRecipe | How an authorized provider credential becomes a temporary env/file/pre-run value |
| ProviderBinding | Mapping from provider name/alias to a ProviderConnection and recipe |
| Run | One guarded init/validate/plan/apply/destroy/refresh action |
| StateVersion | State generation with storage and locking |
| Output | Ordinary root-module output captured after a successful Run |
| Interface | Provider-neutral connection or runtime declaration |
| InterfaceBinding | Authorization of an Interface to an invocation principal |
| AuditEvent | Actor/action/target/result evidence |

A Workspace is not a team-first container or an alias for a deployment
environment. It is a personal context for a purpose such as Personal, Work,
Experiments, or Client, and membership/sharing are optional advanced
composition around that context. `displayName` is the primary human-facing
identity. `handle` is a stable, globally unique public API identifier that API
and CLI callers may supply; it is not a required user choice. First-party
dashboard flows generate handles and surface `@handle` only for disambiguation
or advanced details. Concrete environments remain Capsule-scoped.

StateVersion storage and locking are part of the canonical Run lifecycle; they
are not a separate Resource/Form ledger.

Plan, Apply, Destroy, and Refresh are guarded Run operations, not separate
ledgers. OpenTofu Outputs remain ordinary module values; an Interface may
explicitly reference a Capsule output, but no reserved output name becomes a
runtime registry or credential channel.

## Run authority and mutation fence

RunAuthority (the RunOwner side of the boundary) owns review, lease,
authorization, the canonical dispatch fence, terminal commit, and
reconciliation. Executor (the RunnerObject side) executes one immutable
envelope. Apply and Destroy are at-most-once provider dispatches.

Before either request reaches Executor, RunOwner durably records the exact
Run/action and immutable source, plan, state, module, and provider-binding
semantics. RunnerObject may retain a subordinate executor-local delivery
receipt to prevent a duplicate process/provider call inside its substrate, but
that receipt is not Run authority and cannot authorize ledger adoption or
current-state mutation. Signed Run credentials are reverified on each delivery;
their stable authority claims and delivery coordinates are bound while token
bytes, issuance/expiry times, and JTI remain secret and do not change identity.
Opaque credential material is bound by a one-way digest and is never stored.

A matching canonical `preparing` record may resume with a freshly issued
equivalent credential, but `dispatched`, `indeterminate`, or any semantic
mismatch never grants another provider dispatch. Executor returns its terminal
or typed `runner_mutation_indeterminate` result to RunOwner. Only RunOwner may
verify exact post-dispatch readback, adopt the result, and authorize
ArtifactLedger to commit state/output artifacts or move the current-state
pointer; an Executor receipt or R2 target cannot mint adoption authority.
Without authoritative readback the Run remains indeterminate. Plan, read-only
work, and a provable pre-dispatch preparation failure may retry without
granting mutation authority. Mutation-authority, relay, and container-lifecycle
failure logs use only finite classifications and never include raw messages,
stacks, request bodies, or credential material.

The simplification target is the narrow envelope, not a merge of RunAuthority,
the mutation fence, and Executor. RunOwner and RunnerObject retain separate
failure and security responsibilities.

## Provider-neutral execution and credentials

Plain Stack execution accepts any runner-installable OpenTofu/Terraform
provider. The source address, version/checksum, provider configuration, and
module inputs remain in the user's Stack and the explicit ProviderConnection /
CredentialRecipe / ProviderBinding records. The Executor receives only the
run-scoped material it is authorized to use.

Generic environment/file declarations are an escape hatch for arbitrary
providers. A guided recipe catalog is descriptive metadata, not an execution
allowlist. Core does not branch on a provider name and does not silently inject
provider credentials.

Secrets are write-only at the control-object boundary. Secret values never
enter Resource specs, Interface documents, Outputs, state, Run logs, audit
payloads, or public discovery. Sensitive OpenTofu values remain in encrypted
provider state and cannot become Interface inputs.

## Interfaces and InterfaceBindings

Interfaces are provider-neutral declarations owned by a Workspace or Capsule.
They use a closed `apiVersion`/`kind`/`metadata`/`spec`/`status` envelope and
carry endpoint and input-resolution metadata, not provider account IDs,
credentials, or native resource IDs. Resource-owned Interface rows are legacy
migration records only.

An InterfaceBinding authorizes one exact Interface revision for a principal and
may issue invocation-scoped credentials through the host's credential
brokerage. The binding does not infer a provider, create an Offering, or
schedule a Workspace-wide reconciliation. Runtime handlers fail closed when
the Interface, revision, Workspace, or binding evidence does not match.

## No Offering authority in Takosumi Core

Generic Offering is not a Takosumi Core authority. Existing source code may
still contain `/v1/offering-*` routes, catalog stores, schema projections, and
selection helpers; their presence is an implementation conformance gap and
deletion/migration custody, not a supported customer contract. They must not
select a provider, expose managed capacity, install a Form, or create a second
Resource lifecycle. New Core work must not add an Offering catalog or
`OfferingSelection` ledger.

Takoserver owns the managed-service Offering that binds an exact external Form
to implementation, provider supply, capacity, placement, commercial terms,
and support. Takosumi Hosted may present that Host-owned availability through
retail or client composition, but it cannot mint, alter, or supply the
Offering. A plain BYOC Stack never depends on either surface.

Any retained generic Offering rows are migrated or deleted using exact
immutable identity, authenticated actor/Workspace mapping, bounded pages, and
backup/restore evidence. A route or store that remains only to drain those rows
does not make Generic Offering part of Core.

## Takoform and external Form Hosts

Takoform owns its current provider address, API versions, exact FormRef fields,
package identity, and publication status. Takosumi pins the provider source,
version, and checksum selected by the module; it does not duplicate a
candidate Takoform registry or declare an unpublished API stable.

For retained historical rows, the old Resource wire-to-FormRef mapping remains
migration data. A historical package example may therefore contain:

```json
{
  "apiVersion": "forms.takoform.com/v1alpha1",
  "kind": "ObjectBucket",
  "definitionVersion": "0.0.0-legacy.1",
  "schemaDigest": "sha256:<exact-schema-digest>",
  "packageDigest": "sha256:<exact-package-digest>"
}
```

Historical package evidence alone does not approve a Form, activate it, create
an Offering, or make a backend available. A Host must own its own registry,
executable implementation, activation/audience policy, backend lifecycle,
capacity, and provider receipt. Takoserver is the optional managed Host for
that supply; OSS retains only the bytes and metadata needed to observe, delete,
or migrate old rows safely. A Takoform provider may carry a Host-scoped
credential to that Host, but Takosumi never receives the Host's parent
credential or implementation identity.

## Legacy Resource/Form drain

The old `Resource Shape`, Form Host, and `/v1/resources` family are migration
internals, not a supported OSS authoring flow. The platform edge defaults all
legacy Resource/Form paths and discovery to `404`; no environment variable
turns them into a new public product surface.

An operator may opt into the bounded drain by setting
`TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1` together with the authenticated
control-plane configuration (`TAKOSUMI_DEPLOY_CONTROL_TOKEN` and the control
database). The drain still requires authenticated access and permits only:

| Legacy area | Allowed while drain is enabled |
| --- | --- |
| Resource collection and records | authenticated `GET`/`HEAD` list/read/events, `POST` observe, and `DELETE` |
| TargetPool and SpacePolicy records | authenticated `GET`/`HEAD` (including list) and `DELETE` |

Resource preview/apply/recover/import/refresh, TargetPool/SpacePolicy writes,
Form Registry operations, FormActivation operations, portable Form discovery,
and all other legacy actions remain unavailable. Disabled/unknown paths return
`404`; recognized but retired operations return `410` while the drain is on.
The drain never enables discovery, creates a Form, selects a TargetPool, or
changes the supported Stack/Interface model.

There is no separate same-origin compatibility Host or Form-transition lane in
the supported platform Worker/Core composition. Any retained injection points,
transition routes, provider adapters, or discovery code are implementation
conformance gaps and deletion custody; they must remain unavailable to new
traffic.

If migrating one retained row unavoidably requires a provider mutation, the
operator uses a target-fixed, one-time migration tool outside the public
platform Worker and Core lifecycle. That tool requires exact old/new identity,
dedicated operator authority, an at-most-once operation/receipt, provider
readback, and backup/restore evidence, and is removed after the bounded
migration. It never becomes discovery, authoring, a supported route, or a
second lifecycle ledger.

During the explicit drain window the platform cron may resume incomplete old
Resource operations and perform bounded read-only observation of retained rows.
Those maintenance jobs are disabled with the drain and cannot accept new
desired state.

## Migration custody

Retained Resource, Run, state, audit, TargetPool, SpacePolicy, FormRef, package,
and old Offering rows may be read and transitioned by an operator migration.
Such work must use exact immutable identities, authenticated actor/Workspace
mapping, bounded pages, idempotent evidence, and an isolated backup/restore
drill. It must not infer an identity from `latest`, caller-selected Space, or
kind alone.

Migration runbooks are historical procedures, not current authoring or release
authority. A passing compatibility test or retained route does not make
Resource Shape, Form Registry, FormActivation, TargetPool, SpacePolicy, or
Generic Offering a supported OSS surface.

## Deployment and release

Ordinary Worker deploy is valid for the Takosumi platform Worker and its
operator-owned product components. A managed customer `ModuleWorker`, Workers
for Platforms namespace, or dispatcher belongs to Takoserver Host; it is never
created by the Takosumi Executor or runner.

The owning repository/operator deploys each production surface. A task, branch
name, green check, or this document never authorizes production mutation. A
release must bind the reviewed commit and artifact, prove post-conditions,
state reversal/forward-repair, and record failure handling. Takosumi Hosted
and Takoserver deployment and commercial readiness are separate external-Host
decisions.

## Conformance reading order

Use this document for the present contract, [`CONTEXT.md`](../../CONTEXT.md)
for domain vocabulary, [`architecture.md`](./architecture.md) for target
module/deletion design, public reference docs for stable user behavior, and
`docs/operations/` for operator procedures. Treat `final-plan.md`,
`offering-model.md`, and other historical notes as superseded records; if they
conflict with this document, Core Spec wins and the conflict is a conformance
gap to be corrected.
