# Takosumi Core Spec

Last updated: 2026-08-25

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

| Area                                                                                                                                                                                      | Owner                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Git sources, OpenTofu/Terraform init/validate/plan/apply/destroy, Runs, state, Outputs, audit, provider connections, credential recipes, provider bindings, Interfaces, InterfaceBindings | Takosumi OSS                                     |
| Portable Form schema, FormRef, data-only Form Packages, typed provider, package signatures, and conformance                                                                               | Takoform                                         |
| Hosted Form instances, Form Host lifecycle, backend implementations, targets/capacity, commercial offerings, billing, SLA, support, and abuse controls                                    | Takosumi hosted service or another external Host |

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

| Concept                          | Meaning                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace                        | Personal purpose, resource, and security boundary for sources, secrets, state, Runs, and audit; optional membership and sharing extend it |
| Project                          | A service or infrastructure grouping                                                                                                      |
| Capsule                          | One OpenTofu/Terraform module execution unit, with concrete environments such as `production` and `preview`                               |
| Source                           | Git URL/ref/commit/path for a plain module                                                                                                |
| Adopted Source revision          | SourceSnapshot ref/path/commit derived from a Capsule's current StateVersion apply provenance; never a mutable Capsule or Source field    |
| GitInstallPlan / GitRevisionPlan | Durable idempotent coordinator evidence that stops at one reviewable Plan Run                                                             |
| ProviderConnection               | Stored provider credential configuration                                                                                                  |
| CredentialRecipe                 | How a provider credential becomes a temporary env/file/pre-run value                                                                      |
| ProviderBinding                  | Mapping from provider name/alias to a ProviderConnection                                                                                  |
| Run                              | One guarded init/validate/plan/apply/destroy/refresh action                                                                               |
| StateVersion                     | State generation with storage and locking                                                                                                 |
| Output                           | Ordinary root-module output captured after a successful Run                                                                               |
| Interface                        | Provider-neutral connection or runtime declaration                                                                                        |
| InterfaceBinding                 | Authorization of an Interface to an invocation principal                                                                                  |
| AuditEvent                       | Actor/action/target/result evidence                                                                                                       |

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

Per-Capsule Git tracking uses existing apply provenance:
`Capsule.currentStateVersionId -> StateVersion.createdByRunId -> ApplyRun ->
PlanRun.sourceSnapshotId`. Restore StateVersions follow their exact
`restoredFromStateVersionId` edge. Normal plans and source observation use the
derived SourceSnapshot ref/path lane after the first apply; only the initial
plan uses its reviewed install pin or Source default. A revision plan cannot
change tracking before apply, and no Capsule revision operation mutates the
shared `Source.defaultRef` / `defaultPath`.

Plan, Apply, Destroy, and Refresh are guarded Run operations, not separate
ledgers. OpenTofu Outputs remain ordinary module values; an Interface may
explicitly reference a Capsule output, but no reserved output name becomes a
runtime registry or credential channel.

Current PlanRun creation accepts only a pinned Git source. The historical
`operator_module` payload is not a create/update compatibility surface; it is
decoded only behind a controller-owned marker for exact pre-v1 source-less
destroy/recovery of already-persisted state. That drain cannot create or update
infrastructure and must be removed after operator inventory reaches zero.

Public hostname, DNS, and application endpoint ownership stays inside the Git
module and its provider. Takosumi does not synthesize or reserve Capsule
hostnames, and `public_endpoint` is an ordinary applied-Output projection.
Takosumi does not infer or auto-register an Accounts OIDC client from Git
metadata, provider output, or a provider-boundary call. Provider runtime-binding
is read-only derivation and has no registration authority. A Host may explicitly
opt a DB-owned InstallConfig into the direct Accounts OIDC module-variable
materializer, which owns final-Apply activation. That port derives only its four
declared non-secret values during read-only Plan, pins their authority digest in
the private Plan sidecar, and may idempotently register the exact client only
during the final Apply revalidation after re-reading the current Capsule,
InstallConfig, and verified ProviderBinding.
Destroy Plan and destroy admission remain read-only. Only after provider
destroy and the atomic Capsule `destroyed` transition have committed may Core
ask the Host to idempotently delete that exact DB-owned client, with the current
Capsule, InstallConfig, reviewed variables, ProviderBinding metadata, and pinned
digest revalidated again. This deletion is best-effort because Accounts live
grant validation already denies a terminal Capsule and retries physical
revocation; a cleanup outage cannot make a successful infrastructure destroy
retryable or recreate the client. The port never carries provider credentials,
passwords, generated encryption keys, or the runtime-binding entrypoint.
Generic Accounts OIDC and Interface/InterfaceBinding authorization remain.
Current Capsule lifecycle code does not release historical public-host
reservation rows or perform unrelated bulk OIDC-client cleanup; physical
retirement of those historical rows waits for operator inventory.

