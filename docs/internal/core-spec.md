# Takosumi Core Spec

Last updated: 2026-08-27

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
| Source                           | Git URL/ref/commit and optional captured repository subtree                                                                               |
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
source sync uses its reviewed Git pin or Source default coordinate. Every plan
uses a module path selected from the immutable snapshot scan; `Source.defaultPath`
is never a module fallback. A revision plan cannot
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

Creating a PlanRun publishes the public Run, its private `PlanRunInputs`, and
its immutable `DependencySnapshot` as one store operation. The Run carries the
exact `executionInputsDigest`; credentials and runner dispatch are forbidden
until the store has durably accepted that complete preparation. Redelivery may
adopt only byte-equivalent preparation, may re-enqueue only a still-`queued`
Run, and rejects an occupied Run id or any changed input/dependency evidence.
A Plan that is terminally rejected by create-time policy persists the public
failure and dependency evidence but omits the private input sidecar. Historical
Plan rows without `executionInputsDigest` remain readable evidence but cannot
be dispatched or applied; operators must create a fresh Plan rather than
synthesizing or backfilling private preparation.

Public hostname, DNS, and application endpoint ownership stays inside the Git
module and its provider. Takosumi does not synthesize or reserve Capsule
hostnames. The optional `.well-known/takosumi.json` owns only install-input
assistance and reviewed requests and exact module-variable delivery targets for
Takosumi-provided generic APIs/capabilities. It does not select a source,
provider, resource, deployment, or lifecycle, and its absence does not prevent
an ordinary Git/OpenTofu install.

The app-owned Git/OpenTofu configuration remains the infrastructure and
lifecycle authority. Takosumi owns the implementation of each generic
API/capability it accepts. The repository manifest can only request that
capability and map its delivered values to the app-owned module; it cannot
declare provider or product internals.

An accepted repository `identity.oidc` request compiles into the existing
`oidc_client` and paired `public_endpoint` InstallConfig projections; it creates
no second public or private descriptor. Exactly one of each projection is
required and is usable only with immutable accepted repository provenance.
Manual/operator presentation projections do not opt a Capsule into dynamic
registration. The OIDC projection names exactly the four non-secret string
variables `accountsUrl`, `issuerUrl`, `clientId`, and `redirectUri`; the endpoint
projection names one distinct public-origin variable. Scopes must include
`openid` and remain within an explicit operator allowlist.

Takosumi does not infer or auto-register an Accounts OIDC client from a product
name, provider, ProviderBinding, hostname convention, Git metadata, or provider
output. Read-only Plan must receive a Plan-known canonical HTTPS origin from the
exact endpoint variable; there is no fallback. It derives the redirect URI from
that origin and the reviewed callback, derives the Capsule-bound client
identity, and pins the value-free authority digest and exact four delivered
variables in the private Plan sidecar. Plan and `apply_check` never write
Accounts. Final Apply alone may idempotently register the client after re-reading
the current Capsule, InstallConfig, projections, scope policy, execution epoch,
and digest. Missing Accounts capability and any origin, callback, scope,
variable, provenance, or digest drift fail before runner execution.

Destroy Plan and destroy admission remain read-only. Only after provider
destroy and the atomic Capsule `destroyed` transition have committed may Core
ask the Host to idempotently delete that exact client. Accounts live-grant
validation already denies a terminal Capsule, so a cleanup outage cannot make a
successful infrastructure destroy retryable or recreate the client. The port
never carries provider credentials, passwords, generated encryption keys, or
the runtime-binding entrypoint. There is no private hosted-profile descriptor or
provider-specific fallback for this capability.

A stateful Capsule Destroy Plan pins the current StateVersion's exact applied
PlanRun provenance: its SourceSnapshot, module source coordinate (including
`modulePath`), and required provider identities are copied into the destroy
PlanRun, and current ProviderBindings are resolved again before runner
dispatch. Exact `requiredProviderRequirements` are reused when present; pre-v1
rows without them use only the conservative provider-type local-name mapping
from `requiredProviders`, with ambiguous bindings failing closed. The
Capsule/StateVersion/ApplyRun/PlanRun lineage is scope- and backlink-validated,
and the Plan request is fenced against the same current StateVersion cursor. A
missing or changed provenance fails closed. Destroy never stores or reads a
`CompatibilityReport` id, because compatibility reports are create/update
admission evidence and never a teardown lock.
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
closed request body is `baseInstallConfigId`, `sourceSnapshotId`, bounded
non-secret `reason`, and
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

## Operator runtime-secret file capability

An operator-supplied, DB-owned per-Capsule runtime-binding profile may declare
one opaque runtime-secret file. The stock hosted Worker composes no
application-specific InstallConfig or runtime-secret profile. The declaration
is value-free and product-neutral: it names the exact random values or RSA key
pairs, environment variable, file name, and `0600` mode. It is not a bulk secret
registry, a repository-manifest capability, or authority to select a provider,
resource, deployment, or lifecycle.

