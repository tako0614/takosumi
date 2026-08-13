# Takosumi Core Spec

Last updated: 2026-08-09

This document is the present Takosumi OSS contract. It supersedes historical
planning notes such as [`final-plan.md`](./final-plan.md); those notes cannot
change the current route, ownership, or release boundary.

## Definition

Takosumi OSS is a Git-based OpenTofu/Terraform control plane. Its one supported
Git/OpenTofu/Terraform deployment flow is a plain Stack through a reviewed Run,
persisted state, Outputs, and audit evidence. A provider is selected by the user's
OpenTofu configuration and explicit host bindings; there is no Takosumi DSL or
second desired-state ledger.

Takoform is an ordinary external provider and portable specification project.
Takoform owns Form definitions, FormRef/package publication, provider releases,
and portable conformance. Takosumi ships no first-party Terraform/OpenTofu provider
and does not host a Form Registry or hosted Form lifecycle.

## Ownership boundary

| Area | Owner |
| --- | --- |
| Git sources, OpenTofu/Terraform init/validate/plan/apply/destroy, Runs, state, Outputs, audit, provider connections, credential recipes, provider bindings, Interfaces, InterfaceBindings | Takosumi OSS |
| Portable Form schema, FormRef, data-only Form Packages, typed provider, package signatures, and conformance | Takoform |
| Hosted Form instances, Form Host lifecycle, backend implementations, targets/capacity, commercial offerings, billing, SLA, support, and abuse controls | Takosumi Cloud or another external Host |

The portable project owns no Resource ID, lifecycle ledger, Run, StateVersion,
Output, Target, credential, Policy, Adapter, Interface, or InterfaceBinding.
Conversely, OSS does not acquire portable definition or provider authority by
retaining migration rows.

Takosumi Core does not own:

```text
invoice / payment integration
rated billing and payment enforcement
operator-provided deployment target capacity
official Takosumi native resource internals
official SLA / support / abuse tooling
```

Protocol-specific data paths may be composed around an existing deployed
service, but they are not a second deployment lifecycle. Official hosted
capacity is not an OSS Core responsibility.

## Supported Stack model

| Concept | Meaning |
| --- | --- |
| Workspace | Personal purpose, resource, and security boundary for sources, secrets, state, Runs, and audit; optional membership and sharing extend it |
| Project | A service or infrastructure grouping |
| Capsule | One OpenTofu/Terraform module execution unit, with concrete environments such as `production` and `preview` |
| Source | Git URL/ref/commit/path for a plain module |
| ProviderConnection | Stored provider credential configuration |
| CredentialRecipe | How a provider credential becomes a temporary env/file/pre-run value |
| ProviderBinding | Mapping from provider name/alias to a ProviderConnection |
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

Apply and Destroy are at-most-once provider dispatches. Before either request
can reach the runner container, the runner Durable Object durably records the
stable semantics of the exact Run/action and immutable source, plan, state,
module, and provider-binding inputs. Signed Run credentials are reverified on
each delivery; their stable authority claims and delivery coordinates are
bound while token bytes, issuance/expiry times, and JTI remain secret and do
not change identity. Opaque credential material is bound by a one-way digest
and is never stored. A matching durable `preparing` record may therefore resume
with a freshly issued equivalent credential, but `dispatched`, `indeterminate`,
or any semantic mismatch never grants another provider dispatch. A transport
failure after dispatch returns the typed `runner_mutation_indeterminate`
outcome. Redelivery may complete only by adopting the exact immutable
state/output target already written for that Run; without that authoritative
readback, it remains indeterminate. Plan, read-only work, and a provable
pre-dispatch preparation failure may retry without granting mutation authority.

## Provider-neutral execution

Plain Stack execution accepts any runner-installable OpenTofu/Terraform
provider. The source address, version/checksum, provider configuration, and
module inputs remain in the user's Stack and the explicit `Provider Connection`
/ `CredentialRecipe` / `ProviderBinding` records. The runner receives only the
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

## Generic Offering

Generic Offerings remain an independent OSS projection. An immutable catalog
selects an exact namespaced subject type/ref/version/digest with explicit
requirements and audience; an installed subject resolver returns an exact
resolution fingerprint; the result is an `OfferingSelection`.

```text
POST /v1/offering-catalogs
GET  /v1/offering-catalogs
GET  /v1/offering-catalogs/:catalogId/versions/:catalogVersion
POST /v1/offering-availability/query
POST /v1/offering-selections/resolve
```

Catalogs are operator/deploy-control surfaces, not a customer Form installer.
There is no `latest` fallback, implicit provider selection, commercial field,
or implicit capacity. Empty catalogs are valid and the Stack flow works with
none installed. Takosumi Cloud may attach its own closed commercial binding to
an exact selection; it cannot replace the generic resolver or create a second
lifecycle ledger.

## Takoform and external Form Hosts

Takoform owns its current provider address, API versions, exact FormRef fields,
package identity, and publication status. Takosumi pins the provider source,
version, and checksum selected by the module; it does not duplicate a candidate
Takoform registry or declare an unpublished API stable.

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
an Offering, or make a backend available. An external Host must own its own
registry, executable implementation, activation/audience policy, and backend
lifecycle. OSS retains only the bytes and metadata needed to observe, delete,
or migrate old rows safely.

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
changes the supported Stack/Interface/Offering model.

During the explicit drain window the platform cron may resume incomplete old
Resource operations and perform bounded read-only observation of retained rows.
Those maintenance jobs are disabled with the drain and cannot accept new
desired state.

## Migration custody

Retained Resource, Run, state, audit, TargetPool, SpacePolicy, FormRef, and
package rows may be read and transitioned by an operator migration. Such work
must use exact immutable identities, authenticated actor/Workspace mapping,
bounded pages, idempotent evidence, and an isolated backup/restore drill. It
must not infer an identity from `latest`, caller-selected Space, or kind alone.

Migration runbooks are historical procedures, not current authoring or release
authority. A passing compatibility test or retained route does not make
Resource Shape, Form Registry, FormActivation, TargetPool, or SpacePolicy a
supported OSS surface.

## Deployment and release

The owning repository/operator deploys each production surface. A task, branch
name, green check, or this document never authorizes production mutation. A
release must bind the reviewed commit and artifact, prove post-conditions,
state reversal/forward-repair, and record failure handling. Takosumi Cloud
deployment and commercial readiness are separate external-Host decisions.

## Conformance reading order

Use this document for the present contract, public reference docs for stable
user behavior, and `docs/operations/` for operator procedures. Treat
`final-plan.md` and other historical notes as superseded records; if they
conflict with this document, Core Spec wins and the conflict is a conformance
gap to be corrected.