## Capsule InstallConfig re-adoption

An authenticated Workspace owner or operator (the write-capable owner/admin
membership) may request the explicit re-adoption operation:

```http
POST /api/v1/capsules/{capsuleId}/install-config-re-adoptions
Idempotency-Key: <opaque-key>
```

The caller first reads the Capsule and uses the returned opaque
`installConfigReAdoption.authorityGuard`. The guard is usable as-is; it does
not require the caller to know or submit the private InstallConfig digest. The
closed request body is `baseInstallConfigId`, `sourceSnapshotId`, optional
`deploymentProfileKey`, bounded non-secret `reason`, and
`expected.authorityGuard`. The operation is not an InstallConfig patch and does
not apply infrastructure.

The operation creates one immutable, derived InstallConfig target and then
performs one authority-fenced Capsule rebind. The memory, PostgreSQL, and D1
stores compare the exact current and target InstallConfig records (including
their canonical JSON/digests) together with Capsule status,
`currentStateGeneration`, `currentStateVersionId`, and
`executionAuthorityEpoch` before the pointer and epoch update. Normally,
re-adoption is allowed only when `runtimeSafety` is `safe` or absent (there is
no decisive candidate). Unsafe or ambiguous Apply/Destroy/Restore Runs,
in-flight work, and an unconsumed Plan for the Capsule block the rebind;
consumed or terminal history does not.

The sole exception is a receipt-fenced committed `post_apply` recovery while
`runtimeSafety=unknown`. It requires the decisive failed `create`/`update`
ApplyRun to have exactly one ordered `apply.completed` → `apply.failed` receipt,
with `providerDispatched=true`, `providerApplySucceeded=true`, and terminal
`post_apply` lifecycle failure on the failed receipt. The completed receipt must
identify the exact current `StateVersion` and `Output`; those rows must match
the current Capsule pointers, generation, workspace/capsule ownership,
environment, and failed-Apply provenance. The GET-issued guard and immutable
target's private receipt hold only opaque, value-free evidence; receipt values
are never returned in public Capsule, InstallConfig, or response projections.

In that exception, the same CAS re-reads the latest decisive Run, exact
StateVersion/Output rows, whole current/target InstallConfig JSON, whole
Capsule JSON, and execution authority epoch, and requires no blocking
queued/running Run or Apply and no current unconsumed Plan. Missing or drifted
receipt/Run/StateVersion/Output/config/Capsule/epoch, provider uncertainty or
persisted `providerApplySucceeded=false` partial state, destroy/restore, a
newer safety candidate, in-flight Apply, or current unconsumed Plan returns
409. A successful rebind changes only `installConfigId`, `updatedAt`, and epoch
+ 1; `status=error`, state/output pointers, generation, and
`runtimeSafety=unknown` remain unchanged. The rebind does not dispatch
provider work. A fresh reviewed Plan and Apply is required, and only its
successful Apply may restore the Capsule to `active` / `safe`.

A successful rebind increments `executionAuthorityEpoch`. That epoch is part
of the Accounts OIDC activation authority, so an old or orphaned Apply
activation cannot authorize the newly adopted configuration; only a final
Apply that revalidates the current configuration can save its current
activation digest. A missing legacy Plan epoch is accepted only when the
current Capsule epoch is still 1; after an authority change it fails closed.

The `Idempotency-Key` and request digest make retries value-free and replayable.
The same request returns the canonical target and does not append another
activity event; a stale guard, changed current record, target mutation, or
different request under the same key is rejected. The response contains only
Capsule and target identifiers/digests plus the SourceSnapshot identifier.
Plan remains a separate reviewable Run boundary.