Generated material is sealed in the host secret boundary, keyed to the Capsule
and exact profile, and is absent from `ProviderConnection`, public InstallConfig
projections, state, Outputs, Run/audit records, diagnostics, and logs. The same
Capsule and unchanged profile reopen the same sealed material across
InstallConfig replacement; a profile-digest change is a fence, not an implicit
rotation.

Only a successful `post_apply` runner activation may receive the material. The
runner writes the exactly declared JSON file, exports only its declared path
environment variable, and uses a temporary directory with mode `0700` and file
mode `0600`. The file is removed with fail-closed cleanup; a truncate, fsync,
unlink, or directory-removal failure fails cleanup rather than silently
retaining an active runner file.

Provider destroy commits first. The terminal Capsule transition then records a
value-free `runtime_secret.retirement.pending` intent and attempts sealed-blob
retirement. Success appends `runtime_secret.retirement.completed`; a failed
attempt remains durable and never replays provider destroy. Scheduled repair
scans this retirement outbox independently of the active Workspace catalog,
so archived Workspaces and rows beyond the active prefix are included. Deferred
attempt timestamps are rotated into oldest-attempt-first bounded scans on later
sweeps, providing eventual coverage without a second lifecycle ledger.

## Run-scoped provider sensitive inputs

An installed CredentialRecipe auth mode may declare that its provider reads
run-scoped sensitive inputs: a plan-stable nonce plus an Apply-only sensitive
`map(string)`, named by two provider-block arguments. The declaration is the
protocol shape only. It never carries, names, or selects a value, and Core holds
no provider identity of its own: the recipe is the sole place Takosumi learns
that a provider understands the protocol.

The declaration also carries the lowest exact provider version that accepts the
two arguments. Below that floor the arguments are not in the provider schema and
a plan fails with `Unsupported argument`, so the wiring is attached only when the
Capsule's resolved requirement for that provider instance pins an exact version
at or above the floor. Anything weaker — a range, or no declared version — leaves
the path inert and records a value-free plan warning naming the floor. It never
fails a Capsule, because a Capsule that needs no run-scoped sensitive inputs must
still plan.

The deliverable name set is the Capsule's manifest-gated runtime binding
profile: every binding-delivered sensitive value the manifest requests for the
Worker. That is its `generatedSecrets[].binding` entries, plus the four
`oidcClient` binding names whenever the profile also delivers `identity.oidc` by
bindings. Both the Worker's Host and the provider require the delivered map to
equal the Worker Version's declared sensitive names exactly, so a partial map is
refused before any Host mutation — a name set that carried only the generated
secrets would make an OIDC-requesting Capsule unappliable rather than
under-configured.

Which lane mints the generated-secret values depends on the host. Without a host
derivation they are fresh randomness sealed once per Capsule in the host secret
boundary, under an AAD that pins the owner and the value-free profile digest,
and reopened for every later Run. A host that ALSO materializes the same profile
through its private runtime-binding lane injects that derivation instead; nothing
is then sealed, because the values are a pure function of the host key and the
profile and both lanes necessarily mint the same bytes. Sealing one lane's first
generation would let the other drift away from it with no drift signal.

The OIDC values have no such lane and are never sealed or minted here. An OIDC
client is one registration under the Capsule's Accounts authority — the same
public client the private runtime-binding lane registers, derived from the same
host key — so the host injects that authority as a port and Core carries only
what it returns: the issuer origin, the derived client id, the pairwise owner
subject, and the redirect URI. Minting a second client, or sealing a copy of the
first, would put two identities under one Capsule. The port also answers a
value-free generation identity, which is folded into the nonce so a moved
registration rotates it exactly like re-sealed material. A profile that declares
OIDC bindings and a host with no such port fail closed.

A profile change — the Capsule's manifest adds or renames a generated secret, or
changes which bindings the OIDC grant delivers — retires the previous sealed
generation and seals a new one. Fencing it off instead would leave the Capsule
unable to plan OR destroy, with no recovery path. Re-sealing rotates the nonce,
which is exactly the replacement semantics a provider expects from rotated
material.

The nonce is deterministic per (Workspace, Capsule, profile digest, material
generation, provider instance). It is never random per Run: a provider derives
its apply-idempotency identity from the nonce and that identity forces
replacement, so a per-Run nonce would propose a replacement on every plan and
could deadlock a rename-free resource. `installConfigId` is deliberately not part
of the preimage — a repository re-sync can repoint a Capsule at a
content-identical InstallConfig under a new id, and rotating there would force a
replacement of resources whose content never changed. The material generation is
a digest of the sealed ciphertext (or, on the derived lane, of the derivation
parts), so it moves when and only when the values move.

Exactly one resolved Provider Connection may declare the protocol for a Capsule.
Two declaring instances fail closed, because one manifest-gated value set has no
rule for splitting itself. A Capsule without a generated root also fails closed:
Takosumi owns no provider block there, so it can declare neither the ephemeral
variable nor the two arguments.

A destroy plan wires nothing at all. Both provider-block arguments are optional
and a provider's teardown reads neither, so a destroy needs no nonce, no
variable, and no minted material — and keeping the destroy lane free of the
wiring is what makes teardown the recovery path for a Capsule whose profile has
drifted. A lifecycle release command likewise mints none: its dispatch has no
generated root and no ephemeral variable, so nothing there could consume a map.

The generated root renders the nonce as a literal and the map as a bare
reference to an ephemeral, sensitive, defaultless `map(string)` root variable in
the reserved `takosumi_runtime_inputs__` namespace. No value enters the generated
root, the plan file, the `tfplan.json` artifact, `runs_inputs`, planned or
committed Outputs, state, Run or audit records, credential-mint evidence, or the
Durable Object's mutation record, which projects only the variable name, the
declared binding names, and one-way value digests.

Plan pins a value-free descriptor — variable, provider instance, nonce, names,
profile digest — into the private run-inputs sidecar. Apply re-derives the nonce
and the name set and fails closed with `runtime_inputs_nonce_changed`,
`runtime_inputs_name_set_changed`, `runtime_inputs_variable_changed`, or
`runtime_inputs_wiring_missing`, so a rotated generation, a moved variable, or a
resolution that no longer declares the protocol forces a re-plan instead of
applying a reviewed root against different material. Every failure is a
precondition on Capsule material and reports its own reason.

The runner binds each map to its declared variable and supplies it to OpenTofu
through `-var-file=<pipe>`, at plan (empty) and again at apply (exact). The pipe
is a 0600 FIFO inside a 0700 directory created beside the run workspace: the
runner opens the write end only once OpenTofu holds the read end, writes the body
once, closes, and removes the pipe and its directory immediately. Standard input
is deliberately never used — OpenTofu launches every provider plugin with the
runner's own fd 0, so a var-file body on standard input would be readable by
every plugin in the root, including third-party providers that are not the
declaring instance. `-var` and `TF_VAR_*` are never used either, so no value
reaches the process argv or environment, and no plaintext is ever stored at rest.
The variable has no default, so OpenTofu enforces that a map SET at plan is set
again at apply; it does not enforce the contents, so the provider's own exact
name-set check is the fence on the values themselves. Every value, and its
escaped HCL form, joins the runner's stdout/stderr redaction list, and a value
below that redaction floor is refused at the Core boundary.

The path is completely inert for a Capsule whose resolved Provider Connections
declare nothing: no variable file, no dispatch field, and a byte-identical
generated root.

Known gaps. Takosumi does not extract the module's own `required_sensitive_vars`
from HCL — the compatibility scan reads root variables, outputs, and provider
requirements only — so a Capsule can be wired with a name set the module does not
declare, and the mismatch is caught by the provider at apply rather than at plan.
Rollout is also opt-in per Connection: the protocol descriptor is resolved only
when a Provider Connection is registered, so existing Connections stay completely
inert until they are re-registered.

## Repository-manifest Accounts OIDC capability

Provider runtime-binding remains read-only and has no registration authority.
The Takosumi-owned generic Accounts capability implementation owns final Apply
activation; repository projections select its input/output contract without
adding a second lifecycle owner.

A manifest may attach an explicit generic `identity.oidc` request to a module
already selected from the SourceSnapshot tree scan, only when the same module
declares exactly one paired
`http.endpoint`. Compilation requires exactly one OIDC projection, exactly one
endpoint projection, exact and distinct string-variable targets, a non-empty
unique scope set containing `openid`, and an explicit operator scope allowlist.
The generic default policy bounds that allowlist to `openid`, `profile`,
`email`, `offline_access`, `capsules:read`, and `capsules:write`; a reviewed app
may request a subset. `callbackPath` is a bounded root-relative path and its
exact reviewed value is retained in the projection.

At Plan, the endpoint variable must be the only source value consumed by the
OIDC materializer and must already equal its canonical HTTPS origin. A missing,
empty, non-HTTPS, credential-bearing, path-bearing, query-bearing, fragment-bearing,
or non-canonical value is rejected; neither Cloudflare metadata nor another
provider or hostname supplies a fallback. The materializer derives the public
Capsule-bound client and returns only `accountsUrl`, `issuerUrl`, `clientId`, and
`redirectUri`. Plan and `apply_check` are read-only. Final Apply is the only
registration path; it is idempotent and saves the exact current value-free
`activationDigest`. The digest binds contract
`takosumi.accounts-oidc-activation/v1`, Workspace and Capsule identity,
`executionAuthorityEpoch`, and the full InstallConfig digest. Live-grant
validation requires an exact current match; a legacy null or mismatched digest
is stale/denied without deleting the Apply-repairable client. `updatedAt` is
ordinary audit time only, not activation authority. The registration carries
no client secret in InstallConfig, state, Outputs, or the Run sidecar.

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

No second materialization descriptor or private compatibility branch remains.
Accepted repository provenance and the existing `oidc_client` plus
`public_endpoint` projections are the only materialization authority. This
capability does not change ownership of bulk/operator secrets, generic
ProviderConnections, app infrastructure, or lifecycle.

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