## Takos hosted runtime secret file profile

Takos has one narrow hosted exception to the ordinary operator-owned secret
boundary: a DB-owned per-Capsule runtime-binding profile may declare an opaque
runtime secret file. It is not a bulk secret registry and does not transfer
operator or Workspace provider secrets to the database-owned profile.

The current profile generates exactly these five names:

- `PLATFORM_PRIVATE_KEY`: RSA-2048 private key (SHA-256 profile);
- `PLATFORM_PUBLIC_KEY`: the corresponding RSA-2048 public key;
- `ENCRYPTION_KEY`: 32 random bytes encoded as base64;
- `TAKOS_AGENT_START_TOKEN`: 32 random bytes encoded as hex; and
- `TAKOS_INTERNAL_API_SECRET`: 32 random bytes encoded as hex.

The generated material is sealed in the Takos secret boundary, keyed to the
Capsule and profile, and is absent from `ProviderConnection`, InstallConfig
public projections, state, Outputs, Run/audit records, diagnostics, and logs.
The same Capsule and unchanged profile reopen the same sealed material across
InstallConfig replacement; a profile-digest change is a fence, not an
implicit rotation.

Only a successful `post_apply` runner activation may receive the material. The
runner writes one `takos-runtime-secrets.json` file, exposed through
`TAKOS_RUNTIME_SECRETS_FILE`, under a temporary directory with mode `0700` and
file mode `0600`. The file contains the exact JSON names and is removed with
fail-closed cleanup; a truncate, fsync, unlink, or directory-removal failure
fails the cleanup rather than silently retaining an active runner file.

Provider destroy commits first. The terminal Capsule transition then records a
value-free `runtime_secret.retirement.pending` intent and attempts sealed-blob
retirement. Success appends `runtime_secret.retirement.completed`; a failed
attempt remains durable and never replays provider destroy. Scheduled repair
scans this retirement outbox independently of the active Workspace catalog,
so archived Workspaces and rows beyond the active prefix are included. Deferred
attempt timestamps are rotated into oldest-attempt-first bounded scans on later
sweeps, providing eventual coverage without a second lifecycle ledger.

## Takos Accounts OIDC module-variable profile

The same explicit DB-owned hosted profile may opt a Capsule into Takos Accounts
OIDC module-variable materialization. Plan and `apply_check` are read-only:
they derive the non-secret variables, validate the current Capsule,
InstallConfig, reviewed ProviderBinding metadata, and exact authority digest,
but do not write Accounts. Final Apply is the only registration path; it is
idempotent and saves the exact current value-free `activationDigest`. The
digest binds contract `takosumi.accounts-oidc-activation/v1`, Workspace and
Capsule identity, `executionAuthorityEpoch`, the full InstallConfig digest, and
the OIDC profile digest. Live-grant validation requires an exact match to the
current values; a legacy null or mismatched digest is stale/denied without
deleting the Apply-repairable client. `updatedAt` is ordinary audit time only,
not activation authority.

The browser profile uses the exact six scopes
`openid`, `profile`, `email`, `offline_access`, `capsules:read`, and
`capsules:write`, and the callback path `/auth/oidc/callback`. Its redirect URI
is derived from the exact reviewed HTTPS `public_url` origin (a profile-defined
derived origin is used only when that input is intentionally empty); paths,
queries, credentials, and non-HTTPS origins are rejected. The client identity
is stable per Capsule and profile across replacement of the InstallConfig row.
The registration is public/pairwise and carries no client secret in Takosumi
state or Outputs.

The Accounts schema change is additive and protected, but its promotion order
is substrate-specific. For PostgreSQL, apply migration 043, then migration 044,
before promoting the feature Worker: 043 adds the nullable `activation_digest`
column and its not-yet-validated shape check, while 044 validates that check.
For Cloudflare D1, first verify the exact-v3 ledger/schema closure, then deploy
the v3/v4 feature bridge. The bridge accepts only exact legacy v3 or exact
checksummed v4 and performs no request-time DDL. Retain owner-private backup
and status evidence, complete the bounded pre-ledger backfill, perform the
atomic v4 apply and read-only verify. After the observation window, deploy the
exact-v4-only Worker. A v3-only Worker must never remain live after v4 commits;
the bridge is the compatible rollback floor. Both lanes are forward-only. A
legacy null remains stored for migration compatibility but cannot authorize a
live grant until Apply saves the exact current digest.

This narrow DB-owned hosted profile does not change the ownership rule for
bulk/operator secrets, generic ProviderConnections, or generic Accounts OIDC
clients; those remain operator- or Accounts-owned.

Apply and Destroy are at-most-once provider dispatches. Before either request
can reach the runner container, the runner Durable Object durably records the
stable semantics of the exact Run/action and immutable source, plan, state,
module, and provider-binding inputs. Signed Run credentials are reverified on
each delivery; their stable authority claims and delivery coordinates are
bound while token bytes, issuance/expiry times, and JTI remain secret and do
not change identity. Opaque credential material is bound by a one-way digest
and is never stored. A matching durable `preparing` record may therefore resume
with a freshly issued equivalent credential, but `dispatched`, `indeterminate`,
or any semantic mismatch never grants another provider dispatch. Completed
state/output readback and adoption also require a freshly verified credential
and an exact semantic match against that pre-existing post-dispatch record; an
R2 target cannot mint its own adoption authority. A transport failure after
dispatch returns the typed `runner_mutation_indeterminate` outcome. Redelivery
may complete only by adopting the exact immutable state/output target already
written for that Run; without that authoritative readback, it remains
indeterminate. Plan, read-only work, and a provable pre-dispatch preparation
failure may retry without granting mutation authority. Mutation-authority,
relay, and container-lifecycle failure logs use only finite classifications and
never include raw messages, stacks, request bodies, or credential material.

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
brokerage. The binding does not infer a provider or
schedule a Workspace-wide reconciliation. Runtime handlers fail closed when
the Interface, revision, Workspace, or binding evidence does not match.

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

## Retired Resource/Form HTTP surfaces

The old `Resource Shape`, TargetPool, SpacePolicy, Form Registry, and
FormActivation HTTP families are retired. Their authoring writes are retired;
Core does not mount their `/v1` paths, CLI commands, or public
capability/OpenAPI descriptors. Those paths remain unconditional `404` even
when a bearer and retained rows are present.

The forward schema migrations physically retire this embedded Host schema only
when every retired table is empty: PostgreSQL v110 and D1 v66 fail closed when
they find populated rows. Current Takosumi serves no typed Host migration API,
in-process operation, configuration binding, or portable-protocol compatibility
alias. Before crossing that migration, an operator with retained rows must use
the immediate predecessor release or out-of-band database tooling to inventory
and export the rows, record an explicit disposition, and only then retry the
forward migration. The portable Takoform protocol remains an external Host
contract; it does not grant current Takosumi authority over those rows.

## Migration custody

Retained Resource, TargetPool, SpacePolicy, FormRef, package, and other embedded
Host rows are predecessor/out-of-band migration inputs, not current application
records. Their inventory and export must use exact immutable identities,
bounded pages, idempotent evidence, and an isolated backup/restore drill. Any
transition or deletion requires an explicit operator disposition; it must not
infer an identity from `latest`, caller-selected Space, or kind alone. Current
Run, state, and audit records remain part of the supported Stack model and are
not retired by Host-schema migrations v110/v66.

Migration runbooks are historical procedures, not current authoring or release
authority. A passing compatibility test or retained route does not make
Resource Shape, Form Registry, FormActivation, TargetPool, or SpacePolicy a
supported OSS surface.

## Deployment and release

The owning repository/operator deploys each production surface. A task, branch
name, green check, or this document never authorizes production mutation. A
release must bind the reviewed commit and artifact, prove post-conditions,
state reversal/forward-repair, and record failure handling. Takosumi hosted service
deployment and commercial readiness are separate external-Host decisions.

## Conformance reading order

Use this document for the present contract, public reference docs for stable
user behavior, and `docs/operations/` for operator procedures. Treat
`final-plan.md` and other historical notes as superseded records; if they
conflict with this document, Core Spec wins and the conflict is a conformance
gap to be corrected.
